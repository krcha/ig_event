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
  type IngestionRunMode,
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
  mode?: IngestionRunMode;
};

type ActiveVenueErrorStep =
  | "auth_check"
  | "parse_body"
  | "load_active_venues"
  | "filter_recent_full_scrapes"
  | "enqueue_active_venue_job";

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

function normalizeMode(value: unknown): IngestionRunMode {
  return value === "saved_posts" ? "saved_posts" : "full_scrape";
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
  let step: ActiveVenueErrorStep = "auth_check";
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
      body = {};
    }

    const mode = normalizeMode(body.mode);
    const resultsLimit = normalizePositiveInt(body.resultsLimit);
    const daysBack = normalizePositiveInt(body.daysBack);
    const serviceSecret = requireServiceSecret();

    step = "load_active_venues";
    const activeVenueHandles = await getActiveVenueHandles({ serviceSecret });
    if (activeVenueHandles.length === 0) {
      return NextResponse.json(
        {
          errorStep: "load_active_venues",
          error: "No active venue handles are configured.",
        },
        { status: 400 },
      );
    }

    handles = activeVenueHandles;
    let skippedRecentlyAttempted = 0;
    let skippedDueToRunLimit = 0;
    const cronConfig = getCronIngestionConfig();

    if (mode === "full_scrape") {
      step = "filter_recent_full_scrapes";
      const cooldownMs = cronConfig.fullScrapeCooldownHours * MS_PER_HOUR;
      const recentFullScrapeSummary = await getRecentFullScrapeAttemptSummary({
        candidateHandles: activeVenueHandles,
        minCreatedAt: Date.now() - cooldownMs,
        serviceSecret,
      });
      const handleSelection = selectCronIngestionHandles({
        activeVenueHandles,
        recentlyAttemptedHandles: recentFullScrapeSummary.attemptedHandles,
        maxHandlesPerRun: cronConfig.maxHandlesPerRun,
      });
      handles = handleSelection.handles;
      skippedRecentlyAttempted = handleSelection.skippedRecentlyAttempted;
      skippedDueToRunLimit = handleSelection.skippedDueToRunLimit;

      if (handles.length === 0) {
        return NextResponse.json(
          {
            errorStep: "filter_recent_full_scrapes",
            error: `All active venues have already had a fresh scrape attempt in the last ${cronConfig.fullScrapeCooldownHours} hours.`,
            lastFreshScrapeAt: recentFullScrapeSummary.lastFreshScrapeAt,
            skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
          },
          { status: 400 },
        );
      }
    }

    step = "enqueue_active_venue_job";
    const convex = await createAuthenticatedConvexHttpClient();
    const summary = createEmptyIngestionSummary(handles, {
      source: "active_venues",
      mode,
      activeVenueCount: activeVenueHandles.length,
      selectedHandleCount: handles.length,
      skippedRecentlyAttempted,
      skippedDueToRunLimit,
      fullScrapeCooldownHours: cronConfig.fullScrapeCooldownHours,
      maxHandlesPerRun: cronConfig.maxHandlesPerRun,
      ...(resultsLimit ? { resultsLimit } : {}),
      ...(daysBack ? { daysBack } : {}),
    });
    const state = createInitialIngestionBatchState();

    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "active_venues",
      mode,
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "active_venues",
      mode,
      jobId,
      handles,
      resultsLimit: resultsLimit ?? null,
      daysBack: daysBack ?? null,
      batchSize: DEFAULT_BATCH_SIZE,
    });

    return NextResponse.json(
      {
        started: true,
        jobId,
        status: "queued",
        source: "active_venues",
        mode,
        handles,
        statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run venue ingestion.";
    logError("scrape_failed", {
      source: "active_venues",
      mode: "full_scrape",
      handles,
      errorStep: step,
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
