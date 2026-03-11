import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  importRecentApifyRunPostsToSavedPosts,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type Body = {
  handles?: string[];
  runsLimit?: number;
};

const DEFAULT_RUNS_LIMIT = 300;
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
  let errorStage:
    | "auth"
    | "parse_body"
    | "import_recent_runs"
    | "enqueue_saved_posts_job" = "auth";
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: Body;
  try {
    errorStage = "parse_body";
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const handles = (body.handles ?? [])
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);

  if (handles.length === 0) {
    return NextResponse.json(
      { error: "At least one Instagram handle is required." },
      { status: 400 },
    );
  }

  const runsLimit = normalizePositiveInt(body.runsLimit) ?? DEFAULT_RUNS_LIMIT;

  try {
    errorStage = "import_recent_runs";
    const importSummary = await importRecentApifyRunPostsToSavedPosts({
      handles,
      runsLimit,
    });

    if (importSummary.importedPosts === 0) {
      return NextResponse.json(
        { error: "No matching posts were found in recent Apify runs." },
        { status: 400 },
      );
    }

    const normalizedHandles = importSummary.handles;
    errorStage = "enqueue_saved_posts_job";
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const summary = createEmptyIngestionSummary(normalizedHandles);
    const state = createInitialIngestionBatchState();
    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "manual_apify_history",
      mode: "saved_posts",
      handles: normalizedHandles,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "manual_apify_history",
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
        source: "manual_apify_history",
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
        : "Failed to import recent Apify runs into saved posts.";
    logError("scrape_failed", {
      source: "manual_apify_history",
      mode: "saved_posts",
      handles,
      runsLimit,
      errorStage,
      error: message,
    });
    return NextResponse.json({ error: message, errorStage }, { status: 500 });
  }
}
