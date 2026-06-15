import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE = 500;
const DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES = 20;
const MAX_EXPIRED_EVENT_CLEANUP_MAX_BATCHES = 100;

type DeleteExpiredEventsResult = {
  deletedEventCount: number;
  deletedSavedEventCount: number;
  cutoffDate: string;
  cutoffTime: string;
  timeZone: string;
  hasMore: boolean;
  skippedSameDayEventCount: number;
  sameDayExpiredEventCount: number;
};

type DeleteExpiredEventsUntilDoneResult = {
  batchSize: number;
  maxBatches: number;
  batchesRun: number;
  deletedEventCount: number;
  deletedSavedEventCount: number;
  hasMore: boolean;
  stoppedReason: "complete" | "max_batches_reached";
  cutoffDate: string | null;
  cutoffTime: string | null;
  timeZone: string | null;
  skippedSameDayEventCount: number;
  sameDayExpiredEventCount: number;
};

const deleteExpiredEventsMutation = (internal as unknown as {
  events: {
    deleteExpiredEvents: FunctionReference<
      "mutation",
      "internal",
      { batchSize?: number },
      DeleteExpiredEventsResult
    >;
  };
}).events.deleteExpiredEvents;

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE;
  }

  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function normalizeMaxBatches(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES;
  }

  return Math.max(1, Math.min(MAX_EXPIRED_EVENT_CLEANUP_MAX_BATCHES, Math.trunc(value)));
}

export const deleteExpiredEventsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DeleteExpiredEventsUntilDoneResult> => {
    const batchSize = normalizeBatchSize(args.batchSize);
    const maxBatches = normalizeMaxBatches(args.maxBatches);

    let batchesRun = 0;
    let deletedEventCount = 0;
    let deletedSavedEventCount = 0;
    let hasMore = false;
    let cutoffDate: string | null = null;
    let cutoffTime: string | null = null;
    let timeZone: string | null = null;
    let skippedSameDayEventCount = 0;
    let sameDayExpiredEventCount = 0;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const result: DeleteExpiredEventsResult = await ctx.runMutation(deleteExpiredEventsMutation, { batchSize });

      batchesRun += 1;
      deletedEventCount += result.deletedEventCount;
      deletedSavedEventCount += result.deletedSavedEventCount;
      hasMore = result.hasMore;
      cutoffDate = result.cutoffDate;
      cutoffTime = result.cutoffTime;
      timeZone = result.timeZone;
      skippedSameDayEventCount += result.skippedSameDayEventCount;
      sameDayExpiredEventCount += result.sameDayExpiredEventCount;

      if (!result.hasMore) {
        break;
      }
    }

    return {
      batchSize,
      maxBatches,
      batchesRun,
      deletedEventCount,
      deletedSavedEventCount,
      hasMore,
      stoppedReason: hasMore ? "max_batches_reached" : "complete",
      cutoffDate,
      cutoffTime,
      timeZone,
      skippedSameDayEventCount,
      sameDayExpiredEventCount,
    };
  },
});
