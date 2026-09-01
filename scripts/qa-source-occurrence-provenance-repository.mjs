import assert from "node:assert/strict";

import { DomainError } from "../lib/domain/errors.ts";
import {
  MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION,
  sourceOccurrenceProvenanceRepository,
} from "../convex/repositories/sourceOccurrenceProvenance.ts";

function makeOccurrence({
  canonicalEventId = "event_source",
  id,
  sourceIdentity = `source:${id}`,
  state = "satisfied",
  title = "Exact Source Event",
  venue = "Exact Venue",
} = {}) {
  const expected = {
    artists: ["Artist One", "Artist Two"],
    date: "2026-09-12",
    key: `occurrence:${id}`,
    time: "22:00",
    title,
    venue,
  };
  return {
    _creationTime: 1,
    _id: id,
    canonicalEventId,
    canonicalSourceUrl: `https://www.instagram.com/p/${id}/`,
    createdAt: 1,
    factsJson: JSON.stringify(expected),
    normalizedOccurrenceJson: JSON.stringify(expected),
    occurrenceArtistFingerprint: "artist-one|artist-two",
    occurrenceDateKey: expected.date,
    occurrenceEventType: "nightlife",
    occurrenceOrdinal: 0,
    occurrenceSignatureHash: `signature:${id}`,
    occurrenceSignatureVersion: 1,
    occurrenceTimeIdentity: expected.time,
    occurrenceTitleFamily: "exact source event",
    occurrenceVenueIdentity: "exact venue",
    provider: "instagram",
    sourceDocumentId: `scraped:${id}`,
    sourceFingerprint: `fingerprint:${sourceIdentity}`,
    sourceIdentity,
    sourceOccurrenceKey: expected.key,
    sourceRevision: 1,
    state,
    updatedAt: 1,
    venueResolutionStatus: "resolved",
  };
}

function makeTargetEvent(overrides = {}) {
  return {
    _creationTime: 1,
    _id: "event_target",
    artists: ["Artist Two", "Artist One"],
    createdAt: 1,
    date: "2026-09-12",
    eventType: "nightlife",
    normalizedFieldsJson: JSON.stringify({
      artists: ["Artist One", "Artist Two"],
      normalizedDate: "2026-09-12",
      normalizedVenue: "Exact Venue",
      time: "22:00",
      title: "Exact Source Event",
    }),
    status: "approved",
    time: "22:00",
    title: "Exact Source Event",
    updatedAt: 1,
    venue: "Exact Venue",
    ...overrides,
  };
}

function receiptExpectedForOccurrence(occurrence) {
  for (const encoded of [
    occurrence.normalizedOccurrenceJson,
    occurrence.factsJson,
  ]) {
    try {
      const parsed = JSON.parse(encoded);
      if (
        typeof parsed?.date === "string" &&
        typeof parsed?.title === "string" &&
        typeof parsed?.venue === "string" &&
        Array.isArray(parsed?.artists)
      ) {
        return { ...parsed, key: occurrence.sourceOccurrenceKey };
      }
    } catch {
      // The topology remains valid so malformed first-class facts are tested.
    }
  }
  return {
    artists: ["Artist One", "Artist Two"],
    date: "2026-09-12",
    key: occurrence.sourceOccurrenceKey,
    time: "22:00",
    title: "Exact Source Event",
    venue: "Exact Venue",
  };
}

function makeDb(
  initialOccurrences,
  {
    legacyOnlyIds = [],
    missingLinkIds = [],
    receiptEventByOccurrenceId = {},
  } = {},
) {
  const legacyOnlyIdSet = new Set(legacyOnlyIds);
  const missingLinkIdSet = new Set(missingLinkIds);
  const occurrenceRows = initialOccurrences.map((row) => structuredClone(row));
  const sourceOccurrences = new Map(
    occurrenceRows
      .filter((row) => !legacyOnlyIdSet.has(row._id))
      .map((row) => [row._id, row]),
  );
  const instagramEventSources = new Map();
  const receiptInputsBySourceIdentity = new Map();

  for (const occurrence of occurrenceRows) {
    if (occurrence.state !== "satisfied" || !occurrence.canonicalEventId) continue;
    const expected = receiptExpectedForOccurrence(occurrence);
    const grouped = receiptInputsBySourceIdentity.get(occurrence.sourceIdentity) ?? [];
    grouped.push({ expected, occurrence });
    receiptInputsBySourceIdentity.set(occurrence.sourceIdentity, grouped);
    if (!missingLinkIdSet.has(occurrence._id)) {
      const linkId = `link:${occurrence._id}`;
      instagramEventSources.set(linkId, {
        _creationTime: 1,
        _id: linkId,
        canonicalSourceUrl: occurrence.canonicalSourceUrl,
        eventId: occurrence.canonicalEventId,
        linkedAt: 1,
        sourceFingerprint: occurrence.sourceFingerprint,
        sourceIdentity: occurrence.sourceIdentity,
        sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
        ...(legacyOnlyIdSet.has(occurrence._id)
          ? {}
          : { sourceOccurrenceId: occurrence._id }),
        updatedAt: 1,
      });
    }
  }

  const instagramSourceOccurrenceReceipts = new Map();
  for (const [sourceIdentity, grouped] of receiptInputsBySourceIdentity) {
    const receiptId = `receipt:${sourceIdentity}`;
    instagramSourceOccurrenceReceipts.set(receiptId, {
      _creationTime: 1,
      _id: receiptId,
      createdAt: 1,
      deferredChildCount: 0,
      deferredChildKeys: [],
      expectedKeys: grouped.map(({ expected }) => expected.key),
      expectedOccurrences: grouped.map(({ expected }) => expected),
      satisfiedKeys: grouped.map(({ expected }) => expected.key),
      satisfiedOccurrences: grouped.map(({ expected, occurrence }) => ({
        eventId:
          receiptEventByOccurrenceId[occurrence._id] ??
          occurrence.canonicalEventId,
        key: expected.key,
      })),
      sourceFingerprint: grouped[0].occurrence.sourceFingerprint,
      sourceIdentity,
      updatedAt: 1,
    });
  }

  const tables = {
    instagramEventSources,
    instagramSourceOccurrenceReceipts,
    sourceOccurrenceTopologyEpoch: new Map(),
    sourceOccurrences,
  };
  let nextId = 1;
  const patchCalls = [];
  const deleteCalls = [];
  const takeCalls = [];

  function tableForDocumentId(id) {
    return Object.values(tables).find((rows) => rows.has(id));
  }

  const db = {
    query(table) {
      const rows = tables[table];
      assert.ok(rows, `Unexpected table query: ${table}.`);
      const filters = {};
      let indexName = null;
      const chain = {
        withIndex(index, apply) {
          indexName = index;
          const builder = {
            eq(field, value) {
              filters[field] = value;
              return builder;
            },
          };
          apply(builder);
          return chain;
        },
        async take(limit) {
          takeCalls.push({ index: indexName, limit, table });
          return [...rows.values()]
            .filter((row) =>
              Object.entries(filters).every(
                ([field, value]) => row[field] === value,
              ),
            )
            .slice(0, limit);
        },
        async unique() {
          const matches = [...rows.values()].filter((row) =>
            Object.entries(filters).every(
              ([field, value]) => row[field] === value,
            ),
          );
          if (matches.length > 1) throw new Error("Expected a unique row.");
          return matches[0] ?? null;
        },
      };
      return chain;
    },
    async get(id) {
      return tableForDocumentId(id)?.get(id) ?? null;
    },
    async insert(table, value) {
      const id = `${table}_${nextId++}`;
      tables[table].set(id, { _id: id, ...structuredClone(value) });
      return id;
    },
    async patch(id, patch) {
      const rows = tableForDocumentId(id);
      assert.ok(rows, `Missing document ${id}.`);
      patchCalls.push({ id, patch: structuredClone(patch) });
      rows.set(id, { ...rows.get(id), ...structuredClone(patch) });
    },
    async delete(id) {
      const rows = tableForDocumentId(id);
      assert.ok(rows, `Missing document ${id}.`);
      deleteCalls.push(id);
      rows.delete(id);
    },
  };

  return {
    db,
    deleteCalls,
    patchCalls,
    rows: sourceOccurrences,
    tables,
    takeCalls,
  };
}

function assertNoWrites(state, message = "Operation must fail before every write.") {
  assert.equal(state.patchCalls.length, 0, message);
  assert.equal(state.deleteCalls.length, 0, message);
}

{
  const active = makeOccurrence({ id: "occurrence_active" });
  const superseded = makeOccurrence({
    id: "occurrence_superseded",
    state: "superseded",
    title: "Historical Shape No Longer Represented",
  });
  const state = makeDb([active, superseded]);
  const target = makeTargetEvent();

  const topology =
    await sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
      { db: state.db },
      "event_source",
      target,
    );
  const movedCount =
    await sourceOccurrenceProvenanceRepository.reassignPreparedEventTopology(
      { db: state.db },
      topology,
      target._id,
      { topologyEpochVerified: true },
    );

  assert.equal(movedCount, 2);
  assert.deepEqual(
    [...state.rows.values()].map((row) => [row._id, row.canonicalEventId, row.state]),
    [
      ["occurrence_active", "event_target", "satisfied"],
      ["occurrence_superseded", "event_target", "superseded"],
    ],
    "Prepared reassignment must move all provenance rows while preserving lifecycle state.",
  );
  assert.equal(
    [...state.tables.instagramEventSources.values()][0].eventId,
    "event_target",
  );
  assert.equal(
    [...state.tables.instagramSourceOccurrenceReceipts.values()][0]
      .satisfiedOccurrences[0].eventId,
    "event_target",
  );
}

{
  const state = makeDb([
    makeOccurrence({ id: "occurrence_conflict", venue: "Different Venue" }),
  ]);
  await assert.rejects(
    () =>
      sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
        { db: state.db },
        "event_source",
        makeTargetEvent(),
      ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "A semantic mismatch must fail closed with a stable domain code.",
  );
  assertNoWrites(state, "Conflict validation must not mutate provenance.");
}

{
  const malformed = makeOccurrence({ id: "occurrence_malformed" });
  malformed.normalizedOccurrenceJson = "{not-json";
  malformed.factsJson = JSON.stringify({ title: "Incomplete facts" });
  const state = makeDb([malformed]);

  await assert.rejects(
    () =>
      sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
        { db: state.db },
        "event_source",
        makeTargetEvent(),
      ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "Malformed active provenance must fail closed instead of being silently reassigned.",
  );
  assertNoWrites(state);
}

{
  const legacy = makeOccurrence({
    id: "occurrence_legacy_only",
    venue: "Different Legacy Venue",
  });
  const state = makeDb([legacy], { legacyOnlyIds: [legacy._id] });
  await assert.rejects(
    () =>
      sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
        { db: state.db },
        "event_source",
        makeTargetEvent(),
      ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "Legacy-only receipt evidence must still match the merge target.",
  );
  assertNoWrites(state, "Legacy-only semantic rejection must precede writes.");
}

for (const operation of ["merge", "delete"]) {
  const occurrence = makeOccurrence({ id: `occurrence_missing_link_${operation}` });
  const state = makeDb([occurrence], { missingLinkIds: [occurrence._id] });
  const run =
    operation === "merge"
      ? () =>
          sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
            { db: state.db },
            "event_source",
            makeTargetEvent(),
          )
      : () =>
          sourceOccurrenceProvenanceRepository.removeLegacyBindingsForDeletedEvent(
            { db: state.db },
            "event_source",
            { topologyEpochVerified: true },
          );
  await assert.rejects(
    run,
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    `A ${operation} must reject a current first-class occurrence whose legacy link is missing.`,
  );
  assertNoWrites(
    state,
    `Missing-link ${operation} rejection must happen before every write.`,
  );
}

for (const operation of ["merge", "delete"]) {
  const occurrence = makeOccurrence({ id: `occurrence_cross_target_${operation}` });
  const state = makeDb([occurrence], {
    receiptEventByOccurrenceId: { [occurrence._id]: "event_other" },
  });
  const run =
    operation === "merge"
      ? () =>
          sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
            { db: state.db },
            "event_source",
            makeTargetEvent(),
          )
      : () =>
          sourceOccurrenceProvenanceRepository.removeLegacyBindingsForDeletedEvent(
            { db: state.db },
            "event_source",
            { topologyEpochVerified: true },
          );
  await assert.rejects(
    run,
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    `A ${operation} must reject a receipt satisfaction bound to another event.`,
  );
  assertNoWrites(
    state,
    `Cross-target ${operation} rejection must happen before every write.`,
  );
}

{
  const state = makeDb([
    makeOccurrence({ id: "occurrence_detach_a" }),
    makeOccurrence({ id: "occurrence_detach_b", state: "expected" }),
  ]);
  const detachedCount =
    await sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(
      { db: state.db },
      "event_source",
      { topologyEpochVerified: true },
    );

  assert.equal(detachedCount, 2);
  for (const occurrence of state.rows.values()) {
    assert.equal(occurrence.canonicalEventId, undefined);
    assert.equal(occurrence.state, "superseded");
    assert.ok(occurrence.updatedAt > 1);
  }
}

{
  const tooManyRows = Array.from(
    { length: MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1 },
    (_, index) => makeOccurrence({ id: `occurrence_bound_${index}` }),
  );
  const state = makeDb(tooManyRows);

  await assert.rejects(
    () =>
      sourceOccurrenceProvenanceRepository.listForCanonicalEvent(
        { db: state.db },
        "event_source",
      ),
    (error) =>
      error instanceof DomainError && error.code === "OCCURRENCE_INCOMPLETE",
    "An oversized provenance set must fail before it can be prepared for reassignment.",
  );
  assert.deepEqual(
    state.takeCalls,
    [
      {
        index: "by_canonical_event",
        limit: MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1,
        table: "sourceOccurrences",
      },
    ],
  );
  assertNoWrites(state, "The safe-bound failure must be mutation-free.");
}

console.log(
  "Source-occurrence provenance repository QA passed: coherent topology, legacy semantics, zero-write conflicts, reassign, detach, and bounds are safe.",
);
