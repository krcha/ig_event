import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
  runInstagramIngestionBatchStep,
  type IngestionBatchState,
  type IngestionRunMode,
  type IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  getRecentlyAttemptedFullScrapeHandles,
} from "@/lib/pipeline/recent-full-scrape-handles";
import { loadCronIngestionCandidateSnapshot } from "@/lib/pipeline/cron-ingestion-resumption";
import {
  enforceDailySamplingRunContext,
  getCronIngestionConfig,
  isAuthorizedCronRequestHeader,
  selectCronIngestionHandles,
} from "@/lib/pipeline/cron-ingestion-config";
import { isLatestPost24hSamplingEnabled } from "@/lib/pipeline/instagram-ingestion-durability";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import {
  MAX_CRON_INGESTION_JOB_HANDLES,
  MAX_INGESTION_JOB_HANDLES,
  serializeSafeIngestionJobPayload,
  truncateIngestionError,
} from "@/lib/pipeline/ingestion-job-safety";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;
const findLatestResumableFullScrapeJobQuery =
  "ingestionJobs:findLatestResumableFullScrapeJob" as unknown as FunctionReference<"query">;
const claimStepMutation =
  "ingestionJobs:claimStep" as unknown as FunctionReference<"mutation">;
const completeStepMutation =
  "ingestionJobs:completeStep" as unknown as FunctionReference<"mutation">;
const failStepMutation =
  "ingestionJobs:failStep" as unknown as FunctionReference<"mutation">;
const DEFAULT_BATCH_SIZE = 1;
const MAX_CRON_BATCH_SIZE = 1;
const DEFAULT_CRON_MAX_STEPS_PER_REQUEST = 1;
const MAX_CRON_MAX_STEPS_PER_REQUEST = 1;
const DEFAULT_INGESTION_JOB_LEASE_MS = 30 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_RESUMABLE_LOOKBACK_HOURS = 7 * 24;
const MAX_RESUMABLE_LOOKBACK_HOURS = 30 * 24;

type IngestionJobStatus = "queued" | "running" | "completed" | "failed";

type IngestionJobRecord = {
  _id: string;
  source: string;
  mode?: IngestionRunMode;
  status: IngestionJobStatus;
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  batchSize: number;
  summaryJson: string;
  stateJson: string;
  stateVersion?: number;
  startedAt?: string;
  finishedAt?: string;
};


type ConvexClient = ReturnType<typeof createConvexHttpClient>;

function isAuthorizedCronRequest(request: Request): boolean {
  return isAuthorizedCronRequestHeader(request.headers.get("authorization"));
}

function normalizeCronMaxSteps(value: string | undefined): number {
  if (!value) {
    return DEFAULT_CRON_MAX_STEPS_PER_REQUEST;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_CRON_MAX_STEPS_PER_REQUEST;
  }
  return Math.min(Math.trunc(parsed), MAX_CRON_MAX_STEPS_PER_REQUEST);
}

function normalizeCronBatchSize(value: string | undefined): number {
  if (!value) {
    return DEFAULT_BATCH_SIZE;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(Math.trunc(parsed), MAX_CRON_BATCH_SIZE);
}

function normalizeResumableLookbackHours(value: string | undefined): number {
  if (!value) {
    return DEFAULT_RESUMABLE_LOOKBACK_HOURS;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 24) {
    return DEFAULT_RESUMABLE_LOOKBACK_HOURS;
  }
  return Math.min(Math.trunc(parsed), MAX_RESUMABLE_LOOKBACK_HOURS);
}

function normalizeHostRunRemaining(request: Request, configuredMaximum: number): number {
  const raw = new URL(request.url).searchParams.get("hostRunRemaining");
  if (raw === null) {
    return configuredMaximum;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("hostRunRemaining must be a non-negative integer.");
  }
  return Math.min(Math.trunc(parsed), configuredMaximum);
}

function normalizeHostRunCursor(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("hostRunAfter");
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const handle = raw.trim().replace(/^@+/, "").toLocaleLowerCase();
  if (handle.length > 128 || !/^[a-z0-9._]+$/.test(handle)) {
    throw new Error("hostRunAfter must be a valid normalized Instagram handle.");
  }
  return handle;
}

function parseSummary(summaryJson: string, handles: string[]): IngestionSummary {
  try {
    const parsed = JSON.parse(summaryJson) as IngestionSummary;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.finishedAt === "string" &&
      Array.isArray(parsed.handles)
    ) {
      return parsed;
    }
  } catch {
    // fallback below
  }
  return createEmptyIngestionSummary(handles);
}

function parseState(stateJson: string): IngestionBatchState {
  const fallback = createInitialIngestionBatchState();
  try {
    const parsed = JSON.parse(stateJson) as Partial<IngestionBatchState>;
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    return {
      stateVersion: 2,
      handleIndex:
        typeof parsed.handleIndex === "number" && Number.isFinite(parsed.handleIndex)
          ? Math.max(0, Math.trunc(parsed.handleIndex))
          : 0,
      currentHandle: typeof parsed.currentHandle === "string" ? parsed.currentHandle : null,
      currentPostIndex:
        typeof parsed.currentPostIndex === "number" &&
        Number.isFinite(parsed.currentPostIndex)
          ? Math.max(0, Math.trunc(parsed.currentPostIndex))
          : 0,
      currentHandlePosts: [],
      currentScrapedPostCursor:
        typeof parsed.currentScrapedPostCursor === "string"
          ? parsed.currentScrapedPostCursor
          : null,
      currentScrapedPostIds: Array.isArray(parsed.currentScrapedPostIds)
        ? parsed.currentScrapedPostIds.filter((id): id is string => typeof id === "string")
        : [],
      currentScrapedPostIdIndex:
        typeof parsed.currentScrapedPostIdIndex === "number" &&
        Number.isFinite(parsed.currentScrapedPostIdIndex)
          ? Math.max(0, Math.trunc(parsed.currentScrapedPostIdIndex))
          : 0,
      currentScrapedPostPageDone: parsed.currentScrapedPostPageDone === true,
      seenSourceKeysByHandle:
        parsed.seenSourceKeysByHandle &&
        typeof parsed.seenSourceKeysByHandle === "object" &&
        !Array.isArray(parsed.seenSourceKeysByHandle)
          ? (parsed.seenSourceKeysByHandle as Record<string, string[]>)
          : {},
    };
  } catch {
    return fallback;
  }
}

async function findResumableCronJob(options: {
  convex: ConvexClient;
  serviceSecret: string;
  minCreatedAt: number;
  maxHandles: number;
}): Promise<IngestionJobRecord | null> {
  return (await options.convex.query(findLatestResumableFullScrapeJobQuery, {
    source: "cron_active_venues",
    minCreatedAt: options.minCreatedAt,
    maxHandles: options.maxHandles,
    serviceSecret: options.serviceSecret,
  })) as IngestionJobRecord | null;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  let jobId: string | null = null;

  try {
    const serviceSecret = requireServiceSecret();
    const cronConfig = getCronIngestionConfig();
    const samplingMode = isLatestPost24hSamplingEnabled()
      ? ("latest_one_24h" as const)
      : undefined;
    const effectiveResultsLimit = samplingMode ? 1 : cronConfig.resultsLimit;
    const effectiveDaysBack = samplingMode ? 1 : cronConfig.daysBack;
    const convex = createConvexHttpClient();
    const resumableMinCreatedAt =
      Date.now() -
      normalizeResumableLookbackHours(process.env.CRON_INGESTION_RESUMABLE_LOOKBACK_HOURS) *
        MS_PER_HOUR;
    const cooldownMinCreatedAt =
      Date.now() - cronConfig.fullScrapeCooldownHours * MS_PER_HOUR;
    const effectiveBatchSize = normalizeCronBatchSize(process.env.CRON_INGESTION_BATCH_SIZE);
    const incomingHostRunCursor = normalizeHostRunCursor(request);
    const resumeCapacity = normalizeHostRunRemaining(request, MAX_INGESTION_JOB_HANDLES);
    const candidateSnapshot = await loadCronIngestionCandidateSnapshot({
      resumeCapacity,
      findResumableJob: () =>
        findResumableCronJob({
          convex,
          serviceSecret,
          minCreatedAt: resumableMinCreatedAt,
          maxHandles: resumeCapacity,
        }),
      loadActiveHandles: () => getActiveVenueHandles({ serviceSecret }),
    });
    const resumableJob = candidateSnapshot.resumableJob;
    let activeVenueHandles = candidateSnapshot.activeHandles;
    let activeVenueCount = 0;
    let hostRunMaxHandles = 0;
    let hostRunRemaining = resumeCapacity;
    let hostRunCursor = incomingHostRunCursor;
    let hostRunCompletedThrough = 0;
    let maxHandlesPerJob = Math.min(hostRunRemaining, MAX_CRON_INGESTION_JOB_HANDLES);
    let handles: string[];
    let skippedRecentlyAttempted = 0;
    let skippedDueToRunLimit = 0;
    let resumedJob = false;
    let resumableSummary: IngestionSummary | null = null;

    if (resumableJob) {
      jobId = resumableJob._id;
      handles = resumableJob.handles;
      resumableSummary = parseSummary(resumableJob.summaryJson, resumableJob.handles);
      activeVenueCount =
        resumableSummary.runContext?.activeVenueCount ?? resumableJob.handles.length;
      hostRunMaxHandles =
        resumableSummary.runContext?.maxHandlesPerRun ?? activeVenueCount;
      hostRunRemaining = normalizeHostRunRemaining(request, hostRunMaxHandles);
      hostRunCursor =
        resumableSummary.runContext?.hostRunCursor ??
        resumableJob.handles.at(-1) ??
        incomingHostRunCursor;
      hostRunCompletedThrough =
        resumableSummary.runContext?.hostRunCompletedThrough ?? 0;
      maxHandlesPerJob = Math.min(hostRunRemaining, MAX_CRON_INGESTION_JOB_HANDLES);
      skippedRecentlyAttempted = resumableSummary.runContext?.skippedRecentlyAttempted ?? 0;
      skippedDueToRunLimit = resumableSummary.runContext?.skippedDueToRunLimit ?? 0;
      resumedJob = true;
    } else {
      // A complete active-source snapshot is needed only when creating the next
      // job. Resumed one-handle steps reuse the durable job snapshot instead of
      // rescanning all global sources on every HTTP request.
      activeVenueCount = activeVenueHandles.length;
      hostRunMaxHandles = activeVenueCount;
      hostRunRemaining = normalizeHostRunRemaining(request, hostRunMaxHandles);
      maxHandlesPerJob = Math.min(hostRunRemaining, MAX_CRON_INGESTION_JOB_HANDLES);

      if (activeVenueHandles.length === 0 || maxHandlesPerJob === 0) {
        handles = [];
      } else {
        const recentlyAttemptedHandles = await getRecentlyAttemptedFullScrapeHandles({
          candidateHandles: activeVenueHandles,
          minCreatedAt: cooldownMinCreatedAt,
          serviceSecret,
        });
        const handleSelection = selectCronIngestionHandles({
          activeVenueHandles,
          recentlyAttemptedHandles,
          maxHandlesPerRun: maxHandlesPerJob,
          afterHandle: incomingHostRunCursor,
        });
        handles = handleSelection.handles;
        hostRunCursor = handles.at(-1) ?? incomingHostRunCursor;
        const cursorIndex = hostRunCursor
          ? activeVenueHandles.indexOf(hostRunCursor)
          : -1;
        hostRunCompletedThrough =
          cursorIndex >= 0
            ? cursorIndex + 1
            : handles.length === 0
              ? activeVenueCount
              : 0;
        skippedRecentlyAttempted = handleSelection.skippedRecentlyAttempted;
        skippedDueToRunLimit = handleSelection.skippedDueToRunLimit;
      }
    }

    if (handles.length === 0) {
      if (hostRunRemaining === 0 || activeVenueCount === 0) {
        hostRunCompletedThrough = hostRunMaxHandles;
      } else if (hostRunCompletedThrough === 0) {
        // Every remaining active handle has a durable recent-attempt receipt.
        hostRunCompletedThrough = activeVenueCount;
      }
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([], {
          source: "cron_active_venues",
          mode: "full_scrape",
          samplingMode,
          activeVenueCount,
          selectedHandleCount: 0,
          skippedRecentlyAttempted,
          skippedDueToRunLimit,
          fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
          maxHandlesPerRun: hostRunMaxHandles,
          ...(hostRunCursor ? { hostRunCursor } : {}),
          hostRunCompletedThrough,
          resultsLimit: effectiveResultsLimit,
          daysBack: effectiveDaysBack,
        }),
        activeVenueCount,
        skippedRecentlyAttempted,
        skippedDueToRunLimit,
        maxHandlesPerJob,
        hostRunMaxHandles,
        hostRunRemaining,
        hostRunCursor: hostRunCursor ?? null,
        hostRunCompletedThrough,
        done: true,
        status: "completed",
        costControls: {
          ...cronConfig,
          resultsLimit: effectiveResultsLimit,
          daysBack: effectiveDaysBack,
          maxHandlesPerRun: hostRunMaxHandles,
          samplingMode,
        },
      });
    }

    const initialSummary =
      resumableSummary ??
      createEmptyIngestionSummary(handles, {
        source: "cron_active_venues",
        mode: "full_scrape",
        samplingMode,
        activeVenueCount,
        selectedHandleCount: handles.length,
        skippedRecentlyAttempted,
        skippedDueToRunLimit,
        fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
        maxHandlesPerRun: hostRunMaxHandles,
        ...(hostRunCursor ? { hostRunCursor } : {}),
        hostRunCompletedThrough,
        resultsLimit: effectiveResultsLimit,
        daysBack: effectiveDaysBack,
      });

    const persistedRunStartedAtMs = Date.parse(initialSummary.startedAt);
    const samplingWindowUpperBoundAtMs = samplingMode
      ? Number.isFinite(persistedRunStartedAtMs)
        ? persistedRunStartedAtMs
        : Date.now()
      : undefined;

    enforceDailySamplingRunContext(initialSummary, {
      resultsLimit: effectiveResultsLimit,
      daysBack: effectiveDaysBack,
      samplingMode,
      samplingWindowUpperBoundAtMs,
    });

    const initialState = createInitialIngestionBatchState();
    const initialPayload = serializeSafeIngestionJobPayload({
      handles,
      summary: initialSummary,
      state: initialState,
    });
    if (!jobId) {
      jobId = (await convex.mutation(createIngestionJobMutation, {
        source: "cron_active_venues",
        mode: "full_scrape",
        handles,
        resultsLimit: effectiveResultsLimit,
        daysBack: effectiveDaysBack,
        batchSize: effectiveBatchSize,
        summaryJson: initialPayload.summaryJson,
        stateJson: initialPayload.stateJson,
        serviceSecret,
      })) as string;
    }

    const maxSteps = normalizeCronMaxSteps(process.env.CRON_INGESTION_MAX_STEPS);
    let stepsAdvanced = 0;
    let done = false;
    let summary = initialSummary;
    let status: IngestionJobStatus = "queued";
    let finishedAt: string | null = null;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const leaseOwner = `cron:${jobId}:${Date.now()}:${stepIndex}`;
      const claimedJob = (await convex.mutation(claimStepMutation, {
        id: jobId,
        leaseOwner,
        leaseDurationMs: DEFAULT_INGESTION_JOB_LEASE_MS,
        serviceSecret,
      })) as IngestionJobRecord | null;

      if (!claimedJob) {
        break;
      }

      const stateVersion = claimedJob.stateVersion ?? 0;
      summary = parseSummary(claimedJob.summaryJson, claimedJob.handles);
      enforceDailySamplingRunContext(summary, {
        resultsLimit: effectiveResultsLimit,
        daysBack: effectiveDaysBack,
        samplingMode,
        samplingWindowUpperBoundAtMs,
      });
      const state = parseState(claimedJob.stateJson);

      try {
        const batchResult = await runInstagramIngestionBatchStep({
          handles: claimedJob.handles,
          summary,
          state,
          resultsLimit: effectiveResultsLimit,
          daysBack: effectiveDaysBack,
          batchSize: Math.min(claimedJob.batchSize, effectiveBatchSize),
          mode: claimedJob.mode ?? "full_scrape",
          samplingMode,
          samplingWindowUpperBoundAtMs,
          serviceSecret,
        });

        const persistedPayload = serializeSafeIngestionJobPayload({
          handles: claimedJob.handles,
          summary: batchResult.summary,
          state: batchResult.state,
        });
        summary = persistedPayload.summary;
        done = batchResult.done;
        status = done ? "completed" : "running";
        finishedAt = done ? new Date().toISOString() : null;
        await convex.mutation(completeStepMutation, {
          id: jobId,
          leaseOwner,
          stateVersion,
          patch: {
            status,
            summaryJson: persistedPayload.summaryJson,
            stateJson: persistedPayload.stateJson,
            ...(finishedAt ? { finishedAt } : {}),
          },
          serviceSecret,
        });

        stepsAdvanced += 1;
        if (done) {
          break;
        }
      } catch (error) {
        const failedPayload = serializeSafeIngestionJobPayload({
          handles: claimedJob.handles,
          summary,
          state,
        });
        await convex.mutation(failStepMutation, {
          id: jobId,
          leaseOwner,
          stateVersion,
          error: truncateIngestionError(error),
          summaryJson: failedPayload.summaryJson,
          stateJson: failedPayload.stateJson,
          serviceSecret,
        });
        throw error;
      }
    }

    return NextResponse.json({
      source: "cron_active_venues",
      jobId,
      handles,
      summary,
      status,
      done,
      stepsAdvanced,
      maxSteps,
      effectiveBatchSize,
      resumedJob,
      finishedAt,
      activeVenueCount,
      skippedRecentlyAttempted,
      skippedDueToRunLimit,
      maxHandlesPerJob,
      hostRunMaxHandles,
      hostRunRemaining,
      hostRunCursor: hostRunCursor ?? null,
      hostRunCompletedThrough: done ? hostRunCompletedThrough : null,
      costControls: {
          ...cronConfig,
          resultsLimit: effectiveResultsLimit,
          daysBack: effectiveDaysBack,
          maxHandlesPerRun: hostRunMaxHandles,
          samplingMode,
        },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ...(jobId ? { jobId } : {}),
        error:
          error instanceof Error
            ? error.message
            : "Failed to run scheduled venue ingestion.",
      },
      { status: 500 },
    );
  }
}
