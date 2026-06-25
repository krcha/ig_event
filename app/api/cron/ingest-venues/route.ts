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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;
const claimStepMutation =
  "ingestionJobs:claimStep" as unknown as FunctionReference<"mutation">;
const completeStepMutation =
  "ingestionJobs:completeStep" as unknown as FunctionReference<"mutation">;
const failStepMutation =
  "ingestionJobs:failStep" as unknown as FunctionReference<"mutation">;
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_CRON_MAX_STEPS_PER_REQUEST = 4;
const DEFAULT_INGESTION_JOB_LEASE_MS = 5 * 60 * 1000;
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
  return Math.min(Math.trunc(parsed), 20);
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

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  let jobId: string | null = null;

  try {
    const serviceSecret = requireServiceSecret();
    const cronConfig = getCronIngestionConfig();
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

    const recentlyAttemptedHandles = await getRecentlyAttemptedFullScrapeHandles({
      candidateHandles: activeVenueHandles,
      minCreatedAt: Date.now() - cronConfig.fullScrapeCooldownHours * MS_PER_HOUR,
      serviceSecret,
    });
    const handleSelection = selectCronIngestionHandles({
      activeVenueHandles,
      recentlyAttemptedHandles,
      maxHandlesPerRun: cronConfig.maxHandlesPerRun,
    });
    const { handles } = handleSelection;

    if (handles.length === 0) {
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([], {
          source: "cron_active_venues",
          mode: "full_scrape",
          activeVenueCount: activeVenueHandles.length,
          selectedHandleCount: 0,
          skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
          skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
          fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
          maxHandlesPerRun: cronConfig.maxHandlesPerRun,
          resultsLimit: cronConfig.resultsLimit,
          daysBack: cronConfig.daysBack,
        }),
        activeVenueCount: activeVenueHandles.length,
        skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
        skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
        costControls: cronConfig,
      });
    }

    const convex = createConvexHttpClient();
    const initialSummary = createEmptyIngestionSummary(handles, {
      source: "cron_active_venues",
      mode: "full_scrape",
      activeVenueCount: activeVenueHandles.length,
      selectedHandleCount: handles.length,
      skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
      skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
      maxHandlesPerRun: cronConfig.maxHandlesPerRun,
      resultsLimit: cronConfig.resultsLimit,
      daysBack: cronConfig.daysBack,
    });
    const initialState = createInitialIngestionBatchState();
    jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "cron_active_venues",
      mode: "full_scrape",
      handles,
      resultsLimit: cronConfig.resultsLimit,
      daysBack: cronConfig.daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(initialSummary),
      stateJson: JSON.stringify(initialState),
      serviceSecret,
    })) as string;

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
          batchSize: claimedJob.batchSize,
          mode: claimedJob.mode ?? "full_scrape",
          serviceSecret,
        });

        summary = batchResult.summary;
        done = batchResult.done;
        status = done ? "completed" : "running";
        finishedAt = done ? new Date().toISOString() : null;
        await convex.mutation(completeStepMutation, {
          id: jobId,
          leaseOwner,
          stateVersion,
          patch: {
            status,
            summaryJson: JSON.stringify(batchResult.summary),
            stateJson: JSON.stringify(batchResult.state),
            ...(finishedAt ? { finishedAt } : {}),
          },
          serviceSecret,
        });

        stepsAdvanced += 1;
        if (done) {
          break;
        }
      } catch (error) {
        await convex.mutation(failStepMutation, {
          id: jobId,
          leaseOwner,
          stateVersion,
          error:
            error instanceof Error
              ? error.message
              : "Failed to run scheduled venue ingestion.",
          summaryJson: JSON.stringify(summary),
          stateJson: JSON.stringify(state),
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
      finishedAt,
      activeVenueCount: activeVenueHandles.length,
      skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
      skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      costControls: cronConfig,
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
