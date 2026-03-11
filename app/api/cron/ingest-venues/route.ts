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
  FULL_SCRAPE_COOLDOWN_MS,
  getRecentlyAttemptedFullScrapeHandles,
} from "@/lib/pipeline/recent-full-scrape-handles";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;
const patchIngestionJobMutation =
  "ingestionJobs:patchJob" as unknown as FunctionReference<"mutation">;
const DEFAULT_BATCH_SIZE = 2;

function isAuthorizedCronRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return true;
  }

  const authorizationHeader = request.headers.get("authorization");
  return authorizationHeader === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  let jobId: string | null = null;
  let startedAt: string | null = null;

  try {
    const activeVenueHandles = await getActiveVenueHandles();
    if (activeVenueHandles.length === 0) {
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([]),
      });
    }

    const recentlyAttemptedHandles = await getRecentlyAttemptedFullScrapeHandles({
      candidateHandles: activeVenueHandles,
      minCreatedAt: Date.now() - FULL_SCRAPE_COOLDOWN_MS,
    });
    const recentHandleSet = new Set(recentlyAttemptedHandles);
    const handles = activeVenueHandles.filter((handle) => !recentHandleSet.has(handle));

    if (handles.length === 0) {
      return NextResponse.json({
        source: "cron_active_venues",
        handles: [],
        summary: createEmptyIngestionSummary([]),
      });
    }

    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const initialSummary = createEmptyIngestionSummary(handles);
    const initialState = createInitialIngestionBatchState();
    jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "cron_active_venues",
      mode: "full_scrape",
      handles,
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
    });

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
