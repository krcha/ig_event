import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import {
  createAuthenticatedConvexHttpClient,
  requireServiceSecret,
} from "@/lib/convex/server";
import type {
  IngestionBatchState,
  IngestionRunMode,
  IngestionSummary,
} from "@/lib/pipeline/run-instagram-ingestion";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  runInstagramIngestionBatchStep,
} from "@/lib/pipeline/run-instagram-ingestion";
import { buildOperationsTriageSummary } from "@/lib/pipeline/ingestion-run-triage";
import {
  serializeSafeIngestionJobPayload,
  truncateIngestionError,
} from "@/lib/pipeline/ingestion-job-safety";

type IngestionJobStatus = "queued" | "running" | "completed" | "failed";

type IngestionJobRecord = {
  _id: string;
  source: string;
  mode?: IngestionRunMode;
  status: IngestionJobStatus;
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  batchSize: number;
  summaryJson: string;
  stateJson: string;
  stateVersion?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

const getJobQuery =
  "ingestionJobs:getJob" as unknown as FunctionReference<"query">;
const claimStepMutation =
  "ingestionJobs:claimStep" as unknown as FunctionReference<"mutation">;
const completeStepMutation =
  "ingestionJobs:completeStep" as unknown as FunctionReference<"mutation">;
const failStepMutation =
  "ingestionJobs:failStep" as unknown as FunctionReference<"mutation">;

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
      currentHandlePosts: [],
      currentScrapedPostCursor:
        typeof parsed.currentScrapedPostCursor === "string"
          ? parsed.currentScrapedPostCursor
          : null,
      currentScrapedPostIds: Array.isArray(parsed.currentScrapedPostIds)
        ? parsed.currentScrapedPostIds.filter((id): id is string => typeof id === "string")
        : [],
      currentScrapedPostIdIndex:
        typeof parsed.currentScrapedPostIdIndex === "number" &&
        Number.isFinite(parsed.currentScrapedPostIdIndex)
          ? Math.max(0, Math.trunc(parsed.currentScrapedPostIdIndex))
          : 0,
      currentScrapedPostPageDone: parsed.currentScrapedPostPageDone === true,
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

async function loadJob(
  convex: Awaited<ReturnType<typeof createAuthenticatedConvexHttpClient>>,
  jobId: string,
): Promise<IngestionJobRecord | null> {
  const job = (await convex.query(getJobQuery, {
    id: jobId,
  })) as IngestionJobRecord | null;
  return job;
}

function buildJobResponse(job: IngestionJobRecord) {
  const summary = parseSummary(job.summaryJson, job.handles);
  const status = job.status;
  return {
    jobId: job._id,
    source: job.source,
    mode: job.mode ?? "full_scrape",
    status,
    handles: job.handles,
    summary,
    triage: buildOperationsTriageSummary({
      summary,
      status,
      handles: job.handles,
    }),
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const adminAccess = await requireAdminApiAccess();
    if (!adminAccess.ok) {
      return adminAccess.response;
    }
    const { jobId } = await context.params;
    const convex = await createAuthenticatedConvexHttpClient();
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
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const adminAccess = await requireAdminApiAccess();
    if (!adminAccess.ok) {
      return adminAccess.response;
    }
    const { jobId } = await context.params;
    const convex = await createAuthenticatedConvexHttpClient();
    const job = await loadJob(convex, jobId);

    if (!job) {
      return NextResponse.json({ error: "Ingestion job not found." }, { status: 404 });
    }

    if (job.status === "completed" || job.status === "failed") {
      return NextResponse.json(buildJobResponse(job));
    }

    const leaseOwner = `admin:${adminAccess.userId ?? "unknown"}:${Date.now()}`;
    const claimedJob = (await convex.mutation(claimStepMutation, {
      id: jobId,
      leaseOwner,
    })) as IngestionJobRecord | null;

    if (!claimedJob) {
      const currentJob = await loadJob(convex, jobId);
      return NextResponse.json(
        {
          error: "Ingestion job is already leased or not runnable.",
          ...(currentJob ? buildJobResponse(currentJob) : {}),
        },
        { status: 409 },
      );
    }

    const summary = parseSummary(claimedJob.summaryJson, claimedJob.handles);
    const state = parseState(claimedJob.stateJson);
    const startedAt = claimedJob.startedAt ?? new Date().toISOString();
    const stateVersion = claimedJob.stateVersion ?? 0;
    const serviceSecret = requireServiceSecret();

    logInfo("batch_started", {
      jobId,
      source: claimedJob.source,
      mode: claimedJob.mode ?? "full_scrape",
      status: claimedJob.status,
      handleIndex: state.handleIndex,
      currentHandle: state.currentHandle,
      currentPostIndex: state.currentPostIndex,
    });

    try {
      const batchResult = await runInstagramIngestionBatchStep({
        handles: claimedJob.handles,
        summary,
        state,
        resultsLimit: claimedJob.resultsLimit,
        daysBack: claimedJob.daysBack,
        batchSize: claimedJob.batchSize,
        mode: claimedJob.mode ?? "full_scrape",
        serviceSecret,
      });

      const persistedPayload = serializeSafeIngestionJobPayload({
        handles: claimedJob.handles,
        summary: batchResult.summary,
        state: batchResult.state,
      });
      const finishedAt = batchResult.done ? new Date().toISOString() : undefined;
      await convex.mutation(completeStepMutation, {
        id: jobId,
        leaseOwner,
        stateVersion,
        patch: {
          status: batchResult.done ? "completed" : "running",
          summaryJson: persistedPayload.summaryJson,
          stateJson: persistedPayload.stateJson,
          ...(finishedAt ? { finishedAt } : {}),
          startedAt,
        },
      });

      logInfo("batch_completed", {
        jobId,
        source: claimedJob.source,
        mode: claimedJob.mode ?? "full_scrape",
        done: batchResult.done,
        handleIndex: batchResult.state.handleIndex,
        currentHandle: batchResult.state.currentHandle,
        currentPostIndex: batchResult.state.currentPostIndex,
      });

      if (batchResult.done) {
        logInfo("scrape_completed", {
          jobId,
          source: claimedJob.source,
          mode: claimedJob.mode ?? "full_scrape",
          startedAt,
          finishedAt,
          handles: claimedJob.handles,
        });
      }

      return NextResponse.json({
        jobId,
        source: claimedJob.source,
        status: batchResult.done ? "completed" : "running",
        handles: claimedJob.handles,
        summary: persistedPayload.summary,
        triage: buildOperationsTriageSummary({
          summary: persistedPayload.summary,
          status: batchResult.done ? "completed" : "running",
          handles: claimedJob.handles,
        }),
        error: null,
        startedAt,
        finishedAt: finishedAt ?? null,
      });
    } catch (error) {
      const message = truncateIngestionError(error);
      const failedPayload = serializeSafeIngestionJobPayload({
        handles: claimedJob.handles,
        summary,
        state,
      });
      await convex.mutation(failStepMutation, {
        id: jobId,
        leaseOwner,
        stateVersion,
        error: message,
        summaryJson: failedPayload.summaryJson,
        stateJson: failedPayload.stateJson,
      });
      logError("scrape_failed", {
        jobId,
        source: claimedJob.source,
        error: message,
      });
      return NextResponse.json(
        {
          jobId,
          source: claimedJob.source,
          status: "failed",
          handles: claimedJob.handles,
          summary,
          triage: buildOperationsTriageSummary({
            summary,
            status: "failed",
            handles: claimedJob.handles,
          }),
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
