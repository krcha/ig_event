import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";
import {
  MAX_INGESTION_JOB_HANDLES,
  assertIngestionJobPayloadWithinBounds,
  truncateIngestionError,
} from "../lib/pipeline/ingestion-job-safety";
import {
  clampQueryPaginationOptions,
  resolveOperationLimit,
} from "./internal/requestBounds";

const MAX_INGESTION_JOB_QUERY_PAGE_SIZE = 100;
const DEFAULT_INGESTION_JOB_RETENTION_BATCH_SIZE = 100;
const MAX_INGESTION_JOB_RETENTION_BATCH_SIZE = 500;

const ingestionJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);
const ingestionJobMode = v.union(
  v.literal("full_scrape"),
  v.literal("saved_posts"),
);

export const createJob = mutation({
  args: {
    source: v.string(),
    mode: v.optional(ingestionJobMode),
    handles: v.array(v.string()),
    resultsLimit: v.optional(v.number()),
    daysBack: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    summaryJson: v.string(),
    stateJson: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const { serviceSecret: _serviceSecret, ...jobArgs } = args;
    void _serviceSecret;
    assertIngestionJobPayloadWithinBounds(jobArgs);
    const now = Date.now();
    return ctx.db.insert("ingestionJobs", {
      source: jobArgs.source,
      mode: jobArgs.mode,
      status: "queued",
      handles: jobArgs.handles,
      resultsLimit: jobArgs.resultsLimit,
      daysBack: jobArgs.daysBack,
      batchSize: jobArgs.batchSize ?? 2,
      summaryJson: jobArgs.summaryJson,
      stateJson: jobArgs.stateJson,
      stateVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getJob = query({
  args: {
    id: v.id("ingestionJobs"),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db.get(args.id);
  },
});

export const listJobsForRepairPage = query({
  args: {
    minCreatedAt: v.number(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", args.minCreatedAt))
      .order("desc")
      .paginate(
        clampQueryPaginationOptions(
          args.paginationOpts,
          MAX_INGESTION_JOB_QUERY_PAGE_SIZE,
        ),
      );
    return {
      ...result,
      page: result.page.map((job) => ({
        _id: job._id,
        source: job.source,
        mode: job.mode,
        status: job.status,
        handleCount: job.handles.length,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
      })),
    };
  },
});

const MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS = 12;

async function listBoundedRecentFullScrapeJobs(
  ctx: QueryCtx,
  minCreatedAt: number,
): Promise<Array<Doc<"ingestionJobs">>> {
  const currentJobs = await ctx.db
    .query("ingestionJobs")
    .withIndex("by_mode_createdAt", (q) =>
      q.eq("mode", "full_scrape").gte("createdAt", minCreatedAt),
    )
    .order("desc")
    .take(MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS + 1);
  if (currentJobs.length > MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS) {
    throw new Error(
      `Legacy full-scrape history exceeded the fail-closed ${MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS}-document compatibility budget.`,
    );
  }
  const remaining = MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS - currentJobs.length;
  const legacyJobs = await ctx.db
    .query("ingestionJobs")
    .withIndex("by_mode_createdAt", (q) =>
      q.eq("mode", undefined).gte("createdAt", minCreatedAt),
    )
    .order("desc")
    .take(remaining + 1);
  if (legacyJobs.length > remaining) {
    throw new Error(
      `Legacy optional-mode history exceeded the fail-closed ${MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS}-document compatibility budget.`,
    );
  }
  return [...currentJobs, ...legacyJobs]
    .sort((left, right) => right.createdAt - left.createdAt);
}

export const listRecentFullScrapeJobs = query({
  args: {
    minCreatedAt: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const jobs = await listBoundedRecentFullScrapeJobs(ctx, args.minCreatedAt);
    return jobs.map((job) => ({
      _id: job._id,
      source: job.source,
      status: job.status,
      handles: job.handles,
      summaryJson: job.summaryJson,
      stateJson: job.stateJson,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }));
  },
});

const COMPLETED_HANDLE_PROGRESS_KEYS = [
  "fetchedPosts",
  "fetched_posts",
  "insertedEvents",
  "inserted_events",
  "insertedApprovedEvents",
  "insertedPendingEvents",
  "skippedDuplicates",
  "skipped_duplicates",
  "skipped_duplicates_clean",
  "skipped_missing_date",
  "skipped_missing_venue",
  "skipped_video",
  "skipped_invalid_event",
  "skipped_past_event",
  "skipped_far_future_event",
  "updated_duplicates_bad_data",
  "duplicate_update_failed",
  "failedDownloads",
  "failed_downloads",
  "failedConversions",
  "failed_conversions",
  "failedExtractions",
  "failed_extractions",
  "failed_extraction",
] as const;

function normalizeJobHandle(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^@+/, "").toLowerCase() : "";
}

export function getFreshCompletedAttemptHandles(
  handles: string[],
  summaryJson: string,
): string[] {
  try {
    const parsed = JSON.parse(summaryJson) as {
      handles?: Array<Record<string, unknown> & { errors?: unknown; handle?: unknown }>;
    };
    if (!Array.isArray(parsed.handles)) return handles;

    const summaries = new Map(
      parsed.handles
        .map((summary) => [normalizeJobHandle(summary.handle), summary] as const)
        .filter(([handle]) => Boolean(handle)),
    );
    return handles.filter((handle) => {
      const summary = summaries.get(normalizeJobHandle(handle));
      if (!summary) return true;
      const freshFetchAttempted = summary.freshFetchAttempted;
      if (typeof freshFetchAttempted === "number" && Number.isFinite(freshFetchAttempted)) {
        return freshFetchAttempted > 0;
      }
      // Legacy summaries predate the explicit provider-attempt receipt. Retain
      // their historical progress/error projection only for backward compatibility.
      const hasProgress = COMPLETED_HANDLE_PROGRESS_KEYS.some((key) => {
        const value = summary[key];
        return typeof value === "number" && Number.isFinite(value) && value > 0;
      });
      return hasProgress || !Array.isArray(summary.errors) || summary.errors.length === 0;
    });
  } catch {
    return handles;
  }
}

/**
 * Rollback compatibility for older web images. New code reads compact source
 * receipts instead; keep this legacy function hard-bounded so a web rollback
 * cannot reintroduce unbounded Convex document reads.
 */
export const listRecentFullScrapeAttemptMetadata = query({
  args: {
    minCreatedAt: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const jobs = await listBoundedRecentFullScrapeJobs(ctx, args.minCreatedAt);
    return jobs.map((job) => ({
      _id: job._id,
      source: job.source,
      status: job.status,
      handles: job.handles,
      freshAttemptHandles:
        job.status === "completed"
          ? getFreshCompletedAttemptHandles(job.handles, job.summaryJson)
          : [],
      stateJson: job.stateJson,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }));
  },
});

export const findLatestResumableFullScrapeJob = query({
  args: {
    source: v.string(),
    minCreatedAt: v.number(),
    maxHandles: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const maxHandles = Math.max(1, Math.trunc(args.maxHandles));
    const [queued, running] = await Promise.all(
      (["queued", "running"] as const).map((status) =>
        ctx.db
          .query("ingestionJobs")
          .withIndex("by_source_status_createdAt", (q) =>
            q
              .eq("source", args.source)
              .eq("status", status)
              .gte("createdAt", args.minCreatedAt),
          )
          .order("desc")
          .first(),
      ),
    );
    return (
      [queued, running]
        .filter((candidate) =>
          Boolean(
            candidate &&
              candidate.mode !== "saved_posts" &&
              candidate.handles.length <= maxHandles,
          ),
        )
        .sort((left, right) => (right?.createdAt ?? 0) - (left?.createdAt ?? 0))[0] ?? null
    );
  },
});

export const patchJob = mutation({
  args: {
    id: v.id("ingestionJobs"),
    patch: v.object({
      status: v.optional(ingestionJobStatus),
      summaryJson: v.optional(v.string()),
      stateJson: v.optional(v.string()),
      stateVersion: v.optional(v.number()),
      leaseOwner: v.optional(v.string()),
      leaseExpiresAt: v.optional(v.number()),
      error: v.optional(v.string()),
      startedAt: v.optional(v.string()),
      finishedAt: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const job = await ctx.db.get(args.id);
    if (!job) {
      throw new Error("Ingestion job not found.");
    }
    assertIngestionJobPayloadWithinBounds({
      handles: job.handles,
      summaryJson: args.patch.summaryJson ?? job.summaryJson,
      stateJson: args.patch.stateJson ?? job.stateJson,
    });
    await ctx.db.patch(args.id, {
      ...args.patch,
      ...(args.patch.error
        ? { error: truncateIngestionError(args.patch.error) }
        : {}),
      updatedAt: Date.now(),
    });
  },
});

function normalizeLeaseDurationMs(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 5 * 60 * 1000;
  }
  return Math.max(30_000, Math.min(30 * 60 * 1000, Math.trunc(value as number)));
}

function isClaimable(job: {
  leaseExpiresAt?: number;
  status: "queued" | "running" | "completed" | "failed";
}, now: number): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    (!job.leaseExpiresAt || job.leaseExpiresAt <= now)
  );
}

export const claimStep = mutation({
  args: {
    id: v.optional(v.id("ingestionJobs")),
    leaseOwner: v.string(),
    leaseDurationMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const leaseExpiresAt = now + normalizeLeaseDurationMs(args.leaseDurationMs);
    const candidate = args.id
      ? await ctx.db.get(args.id)
      : (await ctx.db
          .query("ingestionJobs")
          .withIndex("by_status_updatedAt", (q) => q.eq("status", "queued"))
          .order("asc")
          .take(10)).find((job) => isClaimable(job, now)) ??
        (await ctx.db
          .query("ingestionJobs")
          .withIndex("by_status_updatedAt", (q) => q.eq("status", "running"))
          .order("asc")
          .take(10)).find((job) => isClaimable(job, now)) ??
        null;

    if (!candidate || !isClaimable(candidate, now)) {
      return null;
    }

    const stateVersion = (candidate.stateVersion ?? 0) + 1;
    const patch = {
      leaseExpiresAt,
      leaseOwner: args.leaseOwner,
      startedAt: candidate.startedAt ?? new Date(now).toISOString(),
      stateVersion,
      status: "running" as const,
      updatedAt: now,
    };
    await ctx.db.patch(candidate._id, patch);

    return {
      ...candidate,
      ...patch,
    };
  },
});

export const completeStep = mutation({
  args: {
    id: v.id("ingestionJobs"),
    leaseOwner: v.string(),
    stateVersion: v.number(),
    patch: v.object({
      status: v.optional(v.union(v.literal("running"), v.literal("completed"))),
      summaryJson: v.optional(v.string()),
      stateJson: v.optional(v.string()),
      finishedAt: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const job = await ctx.db.get(args.id);
    if (!job) {
      throw new Error("Ingestion job not found.");
    }
    if (job.leaseOwner !== args.leaseOwner) {
      throw new Error("Ingestion job lease owner mismatch.");
    }
    if ((job.leaseExpiresAt ?? 0) <= Date.now()) {
      throw new Error("Ingestion job lease expired.");
    }
    if ((job.stateVersion ?? 0) !== args.stateVersion) {
      throw new Error("Ingestion job state version mismatch.");
    }
    assertIngestionJobPayloadWithinBounds({
      handles: job.handles,
      summaryJson: args.patch.summaryJson ?? job.summaryJson,
      stateJson: args.patch.stateJson ?? job.stateJson,
    });

    const now = Date.now();
    const status = args.patch.status ?? job.status;
    const patch = {
      ...args.patch,
      leaseExpiresAt: undefined,
      leaseOwner: undefined,
      stateVersion: args.stateVersion + 1,
      status,
      updatedAt: now,
      ...(status === "completed" && !args.patch.finishedAt
        ? { finishedAt: new Date(now).toISOString() }
        : {}),
    };

    await ctx.db.patch(args.id, patch);
    return {
      ...job,
      ...patch,
    };
  },
});

export const failStep = mutation({
  args: {
    id: v.id("ingestionJobs"),
    leaseOwner: v.string(),
    stateVersion: v.number(),
    error: v.string(),
    summaryJson: v.optional(v.string()),
    stateJson: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const job = await ctx.db.get(args.id);
    if (!job) {
      throw new Error("Ingestion job not found.");
    }
    if (job.leaseOwner !== args.leaseOwner) {
      throw new Error("Ingestion job lease owner mismatch.");
    }
    if ((job.leaseExpiresAt ?? 0) <= Date.now()) {
      throw new Error("Ingestion job lease expired.");
    }
    if ((job.stateVersion ?? 0) !== args.stateVersion) {
      throw new Error("Ingestion job state version mismatch.");
    }
    if (job.handles.length <= MAX_INGESTION_JOB_HANDLES) {
      assertIngestionJobPayloadWithinBounds({
        handles: job.handles,
        summaryJson: args.summaryJson ?? job.summaryJson,
        stateJson: args.stateJson ?? job.stateJson,
      });
    } else if (args.summaryJson !== undefined || args.stateJson !== undefined) {
      throw new Error(
        "Oversized legacy ingestion jobs may only be terminalized without payload updates.",
      );
    }

    const now = Date.now();
    const patch = {
      error: truncateIngestionError(args.error),
      finishedAt: new Date(now).toISOString(),
      leaseExpiresAt: undefined,
      leaseOwner: undefined,
      ...(args.summaryJson ? { summaryJson: args.summaryJson } : {}),
      ...(args.stateJson ? { stateJson: args.stateJson } : {}),
      stateVersion: args.stateVersion + 1,
      status: "failed" as const,
      updatedAt: now,
    };

    await ctx.db.patch(args.id, patch);
    return {
      ...job,
      ...patch,
    };
  },
});

export const deleteTerminalOlderThan = internalMutation({
  args: {
    cutoffUpdatedAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = resolveOperationLimit(args.limit, {
      defaultValue: DEFAULT_INGESTION_JOB_RETENTION_BATCH_SIZE,
      label: "Ingestion-job retention batch size",
      maxValue: MAX_INGESTION_JOB_RETENTION_BATCH_SIZE,
    });
    const completed = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_status_updatedAt", (q) =>
        q.eq("status", "completed").lt("updatedAt", args.cutoffUpdatedAt),
      )
      .take(limit);
    const remaining = Math.max(0, limit - completed.length);
    const failed =
      remaining > 0
        ? await ctx.db
            .query("ingestionJobs")
            .withIndex("by_status_updatedAt", (q) =>
              q.eq("status", "failed").lt("updatedAt", args.cutoffUpdatedAt),
            )
            .take(remaining)
        : [];
    const jobs = [...completed, ...failed];

    for (const job of jobs) {
      await ctx.db.delete(job._id);
    }

    return {
      deletedCount: jobs.length,
      hasMore: jobs.length === limit,
    };
  },
});
