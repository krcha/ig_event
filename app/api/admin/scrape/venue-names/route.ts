import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
} from "@/lib/pipeline/run-instagram-ingestion";
import { listVenueNameOverrideHandles } from "@/lib/pipeline/venue-name-overrides";

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
  let handles: string[] = [];

  try {
    const adminAccess = await requireAdminApiAccess();
    if (!adminAccess.ok) {
      return adminAccess.response;
    }

    handles = await listVenueNameOverrideHandles();
    if (handles.length === 0) {
      return NextResponse.json(
        {
          error:
            "No venue-name override handles were found in data/venue-name-overrides.csv.",
        },
        { status: 400 },
      );
    }

    const convex = await createAuthenticatedConvexHttpClient();
    const summary = createEmptyIngestionSummary(handles);
    const state = createInitialIngestionBatchState();

    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "csv_venue_names",
      mode: "saved_posts",
      handles,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "csv_venue_names",
      mode: "saved_posts",
      jobId,
      handles,
      batchSize: DEFAULT_BATCH_SIZE,
    });

    return NextResponse.json(
      {
        started: true,
        jobId,
        status: "queued",
        source: "csv_venue_names",
        mode: "saved_posts",
        handles,
        statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to queue CSV venue-name reprocessing.";
    logError("scrape_failed", {
      source: "csv_venue_names",
      mode: "saved_posts",
      handles,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
