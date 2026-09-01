import { v } from "convex/values";

import type { MutationCtx } from "../../_generated/server";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 50;

export type EventDomainMigrationBatchArgs = {
  cursor?: string | null;
  dryRun?: boolean;
  limit?: number;
  restart?: boolean;
};

export type EventDomainMigrationBatchCounts = {
  errorCount?: number;
  mismatchCount: number;
  quarantinedLineageMarkerCount?: number;
  scannedCount: number;
  skippedCount?: number;
  unchangedCount?: number;
  updatedCount: number;
};

export const eventDomainMigrationBatchArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  dryRun: v.optional(v.boolean()),
  limit: v.optional(v.number()),
  restart: v.optional(v.boolean()),
};

export const eventDomainMigrationBatchResult = v.object({
  continueCursor: v.string(),
  dryRun: v.boolean(),
  errorCount: v.optional(v.number()),
  isDone: v.boolean(),
  mismatchCount: v.number(),
  quarantinedLineageMarkerCount: v.optional(v.number()),
  scannedCount: v.number(),
  skippedCount: v.optional(v.number()),
  unchangedCount: v.optional(v.number()),
  updatedCount: v.number(),
});

export function normalizeEventDomainMigrationBatchSize(
  value: number | undefined,
): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value as number)));
}

export async function recordEventDomainMigrationProgress(options: {
  counts: EventDomainMigrationBatchCounts;
  ctx: MutationCtx;
  cursor: string;
  detailJson?: string;
  dryRun: boolean;
  inputCursor: string | null;
  isDone: boolean;
  key: string;
  phase: string;
  restart: boolean;
  topologyEpoch?: number;
}): Promise<void> {
  if (options.dryRun) return;
  const existing = await options.ctx.db
    .query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", options.key))
    .unique();
  if (!existing && options.inputCursor !== null) {
    throw new Error("A migration apply run must start from a null cursor.");
  }
  if (options.restart && options.inputCursor !== null) {
    throw new Error("A migration restart must start from a null cursor.");
  }
  if (
    existing &&
    !options.restart &&
    (existing.completedAt !== undefined || existing.isDone === true)
  ) {
    throw new Error(
      "Migration run is already finished; use restart for a fresh verification run.",
    );
  }
  if (
    existing &&
    !options.restart &&
    (existing.cursor ?? null) !== options.inputCursor
  ) {
    throw new Error(
      "Migration cursor does not match the committed progress cursor.",
    );
  }
  if (
    options.topologyEpoch !== undefined &&
    (!Number.isSafeInteger(options.topologyEpoch) || options.topologyEpoch < 0)
  ) {
    throw new Error("Migration topology epoch is invalid.");
  }
  if (
    existing &&
    !options.restart &&
    options.topologyEpoch !== undefined &&
    existing.topologyEpoch !== options.topologyEpoch
  ) {
    throw new Error(
      "Migration topology epoch does not match committed progress.",
    );
  }
  const now = Date.now();
  const previousMismatchCount =
    existing && !options.restart ? existing.mismatchCount : 0;
  const previousErrorCount =
    existing && !options.restart ? (existing.errorCount ?? 0) : 0;
  const previousSkippedCount =
    existing && !options.restart ? (existing.skippedCount ?? 0) : 0;
  const previousUnchangedCount =
    existing && !options.restart ? (existing.unchangedCount ?? 0) : 0;
  const previousQuarantinedLineageMarkerCount =
    existing && !options.restart
      ? (existing.quarantinedLineageMarkerCount ?? 0)
      : 0;
  const previousScannedCount =
    existing && !options.restart ? existing.scannedCount : 0;
  const previousUpdatedCount =
    existing && !options.restart ? existing.updatedCount : 0;
  const batchErrorCount = options.counts.errorCount ?? 0;
  const batchSkippedCount = options.counts.skippedCount ?? 0;
  const batchUnchangedCount =
    options.counts.unchangedCount ??
    Math.max(
      0,
      options.counts.scannedCount -
        options.counts.updatedCount -
        options.counts.mismatchCount -
        batchSkippedCount -
        batchErrorCount,
    );
  const nextMismatchCount =
    previousMismatchCount + options.counts.mismatchCount;
  const nextErrorCount = previousErrorCount + batchErrorCount;
  const nextSkippedCount = previousSkippedCount + batchSkippedCount;
  const nextUnchangedCount = previousUnchangedCount + batchUnchangedCount;
  const nextQuarantinedLineageMarkerCount =
    previousQuarantinedLineageMarkerCount +
    (options.counts.quarantinedLineageMarkerCount ?? 0);
  const values = {
    attempt: existing ? (existing.attempt ?? 1) + (options.restart ? 1 : 0) : 1,
    ...(options.detailJson ? { auditDetailsJson: options.detailJson } : {}),
    ...(options.isDone && nextMismatchCount === 0 && nextErrorCount === 0
      ? { completedAt: now }
      : { completedAt: undefined }),
    cursor: options.cursor,
    errorCount: nextErrorCount,
    isDone: options.isDone,
    mismatchCount: nextMismatchCount,
    phase: options.phase,
    quarantinedLineageMarkerCount: nextQuarantinedLineageMarkerCount,
    scannedCount: previousScannedCount + options.counts.scannedCount,
    skippedCount: nextSkippedCount,
    skipReasonCountsJson: JSON.stringify({
      audited_lineage_requires_reattestation: nextQuarantinedLineageMarkerCount,
    }),
    ...(options.topologyEpoch !== undefined
      ? { topologyEpoch: options.topologyEpoch }
      : {}),
    unchangedCount: nextUnchangedCount,
    updatedAt: now,
    updatedCount: previousUpdatedCount + options.counts.updatedCount,
  };
  if (existing) {
    await options.ctx.db.patch(existing._id, values);
  } else {
    await options.ctx.db.insert("eventDomainMigrationState", {
      ...values,
      createdAt: now,
      key: options.key,
    });
  }
}

export function eventDomainMigrationPatchDiffers(
  current: Readonly<object>,
  patch: Readonly<Record<string, unknown>>,
): boolean {
  const currentRecord = current as Readonly<Record<string, unknown>>;
  return Object.entries(patch).some(
    ([key, value]) =>
      JSON.stringify(currentRecord[key]) !== JSON.stringify(value),
  );
}

export async function assertCleanCompletedEventDomainMigration(
  ctx: MutationCtx,
  key: string,
): Promise<void> {
  const states = await ctx.db
    .query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .take(2);
  const state = states.length === 1 ? states[0] : null;
  if (
    !state?.completedAt ||
    state.mismatchCount !== 0 ||
    (state.errorCount ?? 0) !== 0
  ) {
    throw new Error(`Required migration is not cleanly complete: ${key}.`);
  }
}
