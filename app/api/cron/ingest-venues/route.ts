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
import {
  getCronIngestionConfig,
  isAuthorizedCronRequestHeader,
  selectCronIngestionHandles,
} from "@/lib/pipeline/cron-ingestion-config";
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
const getIngestionJobQuery =
  "ingestionJobs:getJob" as unknown as FunctionReference<"query">;
const listRecentFullScrapeJobsQuery =
  "ingestionJobs:listRecentFullScrapeJobs" as unknown as FunctionReference<"query">;
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
const CRON_CHUNK_ATTEMPT_WINDOW_MS = 6 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

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

type RecentFullScrapeJobRecord = {
  _id: string;
  source: string;
  status: IngestionJobStatus;
  handles: string[];
  stateJson: string;
  createdAt: number;
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
  const recentJobs = (await options.convex.query(listRecentFullScrapeJobsQuery, {
    minCreatedAt: options.minCreatedAt,
    serviceSecret: options.serviceSecret,
  })) as RecentFullScrapeJobRecord[];

  const resumableJob = recentJobs
    .filter(
      (job) =>
        job.source === "cron_active_venues" &&
        job.handles.length <= options.maxHandles &&
        (job.status === "queued" || job.status === "running"),
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];

  if (!resumableJob) {
    return null;
  }

  return (await options.convex.query(getIngestionJobQuery, {
    id: resumableJob._id,
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
    const convex = createConvexHttpClient();
    const activeVenueHandles = await getActiveVenueHandles({ serviceSecret });
    if (activeVenueHandles.length === 0) {
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([], {
          source: "cron_active_venues",
          mode: "full_scrape",
          activeVenueCount: 0,
          selectedHandleCount: 0,
          skippedRecentlyAttempted: 0,
          skippedDueToRunLimit: 0,
          fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
          maxHandlesPerRun: cronConfig.maxHandlesPerRun,
          resultsLimit: cronConfig.resultsLimit,
          daysBack: cronConfig.daysBack,
        }),
        costControls: cronConfig,
      });
    }

    const minCreatedAt = Date.now() - cronConfig.fullScrapeCooldownHours * MS_PER_HOUR;
    const effectiveBatchSize = normalizeCronBatchSize(process.env.CRON_INGESTION_BATCH_SIZE);
    const hostRunMaxHandles = activeVenueHandles.length;
    const hostRunRemaining = normalizeHostRunRemaining(request, hostRunMaxHandles);
    const maxHandlesPerJob = Math.min(hostRunRemaining, MAX_CRON_INGESTION_JOB_HANDLES);
    const resumableJob = await findResumableCronJob({
      convex,
      serviceSecret,
      minCreatedAt,
      maxHandles: Math.min(hostRunRemaining, MAX_INGESTION_JOB_HANDLES),
    });
    let handles: string[];
    let skippedRecentlyAttempted = 0;
    let skippedDueToRunLimit = 0;
    let resumedJob = false;

    if (maxHandlesPerJob === 0) {
      handles = [];
    } else if (resumableJob) {
      jobId = resumableJob._id;
      handles = resumableJob.handles;
      const resumableSummary = parseSummary(resumableJob.summaryJson, resumableJob.handles);
      skippedRecentlyAttempted = resumableSummary.runContext?.skippedRecentlyAttempted ?? 0;
      skippedDueToRunLimit = resumableSummary.runContext?.skippedDueToRunLimit ?? 0;
      resumedJob = true;
    } else {
      const [freshlyAttemptedHandles, currentRunAttemptedHandles] = await Promise.all([
        getRecentlyAttemptedFullScrapeHandles({
          candidateHandles: activeVenueHandles,
          minCreatedAt,
          serviceSecret,
        }),
        getRecentlyAttemptedFullScrapeHandles({
          candidateHandles: activeVenueHandles,
          minCreatedAt: Date.now() - CRON_CHUNK_ATTEMPT_WINDOW_MS,
          serviceSecret,
          includeErroredCompletedHandles: true,
        }),
      ]);
      const recentlyAttemptedHandles = [
        ...new Set([...freshlyAttemptedHandles, ...currentRunAttemptedHandles]),
      ];
      const handleSelection = selectCronIngestionHandles({
        activeVenueHandles,
        recentlyAttemptedHandles,
        maxHandlesPerRun: maxHandlesPerJob,
      });
      handles = handleSelection.handles;
      skippedRecentlyAttempted = handleSelection.skippedRecentlyAttempted;
      skippedDueToRunLimit = handleSelection.skippedDueToRunLimit;
    }

    if (handles.length === 0) {
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([], {
          source: "cron_active_venues",
          mode: "full_scrape",
          activeVenueCount: activeVenueHandles.length,
          selectedHandleCount: 0,
          skippedRecentlyAttempted,
          skippedDueToRunLimit,
          fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
          maxHandlesPerRun: hostRunMaxHandles,
          resultsLimit: cronConfig.resultsLimit,
          daysBack: cronConfig.daysBack,
        }),
        activeVenueCount: activeVenueHandles.length,
        skippedRecentlyAttempted,
        skippedDueToRunLimit,
        maxHandlesPerJob,
        hostRunMaxHandles,
        hostRunRemaining,
        costControls: { ...cronConfig, maxHandlesPerRun: hostRunMaxHandles },
      });
    }

    const initialSummary = createEmptyIngestionSummary(handles, {
      source: "cron_active_venues",
      mode: "full_scrape",
      activeVenueCount: activeVenueHandles.length,
      selectedHandleCount: handles.length,
      skippedRecentlyAttempted,
      skippedDueToRunLimit,
      fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
      maxHandlesPerRun: hostRunMaxHandles,
      resultsLimit: cronConfig.resultsLimit,
      daysBack: cronConfig.daysBack,
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
        resultsLimit: cronConfig.resultsLimit,
        daysBack: cronConfig.daysBack,
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
      const state = parseState(claimedJob.stateJson);

      try {
        const batchResult = await runInstagramIngestionBatchStep({
          handles: claimedJob.handles,
          summary,
          state,
          resultsLimit: claimedJob.resultsLimit,
          daysBack: claimedJob.daysBack,
          batchSize: Math.min(claimedJob.batchSize, effectiveBatchSize),
          mode: claimedJob.mode ?? "full_scrape",
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
      activeVenueCount: activeVenueHandles.length,
      skippedRecentlyAttempted,
      skippedDueToRunLimit,
      maxHandlesPerJob,
      hostRunMaxHandles,
      hostRunRemaining,
      costControls: { ...cronConfig, maxHandlesPerRun: hostRunMaxHandles },
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
