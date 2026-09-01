import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";

export const CANONICAL_SAVED_EVENT_TABLE = "savedEvents" as const;
export const LEGACY_SAVED_EVENT_TABLE = "userSavedEvents" as const;
export const SAVED_EVENT_MIGRATION_STATE_KEY =
  "saved-events-legacy-to-canonical-v1" as const;

export function isSavedEventMigrationStateEquivalent(
  state: Doc<"savedEventMigrationState">,
): boolean {
  const classifiedCount =
    state.alreadyCanonicalCount +
    state.insertedCount +
    state.duplicateLegacyRowCount +
    state.missingUserCount +
    state.conflictCount +
    state.timestampMismatchCount;
  const expectedMismatchCount =
    state.missingUserCount + state.conflictCount + state.timestampMismatchCount;
  return (
    state.isDone &&
    state.completedAt !== undefined &&
    state.canonicalAuditDone === true &&
    state.canonicalScannedCount ===
      (state.canonicalUniqueRowCount ?? 0) +
        (state.canonicalDuplicateRowCount ?? 0) &&
    state.canonicalDuplicateRowCount === 0 &&
    state.scannedCount === classifiedCount &&
    state.mismatchCount === expectedMismatchCount &&
    expectedMismatchCount === 0
  );
}

export type SavedEventStorage = "canonical" | "legacy" | "both";

export type SavedEventReference = {
  eventId: Id<"events">;
  savedAt: number;
  storage: SavedEventStorage;
};

export type SavedEventReferenceList = {
  canonicalRowCount: number;
  canonicalScanLimitReached: boolean;
  duplicateLogicalReferenceCount: number;
  legacyRowCount: number;
  legacyScanLimitReached: boolean;
  references: SavedEventReference[];
  scanLimitReached: boolean;
  truncated: boolean;
};

export type SavedEventTransitionResult =
  | {
      eventId: Id<"events">;
      saved: false;
    }
  | {
      createdAt: number;
      eventId: Id<"events">;
      saved: true;
      savedEventId: Id<"savedEvents">;
    };

export class SavedEventRepositoryConflict extends Error {
  readonly code = "E_SAVED_EVENT_REFERENCE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SavedEventRepositoryConflict";
  }
}

type ReadContext = { db: DatabaseReader };
type WriteContext = { db: DatabaseWriter };

type SubjectIdentity = {
  legacyUserId?: Id<"users"> | null;
  subject: string;
};

type SavedEventState = {
  canonical: Doc<"savedEvents"> | null;
  legacy: Doc<"userSavedEvents"> | null;
  legacyRows: Doc<"userSavedEvents">[];
};

export type SavedEventCutoverMode = {
  generation: number;
  read: "dual" | "canonical";
  write: "compatibility" | "canonical";
};

const MAX_POINT_LOOKUP_ROWS = 2;
const MAX_LEGACY_POINT_LOOKUP_ROWS = 25;
const MAX_LIST_PHYSICAL_SCAN_ROWS = 2_000;
const LIST_SCAN_PAGE_SIZE = 100;
// This is a combined physical-row budget across both compatibility tables.
// Reassign performs at least one indexed lookup and one write per row, so keep
// the bound deliberately below the general Convex transaction limits.
export const MAX_SAVED_REFERENCES_PER_EVENT_OPERATION = 250;

function normalizeReferenceLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function assertSingleRow<T>(rows: T[], label: string): T | null {
  if (rows.length > 1) {
    throw new SavedEventRepositoryConflict(`${label} is not unique.`);
  }
  return rows[0] ?? null;
}

async function resolveLegacyUserId(
  ctx: ReadContext,
  identity: SubjectIdentity,
): Promise<Id<"users"> | null> {
  if (identity.legacyUserId !== undefined) {
    return identity.legacyUserId;
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
  return user?._id ?? null;
}

async function loadCutoverMode(
  ctx: ReadContext,
): Promise<SavedEventCutoverMode> {
  const rows = await ctx.db
    .query("savedEventMigrationState")
    .withIndex("by_key", (q) => q.eq("key", SAVED_EVENT_MIGRATION_STATE_KEY))
    .take(2);
  if (rows.length > 1) {
    throw new SavedEventRepositoryConflict(
      "Saved-event migration state is not unique.",
    );
  }
  const state = rows[0];
  const cleanReviewedCutover = Boolean(
    state &&
    isSavedEventMigrationStateEquivalent(state) &&
    state.reviewedAt !== undefined &&
    state.reviewedBy?.trim() &&
    state.reviewNote?.trim(),
  );
  const readEnabled = Boolean(
    cleanReviewedCutover &&
    state?.phase === "cutover_enabled" &&
    (state.readCutoverEnabled ?? state.cutoverEnabled),
  );
  const writeEnabled = Boolean(
    readEnabled && state?.writeCutoverEnabled === true,
  );
  return {
    generation: state?.cutoverGeneration ?? 0,
    read: readEnabled ? "canonical" : "dual",
    write: writeEnabled ? "canonical" : "compatibility",
  };
}

async function readState(
  ctx: ReadContext,
  identity: SubjectIdentity,
  eventId: Id<"events">,
): Promise<SavedEventState> {
  const legacyUserIdPromise = resolveLegacyUserId(ctx, identity);
  const canonicalRowsPromise = ctx.db
    .query(CANONICAL_SAVED_EVENT_TABLE)
    .withIndex("by_user_event", (q) =>
      q.eq("userId", identity.subject).eq("eventId", eventId),
    )
    .take(MAX_POINT_LOOKUP_ROWS);
  const [legacyUserId, canonicalRows] = await Promise.all([
    legacyUserIdPromise,
    canonicalRowsPromise,
  ]);
  const legacyRows = legacyUserId
    ? await ctx.db
        .query(LEGACY_SAVED_EVENT_TABLE)
        .withIndex("by_user_event", (q) =>
          q.eq("userId", legacyUserId).eq("eventId", eventId),
        )
        .take(MAX_LEGACY_POINT_LOOKUP_ROWS + 1)
    : [];
  if (legacyRows.length > MAX_LEGACY_POINT_LOOKUP_ROWS) {
    throw new SavedEventRepositoryConflict(
      "Legacy saved-event reference set exceeds the safe convergence limit.",
    );
  }
  const logicalLegacy = [...legacyRows].sort(
    (left, right) =>
      right.savedAt - left.savedAt ||
      String(left._id).localeCompare(String(right._id)),
  )[0];

  return {
    canonical: assertSingleRow(
      canonicalRows,
      "Canonical saved-event reference",
    ),
    legacy: logicalLegacy ?? null,
    legacyRows,
  };
}

type CanonicalListScan = {
  exhausted: boolean;
  rows: Doc<"savedEvents">[];
  scanLimitReached: boolean;
};

type LegacyListScan = {
  exhausted: boolean;
  rows: Doc<"userSavedEvents">[];
  scanLimitReached: boolean;
};

async function scanCanonicalReferences(
  ctx: ReadContext,
  subject: string,
  targetUniqueCount: number,
): Promise<CanonicalListScan> {
  const rows: Doc<"savedEvents">[] = [];
  const eventIds = new Set<string>();
  let cursor: string | null = null;
  let exhausted = false;

  while (
    !exhausted &&
    rows.length < MAX_LIST_PHYSICAL_SCAN_ROWS &&
    eventIds.size < targetUniqueCount
  ) {
    const page = await ctx.db
      .query(CANONICAL_SAVED_EVENT_TABLE)
      .withIndex("by_user_createdAt", (q) => q.eq("userId", subject))
      .order("desc")
      .paginate({
        cursor,
        numItems: Math.min(
          LIST_SCAN_PAGE_SIZE,
          MAX_LIST_PHYSICAL_SCAN_ROWS - rows.length,
        ),
      });
    rows.push(...page.page);
    for (const row of page.page) eventIds.add(String(row.eventId));
    exhausted = page.isDone;
    if (!exhausted && !page.continueCursor) {
      throw new SavedEventRepositoryConflict(
        "Canonical saved-event list pagination did not advance.",
      );
    }
    cursor = page.continueCursor;
  }

  return {
    exhausted,
    rows,
    scanLimitReached:
      !exhausted &&
      rows.length >= MAX_LIST_PHYSICAL_SCAN_ROWS &&
      eventIds.size < targetUniqueCount,
  };
}

async function scanLegacyReferences(
  ctx: ReadContext,
  legacyUserId: Id<"users">,
  targetUniqueCount: number,
): Promise<LegacyListScan> {
  const rows: Doc<"userSavedEvents">[] = [];
  const eventIds = new Set<string>();
  let cursor: string | null = null;
  let exhausted = false;

  while (
    !exhausted &&
    rows.length < MAX_LIST_PHYSICAL_SCAN_ROWS &&
    eventIds.size < targetUniqueCount
  ) {
    const page = await ctx.db
      .query(LEGACY_SAVED_EVENT_TABLE)
      .withIndex("by_user_savedAt", (q) => q.eq("userId", legacyUserId))
      .order("desc")
      .paginate({
        cursor,
        numItems: Math.min(
          LIST_SCAN_PAGE_SIZE,
          MAX_LIST_PHYSICAL_SCAN_ROWS - rows.length,
        ),
      });
    rows.push(...page.page);
    for (const row of page.page) eventIds.add(String(row.eventId));
    exhausted = page.isDone;
    if (!exhausted && !page.continueCursor) {
      throw new SavedEventRepositoryConflict(
        "Legacy saved-event list pagination did not advance.",
      );
    }
    cursor = page.continueCursor;
  }

  return {
    exhausted,
    rows,
    scanLimitReached:
      !exhausted &&
      rows.length >= MAX_LIST_PHYSICAL_SCAN_ROWS &&
      eventIds.size < targetUniqueCount,
  };
}

async function listForSubject(
  ctx: ReadContext,
  identity: SubjectIdentity & { limit: number },
): Promise<SavedEventReferenceList> {
  const limit = normalizeReferenceLimit(identity.limit);
  const [legacyUserId, cutoverMode] = await Promise.all([
    resolveLegacyUserId(ctx, identity),
    loadCutoverMode(ctx),
  ]);
  const canonicalReadCutoverEnabled = cutoverMode.read === "canonical";
  const [canonicalScan, legacyScan] = await Promise.all([
    scanCanonicalReferences(ctx, identity.subject, limit + 1),
    legacyUserId && !canonicalReadCutoverEnabled
      ? scanLegacyReferences(ctx, legacyUserId, limit + 1)
      : Promise.resolve({ exhausted: true, rows: [], scanLimitReached: false }),
  ]);
  const canonicalRows = canonicalScan.rows;
  const legacyRows = legacyScan.rows;
  const byEventId = new Map<string, SavedEventReference>();

  for (const row of canonicalRows) {
    const key = String(row.eventId);
    const existing = byEventId.get(key);
    if (!existing || row.createdAt > existing.savedAt) {
      byEventId.set(key, {
        eventId: row.eventId,
        savedAt: row.createdAt,
        storage: "canonical",
      });
    }
  }
  for (const row of legacyRows) {
    const key = String(row.eventId);
    const existing = byEventId.get(key);
    if (!existing) {
      byEventId.set(key, {
        eventId: row.eventId,
        savedAt: row.savedAt,
        storage: "legacy",
      });
      continue;
    }
    byEventId.set(key, {
      eventId: existing.eventId,
      savedAt: Math.max(existing.savedAt, row.savedAt),
      storage: existing.storage === "canonical" ? "both" : existing.storage,
    });
  }

  const allReferences = [...byEventId.values()].sort((left, right) => {
    return (
      right.savedAt - left.savedAt ||
      String(left.eventId).localeCompare(String(right.eventId))
    );
  });

  return {
    canonicalRowCount: canonicalRows.length,
    canonicalScanLimitReached: canonicalScan.scanLimitReached,
    duplicateLogicalReferenceCount:
      canonicalRows.length + legacyRows.length - allReferences.length,
    legacyRowCount: legacyRows.length,
    legacyScanLimitReached: legacyScan.scanLimitReached,
    references: allReferences.slice(0, limit),
    scanLimitReached:
      canonicalScan.scanLimitReached || legacyScan.scanLimitReached,
    truncated:
      !canonicalScan.exhausted ||
      !legacyScan.exhausted ||
      allReferences.length > limit,
  };
}

async function transitionForSubject(
  ctx: WriteContext,
  args: SubjectIdentity & {
    ensureCanSave: () => Promise<void>;
    eventId: Id<"events">;
    now?: number;
    saved?: boolean;
  },
): Promise<SavedEventTransitionResult> {
  const state = await readState(ctx, args, args.eventId);
  const shouldSave = args.saved ?? !(state.canonical || state.legacy);

  if (!shouldSave) {
    if (state.canonical) await ctx.db.delete(state.canonical._id);
    for (const legacyReference of state.legacyRows) {
      await ctx.db.delete(legacyReference._id);
    }
    return { eventId: args.eventId, saved: false };
  }

  await args.ensureCanSave();
  const createdAt =
    state.canonical?.createdAt ??
    state.legacy?.savedAt ??
    args.now ??
    Date.now();
  const savedEventId =
    state.canonical?._id ??
    (await ctx.db.insert(CANONICAL_SAVED_EVENT_TABLE, {
      createdAt,
      eventId: args.eventId,
      userId: args.subject,
    }));

  // This is the migration-safe write boundary: reads remain dual-model, but every
  // touched save converges on the newer Clerk-subject keyed table atomically.
  for (const legacyReference of state.legacyRows) {
    await ctx.db.delete(legacyReference._id);
  }

  return {
    createdAt,
    eventId: args.eventId,
    saved: true,
    savedEventId,
  };
}

async function dualWriteForLegacyAdapter(
  ctx: WriteContext,
  args: {
    ensureCanSave: () => Promise<void>;
    eventId: Id<"events">;
    legacyUserId: Id<"users">;
    now?: number;
    subject: string;
  },
): Promise<{
  canonicalSavedEventId: Id<"savedEvents">;
  createdAt: number;
  legacySavedEventId: Id<"userSavedEvents">;
}> {
  const cutoverMode = await loadCutoverMode(ctx);
  if (cutoverMode.write === "canonical") {
    throw new SavedEventRepositoryConflict(
      "The legacy saved-event write adapter is disabled by the reviewed canonical write cutover.",
    );
  }
  const state = await readState(ctx, args, args.eventId);
  await args.ensureCanSave();
  const createdAt =
    state.canonical?.createdAt ??
    state.legacy?.savedAt ??
    args.now ??
    Date.now();
  const canonicalSavedEventId =
    state.canonical?._id ??
    (await ctx.db.insert(CANONICAL_SAVED_EVENT_TABLE, {
      createdAt,
      eventId: args.eventId,
      userId: args.subject,
    }));
  const legacySavedEventId =
    state.legacy?._id ??
    (await ctx.db.insert(LEGACY_SAVED_EVENT_TABLE, {
      eventId: args.eventId,
      savedAt: createdAt,
      userId: args.legacyUserId,
    }));
  if (state.legacy && state.legacy.savedAt !== createdAt) {
    await ctx.db.patch(state.legacy._id, { savedAt: createdAt });
  }
  for (const duplicate of state.legacyRows) {
    if (duplicate._id !== legacySavedEventId)
      await ctx.db.delete(duplicate._id);
  }

  return { canonicalSavedEventId, createdAt, legacySavedEventId };
}

async function mirrorLegacyReference(
  ctx: WriteContext,
  args: {
    legacyReference: Doc<"userSavedEvents">;
    subject: string;
  },
): Promise<"already_canonical" | "inserted"> {
  const canonicalRows = await ctx.db
    .query(CANONICAL_SAVED_EVENT_TABLE)
    .withIndex("by_user_event", (q) =>
      q.eq("userId", args.subject).eq("eventId", args.legacyReference.eventId),
    )
    .take(MAX_POINT_LOOKUP_ROWS);
  const existing = assertSingleRow(
    canonicalRows,
    "Canonical saved-event reference",
  );
  if (existing) {
    if (existing.createdAt !== args.legacyReference.savedAt) {
      throw new SavedEventRepositoryConflict(
        "Canonical and legacy saved-event timestamps do not match.",
      );
    }
    return "already_canonical";
  }

  await ctx.db.insert(CANONICAL_SAVED_EVENT_TABLE, {
    createdAt: args.legacyReference.savedAt,
    eventId: args.legacyReference.eventId,
    userId: args.subject,
  });
  return "inserted";
}

async function classifyLegacyReference(
  ctx: ReadContext,
  args: {
    legacyReference: Doc<"userSavedEvents">;
    subject: string;
  },
): Promise<"already_canonical" | "missing_canonical" | "timestamp_mismatch"> {
  const canonicalRows = await ctx.db
    .query(CANONICAL_SAVED_EVENT_TABLE)
    .withIndex("by_user_event", (q) =>
      q.eq("userId", args.subject).eq("eventId", args.legacyReference.eventId),
    )
    .take(MAX_POINT_LOOKUP_ROWS);
  const existing = assertSingleRow(
    canonicalRows,
    "Canonical saved-event reference",
  );
  if (!existing) return "missing_canonical";
  return existing.createdAt === args.legacyReference.savedAt
    ? "already_canonical"
    : "timestamp_mismatch";
}

async function loadEventReferences(
  ctx: ReadContext,
  eventId: Id<"events">,
  options: { limit?: number } = {},
): Promise<{
  canonical: Doc<"savedEvents">[];
  legacy: Doc<"userSavedEvents">[];
}> {
  const requestedLimit =
    options.limit ?? MAX_SAVED_REFERENCES_PER_EVENT_OPERATION;
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > MAX_SAVED_REFERENCES_PER_EVENT_OPERATION
  ) {
    throw new SavedEventRepositoryConflict(
      "Saved-event reference read limit is invalid.",
    );
  }
  const [canonical, legacy] = await Promise.all([
    ctx.db
      .query(CANONICAL_SAVED_EVENT_TABLE)
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(requestedLimit + 1),
    ctx.db
      .query(LEGACY_SAVED_EVENT_TABLE)
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(requestedLimit + 1),
  ]);
  if (
    canonical.length > requestedLimit ||
    legacy.length > requestedLimit ||
    canonical.length + legacy.length > requestedLimit
  ) {
    throw new SavedEventRepositoryConflict(
      "Saved-event reference set exceeds the safe bounded operation limit.",
    );
  }
  return { canonical, legacy };
}

async function deleteEventReferences(
  ctx: WriteContext,
  eventId: Id<"events">,
): Promise<number> {
  const references = await loadEventReferences(ctx, eventId);
  for (const row of [...references.canonical, ...references.legacy]) {
    await ctx.db.delete(row._id);
  }
  return references.canonical.length + references.legacy.length;
}

async function reassignEventReferences(
  ctx: WriteContext,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
): Promise<{ dedupedCount: number; movedCount: number }> {
  if (fromEventId === toEventId) return { dedupedCount: 0, movedCount: 0 };
  const references = await loadEventReferences(ctx, fromEventId);
  let dedupedCount = 0;
  let movedCount = 0;

  for (const row of references.legacy) {
    const targetRows = await ctx.db
      .query(LEGACY_SAVED_EVENT_TABLE)
      .withIndex("by_user_event", (q) =>
        q.eq("userId", row.userId).eq("eventId", toEventId),
      )
      .take(MAX_POINT_LOOKUP_ROWS);
    const target = assertSingleRow(
      targetRows,
      "Legacy target saved-event reference",
    );
    if (target) {
      if (target.savedAt !== Math.max(target.savedAt, row.savedAt)) {
        await ctx.db.patch(target._id, {
          savedAt: Math.max(target.savedAt, row.savedAt),
        });
      }
      await ctx.db.delete(row._id);
      dedupedCount += 1;
    } else {
      await ctx.db.patch(row._id, { eventId: toEventId });
      movedCount += 1;
    }
  }

  for (const row of references.canonical) {
    const targetRows = await ctx.db
      .query(CANONICAL_SAVED_EVENT_TABLE)
      .withIndex("by_user_event", (q) =>
        q.eq("userId", row.userId).eq("eventId", toEventId),
      )
      .take(MAX_POINT_LOOKUP_ROWS);
    const target = assertSingleRow(
      targetRows,
      "Canonical target saved-event reference",
    );
    if (target) {
      if (target.createdAt !== Math.max(target.createdAt, row.createdAt)) {
        await ctx.db.patch(target._id, {
          createdAt: Math.max(target.createdAt, row.createdAt),
        });
      }
      await ctx.db.delete(row._id);
      dedupedCount += 1;
    } else {
      await ctx.db.patch(row._id, { eventId: toEventId });
      movedCount += 1;
    }
  }
  return { dedupedCount, movedCount };
}

/**
 * The single compatibility boundary for the two historical save tables.
 * `savedEvents` is canonical (introduced after `userSavedEvents`); legacy rows
 * remain readable until a verified backfill and later, separate cutover.
 */
export const savedEventRepository = {
  classifyLegacyReference,
  deleteEventReferences,
  dualWriteForLegacyAdapter,
  listForSubject,
  loadCutoverMode,
  loadEventReferences,
  mirrorLegacyReference,
  readState,
  reassignEventReferences,
  transitionForSubject,
};
