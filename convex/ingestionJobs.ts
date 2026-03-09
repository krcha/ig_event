import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ingestionJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

export const createJob = mutation({
  args: {
    source: v.string(),
    handles: v.array(v.string()),
    resultsLimit: v.optional(v.number()),
    daysBack: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    summaryJson: v.string(),
    stateJson: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("ingestionJobs", {
      source: args.source,
      status: "queued",
      handles: args.handles,
      resultsLimit: args.resultsLimit,
      daysBack: args.daysBack,
      batchSize: args.batchSize ?? 2,
      summaryJson: args.summaryJson,
      stateJson: args.stateJson,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getJob = query({
  args: { id: v.id("ingestionJobs") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

export const patchJob = mutation({
  args: {
    id: v.id("ingestionJobs"),
    patch: v.object({
      status: v.optional(ingestionJobStatus),
      summaryJson: v.optional(v.string()),
      stateJson: v.optional(v.string()),
      error: v.optional(v.string()),
      startedAt: v.optional(v.string()),
      finishedAt: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      ...args.patch,
      updatedAt: Date.now(),
    });
  },
});
