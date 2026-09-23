import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE = 1;
const DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES = 5;
const MAX_CLEANUP_BATCHES = 5;
const DEFAULT_RETENTION_AUDIT_MAX_BATCHES = 20;
const MAX_RETENTION_AUDIT_BATCHES = 50;
const DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE = 25;
const DEFAULT_INGESTION_ARTIFACT_CLEANUP_MAX_BATCHES = 2;
const DEFAULT_MEDIA_CLEANUP_BATCH_SIZE = 5;
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
  retainedCampaignEventCount: number;
  beforeDateCursor: string | null;
  beforeDateScanComplete: boolean;
  sameDayCursor: string | null;
  sameDayScanComplete: boolean;
};

type DeleteExpiredEventsUntilDoneResult = {
  batchSize: number;
  maxBatches: number;
  batchesRun: number;
  deletedEventCount: number;
  deletedSavedEventCount: number;
  hasMore: boolean;
  stoppedReason: "complete" | "max_batches_reached" | "audit_pending" | "audit_blocked";
  auditBatchesRun: number;
  auditReady: boolean;
  auditScannedCount: number;
  auditMismatchCount: number;
  cutoffDate: string | null;
  cutoffTime: string | null;
  timeZone: string | null;
  skippedSameDayEventCount: number;
  sameDayExpiredEventCount: number;
  retainedCampaignEventCount: number;
};

type RetentionReceiptAuditResult = {
  ready: boolean;
  isDone: boolean;
  scannedCount: number;
  mismatchCount: number;
};

const auditRetentionReceiptCoverageMutation = (internal as unknown as {
  internal: {
    retentionReceiptCoverage: {
      auditRetentionReceiptCoverageBatch: FunctionReference<
        "mutation", "internal", { limit?: number }, RetentionReceiptAuditResult
      >;
    };
  };
}).internal.retentionReceiptCoverage.auditRetentionReceiptCoverageBatch;

const deleteExpiredEventsMutation = (internal as unknown as {
  events: {
    deleteExpiredEvents: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        beforeDate?: string;
        beforeDateCursor?: string | null;
        beforeDateScanComplete?: boolean;
        sameDayCursor?: string | null;
        sameDayScanComplete?: boolean;
      },
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

type DeleteScrapedPostsResult = DeleteByUpdatedAtResult & {
  continueCursor: string;
  cutoffUpdatedAt: number;
  retainedReferencedCount: number;
  scannedCount: number;
};

type DeleteScrapedPostsMutation = FunctionReference<
  "mutation",
  "internal",
  { cutoffUpdatedAt: number; cursor?: string | null; limit?: number },
  DeleteScrapedPostsResult
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
  stoppedReason: "complete" | "max_batches_reached";
};

const deleteOldScrapedPostsMutation: DeleteScrapedPostsMutation = (internal as unknown as {
  scrapedPosts: {
    deleteOlderThan: DeleteScrapedPostsMutation;
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
  cutoffUpdatedAt: number;
  detachedScrapedPostCount: number;
  retainedAssetCount: number;
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

function normalizeBatchSize(
  value: number | undefined,
  maximum = DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.min(maximum, DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE);
  }

  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function normalizeMaxBatches(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES;
  }

  return Math.max(1, Math.min(MAX_CLEANUP_BATCHES, Math.trunc(value)));
}

export const deleteExpiredEventsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    beforeDate: v.optional(v.string()),
    maxBatches: v.optional(v.number()),
    auditMaxBatches: v.optional(v.number()),
  },
  returns: v.object({
    batchSize: v.number(),
    maxBatches: v.number(),
    batchesRun: v.number(),
    deletedEventCount: v.number(),
    deletedSavedEventCount: v.number(),
    hasMore: v.boolean(),
    stoppedReason: v.union(v.literal("complete"), v.literal("max_batches_reached"), v.literal("audit_pending"), v.literal("audit_blocked")),
    auditBatchesRun: v.number(),
    auditReady: v.boolean(),
    auditScannedCount: v.number(),
    auditMismatchCount: v.number(),
    cutoffDate: v.union(v.string(), v.null()),
    cutoffTime: v.union(v.string(), v.null()),
    timeZone: v.union(v.string(), v.null()),
    skippedSameDayEventCount: v.number(),
    sameDayExpiredEventCount: v.number(),
    retainedCampaignEventCount: v.number(),
  }),
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
    let retainedCampaignEventCount = 0;
    const auditMaxBatches = Number.isFinite(args.auditMaxBatches)
      ? Math.max(1, Math.min(MAX_RETENTION_AUDIT_BATCHES, Math.trunc(args.auditMaxBatches!)))
      : DEFAULT_RETENTION_AUDIT_MAX_BATCHES;
    let auditBatchesRun = 0;
    let audit: RetentionReceiptAuditResult = { ready: false, isDone: false, scannedCount: 0, mismatchCount: 0 };
    // This separate reverse-reference audit does not certify source semantics.
    // A changed source epoch restarts its durable scan, rather than trusting an
    // obsolete completeness claim. No event writes occur while it is pending.
    while (auditBatchesRun < auditMaxBatches) {
      audit = await ctx.runMutation(auditRetentionReceiptCoverageMutation, {});
      auditBatchesRun += 1;
      if (audit.ready || audit.isDone) break;
    }
    if (!audit.ready) {
      const summary: DeleteExpiredEventsUntilDoneResult = {
        batchSize, maxBatches, batchesRun, deletedEventCount, deletedSavedEventCount,
        hasMore: true, stoppedReason: audit.isDone ? "audit_blocked" : "audit_pending",
        auditBatchesRun, auditReady: false, auditScannedCount: audit.scannedCount,
        auditMismatchCount: audit.mismatchCount, cutoffDate, cutoffTime, timeZone,
        skippedSameDayEventCount, sameDayExpiredEventCount, retainedCampaignEventCount,
      };
      console.info("retention_cleanup", { kind: "events", ...summary });
      return summary;
    }
    // No initial cursor override: a scheduled tick must resume persisted state.
    // Explicit beforeDate scans still carry their action-local continuation.
    let continuation: {
      beforeDateCursor: string | null;
      beforeDateScanComplete: boolean;
      sameDayCursor: string | null;
      sameDayScanComplete: boolean;
    } | undefined;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const result: DeleteExpiredEventsResult = await ctx.runMutation(deleteExpiredEventsMutation, {
        batchSize,
        beforeDate: args.beforeDate,
        ...continuation,
      });

      batchesRun += 1;
      deletedEventCount += result.deletedEventCount;
      deletedSavedEventCount += result.deletedSavedEventCount;
      hasMore = result.hasMore;
      cutoffDate = result.cutoffDate;
      cutoffTime = result.cutoffTime;
      timeZone = result.timeZone;
      skippedSameDayEventCount += result.skippedSameDayEventCount;
      sameDayExpiredEventCount += result.sameDayExpiredEventCount;
      retainedCampaignEventCount += result.retainedCampaignEventCount;
      continuation = {
        beforeDateCursor: result.beforeDateCursor,
        beforeDateScanComplete: result.beforeDateScanComplete,
        sameDayCursor: result.sameDayCursor,
        sameDayScanComplete: result.sameDayScanComplete,
      };

      if (!result.hasMore) {
        break;
      }
    }

    const summary: DeleteExpiredEventsUntilDoneResult = {
      batchSize,
      maxBatches,
      batchesRun,
      deletedEventCount,
      deletedSavedEventCount,
      hasMore,
      stoppedReason: hasMore ? "max_batches_reached" : "complete",
      auditBatchesRun,
      auditReady: true,
      auditScannedCount: audit.scannedCount,
      auditMismatchCount: audit.mismatchCount,
      cutoffDate,
      cutoffTime,
      timeZone,
      skippedSameDayEventCount,
      sameDayExpiredEventCount,
      retainedCampaignEventCount,
    };
    console.info("retention_cleanup", { kind: "events", ...summary });
    return summary;
  },
});

export const cleanupIngestionArtifactsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.object({
    batchSize: v.number(),
    maxBatches: v.number(),
    batchesRun: v.number(),
    deletedIngestionJobCount: v.number(),
    deletedScrapedPostCount: v.number(),
    hasMore: v.boolean(),
    ingestionJobsHaveMore: v.boolean(),
    scrapedPostsHaveMore: v.boolean(),
    jobCutoffUpdatedAt: v.number(),
    scrapedPostCutoffUpdatedAt: v.number(),
    stoppedReason: v.union(v.literal("complete"), v.literal("max_batches_reached")),
  }),
  handler: async (ctx, args): Promise<CleanupIngestionArtifactsUntilDoneResult> => {
    const batchSize = normalizeBatchSize(
      args.batchSize ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE,
      DEFAULT_INGESTION_ARTIFACT_CLEANUP_BATCH_SIZE,
    );
    const maxBatches = normalizeMaxBatches(
      args.maxBatches ?? DEFAULT_INGESTION_ARTIFACT_CLEANUP_MAX_BATCHES,
    );
    const now = Date.now();
    const jobCutoffUpdatedAt = now - INGESTION_JOB_RETENTION_MS;
    const requestedScrapedPostCutoffUpdatedAt = now - SCRAPED_POST_RETENTION_MS;
    let scrapedPostCutoffUpdatedAt = requestedScrapedPostCutoffUpdatedAt;
    let deletedIngestionJobCount = 0;
    let deletedScrapedPostCount = 0;
    let ingestionJobsHaveMore = false;
    let scrapedPostsHaveMore = false;
    let scrapedPostCursor: string | null = null;
    let batchesRun = 0;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const results: [DeleteByUpdatedAtResult, DeleteScrapedPostsResult] =
        await Promise.all([
          ctx.runMutation(deleteOldIngestionJobsMutation, {
            cutoffUpdatedAt: jobCutoffUpdatedAt,
            limit: batchSize,
          }),
          ctx.runMutation(deleteOldScrapedPostsMutation, {
            cutoffUpdatedAt: scrapedPostCutoffUpdatedAt,
            cursor: scrapedPostCursor,
            limit: batchSize,
          }),
        ]);
      const [jobResult, scrapedPostResult] = results;

      batchesRun += 1;
      deletedIngestionJobCount += jobResult.deletedCount;
      deletedScrapedPostCount += scrapedPostResult.deletedCount;
      ingestionJobsHaveMore = jobResult.hasMore;
      scrapedPostsHaveMore = scrapedPostResult.hasMore;
      scrapedPostCursor = scrapedPostResult.continueCursor;
      scrapedPostCutoffUpdatedAt = scrapedPostResult.cutoffUpdatedAt;

      if (!ingestionJobsHaveMore && !scrapedPostsHaveMore) {
        break;
      }
    }

    const hasMore = ingestionJobsHaveMore || scrapedPostsHaveMore;
    const summary: CleanupIngestionArtifactsUntilDoneResult = {
      batchSize,
      maxBatches,
      batchesRun,
      deletedIngestionJobCount,
      deletedScrapedPostCount,
      hasMore,
      ingestionJobsHaveMore,
      scrapedPostsHaveMore,
      jobCutoffUpdatedAt,
      scrapedPostCutoffUpdatedAt,
      stoppedReason: hasMore ? "max_batches_reached" : "complete",
    };
    console.info("retention_cleanup", { kind: "ingestion_artifacts", ...summary });
    return summary;
  },
});

export const cleanupOrphanedMediaAssetsUntilDone = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.object({
    batchSize: v.number(),
    maxBatches: v.number(),
    batchesRun: v.number(),
    scannedAssetCount: v.number(),
    deletedAssetCount: v.number(),
    deletedStorageObjectCount: v.number(),
    cutoffUpdatedAt: v.number(),
    detachedScrapedPostCount: v.number(),
    retainedAssetCount: v.number(),
    hasMore: v.boolean(),
    stoppedReason: v.union(v.literal("complete"), v.literal("max_batches_reached")),
  }),
  handler: async (ctx, args) => {
    const batchSize = normalizeBatchSize(
      args.batchSize ?? DEFAULT_MEDIA_CLEANUP_BATCH_SIZE,
      DEFAULT_MEDIA_CLEANUP_BATCH_SIZE,
    );
    const maxBatches = normalizeMaxBatches(
      args.maxBatches ?? DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES,
    );
    let cutoffUpdatedAt = Date.now() - ORPHANED_MEDIA_ASSET_GRACE_MS;
    let cursor: string | null = null;
    let batchesRun = 0;
    let scannedAssetCount = 0;
    let deletedAssetCount = 0;
    let deletedStorageObjectCount = 0;
    let detachedScrapedPostCount = 0;
    let retainedAssetCount = 0;
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
      detachedScrapedPostCount += result.detachedScrapedPostCount;
      retainedAssetCount += result.retainedAssetCount;
      cutoffUpdatedAt = result.cutoffUpdatedAt;
      cursor = result.continueCursor;
      isDone = result.isDone;
      if (result.isDone) break;
    }

    const summary = {
      batchSize,
      maxBatches,
      batchesRun,
      scannedAssetCount,
      deletedAssetCount,
      deletedStorageObjectCount,
      cutoffUpdatedAt,
      detachedScrapedPostCount,
      retainedAssetCount,
      hasMore: !isDone,
      stoppedReason: isDone ? "complete" as const : "max_batches_reached" as const,
    };
    console.info("retention_cleanup", { kind: "media_assets", ...summary });
    return summary;
  },
});
