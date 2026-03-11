import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  importUpcomingEventsToSavedPosts,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type ErrorStage =
  | "auth"
  | "import_upcoming_convex_events"
  | "enqueue_saved_posts_job";

const DEFAULT_BATCH_SIZE = 2;
const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;

export const maxDuration = 300;

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

export async function POST() {
  let errorStage: ErrorStage = "auth";

  try {
    if (hasClerkEnv()) {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    errorStage = "import_upcoming_convex_events";
    const importSummary = await importUpcomingEventsToSavedPosts();

    if (importSummary.importedPosts === 0) {
      return NextResponse.json(
        {
          error: `No upcoming Convex events were imported. Scanned ${importSummary.scannedEvents}, skipped ${importSummary.skippedPastEvents} past, ${importSummary.skippedMissingVenue} missing venue, ${importSummary.skippedMissingSource} missing source.`,
        },
        { status: 400 },
      );
    }

    errorStage = "enqueue_saved_posts_job";
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const summary = createEmptyIngestionSummary(importSummary.handles);
    const state = createInitialIngestionBatchState();
    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "upcoming_convex_events",
      mode: "saved_posts",
      handles: importSummary.handles,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "upcoming_convex_events",
      mode: "saved_posts",
      jobId,
      handles: importSummary.handles,
      batchSize: DEFAULT_BATCH_SIZE,
      importedPosts: importSummary.importedPosts,
      scannedEvents: importSummary.scannedEvents,
      handlesWithImportedPosts: importSummary.handlesWithImportedPosts,
      skippedPastEvents: importSummary.skippedPastEvents,
      skippedMissingVenue: importSummary.skippedMissingVenue,
      skippedMissingSource: importSummary.skippedMissingSource,
    });

    return NextResponse.json(
      {
        started: true,
        jobId,
        status: "queued",
        source: "upcoming_convex_events",
        mode: "saved_posts",
        handles: importSummary.handles,
        statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to import upcoming Convex events.";
    logError("scrape_failed", {
      source: "upcoming_convex_events",
      mode: "saved_posts",
      errorStage,
      error: message,
    });
    return NextResponse.json({ error: message, errorStage }, { status: 500 });
  }
}
