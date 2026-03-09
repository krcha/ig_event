import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
  importRecentApifyRunPostsToSavedPosts,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type Body = {
  runsLimit?: number;
};

const DEFAULT_RUNS_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 2;
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
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }

  const runsLimit = normalizePositiveInt(body.runsLimit) ?? DEFAULT_RUNS_LIMIT;

  try {
    const handles = await getActiveVenueHandles();
    if (handles.length === 0) {
      return NextResponse.json(
        { error: "No active venue handles are configured." },
        { status: 400 },
      );
    }

    const importSummary = await importRecentApifyRunPostsToSavedPosts({
      handles,
      runsLimit,
    });

    if (importSummary.importedPosts === 0) {
      return NextResponse.json(
        { error: "No matching posts were found in recent Apify runs for active venues." },
        { status: 400 },
      );
    }

    const normalizedHandles = importSummary.handles;
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const summary = createEmptyIngestionSummary(normalizedHandles);
    const state = createInitialIngestionBatchState();
    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "active_venues_apify_history",
      mode: "saved_posts",
      handles: normalizedHandles,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "active_venues_apify_history",
      mode: "saved_posts",
      jobId,
      handles: normalizedHandles,
      batchSize: DEFAULT_BATCH_SIZE,
      importedPosts: importSummary.importedPosts,
      runsScanned: importSummary.runsScanned,
      handlesWithImportedPosts: importSummary.handlesWithImportedPosts,
    });

    return NextResponse.json(
      {
        started: true,
        jobId,
        status: "queued",
        source: "active_venues_apify_history",
        mode: "saved_posts",
        handles: normalizedHandles,
        statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to import recent Apify runs for active venues.";
    logError("scrape_failed", {
      source: "active_venues_apify_history",
      mode: "saved_posts",
      runsLimit,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
