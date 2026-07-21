import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE = 500;
const DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES = 20;
const MAX_EXPIRED_EVENT_CLEANUP_MAX_BATCHES = 100;
const DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE = 100;
const DEFAULT_INGESTION_ARTIFACT_CLEANUP_MAX_BATCHES = 10;
const INGESTION_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRAPED_POST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ORPHANED_MEDIA_ASSET_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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

type DeleteByUpdatedAtResult = {
  deletedCount: number;
  hasMore: boolean;
};

type DeleteByUpdatedAtMutation = FunctionReference<
  "mutation",
  "internal",
  { cutoffUpdatedAt: number; limit?: number },
  DeleteByUpdatedAtResult
>;

type CleanupIngestionArtifactsUntilDoneResult = {
  batchSize: number;
  maxBatches: number;
  batchesRun: number;
  deletedIngestionJobCount: number;
  deletedScrapedPostCount: number;
  hasMore: boolean;
  ingestionJobsHaveMore: boolean;
  scrapedPostsHaveMore: boolean;
  jobCutoffUpdatedAt: number;
  scrapedPostCutoffUpdatedAt: number;
};

const deleteOldScrapedPostsMutation: DeleteByUpdatedAtMutation = (internal as unknown as {
  scrapedPosts: {
    deleteOlderThan: DeleteByUpdatedAtMutation;
  };
}).scrapedPosts.deleteOlderThan;

const deleteOldIngestionJobsMutation: DeleteByUpdatedAtMutation = (internal as unknown as {
  ingestionJobs: {
    deleteTerminalOlderThan: DeleteByUpdatedAtMutation;
  };
}).ingestionJobs.deleteTerminalOlderThan;

type DeleteOrphanedMediaAssetsPageResult = {
  continueCursor: string;
  deletedAssetCount: number;
  deletedStorageObjectCount: number;
  isDone: boolean;
  scannedAssetCount: number;
};

const deleteOrphanedMediaAssetsPageMutation = (internal as unknown as {
  mediaAssets: {
    deleteOrphanedPage: FunctionReference<
      "mutation",
      "internal",
      {
        cutoffUpdatedAt: number;
        paginationOpts: { cursor: string | null; numItems: number };
      },
      DeleteOrphanedMediaAssetsPageResult
    >;
  };
}).mediaAssets.deleteOrphanedPage;

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

export const cleanupIngestionArtifactsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CleanupIngestionArtifactsUntilDoneResult> => {
    const batchSize = normalizeBatchSize(args.batchSize ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE);
    const maxBatches = normalizeMaxBatches(
      args.maxBatches ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_MAX_BATCHES,
    );
    const now = Date.now();
    const jobCutoffUpdatedAt = now - INGESTION_JOB_RETENTION_MS;
    const scrapedPostCutoffUpdatedAt = now - SCRAPED_POST_RETENTION_MS;
    let deletedIngestionJobCount = 0;
    let deletedScrapedPostCount = 0;
    let ingestionJobsHaveMore = false;
    let scrapedPostsHaveMore = false;
    let batchesRun = 0;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const [jobResult, scrapedPostResult] = await Promise.all([
        ctx.runMutation(deleteOldIngestionJobsMutation, {
          cutoffUpdatedAt: jobCutoffUpdatedAt,
          limit: batchSize,
        }),
        ctx.runMutation(deleteOldScrapedPostsMutation, {
          cutoffUpdatedAt: scrapedPostCutoffUpdatedAt,
          limit: batchSize,
        }),
      ]);

      batchesRun += 1;
      deletedIngestionJobCount += jobResult.deletedCount;
      deletedScrapedPostCount += scrapedPostResult.deletedCount;
      ingestionJobsHaveMore = jobResult.hasMore;
      scrapedPostsHaveMore = scrapedPostResult.hasMore;

      if (!ingestionJobsHaveMore && !scrapedPostsHaveMore) {
        break;
      }
    }

    return {
      batchSize,
      maxBatches,
      batchesRun,
      deletedIngestionJobCount,
      deletedScrapedPostCount,
      hasMore: ingestionJobsHaveMore || scrapedPostsHaveMore,
      ingestionJobsHaveMore,
      scrapedPostsHaveMore,
      jobCutoffUpdatedAt,
      scrapedPostCutoffUpdatedAt,
    };
  },
});

export const cleanupOrphanedMediaAssetsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = normalizeBatchSize(
      args.batchSize ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE,
    );
    const maxBatches = normalizeMaxBatches(
      args.maxBatches ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_MAX_BATCHES,
    );
    const cutoffUpdatedAt = Date.now() - ORPHANED_MEDIA_ASSET_GRACE_MS;
    let cursor: string | null = null;
    let batchesRun = 0;
    let scannedAssetCount = 0;
    let deletedAssetCount = 0;
    let deletedStorageObjectCount = 0;
    let isDone = false;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const result: DeleteOrphanedMediaAssetsPageResult = await ctx.runMutation(
        deleteOrphanedMediaAssetsPageMutation,
        {
          cutoffUpdatedAt,
          paginationOpts: { cursor, numItems: batchSize },
        },
      );
      batchesRun += 1;
      scannedAssetCount += result.scannedAssetCount;
      deletedAssetCount += result.deletedAssetCount;
      deletedStorageObjectCount += result.deletedStorageObjectCount;
      cursor = result.continueCursor;
      isDone = result.isDone;
      if (result.isDone) break;
    }

    return {
      batchSize,
      maxBatches,
      batchesRun,
      scannedAssetCount,
      deletedAssetCount,
      deletedStorageObjectCount,
      cutoffUpdatedAt,
      hasMore: !isDone,
    };
  },
});
