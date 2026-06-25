import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import {
  createAuthenticatedConvexHttpClient,
  requireServiceSecret,
} from "@/lib/convex/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  getRecentFullScrapeAttemptSummary,
} from "@/lib/pipeline/recent-full-scrape-handles";
import {
  getCronIngestionConfig,
  selectCronIngestionHandles,
} from "@/lib/pipeline/cron-ingestion-config";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
};

type RepairErrorStep = "auth_check" | "parse_body" | "enqueue_repair_job";

const DEFAULT_BATCH_SIZE = 2;
const MS_PER_HOUR = 60 * 60 * 1000;
const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;

export const maxDuration = 300;

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
}

function logInfo(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: "info",
      event,
      ...payload,
    }),
  );
}

function logError(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...payload,
    }),
  );
}

export async function POST(request: Request) {
  let step: RepairErrorStep = "auth_check";
  let handles: string[] = [];

  try {
    const adminAccess = await requireAdminApiAccess();
    if (!adminAccess.ok) {
      return adminAccess.response;
    }

    step = "parse_body";

    let body: Body = {};
    try {
      body = (await request.json()) as Body;
    } catch {
      return NextResponse.json(
        { errorStep: "parse_body", error: "Invalid JSON payload." },
        { status: 400 },
      );
    }

    const cronConfig = getCronIngestionConfig();
    const serviceSecret = requireServiceSecret();
    const requestedResultsLimit = normalizePositiveInt(body.resultsLimit);
    const requestedDaysBack = normalizePositiveInt(body.daysBack);
    const resultsLimit = Math.min(
      requestedResultsLimit ?? cronConfig.resultsLimit,
      cronConfig.resultsLimit,
    );
    const daysBack = Math.min(
      requestedDaysBack ?? cronConfig.daysBack,
      cronConfig.daysBack,
    );

    step = "enqueue_repair_job";
    const activeVenueHandles = await getActiveVenueHandles({ serviceSecret });

    if (activeVenueHandles.length === 0) {
      return NextResponse.json(
        {
          errorStep: "enqueue_repair_job",
          error: "No active venue handles are configured for repair.",
        },
        { status: 400 },
      );
    }

    const recentFullScrapeSummary = await getRecentFullScrapeAttemptSummary({
      candidateHandles: activeVenueHandles,
      minCreatedAt: Date.now() - cronConfig.fullScrapeCooldownHours * MS_PER_HOUR,
      serviceSecret,
    });
    const handleSelection = selectCronIngestionHandles({
      activeVenueHandles,
      recentlyAttemptedHandles: recentFullScrapeSummary.attemptedHandles,
      maxHandlesPerRun: cronConfig.maxHandlesPerRun,
    });
    handles = handleSelection.handles;

    if (handles.length === 0) {
      return NextResponse.json(
        {
          errorStep: "enqueue_repair_job",
          error: `All active venues have already had a fresh scrape attempt in the last ${cronConfig.fullScrapeCooldownHours} hours.`,
          lastFreshScrapeAt: recentFullScrapeSummary.lastFreshScrapeAt,
          skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
        },
        { status: 400 },
      );
    }

    const convex = await createAuthenticatedConvexHttpClient();
    const summary = createEmptyIngestionSummary(handles, {
      source: "repair_active_venues",
      mode: "full_scrape",
      activeVenueCount: activeVenueHandles.length,
      selectedHandleCount: handles.length,
      skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
      skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
      maxHandlesPerRun: cronConfig.maxHandlesPerRun,
      resultsLimit,
      daysBack,
    });
    const state = createInitialIngestionBatchState();

    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "repair_active_venues",
      mode: "full_scrape",
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      mode: "full_scrape",
      source: "repair_active_venues",
      jobId,
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      selectedHandleCount: handles.length,
      activeVenueHandleCount: activeVenueHandles.length,
      skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
      skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
    });

    return NextResponse.json({
      started: true,
      mode: "full_scrape",
      source: "repair_active_venues",
      handles,
      jobId,
      status: "queued",
      statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      config: {
        resultsLimit,
        daysBack,
        maxHandlesPerRun: cronConfig.maxHandlesPerRun,
        fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
        skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
        skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      },
    }, { status: 202 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to enqueue repair ingestion.";
    logError("repair_scrape_failed", {
      step,
      mode: "full_scrape",
      source: "repair_active_venues",
      handles,
      error: message,
    });
    return NextResponse.json(
      {
        errorStep: step,
        error: message,
      },
      { status: 500 },
    );
  }
}
