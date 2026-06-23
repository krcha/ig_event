import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
  runInstagramIngestion,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  getRecentlyAttemptedFullScrapeHandles,
} from "@/lib/pipeline/recent-full-scrape-handles";
import {
  getCronIngestionConfig,
  isAuthorizedCronRequestHeader,
  selectCronIngestionHandles,
} from "@/lib/pipeline/cron-ingestion-config";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;
const patchIngestionJobMutation =
  "ingestionJobs:patchJob" as unknown as FunctionReference<"mutation">;
const DEFAULT_BATCH_SIZE = 2;
const MS_PER_HOUR = 60 * 60 * 1000;

function isAuthorizedCronRequest(request: Request): boolean {
  return isAuthorizedCronRequestHeader(request.headers.get("authorization"));
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  let jobId: string | null = null;
  let startedAt: string | null = null;

  try {
    const cronConfig = getCronIngestionConfig();
    const activeVenueHandles = await getActiveVenueHandles();
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

    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
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
    })) as string;

    startedAt = new Date().toISOString();
    await convex.mutation(patchIngestionJobMutation, {
      id: jobId,
      patch: {
        status: "running",
        startedAt,
      },
    });

    const summary = await runInstagramIngestion({
      handles,
      mode: "full_scrape",
      resultsLimit: cronConfig.resultsLimit,
      daysBack: cronConfig.daysBack,
    });
    summary.runContext = initialSummary.runContext;

    await convex.mutation(patchIngestionJobMutation, {
      id: jobId,
      patch: {
        status: "completed",
        summaryJson: JSON.stringify(summary),
        startedAt,
        finishedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      source: "cron_active_venues",
      handles,
      summary,
      activeVenueCount: activeVenueHandles.length,
      skippedRecentlyAttempted: handleSelection.skippedRecentlyAttempted,
      skippedDueToRunLimit: handleSelection.skippedDueToRunLimit,
      costControls: cronConfig,
    });
  } catch (error) {
    if (jobId) {
      const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
      await convex.mutation(patchIngestionJobMutation, {
        id: jobId,
        patch: {
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Failed to run scheduled venue ingestion.",
          ...(startedAt ? { startedAt } : {}),
          finishedAt: new Date().toISOString(),
        },
      });
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run scheduled venue ingestion.",
      },
      { status: 500 },
    );
  }
}
