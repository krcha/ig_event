import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  getActiveVenueHandles,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
};

type RepairErrorStep = "auth_check" | "validate_request" | "enqueue_repair_job";

const DEFAULT_REPAIR_RESULTS_LIMIT = 100;
const DEFAULT_REPAIR_DAYS_BACK = 365;
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
  let step: RepairErrorStep = "auth_check";
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

    step = "validate_request";

    let body: Body = {};
    try {
      body = (await request.json()) as Body;
    } catch {
      return NextResponse.json(
        { errorStep: "validate_request", error: "Invalid JSON payload." },
        { status: 400 },
      );
    }

    const resultsLimit =
      normalizePositiveInt(body.resultsLimit) ?? DEFAULT_REPAIR_RESULTS_LIMIT;
    const daysBack = normalizePositiveInt(body.daysBack) ?? DEFAULT_REPAIR_DAYS_BACK;
    handles = await getActiveVenueHandles();

    if (handles.length === 0) {
      return NextResponse.json(
        {
          errorStep: "validate_request",
          error: "No active venue handles are configured for repair.",
        },
        { status: 400 },
      );
    }

    step = "enqueue_repair_job";

    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const summary = createEmptyIngestionSummary(handles);
    const state = createInitialIngestionBatchState();

    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "repair_active_venues",
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      mode: "repair",
      source: "repair_active_venues",
      jobId,
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
    });

    return NextResponse.json({
      started: true,
      mode: "repair",
      source: "repair_active_venues",
      handles,
      jobId,
      status: "queued",
      statusUrl: `/api/admin/scrape/jobs/${jobId}`,
      config: { resultsLimit, daysBack },
    }, { status: 202 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to enqueue repair ingestion.";
    logError("repair_scrape_failed", {
      step,
      mode: "repair",
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
