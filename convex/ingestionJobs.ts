import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";

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

export const listRecentFullScrapeJobs = query({
  args: {
    minCreatedAt: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const jobs = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", args.minCreatedAt))
      .collect();

    return jobs
      .filter((job) => job.mode !== "saved_posts")
      .map((job) => ({
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
    await ctx.db.patch(args.id, {
      ...args.patch,
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
    if ((job.stateVersion ?? 0) !== args.stateVersion) {
      throw new Error("Ingestion job state version mismatch.");
    }

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
    if ((job.stateVersion ?? 0) !== args.stateVersion) {
      throw new Error("Ingestion job state version mismatch.");
    }

    const now = Date.now();
    const patch = {
      error: args.error,
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
    const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 100)));
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
