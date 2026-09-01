import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  auditCanonicalSavedEventsBatch,
  backfillLegacySavedEventsBatch,
  reviewSavedEventReadCutover,
  reviewSavedEventWriteCutover,
  rollbackSavedEventCutover,
} from "../convex/internal/migrations/savedEvents.ts";
import {
  SavedEventRepositoryConflict,
  savedEventRepository,
} from "../convex/repositories/savedEvents.ts";

function makeDb(initial = {}) {
  const tables = Object.fromEntries(
    [
      "events",
      "savedEvents",
      "savedEventMigrationState",
      "userSavedEvents",
      "users",
    ].map((table) => [
        table,
        new Map((initial[table] ?? []).map((row) => [row._id, structuredClone(row)])),
      ]),
  );
  let nextId = 1;

  function rowsFor(table, filters, direction, indexName) {
    const rows = [...tables[table].values()].filter((row) =>
      Object.entries(filters).every(([field, value]) => row[field] === value),
    );
    const logicalTimeField =
      indexName === "by_user_createdAt"
        ? "createdAt"
        : indexName === "by_user_savedAt"
          ? "savedAt"
          : "_creationTime";
    rows.sort((left, right) => {
      const leftTime = left[logicalTimeField] ?? 0;
      const rightTime = right[logicalTimeField] ?? 0;
      return (
        (direction === "desc" ? rightTime - leftTime : leftTime - rightTime) ||
        (direction === "desc"
          ? (right._creationTime ?? 0) - (left._creationTime ?? 0)
          : (left._creationTime ?? 0) - (right._creationTime ?? 0)) ||
        String(left._id).localeCompare(String(right._id))
      );
    });
    return rows;
  }

  const db = {
    query(table) {
      const filters = {};
      let direction = "asc";
      let indexName = null;
      const chain = {
        withIndex(nextIndexName, apply) {
          indexName = nextIndexName;
          const builder = {
            eq(field, value) {
              filters[field] = value;
              return builder;
            },
          };
          apply(builder);
          return chain;
        },
        order(nextDirection) {
          direction = nextDirection;
          return chain;
        },
        async paginate({ cursor, numItems }) {
          const offset = cursor ? Number.parseInt(cursor, 10) : 0;
          const rows = rowsFor(table, filters, direction, indexName);
          const page = rows.slice(offset, offset + numItems);
          const nextOffset = offset + page.length;
          return {
            continueCursor: String(nextOffset),
            isDone: nextOffset >= rows.length,
            page,
          };
        },
        async take(limit) {
          return rowsFor(table, filters, direction, indexName).slice(0, limit);
        },
        async unique() {
          const rows = rowsFor(table, filters, direction, indexName);
          if (rows.length > 1) throw new Error("unique query returned multiple rows");
          return rows[0] ?? null;
        },
      };
      return chain;
    },
    async delete(id) {
      for (const table of Object.values(tables)) {
        if (table.delete(id)) return;
      }
      throw new Error(`Missing row ${id}`);
    },
    async get(id) {
      for (const table of Object.values(tables)) {
        const row = table.get(id);
        if (row) return row;
      }
      return null;
    },
    async insert(table, value) {
      const id = `${table}_${nextId++}`;
      tables[table].set(id, {
        _creationTime: 10_000 + nextId,
        _id: id,
        ...structuredClone(value),
      });
      return id;
    },
    async patch(id, patch) {
      for (const table of Object.values(tables)) {
        const row = table.get(id);
        if (row) {
          table.set(id, { ...row, ...structuredClone(patch) });
          return;
        }
      }
      throw new Error(`Missing row ${id}`);
    },
  };

  return { db, tables };
}

const user = {
  _creationTime: 1,
  _id: "user_a",
  clerkId: "clerk_a",
  createdAt: 1,
  updatedAt: 1,
};

{
  const { db } = makeDb({
    savedEvents: [
      {
        _creationTime: 10,
        _id: "canonical_shared",
        createdAt: 10,
        eventId: "event_shared",
        userId: user.clerkId,
      },
      {
        _creationTime: 5,
        _id: "canonical_only",
        createdAt: 5,
        eventId: "event_canonical",
        userId: user.clerkId,
      },
    ],
    userSavedEvents: [
      {
        _creationTime: 20,
        _id: "legacy_shared",
        eventId: "event_shared",
        savedAt: 20,
        userId: user._id,
      },
      {
        _creationTime: 15,
        _id: "legacy_only",
        eventId: "event_legacy",
        savedAt: 15,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const result = await savedEventRepository.listForSubject(
    { db },
    { legacyUserId: user._id, limit: 10, subject: user.clerkId },
  );
  assert.deepEqual(
    result.references.map(({ eventId, savedAt, storage }) => ({ eventId, savedAt, storage })),
    [
      { eventId: "event_shared", savedAt: 20, storage: "both" },
      { eventId: "event_legacy", savedAt: 15, storage: "legacy" },
      { eventId: "event_canonical", savedAt: 5, storage: "canonical" },
    ],
  );
  assert.equal(result.duplicateLogicalReferenceCount, 1);
  assert.equal(result.truncated, false);
}

{
  const { db } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "canonical_logically_newest",
        createdAt: 100,
        eventId: "event_logically_newest",
        userId: user.clerkId,
      },
      ...[10, 9, 8].map((createdAt, index) => ({
        _creationTime: 100 - index,
        _id: `canonical_creation_newer_${index}`,
        createdAt,
        eventId: `event_creation_newer_${index}`,
        userId: user.clerkId,
      })),
    ],
    userSavedEvents: [
      {
        _creationTime: 2,
        _id: "legacy_logically_second",
        eventId: "event_logically_second",
        savedAt: 95,
        userId: user._id,
      },
      ...[7, 6, 5].map((savedAt, index) => ({
        _creationTime: 200 - index,
        _id: `legacy_creation_newer_${index}`,
        eventId: `event_legacy_creation_newer_${index}`,
        savedAt,
        userId: user._id,
      })),
    ],
    users: [user],
  });
  const result = await savedEventRepository.listForSubject(
    { db },
    { legacyUserId: user._id, limit: 2, subject: user.clerkId },
  );
  assert.deepEqual(
    result.references.map(({ eventId, savedAt }) => ({ eventId, savedAt })),
    [
      { eventId: "event_logically_newest", savedAt: 100 },
      { eventId: "event_logically_second", savedAt: 95 },
    ],
    "Bounded dual reads must rank by createdAt/savedAt before final merge, not by insertion time.",
  );
  assert.equal(result.truncated, true);
}

{
  const duplicateRows = Array.from({ length: 150 }, (_, index) => ({
    _creationTime: index + 1,
    _id: `canonical_physical_duplicate_${index}`,
    createdAt: 1_000 - index,
    eventId: "event_duplicate_heavy",
    userId: user.clerkId,
  }));
  const { db } = makeDb({
    savedEvents: [
      ...duplicateRows,
      {
        _creationTime: 151,
        _id: "canonical_after_duplicates_a",
        createdAt: 800,
        eventId: "event_after_duplicates_a",
        userId: user.clerkId,
      },
      {
        _creationTime: 152,
        _id: "canonical_after_duplicates_b",
        createdAt: 700,
        eventId: "event_after_duplicates_b",
        userId: user.clerkId,
      },
    ],
    users: [user],
  });
  const result = await savedEventRepository.listForSubject(
    { db },
    { legacyUserId: user._id, limit: 2, subject: user.clerkId },
  );
  assert.deepEqual(
    result.references.map(({ eventId, savedAt }) => ({ eventId, savedAt })),
    [
      { eventId: "event_duplicate_heavy", savedAt: 1_000 },
      { eventId: "event_after_duplicates_a", savedAt: 800 },
    ],
    "Physical duplicates must not consume the bounded logical result window.",
  );
  assert.equal(result.canonicalRowCount, 152);
  assert.equal(result.scanLimitReached, false);
  assert.equal(result.truncated, true);
}

{
  const { db, tables } = makeDb({
    savedEvents: [],
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_save",
        eventId: "event_1",
        savedAt: 123,
        userId: user._id,
      },
    ],
    users: [user],
  });
  let validationCount = 0;
  const result = await savedEventRepository.transitionForSubject(
    { db },
    {
      ensureCanSave: async () => {
        validationCount += 1;
      },
      eventId: "event_1",
      legacyUserId: user._id,
      saved: true,
      subject: user.clerkId,
    },
  );
  assert.equal(result.saved, true);
  assert.equal(result.createdAt, 123, "A transition must preserve the original save time.");
  assert.equal(validationCount, 1);
  assert.equal(tables.savedEvents.size, 1);
  assert.equal(tables.userSavedEvents.size, 0, "A touched legacy row must converge atomically.");
}

{
  const { db, tables } = makeDb({
    savedEvents: [
      {
        _creationTime: 2,
        _id: "canonical_save",
        createdAt: 2,
        eventId: "event_2",
        userId: user.clerkId,
      },
    ],
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_save",
        eventId: "event_2",
        savedAt: 1,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const result = await savedEventRepository.transitionForSubject(
    { db },
    {
      ensureCanSave: async () => {
        throw new Error("Removing a stale save must not validate publication eligibility.");
      },
      eventId: "event_2",
      legacyUserId: user._id,
      saved: false,
      subject: user.clerkId,
    },
  );
  assert.deepEqual(result, { eventId: "event_2", saved: false });
  assert.equal(tables.savedEvents.size, 0);
  assert.equal(tables.userSavedEvents.size, 0);
}

{
  const { db, tables } = makeDb({ savedEvents: [], userSavedEvents: [], users: [user] });
  const first = await savedEventRepository.dualWriteForLegacyAdapter(
    { db },
    {
      ensureCanSave: async () => {},
      eventId: "event_3",
      legacyUserId: user._id,
      now: 321,
      subject: user.clerkId,
    },
  );
  const second = await savedEventRepository.dualWriteForLegacyAdapter(
    { db },
    {
      ensureCanSave: async () => {},
      eventId: "event_3",
      legacyUserId: user._id,
      now: 999,
      subject: user.clerkId,
    },
  );
  assert.deepEqual(second, first, "The compatibility write must be idempotent.");
  assert.equal(tables.savedEvents.size, 1);
  assert.equal(tables.userSavedEvents.size, 1);
}

{
  const { db } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "bounded_reference_a",
        createdAt: 1,
        eventId: "event_bounded_references",
        userId: "subject_a",
      },
      {
        _creationTime: 2,
        _id: "bounded_reference_b",
        createdAt: 2,
        eventId: "event_bounded_references",
        userId: "subject_b",
      },
    ],
  });
  await assert.rejects(
    savedEventRepository.loadEventReferences(
      { db },
      "event_bounded_references",
      { limit: 1 },
    ),
    /exceeds the safe bounded operation limit/iu,
  );
  const withinBound = await savedEventRepository.loadEventReferences(
    { db },
    "event_bounded_references",
    { limit: 2 },
  );
  assert.equal(withinBound.canonical.length, 2);
  assert.equal(withinBound.legacy.length, 0);
}

{
  const eventId = "event_combined_physical_bound";
  const { db } = makeDb({
    savedEvents: Array.from({ length: 600 }, (_, index) => ({
      _creationTime: index + 1,
      _id: `combined_canonical_${index}`,
      createdAt: index + 1,
      eventId,
      userId: `canonical_subject_${index}`,
    })),
    userSavedEvents: Array.from({ length: 600 }, (_, index) => ({
      _creationTime: 1_000 + index,
      _id: `combined_legacy_${index}`,
      eventId,
      savedAt: index + 1,
      userId: `legacy_user_${index}`,
    })),
  });
  await assert.rejects(
    savedEventRepository.loadEventReferences({ db }, eventId),
    /exceeds the safe bounded operation limit/iu,
    "The mutation budget is combined across canonical and legacy physical rows.",
  );
}

{
  const { db } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "duplicate_a",
        createdAt: 1,
        eventId: "event_conflict",
        userId: user.clerkId,
      },
      {
        _creationTime: 2,
        _id: "duplicate_b",
        createdAt: 2,
        eventId: "event_conflict",
        userId: user.clerkId,
      },
    ],
    users: [user],
  });
  await assert.rejects(
    () =>
      savedEventRepository.transitionForSubject(
        { db },
        {
          ensureCanSave: async () => {},
          eventId: "event_conflict",
          legacyUserId: user._id,
          saved: true,
          subject: user.clerkId,
        },
      ),
    (error) =>
      error instanceof SavedEventRepositoryConflict &&
      error.code === "E_SAVED_EVENT_REFERENCE_CONFLICT",
  );
}

{
  const missingUserReference = {
    _creationTime: 3,
    _id: "legacy_orphan",
    eventId: "event_orphan",
    savedAt: 3,
    userId: "missing_user",
  };
  const { db, tables } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "already_canonical",
        createdAt: 1,
        eventId: "event_existing",
        userId: user.clerkId,
      },
    ],
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_existing",
        eventId: "event_existing",
        savedAt: 1,
        userId: user._id,
      },
      {
        _creationTime: 2,
        _id: "legacy_missing",
        eventId: "event_missing",
        savedAt: 2,
        userId: user._id,
      },
      missingUserReference,
    ],
    users: [user],
  });
  const dryRun = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: true, limit: 10 },
  );
  assert.deepEqual(dryRun, {
    alreadyCanonical: 1,
    conflictCount: 0,
    continueCursor: "3",
    cumulative: {
      alreadyCanonical: 1,
      conflictCount: 0,
      duplicateLegacyRowCount: 0,
      inserted: 0,
      mismatchCount: 1,
      missingUserCount: 1,
      scanned: 3,
      timestampMismatchCount: 0,
    },
    cutoverEnabled: false,
    dryRun: true,
    duplicateLegacyRowCount: 0,
    inserted: 0,
    isDone: true,
    missingUserCount: 1,
    scanned: 3,
    statePhase: "preview",
    stateUpdatedAt: null,
    timestampMismatchCount: 0,
    tracked: false,
    wouldInsert: 1,
  });
  assert.equal(tables.savedEvents.size, 1, "Dry-run must not write.");
  assert.equal(tables.userSavedEvents.size, 3, "Dry-run must not delete legacy rows.");

  const applied = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: false, limit: 10 },
  );
  assert.equal(applied.inserted, 1);
  assert.equal(applied.statePhase, "blocked");
  assert.equal(applied.cumulative.mismatchCount, 1);
  assert.equal(tables.savedEvents.size, 2);
  assert.equal(tables.userSavedEvents.size, 3, "Backfill must remain additive.");
  const blockedState = [...tables.savedEventMigrationState.values()][0];
  await assert.rejects(
    reviewSavedEventReadCutover._handler(
      { db },
      {
        enable: true,
        expectedStateUpdatedAt: blockedState.updatedAt,
        note: "QA blocked migration review",
        reviewedBy: "qa-operator",
      },
    ),
    /equivalence is not clean/iu,
  );

  const verified = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: true, limit: 10 },
  );
  assert.equal(verified.alreadyCanonical, 2);
  assert.equal(verified.wouldInsert, 0);
}

{
  const secondUser = { ...user, _id: "user_b", clerkId: "clerk_b" };
  const { db, tables } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "canonical_from_a",
        createdAt: 1,
        eventId: "event_from",
        userId: user.clerkId,
      },
      {
        _creationTime: 2,
        _id: "canonical_to_a",
        createdAt: 2,
        eventId: "event_to",
        userId: user.clerkId,
      },
      {
        _creationTime: 3,
        _id: "canonical_from_b",
        createdAt: 3,
        eventId: "event_from",
        userId: secondUser.clerkId,
      },
    ],
    userSavedEvents: [
      {
        _creationTime: 4,
        _id: "legacy_from_a",
        eventId: "event_from",
        savedAt: 4,
        userId: user._id,
      },
      {
        _creationTime: 5,
        _id: "legacy_to_a",
        eventId: "event_to",
        savedAt: 5,
        userId: user._id,
      },
      {
        _creationTime: 6,
        _id: "legacy_from_b",
        eventId: "event_from",
        savedAt: 6,
        userId: secondUser._id,
      },
    ],
    users: [user, secondUser],
  });
  const moved = await savedEventRepository.reassignEventReferences(
    { db },
    "event_from",
    "event_to",
  );
  assert.deepEqual(moved, { dedupedCount: 2, movedCount: 2 });
  assert.equal(
    [...tables.savedEvents.values()].filter((row) => row.eventId === "event_from")
      .length,
    0,
  );
  assert.equal(
    [...tables.userSavedEvents.values()].filter((row) => row.eventId === "event_from")
      .length,
    0,
  );

  const deleted = await savedEventRepository.deleteEventReferences(
    { db },
    "event_to",
  );
  assert.equal(deleted, 4);
  assert.equal(tables.savedEvents.size, 0);
  assert.equal(tables.userSavedEvents.size, 0);
}

{
  const { db } = makeDb({
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_duplicate_first",
        eventId: "event_duplicate_pages",
        savedAt: 10,
        userId: user._id,
      },
      {
        _creationTime: 2,
        _id: "legacy_duplicate_second",
        eventId: "event_duplicate_pages",
        savedAt: 20,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const firstPage = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: true, limit: 1 },
  );
  const secondPage = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: firstPage.continueCursor, dryRun: true, limit: 1 },
  );
  assert.equal(firstPage.wouldInsert, 0);
  assert.equal(firstPage.duplicateLegacyRowCount, 1);
  assert.equal(secondPage.wouldInsert, 1);
  assert.equal(
    secondPage.duplicateLegacyRowCount,
    0,
    "Only the latest logical duplicate may become the canonical reference across page boundaries.",
  );
}

{
  const { db } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "canonical_timestamp_mismatch",
        createdAt: 10,
        eventId: "event_timestamp_mismatch",
        userId: user.clerkId,
      },
    ],
    userSavedEvents: [
      {
        _creationTime: 2,
        _id: "legacy_timestamp_mismatch",
        eventId: "event_timestamp_mismatch",
        savedAt: 20,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const preview = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: true, limit: 10 },
  );
  assert.equal(preview.alreadyCanonical, 0);
  assert.equal(preview.timestampMismatchCount, 1);
  assert.equal(preview.cumulative.mismatchCount, 1);
  assert.equal(preview.wouldInsert, 0);
}

{
  const { db, tables } = makeDb({
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_tracked_a",
        eventId: "event_tracked_a",
        savedAt: 20,
        userId: user._id,
      },
      {
        _creationTime: 2,
        _id: "legacy_tracked_b",
        eventId: "event_tracked_b",
        savedAt: 30,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const first = await backfillLegacySavedEventsBatch._handler(
    { db },
    { cursor: null, dryRun: false, limit: 1 },
  );
  assert.equal(first.statePhase, "backfill");
  assert.equal(first.cumulative.scanned, 1);
  assert.equal(first.cumulative.inserted, 1);
  assert.equal(first.isDone, false);

  const second = await backfillLegacySavedEventsBatch._handler(
    { db },
    { dryRun: false, limit: 1 },
  );
  assert.equal(second.statePhase, "backfill");
  assert.equal(second.cumulative.scanned, 2);
  assert.equal(second.cumulative.inserted, 2);
  assert.equal(second.cumulative.mismatchCount, 0);
  assert.equal(second.isDone, true);
  assert.equal(tables.savedEvents.size, 2);
  assert.equal(tables.userSavedEvents.size, 2, "Tracked backfill remains additive.");

  const canonicalAudit = await auditCanonicalSavedEventsBatch._handler(
    { db },
    { limit: 1 },
  );
  assert.equal(canonicalAudit.phase, "canonical_audit");
  const completedCanonicalAudit = await auditCanonicalSavedEventsBatch._handler(
    { db },
    { limit: 1 },
  );
  assert.equal(completedCanonicalAudit.phase, "ready_for_review");
  assert.equal(completedCanonicalAudit.canonicalScannedCount, 2);
  assert.equal(completedCanonicalAudit.canonicalUniqueRowCount, 2);
  assert.equal(completedCanonicalAudit.canonicalDuplicateRowCount, 0);

  const reviewed = await reviewSavedEventReadCutover._handler(
    { db },
    {
      enable: true,
      expectedStateUpdatedAt: completedCanonicalAudit.stateUpdatedAt,
      note: "QA clean equivalence review",
      reviewedBy: "qa-operator",
    },
  );
  assert.equal(reviewed.phase, "cutover_enabled");
  assert.equal(reviewed.cutoverEnabled, true);

  tables.userSavedEvents.set("legacy_after_review_guard", {
    _creationTime: 100,
    _id: "legacy_after_review_guard",
    eventId: "event_legacy_only_after_review",
    savedAt: 1_000,
    userId: user._id,
  });
  const canonicalOnly = await savedEventRepository.listForSubject(
    { db },
    { legacyUserId: user._id, limit: 10, subject: user.clerkId },
  );
  assert.deepEqual(
    canonicalOnly.references.map((reference) => reference.eventId),
    ["event_tracked_b", "event_tracked_a"],
    "Canonical-only reads require a clean completed and explicitly reviewed cutover state.",
  );
  assert.equal(canonicalOnly.legacyRowCount, 0);

  const writeCutover = await reviewSavedEventWriteCutover._handler(
    { db },
    {
      enable: true,
      expectedStateUpdatedAt: reviewed.updatedAt,
      note: "QA retire compatibility writer",
      reviewedBy: "qa-operator",
    },
  );
  assert.equal(writeCutover.readCutoverEnabled, true);
  assert.equal(writeCutover.writeCutoverEnabled, true);
  assert.deepEqual(await savedEventRepository.loadCutoverMode({ db }), {
    generation: writeCutover.cutoverGeneration,
    read: "canonical",
    write: "canonical",
  });
  await assert.rejects(
    savedEventRepository.dualWriteForLegacyAdapter(
      { db },
      {
        ensureCanSave: async () => {},
        eventId: "event_adapter_must_stop",
        legacyUserId: user._id,
        subject: user.clerkId,
      },
    ),
    /legacy saved-event write adapter is disabled/iu,
  );

  const rollback = await rollbackSavedEventCutover._handler(
    { db },
    {
      expectedStateUpdatedAt: writeCutover.updatedAt,
      note: "QA exact dual-model rollback",
      reviewedBy: "qa-operator",
    },
  );
  assert.equal(rollback.readCutoverEnabled, false);
  assert.equal(rollback.writeCutoverEnabled, false);
  assert.deepEqual(await savedEventRepository.loadCutoverMode({ db }), {
    generation: rollback.cutoverGeneration,
    read: "dual",
    write: "compatibility",
  });
  const rolledBackReads = await savedEventRepository.listForSubject(
    { db },
    { legacyUserId: user._id, limit: 10, subject: user.clerkId },
  );
  assert.ok(
    rolledBackReads.references.some(
      (reference) => reference.eventId === "event_legacy_only_after_review",
    ),
    "Rollback must restore dual reads without deleting legacy evidence.",
  );
}

{
  const { db, tables } = makeDb({
    userSavedEvents: [
      {
        _creationTime: 1,
        _id: "legacy_cutover_duplicate_old",
        eventId: "event_cutover_duplicate",
        savedAt: 10,
        userId: user._id,
      },
      {
        _creationTime: 2,
        _id: "legacy_cutover_duplicate_latest",
        eventId: "event_cutover_duplicate",
        savedAt: 20,
        userId: user._id,
      },
    ],
    users: [user],
  });
  const migrated = await backfillLegacySavedEventsBatch._handler(
    { db },
    { dryRun: false, limit: 10 },
  );
  assert.equal(migrated.cumulative.duplicateLegacyRowCount, 1);
  assert.equal(migrated.cumulative.inserted, 1);
  const audited = await auditCanonicalSavedEventsBatch._handler(
    { db },
    { limit: 10 },
  );
  assert.equal(audited.phase, "ready_for_review");
  await reviewSavedEventReadCutover._handler(
    { db },
    {
      enable: true,
      expectedStateUpdatedAt: audited.stateUpdatedAt,
      note: "QA duplicate convergence review",
      reviewedBy: "qa-operator",
    },
  );
  const saved = await savedEventRepository.transitionForSubject(
    { db },
    {
      ensureCanSave: async () => {},
      eventId: "event_cutover_duplicate",
      legacyUserId: user._id,
      saved: true,
      subject: user.clerkId,
    },
  );
  assert.equal(saved.saved, true);
  assert.equal(tables.userSavedEvents.size, 0);
  const unsaved = await savedEventRepository.transitionForSubject(
    { db },
    {
      ensureCanSave: async () => {
        throw new Error("Unsave must not run eligibility validation.");
      },
      eventId: "event_cutover_duplicate",
      legacyUserId: user._id,
      saved: false,
      subject: user.clerkId,
    },
  );
  assert.equal(unsaved.saved, false);
  assert.equal(tables.savedEvents.size, 0);
}

{
  const { db, tables } = makeDb({
    savedEvents: [
      {
        _creationTime: 1,
        _id: "canonical_audit_duplicate_a",
        createdAt: 1,
        eventId: "event_canonical_audit_duplicate",
        userId: user.clerkId,
      },
      {
        _creationTime: 2,
        _id: "canonical_audit_duplicate_b",
        createdAt: 2,
        eventId: "event_canonical_audit_duplicate",
        userId: user.clerkId,
      },
    ],
    users: [user],
  });
  await backfillLegacySavedEventsBatch._handler(
    { db },
    { dryRun: false, limit: 10 },
  );
  const audit = await auditCanonicalSavedEventsBatch._handler(
    { db },
    { limit: 10 },
  );
  assert.equal(audit.phase, "blocked");
  assert.equal(audit.canonicalScannedCount, 2);
  assert.equal(audit.canonicalDuplicateRowCount, 2);
  const state = [...tables.savedEventMigrationState.values()][0];
  await assert.rejects(
    reviewSavedEventReadCutover._handler(
      { db },
      {
        enable: true,
        expectedStateUpdatedAt: state.updatedAt,
        note: "QA duplicate canonical block",
        reviewedBy: "qa-operator",
      },
    ),
    /equivalence is not clean/iu,
  );
}

const usersSource = readFileSync("convex/users.ts", "utf8");
const schemaSource = readFileSync("convex/schema.ts", "utf8");
assert.match(usersSource, /savedEventRepository\.listForSubject/);
assert.match(usersSource, /savedEventRepository\.transitionForSubject/);
assert.match(usersSource, /savedEventRepository\.dualWriteForLegacyAdapter/);
assert.match(usersSource, /MAX_USER_LIBRARY_REFERENCE_SCAN = 500/u);
assert.match(usersSource, /allApprovedSavedEvents\.slice\([\s\S]{0,100}MAX_USER_LIBRARY_REFERENCES/u);
assert.match(usersSource, /savedEventsTruncated:/u);
assert.doesNotMatch(
  usersSource,
  /query\("userSavedEvents"\)[\s\S]{0,200}\.filter\(/,
  "Saved-event access must not regress to a filtered user scan.",
);
assert.match(
  schemaSource,
  /savedEvents: defineTable\([\s\S]*?\.index\("by_user_createdAt", \["userId", "createdAt"\]\)/u,
);
assert.match(
  schemaSource,
  /userSavedEvents: defineTable\([\s\S]*?\.index\("by_user_savedAt", \["userId", "savedAt"\]\)/u,
);

console.log(
  "Saved-event repository QA passed (dual-read dedupe, canonical transition, reviewed read/write cutovers, exact rollback, merge preservation, conflicts, and additive backfill).",
);
