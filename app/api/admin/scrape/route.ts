import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  type IngestionRunMode,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type ScrapeRequestBody = {
  handles?: string[];
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
};

const createIngestionJobMutation =
  "ingestionJobs:createJob" as unknown as FunctionReference<"mutation">;
const DEFAULT_BATCH_SIZE = 2;

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
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: ScrapeRequestBody;
  try {
    body = (await request.json()) as ScrapeRequestBody;
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

  const step = "enqueue_job";
  try {
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const resultsLimit = normalizePositiveInt(body.resultsLimit);
    const daysBack = normalizePositiveInt(body.daysBack);
    const mode = normalizeMode(body.mode);
    const summary = createEmptyIngestionSummary(handles);
    const state = createInitialIngestionBatchState();

    const jobId = (await convex.mutation(createIngestionJobMutation, {
      source: "manual",
      mode,
      handles,
      resultsLimit,
      daysBack,
      batchSize: DEFAULT_BATCH_SIZE,
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
    })) as string;

    logInfo("scrape_started", {
      source: "manual",
      mode,
      jobId,
      handles,
      resultsLimit: resultsLimit ?? null,
      daysBack: daysBack ?? null,
      batchSize: DEFAULT_BATCH_SIZE,
    });

    return NextResponse.json({
      started: true,
      jobId,
      status: "queued",
      source: "manual",
      mode,
      handles,
      statusUrl: `/api/admin/scrape/jobs/${jobId}`,
    }, { status: 202 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run ingestion pipeline.";
    logError("scrape_failed", {
      step,
      source: "manual",
      mode: body.mode ?? "full_scrape",
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
