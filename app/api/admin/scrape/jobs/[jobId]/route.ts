import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import type {
  IngestionBatchState,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  runInstagramIngestionBatchStep,
} from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type IngestionJobStatus = "queued" | "running" | "completed" | "failed";

type IngestionJobRecord = {
  _id: string;
  source: string;
  status: IngestionJobStatus;
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  batchSize: number;
  summaryJson: string;
  stateJson: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

const getJobQuery =
  "ingestionJobs:getJob" as unknown as FunctionReference<"query">;
const patchJobMutation =
  "ingestionJobs:patchJob" as unknown as FunctionReference<"mutation">;

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

function getConvexClient(): ConvexHttpClient {
  return new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
}

function parseSummary(summaryJson: string, handles: string[]): IngestionSummary {
  try {
    const parsed = JSON.parse(summaryJson) as IngestionSummary;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.finishedAt === "string" &&
      Array.isArray(parsed.handles)
    ) {
      return parsed;
    }
  } catch {
    // no-op fallback below
  }
  return createEmptyIngestionSummary(handles);
}

function parseState(stateJson: string): IngestionBatchState {
  const fallback = createInitialIngestionBatchState();
  try {
    const parsed = JSON.parse(stateJson) as Partial<IngestionBatchState>;
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    return {
      handleIndex:
        typeof parsed.handleIndex === "number" && Number.isFinite(parsed.handleIndex)
          ? Math.max(0, Math.trunc(parsed.handleIndex))
          : 0,
      currentHandle: typeof parsed.currentHandle === "string" ? parsed.currentHandle : null,
      currentPostIndex:
        typeof parsed.currentPostIndex === "number" &&
        Number.isFinite(parsed.currentPostIndex)
          ? Math.max(0, Math.trunc(parsed.currentPostIndex))
          : 0,
      currentHandlePosts: Array.isArray(parsed.currentHandlePosts)
        ? parsed.currentHandlePosts
        : [],
      seenSourceKeysByHandle:
        parsed.seenSourceKeysByHandle &&
        typeof parsed.seenSourceKeysByHandle === "object" &&
        !Array.isArray(parsed.seenSourceKeysByHandle)
          ? (parsed.seenSourceKeysByHandle as Record<string, string[]>)
          : {},
    };
  } catch {
    return fallback;
  }
}

async function loadJob(convex: ConvexHttpClient, jobId: string): Promise<IngestionJobRecord | null> {
  const job = (await convex.query(getJobQuery, {
    id: jobId,
  })) as IngestionJobRecord | null;
  return job;
}

function buildJobResponse(job: IngestionJobRecord) {
  const summary = parseSummary(job.summaryJson, job.handles);
  return {
    jobId: job._id,
    source: job.source,
    status: job.status,
    handles: job.handles,
    summary,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function getUnauthorizedResponse(): Promise<NextResponse | null> {
  if (!hasClerkEnv()) {
    return null;
  }
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(
  _request: Request,
  context: { params: { jobId: string } },
) {
  try {
    const unauthorizedResponse = await getUnauthorizedResponse();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }
    const { jobId } = context.params;
    const convex = getConvexClient();
    const job = await loadJob(convex, jobId);

    if (!job) {
      return NextResponse.json({ error: "Ingestion job not found." }, { status: 404 });
    }

    return NextResponse.json(buildJobResponse(job));
  } catch (error) {
    return NextResponse.json(
      {
        errorStep: "job_status",
        error:
          error instanceof Error
            ? error.message
            : "Failed to load ingestion job.",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  _request: Request,
  context: { params: { jobId: string } },
) {
  try {
    const unauthorizedResponse = await getUnauthorizedResponse();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }
    const { jobId } = context.params;
    const convex = getConvexClient();
    const job = await loadJob(convex, jobId);

    if (!job) {
      return NextResponse.json({ error: "Ingestion job not found." }, { status: 404 });
    }

    if (job.status === "completed" || job.status === "failed") {
      return NextResponse.json(buildJobResponse(job));
    }

    const summary = parseSummary(job.summaryJson, job.handles);
    const state = parseState(job.stateJson);
    const startedAt = job.startedAt ?? new Date().toISOString();

    await convex.mutation(patchJobMutation, {
      id: jobId,
      patch: {
        status: "running",
        startedAt,
      },
    });

    logInfo("batch_started", {
      jobId,
      source: job.source,
      status: job.status,
      handleIndex: state.handleIndex,
      currentHandle: state.currentHandle,
      currentPostIndex: state.currentPostIndex,
    });

    try {
      const batchResult = await runInstagramIngestionBatchStep({
        handles: job.handles,
        summary,
        state,
        resultsLimit: job.resultsLimit,
        daysBack: job.daysBack,
        batchSize: job.batchSize,
      });

      const finishedAt = batchResult.done ? new Date().toISOString() : undefined;
      await convex.mutation(patchJobMutation, {
        id: jobId,
        patch: {
          status: batchResult.done ? "completed" : "running",
          summaryJson: JSON.stringify(batchResult.summary),
          stateJson: JSON.stringify(batchResult.state),
          ...(finishedAt ? { finishedAt } : {}),
          startedAt,
        },
      });

      logInfo("batch_completed", {
        jobId,
        source: job.source,
        done: batchResult.done,
        handleIndex: batchResult.state.handleIndex,
        currentHandle: batchResult.state.currentHandle,
        currentPostIndex: batchResult.state.currentPostIndex,
      });

      if (batchResult.done) {
        logInfo("scrape_completed", {
          jobId,
          source: job.source,
          startedAt,
          finishedAt,
          handles: job.handles,
        });
      }

      return NextResponse.json({
        jobId,
        source: job.source,
        status: batchResult.done ? "completed" : "running",
        handles: job.handles,
        summary: batchResult.summary,
        error: null,
        startedAt,
        finishedAt: finishedAt ?? null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to run ingestion batch.";
      await convex.mutation(patchJobMutation, {
        id: jobId,
        patch: {
          status: "failed",
          summaryJson: JSON.stringify(summary),
          stateJson: JSON.stringify(state),
          error: message,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      });
      logError("scrape_failed", {
        jobId,
        source: job.source,
        error: message,
      });
      return NextResponse.json(
        {
          jobId,
          source: job.source,
          status: "failed",
          handles: job.handles,
          summary,
          errorStep: "batch_process",
          error: message,
          startedAt,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        errorStep: "job_request",
        error:
          error instanceof Error
            ? error.message
            : "Failed to process ingestion job.",
      },
      { status: 500 },
    );
  }
}
