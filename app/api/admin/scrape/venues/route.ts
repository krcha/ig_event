import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
  type IngestionRunMode,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
};

type ActiveVenueErrorStep =
  | "auth_check"
  | "parse_body"
  | "load_active_venues"
  | "enqueue_active_venue_job";

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
    if (hasClerkEnv()) {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.json(
          { errorStep: "auth_check", error: "Unauthorized" },
          { status: 401 },
        );
      }
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

    step = "load_active_venues";
    handles = await getActiveVenueHandles();
    if (handles.length === 0) {
      return NextResponse.json(
        {
          errorStep: "load_active_venues",
          error: "No active venue handles are configured.",
        },
        { status: 400 },
      );
    }

    step = "enqueue_active_venue_job";
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const summary = createEmptyIngestionSummary(handles);
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
