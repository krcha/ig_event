import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import {
  SAVED_EVENT_MIGRATION_STATE_KEY,
  SavedEventRepositoryConflict,
  isSavedEventMigrationStateEquivalent,
  savedEventRepository,
} from "../../repositories/savedEvents";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const MAX_DUPLICATE_LEGACY_REFERENCES = 25;

const savedEventMigrationPhase = v.union(
  v.literal("preview"),
  v.literal("backfill"),
  v.literal("canonical_audit"),
  v.literal("blocked"),
  v.literal("ready_for_review"),
  v.literal("cutover_enabled"),
);
const savedEventMigrationCounters = v.object({
  alreadyCanonical: v.number(),
  conflictCount: v.number(),
  duplicateLegacyRowCount: v.number(),
  inserted: v.number(),
  mismatchCount: v.number(),
  missingUserCount: v.number(),
  scanned: v.number(),
  timestampMismatchCount: v.number(),
});

type MigrationCounters = {
  alreadyCanonical: number;
  conflictCount: number;
  duplicateLegacyRowCount: number;
  inserted: number;
  mismatchCount: number;
  missingUserCount: number;
  scanned: number;
  timestampMismatchCount: number;
};

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value as number)));
}

function emptyCounters(): MigrationCounters {
  return {
    alreadyCanonical: 0,
    conflictCount: 0,
    duplicateLegacyRowCount: 0,
    inserted: 0,
    mismatchCount: 0,
    missingUserCount: 0,
    scanned: 0,
    timestampMismatchCount: 0,
  };
}

function countersFromState(
  state: Doc<"savedEventMigrationState"> | null,
): MigrationCounters {
  if (!state) return emptyCounters();
  return {
    alreadyCanonical: state.alreadyCanonicalCount,
    conflictCount: state.conflictCount,
    duplicateLegacyRowCount: state.duplicateLegacyRowCount,
    inserted: state.insertedCount,
    mismatchCount: state.mismatchCount,
    missingUserCount: state.missingUserCount,
    scanned: state.scannedCount,
    timestampMismatchCount: state.timestampMismatchCount,
  };
}

function addCounters(
  left: MigrationCounters,
  right: MigrationCounters,
): MigrationCounters {
  return {
    alreadyCanonical: left.alreadyCanonical + right.alreadyCanonical,
    conflictCount: left.conflictCount + right.conflictCount,
    duplicateLegacyRowCount:
      left.duplicateLegacyRowCount + right.duplicateLegacyRowCount,
    inserted: left.inserted + right.inserted,
    mismatchCount: left.mismatchCount + right.mismatchCount,
    missingUserCount: left.missingUserCount + right.missingUserCount,
    scanned: left.scanned + right.scanned,
    timestampMismatchCount:
      left.timestampMismatchCount + right.timestampMismatchCount,
  };
}

async function loadMigrationState(
  ctx: MutationCtx,
): Promise<Doc<"savedEventMigrationState"> | null> {
  const rows = await ctx.db
    .query("savedEventMigrationState")
    .withIndex("by_key", (q) => q.eq("key", SAVED_EVENT_MIGRATION_STATE_KEY))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Saved-event migration state is not unique.");
  }
  return rows[0] ?? null;
}

/**
 * Additively mirrors legacy userSavedEvents rows into canonical savedEvents.
 * Apply mode owns a durable cursor and cumulative equivalence counters. It
 * never deletes legacy rows, and a timestamp mismatch blocks read cutover.
 */
export const backfillLegacySavedEventsBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: v.object({
    alreadyCanonical: v.number(),
    conflictCount: v.number(),
    continueCursor: v.string(),
    cumulative: savedEventMigrationCounters,
    cutoverEnabled: v.boolean(),
    dryRun: v.boolean(),
    duplicateLegacyRowCount: v.number(),
    inserted: v.number(),
    isDone: v.boolean(),
    missingUserCount: v.number(),
    scanned: v.number(),
    statePhase: savedEventMigrationPhase,
    stateUpdatedAt: v.union(v.number(), v.null()),
    timestampMismatchCount: v.number(),
    tracked: v.boolean(),
    wouldInsert: v.number(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const existingState = dryRun ? null : await loadMigrationState(ctx);
    if (existingState?.cutoverEnabled) {
      throw new Error("Saved-event read cutover is enabled; backfill is immutable.");
    }
    if (!dryRun && !existingState && args.cursor) {
      throw new Error("A tracked saved-event migration must start at the first page.");
    }
    if (
      !dryRun &&
      existingState &&
      args.cursor &&
      args.cursor !== existingState.cursor
    ) {
      throw new Error("Saved-event migration cursor does not match durable state.");
    }
    const restartCompleted = args.restartCompleted ?? false;
    if (restartCompleted && existingState && !existingState.isDone) {
      throw new Error("Only a completed saved-event migration can be restarted.");
    }
    if (!dryRun && existingState?.isDone && !restartCompleted) {
      throw new Error(
        "Saved-event migration is complete; use restartCompleted for a new equivalence audit.",
      );
    }
    if (!dryRun && existingState && !existingState.isDone && !existingState.cursor) {
      throw new Error("In-progress saved-event migration state has no cursor.");
    }

    const durableBaseState = restartCompleted ? null : existingState;
    const cursor = dryRun ? args.cursor ?? null : durableBaseState?.cursor ?? null;
    const page = await ctx.db.query("userSavedEvents").order("asc").paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
    const batch = emptyCounters();
    let wouldInsert = 0;

    for (const legacyReference of page.page) {
      batch.scanned += 1;
      const user = await ctx.db.get(legacyReference.userId);
      if (!user) {
        batch.missingUserCount += 1;
        continue;
      }
      const legacyDuplicates = await ctx.db
        .query("userSavedEvents")
        .withIndex("by_user_event", (q) =>
          q
            .eq("userId", legacyReference.userId)
            .eq("eventId", legacyReference.eventId),
        )
        .take(MAX_DUPLICATE_LEGACY_REFERENCES + 1);
      if (legacyDuplicates.length > MAX_DUPLICATE_LEGACY_REFERENCES) {
        batch.conflictCount += 1;
        continue;
      }
      const logicalLegacyReference = [...legacyDuplicates].sort(
        (left, right) =>
          right.savedAt - left.savedAt ||
          String(left._id).localeCompare(String(right._id)),
      )[0];
      if (logicalLegacyReference?._id !== legacyReference._id) {
        batch.duplicateLegacyRowCount += 1;
        continue;
      }

      try {
        const classification = await savedEventRepository.classifyLegacyReference(ctx, {
          legacyReference,
          subject: user.clerkId,
        });
        if (classification === "already_canonical") {
          batch.alreadyCanonical += 1;
          continue;
        }
        if (classification === "timestamp_mismatch") {
          batch.timestampMismatchCount += 1;
          continue;
        }
        wouldInsert += 1;
        if (!dryRun) {
          await savedEventRepository.mirrorLegacyReference(ctx, {
            legacyReference,
            subject: user.clerkId,
          });
          batch.inserted += 1;
        }
      } catch (error) {
        if (!(error instanceof SavedEventRepositoryConflict)) throw error;
        batch.conflictCount += 1;
      }
    }

    batch.mismatchCount =
      batch.conflictCount +
      batch.missingUserCount +
      batch.timestampMismatchCount;
    const cumulative = addCounters(countersFromState(durableBaseState), batch);
    let stateUpdatedAt: number | null = null;
    let statePhase:
      | "preview"
      | "backfill"
      | "blocked"
      | "ready_for_review" = "preview";

    if (!dryRun) {
      if (!page.isDone && !page.continueCursor) {
        throw new Error("Saved-event migration pagination did not advance.");
      }
      const now = Date.now();
      stateUpdatedAt = now;
      statePhase = page.isDone && cumulative.mismatchCount > 0
        ? "blocked"
        : "backfill";
      const statePatch = {
        key: SAVED_EVENT_MIGRATION_STATE_KEY,
        phase: statePhase,
        cursor: page.isDone ? undefined : page.continueCursor,
        isDone: page.isDone,
        scannedCount: cumulative.scanned,
        insertedCount: cumulative.inserted,
        alreadyCanonicalCount: cumulative.alreadyCanonical,
        duplicateLegacyRowCount: cumulative.duplicateLegacyRowCount,
        missingUserCount: cumulative.missingUserCount,
        conflictCount: cumulative.conflictCount,
        timestampMismatchCount: cumulative.timestampMismatchCount,
        mismatchCount: cumulative.mismatchCount,
        canonicalAuditCursor: undefined,
        canonicalAuditDone: false,
        canonicalScannedCount: 0,
        canonicalUniqueRowCount: 0,
        canonicalDuplicateRowCount: 0,
        cutoverEnabled: false,
        reviewedBy: undefined,
        reviewNote: undefined,
        reviewedAt: undefined,
        completedAt: undefined,
        updatedAt: now,
      } as const;
      if (existingState) {
        await ctx.db.patch(existingState._id, statePatch);
      } else {
        await ctx.db.insert("savedEventMigrationState", {
          key: SAVED_EVENT_MIGRATION_STATE_KEY,
          phase: statePhase,
          ...(page.isDone
            ? { completedAt: now }
            : { cursor: page.continueCursor }),
          isDone: page.isDone,
          scannedCount: cumulative.scanned,
          insertedCount: cumulative.inserted,
          alreadyCanonicalCount: cumulative.alreadyCanonical,
          duplicateLegacyRowCount: cumulative.duplicateLegacyRowCount,
          missingUserCount: cumulative.missingUserCount,
          conflictCount: cumulative.conflictCount,
          timestampMismatchCount: cumulative.timestampMismatchCount,
          mismatchCount: cumulative.mismatchCount,
          canonicalAuditDone: false,
          canonicalScannedCount: 0,
          canonicalUniqueRowCount: 0,
          canonicalDuplicateRowCount: 0,
          readCutoverEnabled: false,
          writeCutoverEnabled: false,
          cutoverGeneration: 0,
          cutoverEnabled: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return {
      alreadyCanonical: batch.alreadyCanonical,
      conflictCount: batch.conflictCount,
      continueCursor: page.continueCursor,
      cumulative,
      cutoverEnabled: false,
      dryRun,
      duplicateLegacyRowCount: batch.duplicateLegacyRowCount,
      inserted: batch.inserted,
      isDone: page.isDone,
      missingUserCount: batch.missingUserCount,
      scanned: batch.scanned,
      statePhase,
      stateUpdatedAt,
      timestampMismatchCount: batch.timestampMismatchCount,
      tracked: !dryRun,
      wouldInsert,
    };
  },
});

/**
 * Audits canonical savedEvents uniqueness after the legacy backfill. This is a
 * separate durable pass so canonical-only duplicates can never be hidden by a
 * clean legacy equivalence count or by an operator review.
 */
export const auditCanonicalSavedEventsBatch = internalMutation({
  args: {
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: v.object({
    canonicalDuplicateRowCount: v.number(),
    canonicalScannedCount: v.number(),
    canonicalUniqueRowCount: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
    phase: savedEventMigrationPhase,
    stateUpdatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const state = await loadMigrationState(ctx);
    if (!state || !state.isDone) {
      throw new Error("Saved-event legacy backfill must finish before canonical audit.");
    }
    if (state.cutoverEnabled) {
      throw new Error("Saved-event read cutover is enabled; audit state is immutable.");
    }
    const restartCompleted = args.restartCompleted ?? false;
    if (state.canonicalAuditDone && !restartCompleted) {
      throw new Error(
        "Canonical saved-event audit is complete; use restartCompleted for a new audit.",
      );
    }
    if (restartCompleted && !state.canonicalAuditDone) {
      throw new Error("Only a completed canonical saved-event audit can be restarted.");
    }
    if (!state.canonicalAuditDone && state.canonicalScannedCount && !state.canonicalAuditCursor) {
      throw new Error("In-progress canonical saved-event audit has no cursor.");
    }

    const cursor = restartCompleted ? null : state.canonicalAuditCursor ?? null;
    const page = await ctx.db.query("savedEvents").order("asc").paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
    let scanned = 0;
    let uniqueRows = 0;
    let duplicateRows = 0;
    for (const reference of page.page) {
      scanned += 1;
      const logicalRows = await ctx.db
        .query("savedEvents")
        .withIndex("by_user_event", (q) =>
          q.eq("userId", reference.userId).eq("eventId", reference.eventId),
        )
        .take(2);
      if (logicalRows.length > 1) duplicateRows += 1;
      else uniqueRows += 1;
    }
    if (!page.isDone && !page.continueCursor) {
      throw new Error("Canonical saved-event audit pagination did not advance.");
    }

    const canonicalScannedCount =
      (restartCompleted ? 0 : state.canonicalScannedCount ?? 0) + scanned;
    const canonicalUniqueRowCount =
      (restartCompleted ? 0 : state.canonicalUniqueRowCount ?? 0) + uniqueRows;
    const canonicalDuplicateRowCount =
      (restartCompleted ? 0 : state.canonicalDuplicateRowCount ?? 0) +
      duplicateRows;
    const phase: "blocked" | "canonical_audit" | "ready_for_review" = page.isDone
      ? state.mismatchCount === 0 && canonicalDuplicateRowCount === 0
        ? "ready_for_review"
        : "blocked"
      : "canonical_audit";
    const now = Date.now();
    await ctx.db.patch(state._id, {
      canonicalAuditCursor: page.isDone ? undefined : page.continueCursor,
      canonicalAuditDone: page.isDone,
      canonicalScannedCount,
      canonicalUniqueRowCount,
      canonicalDuplicateRowCount,
      completedAt: page.isDone ? now : undefined,
      phase,
      reviewedAt: undefined,
      reviewedBy: undefined,
      reviewNote: undefined,
      readCutoverEnabled: false,
      writeCutoverEnabled: false,
      cutoverEnabled: false,
      updatedAt: now,
    });
    return {
      canonicalDuplicateRowCount,
      canonicalScannedCount,
      canonicalUniqueRowCount,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      phase,
      stateUpdatedAt: now,
    };
  },
});

/** Enables canonical-only reads only after a clean completed audit and an
 * optimistic, named operator review. No migration calls this automatically. */
export const reviewSavedEventReadCutover = internalMutation({
  args: {
    enable: v.boolean(),
    expectedStateUpdatedAt: v.number(),
    note: v.string(),
    reviewedBy: v.string(),
  },
  returns: v.object({
    cutoverEnabled: v.boolean(),
    phase: savedEventMigrationPhase,
    reviewedAt: v.number(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const reviewedBy = args.reviewedBy.trim();
    const note = args.note.trim();
    if (!reviewedBy || !note) {
      throw new Error("Saved-event cutover review requires an operator and note.");
    }
    const state = await loadMigrationState(ctx);
    if (!state || state.updatedAt !== args.expectedStateUpdatedAt) {
      throw new Error("Saved-event migration state changed before cutover review.");
    }
    if (
      args.enable &&
      (!isSavedEventMigrationStateEquivalent(state) ||
        state.phase !== "ready_for_review")
    ) {
      throw new Error("Saved-event migration equivalence is not clean for cutover.");
    }
    const now = Date.now();
    const phase: "blocked" | "cutover_enabled" | "ready_for_review" =
      args.enable
        ? "cutover_enabled"
        : isSavedEventMigrationStateEquivalent(state)
          ? "ready_for_review"
          : "blocked";
    await ctx.db.patch(state._id, {
      cutoverEnabled: args.enable,
      readCutoverEnabled: args.enable,
      // Read cutover and legacy-writer retirement are deliberately separate
      // reviewed transitions. A read review can never inherit a stale write
      // cutover bit.
      writeCutoverEnabled: false,
      cutoverGeneration: (state.cutoverGeneration ?? 0) + 1,
      phase,
      reviewedAt: now,
      reviewedBy,
      reviewNote: note,
      updatedAt: now,
    });
    return { cutoverEnabled: args.enable, phase, reviewedAt: now, updatedAt: now };
  },
});

/**
 * Separately retires the legacy write adapter after canonical-only reads have
 * already been reviewed. Existing compatibility callers fail closed instead
 * of silently recreating legacy rows. Disabling this mode is the exact write
 * rollback and does not alter either save table.
 */
export const reviewSavedEventWriteCutover = internalMutation({
  args: {
    enable: v.boolean(),
    expectedStateUpdatedAt: v.number(),
    note: v.string(),
    reviewedBy: v.string(),
  },
  returns: v.object({
    cutoverGeneration: v.number(),
    readCutoverEnabled: v.boolean(),
    reviewedAt: v.number(),
    updatedAt: v.number(),
    writeCutoverEnabled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const reviewedBy = args.reviewedBy.trim();
    const note = args.note.trim();
    if (!reviewedBy || !note) {
      throw new Error("Saved-event write cutover review requires an operator and note.");
    }
    const state = await loadMigrationState(ctx);
    if (!state || state.updatedAt !== args.expectedStateUpdatedAt) {
      throw new Error("Saved-event migration state changed before write cutover review.");
    }
    const readCutoverEnabled = Boolean(
      state.cutoverEnabled &&
        (state.readCutoverEnabled ?? state.cutoverEnabled) &&
        state.phase === "cutover_enabled" &&
        isSavedEventMigrationStateEquivalent(state),
    );
    if (args.enable && !readCutoverEnabled) {
      throw new Error(
        "Canonical saved-event reads must be clean and enabled before retiring legacy writes.",
      );
    }
    const now = Date.now();
    const cutoverGeneration = (state.cutoverGeneration ?? 0) + 1;
    await ctx.db.patch(state._id, {
      cutoverGeneration,
      reviewedAt: now,
      reviewedBy,
      reviewNote: note,
      updatedAt: now,
      writeCutoverEnabled: args.enable,
    });
    return {
      cutoverGeneration,
      readCutoverEnabled,
      reviewedAt: now,
      updatedAt: now,
      writeCutoverEnabled: args.enable,
    };
  },
});

/** Exact non-destructive rollback to dual reads and compatibility writes. */
export const rollbackSavedEventCutover = internalMutation({
  args: {
    expectedStateUpdatedAt: v.number(),
    note: v.string(),
    reviewedBy: v.string(),
  },
  returns: v.object({
    cutoverGeneration: v.number(),
    phase: savedEventMigrationPhase,
    readCutoverEnabled: v.literal(false),
    updatedAt: v.number(),
    writeCutoverEnabled: v.literal(false),
  }),
  handler: async (ctx, args) => {
    const reviewedBy = args.reviewedBy.trim();
    const note = args.note.trim();
    if (!reviewedBy || !note) {
      throw new Error("Saved-event cutover rollback requires an operator and note.");
    }
    const state = await loadMigrationState(ctx);
    if (!state || state.updatedAt !== args.expectedStateUpdatedAt) {
      throw new Error("Saved-event migration state changed before rollback.");
    }
    const now = Date.now();
    const phase = isSavedEventMigrationStateEquivalent(state)
      ? ("ready_for_review" as const)
      : ("blocked" as const);
    const cutoverGeneration = (state.cutoverGeneration ?? 0) + 1;
    await ctx.db.patch(state._id, {
      cutoverEnabled: false,
      cutoverGeneration,
      phase,
      readCutoverEnabled: false,
      reviewedAt: now,
      reviewedBy,
      reviewNote: note,
      updatedAt: now,
      writeCutoverEnabled: false,
    });
    return {
      cutoverGeneration,
      phase,
      readCutoverEnabled: false as const,
      updatedAt: now,
      writeCutoverEnabled: false as const,
    };
  },
});
