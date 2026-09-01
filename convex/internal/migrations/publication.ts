import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import { PUBLICATION_POLICY_VERSION } from "../../../lib/domain/publication/policy";
import {
  evaluateEventPublication,
  toPublicationPatch,
} from "../../publicationPolicy";
import {
  PUBLICATION_MIGRATION_STATE_KEY,
  hasPublicationDependencyWriteSince,
  isPublicationMigrationStateEquivalent,
  loadPublicationMigrationState,
} from "../../publicationCutover";
import { readSourceOccurrenceTopologyEpoch } from "../sourceOccurrenceTopologyEpoch";

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 64;

const publicationMigrationPhase = v.union(
  v.literal("backfill"),
  v.literal("audit"),
  v.literal("blocked"),
  v.literal("ready_for_review"),
  v.literal("cutover_enabled"),
);

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value as number)));
}

function publicationFieldsMatch(
  event: Doc<"events">,
  patch: ReturnType<typeof toPublicationPatch>,
): boolean {
  return (
    event.publicationPolicyVersion === patch.publicationPolicyVersion &&
    event.publicationReason === patch.publicationReason &&
    event.publicationState === patch.publicationState
  );
}

async function requireUniqueState(
  ctx: MutationCtx,
): Promise<Doc<"publicationMigrationState"> | null> {
  return loadPublicationMigrationState(ctx);
}

export const backfillMaterializedPublicationBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: v.object({
    continueCursor: v.string(),
    dryRun: v.boolean(),
    isDone: v.boolean(),
    mismatchCount: v.number(),
    phase: publicationMigrationPhase,
    scannedCount: v.number(),
    updatedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const state = dryRun ? null : await requireUniqueState(ctx);
    const restartCompleted = args.restartCompleted ?? false;
    if (!dryRun && state?.readCutoverEnabled) {
      throw new Error("Publication read cutover is enabled; backfill state is immutable.");
    }
    if (!dryRun && !state && (args.cursor ?? null) !== null) {
      throw new Error("Tracked publication backfill must start at the first page.");
    }
    if (
      !dryRun &&
      state &&
      args.cursor !== undefined &&
      (args.cursor ?? null) !== (state.backfillCursor ?? null)
    ) {
      throw new Error("Publication backfill cursor does not match durable state.");
    }
    if (restartCompleted && state && !state.backfillDone) {
      throw new Error("Only a completed publication backfill can be restarted.");
    }
    if (!dryRun && state?.backfillDone && !restartCompleted) {
      throw new Error("Publication backfill is complete; restart explicitly to run it again.");
    }
    if (
      !dryRun &&
      state &&
      !state.backfillDone &&
      !restartCompleted &&
      !state.backfillCursor
    ) {
      throw new Error("In-progress publication backfill has no durable cursor.");
    }
    const cursor = dryRun
      ? args.cursor ?? null
      : restartCompleted
        ? null
        : state?.backfillCursor ?? null;
    const page = await ctx.db.query("events").order("asc").paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
    let mismatchCount = 0;
    let updatedCount = 0;
    for (const event of page.page) {
      try {
        const patch = toPublicationPatch(
          await evaluateEventPublication(ctx, event),
        );
        if (publicationFieldsMatch(event, patch)) continue;
        updatedCount += 1;
        if (!dryRun) await ctx.db.patch(event._id, patch);
      } catch {
        mismatchCount += 1;
      }
    }
    if (!page.isDone && !page.continueCursor) {
      throw new Error("Publication backfill pagination did not advance.");
    }
    let phase: Doc<"publicationMigrationState">["phase"] = "backfill";
    if (!dryRun) {
      const now = Date.now();
      const cumulativeScanned =
        (restartCompleted ? 0 : state?.scannedCount ?? 0) + page.page.length;
      const cumulativeUpdated =
        (restartCompleted ? 0 : state?.updatedCount ?? 0) + updatedCount;
      const cumulativeMismatch =
        (restartCompleted ? 0 : state?.mismatchCount ?? 0) + mismatchCount;
      phase = page.isDone
        ? cumulativeMismatch === 0
          ? "audit"
          : "blocked"
        : "backfill";
      const next = {
        key: PUBLICATION_MIGRATION_STATE_KEY,
        policyVersion: PUBLICATION_POLICY_VERSION,
        phase,
        backfillCursor: page.isDone ? undefined : page.continueCursor,
        backfillDone: page.isDone,
        scannedCount: cumulativeScanned,
        updatedCount: cumulativeUpdated,
        mismatchCount: cumulativeMismatch,
        auditCursor: undefined,
        auditStartedAt: undefined,
        sourceTopologyEpoch: undefined,
        auditDone: false,
        auditScannedCount: 0,
        auditDriftCount: 0,
        readCutoverEnabled: false,
        reviewedBy: undefined,
        reviewNote: undefined,
        reviewedAt: undefined,
        completedAt: undefined,
        updatedAt: now,
      } as const;
      if (state) {
        await ctx.db.patch(state._id, next);
      } else {
        await ctx.db.insert("publicationMigrationState", {
          ...next,
          createdAt: now,
        });
      }
    }
    return {
      continueCursor: page.continueCursor,
      dryRun,
      isDone: page.isDone,
      mismatchCount,
      phase,
      scannedCount: page.page.length,
      updatedCount,
    };
  },
});

export const auditMaterializedPublicationBatch = internalMutation({
  args: {
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: v.object({
    auditDriftCount: v.number(),
    auditScannedCount: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
    phase: publicationMigrationPhase,
    sourceTopologyEpoch: v.number(),
  }),
  handler: async (ctx, args) => {
    const state = await requireUniqueState(ctx);
    if (!state?.backfillDone || state.mismatchCount !== 0) {
      throw new Error("A clean publication backfill must finish before audit.");
    }
    if (state.readCutoverEnabled) {
      throw new Error("Publication read cutover is enabled; audit state is immutable.");
    }
    const restartCompleted = args.restartCompleted ?? false;
    if (state.auditDone && !restartCompleted) {
      throw new Error("Publication audit is complete; restart explicitly to run it again.");
    }
    if (restartCompleted && !state.auditDone) {
      throw new Error("Only a completed publication audit can be restarted.");
    }
    const starting = restartCompleted || state.auditStartedAt === undefined;
    if (
      !restartCompleted &&
      state.auditStartedAt === undefined &&
      (state.auditCursor !== undefined ||
        state.auditScannedCount !== 0 ||
        state.auditDriftCount !== 0)
    ) {
      throw new Error("Publication audit state has no valid starting frontier.");
    }
    if (
      !starting &&
      !state.auditDone &&
      state.auditCursor === undefined
    ) {
      throw new Error("In-progress publication audit has no durable cursor.");
    }
    const topology = await readSourceOccurrenceTopologyEpoch(ctx);
    if (!topology || topology.currentEpoch !== topology.verifiedEpoch) {
      throw new Error("Publication audit requires a fully verified source topology epoch.");
    }
    const sourceTopologyEpoch = starting
      ? topology.currentEpoch
      : state.sourceTopologyEpoch;
    if (
      sourceTopologyEpoch === undefined ||
      topology.currentEpoch !== sourceTopologyEpoch
    ) {
      throw new Error("Source topology changed during the publication audit.");
    }
    const auditStartedAt = starting ? Date.now() : state.auditStartedAt!;
    const cursor = starting ? null : state.auditCursor ?? null;
    const page = await ctx.db.query("events").order("asc").paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
    let batchDrift = 0;
    for (const event of page.page) {
      try {
        const patch = toPublicationPatch(
          await evaluateEventPublication(ctx, event),
        );
        if (!publicationFieldsMatch(event, patch)) batchDrift += 1;
      } catch {
        batchDrift += 1;
      }
    }
    if (!page.isDone && !page.continueCursor) {
      throw new Error("Publication audit pagination did not advance.");
    }
    let concurrentEventWrite = false;
    let concurrentPublicationDependencyWrite = false;
    if (page.isDone) {
      const [eventWrite, dependencyWrite] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_updatedAt", (q) => q.gte("updatedAt", auditStartedAt))
          .first(),
        hasPublicationDependencyWriteSince(ctx, auditStartedAt),
      ]);
      concurrentEventWrite = Boolean(eventWrite);
      concurrentPublicationDependencyWrite = dependencyWrite;
    }
    const auditScannedCount =
      (starting ? 0 : state.auditScannedCount) + page.page.length;
    const auditDriftCount =
      (starting ? 0 : state.auditDriftCount) +
      batchDrift +
      (concurrentEventWrite ? 1 : 0) +
      (concurrentPublicationDependencyWrite ? 1 : 0);
    const phase: Doc<"publicationMigrationState">["phase"] = page.isDone
      ? auditDriftCount === 0
        ? "ready_for_review"
        : "blocked"
      : "audit";
    const now = Date.now();
    await ctx.db.patch(state._id, {
      auditCursor: page.isDone ? undefined : page.continueCursor,
      auditDone: page.isDone,
      auditDriftCount,
      auditScannedCount,
      auditStartedAt,
      completedAt: page.isDone && auditDriftCount === 0 ? now : undefined,
      phase,
      readCutoverEnabled: false,
      reviewedAt: undefined,
      reviewedBy: undefined,
      reviewNote: undefined,
      sourceTopologyEpoch,
      updatedAt: now,
    });
    return {
      auditDriftCount,
      auditScannedCount,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      phase,
      sourceTopologyEpoch,
    };
  },
});

/** Enables or rolls back indexed reads; it never changes event data. */
export const reviewMaterializedPublicationReadCutover = internalMutation({
  args: {
    enable: v.boolean(),
    expectedStateUpdatedAt: v.number(),
    note: v.string(),
    reviewedBy: v.string(),
  },
  returns: v.object({
    phase: publicationMigrationPhase,
    readCutoverEnabled: v.boolean(),
    reviewedAt: v.number(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const reviewedBy = args.reviewedBy.trim();
    const note = args.note.trim();
    if (!reviewedBy || !note) {
      throw new Error("Publication cutover review requires an operator and note.");
    }
    const state = await requireUniqueState(ctx);
    if (!state || state.updatedAt !== args.expectedStateUpdatedAt) {
      throw new Error("Publication migration state changed before cutover review.");
    }
    const topology = await readSourceOccurrenceTopologyEpoch(ctx);
    const dependencyDrift = state?.auditStartedAt === undefined
      ? true
      : await hasPublicationDependencyWriteSince(ctx, state.auditStartedAt);
    if (
      args.enable &&
      (!isPublicationMigrationStateEquivalent(state) ||
        state.phase !== "ready_for_review" ||
        !topology ||
        topology.currentEpoch !== topology.verifiedEpoch ||
        topology.currentEpoch !== state.sourceTopologyEpoch ||
        dependencyDrift)
    ) {
      throw new Error("Publication materialization is not clean for indexed read cutover.");
    }
    const now = Date.now();
    const phase = args.enable
      ? ("cutover_enabled" as const)
      : isPublicationMigrationStateEquivalent(state)
        ? ("ready_for_review" as const)
        : ("blocked" as const);
    await ctx.db.patch(state._id, {
      phase,
      readCutoverEnabled: args.enable,
      reviewedAt: now,
      reviewedBy,
      reviewNote: note,
      updatedAt: now,
    });
    return {
      phase,
      readCutoverEnabled: args.enable,
      reviewedAt: now,
      updatedAt: now,
    };
  },
});
