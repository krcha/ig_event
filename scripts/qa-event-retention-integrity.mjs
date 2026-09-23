import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deleteExpiredEventsHandler } from "../convex/eventDomain/lifecycleCommands.ts";
import { deleteEventWithSavedReferences, deleteExpiredEventWithSavedReferences } from "../convex/eventDomain/persistence.ts";
import { auditRetentionReceiptCoverageBatch } from "../convex/internal/retentionReceiptCoverage.ts";
import { markSourceOccurrenceTopologyMutation } from "../convex/internal/sourceOccurrenceTopologyEpoch.ts";
import { sourceOccurrenceProvenanceRepository } from "../convex/repositories/sourceOccurrenceProvenance.ts";
import { evaluateEventPublication } from "../convex/publicationPolicy.ts";
import { getEventExpiryCutoff, isEventExpiredAtCutoff } from "../lib/events/event-retention.ts";

// This is a deterministic in-memory transaction harness, not a claim about
// live Convex engine rollback. Optional snapshots never leave this process.
const tableNames = [
  "events", "instagramEventSources", "instagramSourceOccurrenceReceipts", "sourceOccurrences",
  "campaignLineageReattestations", "eventAuditLog", "scrapedPosts", "sourceOccurrenceTopologyEpoch",
  "eventDomainMigrationState", "eventRetentionReceiptReferences", "eventRetentionCursors",
  "savedEvents", "userSavedEvents", "savedEventMigrationState", "publicationMigrationState",
  "venues", "venueIdentities", "legacySourceOccurrenceAdmissions", "mediaAssets",
];

async function runMutation(handler, ctx, args) {
  let paginatedQueryCount = 0;
  const wrapQuery = (query) => new Proxy(query, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...parameters) => {
        if (property === "paginate") {
          paginatedQueryCount += 1;
          assert.ok(paginatedQueryCount <= 1,
            "Convex permits only one paginated query per function invocation.");
        }
        const result = value.apply(target, parameters);
        return property === "withIndex" || property === "order" ? wrapQuery(result) : result;
      };
    },
  });
  return handler({ ...ctx, db: { ...ctx.db, query: (...parameters) => wrapQuery(ctx.db.query(...parameters)) } }, args);
}

function makeDb(initial = {}) {
  const tables = Object.fromEntries(tableNames.map((name) => [name,
    new Map((initial[name] ?? []).map((row) => [row._id, structuredClone(row)])),
  ]));
  let counter = 0;
  const db = {
    normalizeId: (_table, id) => typeof id === "string" ? id : null,
    async get(id) { for (const rows of Object.values(tables)) if (rows.has(id)) return rows.get(id); return null; },
    async insert(table, value) {
      const id = `qa:${table}:${++counter}`;
      tables[table].set(id, { _id: id, _creationTime: Date.now() + counter / 10000, ...structuredClone(value) });
      return id;
    },
    async patch(id, patch) {
      for (const rows of Object.values(tables)) if (rows.has(id)) {
        const updated = { ...rows.get(id), ...structuredClone(patch) };
        for (const [key, value] of Object.entries(updated)) if (value === undefined) delete updated[key];
        rows.set(id, updated); return;
      }
      throw new Error(`Missing fixture patch ${id}`);
    },
    async delete(id) { for (const rows of Object.values(tables)) if (rows.delete(id)) return; throw new Error(`Missing fixture delete ${id}`); },
    query(table) {
      assert.ok(tables[table], `Unexpected table ${table}`);
      const predicates = []; let index; let direction = "asc";
      const key = (row) => [index === "by_date" ? row.date : "", row._creationTime ?? 0, row._id];
      const compare = (a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2].localeCompare(b[2]);
      const rows = () => [...tables[table].values()].filter((row) => predicates.every((test) => test(row)))
        .sort((a, b) => compare(key(a), key(b)) * (direction === "desc" ? -1 : 1));
      const query = {
        withIndex(name, configure) {
          index = name;
          const builder = {
            eq(field, value) { predicates.push((row) => row[field] === value); return builder; },
            lt(field, value) { predicates.push((row) => row[field] < value); return builder; },
          };
          configure(builder); return query;
        },
        order(value) { direction = value; return query; },
        async take(limit) { return rows().slice(0, limit); },
        async unique() { const result = rows(); assert.ok(result.length <= 1); return result[0] ?? null; },
        async paginate({ cursor, numItems }) {
          const after = cursor ? JSON.parse(cursor) : null;
          const available = rows().filter((row) => !after || compare(key(row), after) > 0);
          const page = available.slice(0, numItems);
          return { page, isDone: page.length >= available.length, continueCursor: page.length ? JSON.stringify(key(page.at(-1))) : cursor ?? "" };
        },
      };
      return query;
    },
  };
  return { db, tables };
}

async function audit(ctx) {
  for (let index = 0; index < 10000; index += 1) {
    const result = await runMutation(auditRetentionReceiptCoverageBatch._handler, ctx, {});
    if (result.isDone) { assert.equal(result.ready, true); return result; }
  }
  throw new Error("Retention fixture audit did not terminate");
}

function event(id, date = "2026-09-10") {
  return { _id: id, _creationTime: 1, title: id, date, time: "21:00", artists: [], venue: "QA Venue", eventType: "nightlife", status: "pending", createdAt: 1, updatedAt: 1 };
}

function receipt(id, children) {
  const expectedOccurrences = children.map(([eventId, date]) => ({ key: `child:${eventId}`, date, time: "21:00", title: eventId, venue: "QA Venue", artists: [] }));
  return {
    _id: id, _creationTime: 1, sourceIdentity: `source:${id}`, sourceFingerprint: `fingerprint:${id}`,
    expectedKeys: expectedOccurrences.map((item) => item.key), expectedOccurrences,
    satisfiedKeys: expectedOccurrences.map((item) => item.key),
    satisfiedOccurrences: children.map(([eventId]) => ({ key: `child:${eventId}`, eventId })),
    deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1,
  };
}

const cutoff = { isoDate: "2026-09-21", minutesSinceMidnight: 0 };
const initial = {
  events: [event("old"), event("future", "2026-10-01"), event("wrong-public-date")],
  instagramSourceOccurrenceReceipts: [
    receipt("shared", [["old", "2026-09-10"], ["future", "2026-10-01"]]),
    receipt("future-child", [["wrong-public-date", "2026-10-01"]]),
    receipt("already-missing", [["historically-deleted", "2026-08-01"]]),
  ],
  sourceOccurrenceTopologyEpoch: [{ _id: "epoch", key: "source-occurrence-topology-v1", currentEpoch: 2, verifiedEpoch: 1, lastUnverifiedEpoch: 2, createdAt: 1, updatedAt: 1 }],
};
const fixture = makeDb(initial);
const coverage = await audit(fixture);
assert.equal(coverage.missingEventReferenceCount, 1);
assert.equal(coverage.indexedReferenceCount, 3);
await assert.rejects(() => deleteEventWithSavedReferences(fixture, "old"), /complete zero-exception receipt coverage/);
const futureBefore = structuredClone(await fixture.db.get("future"));
const missingBefore = structuredClone(await fixture.db.get("already-missing"));
const strictAuditBefore = [...fixture.tables.eventDomainMigrationState.values()].filter((row) => row.key === "source-occurrence-receipt-topology-v1");
const held = await deleteExpiredEventWithSavedReferences(fixture, await fixture.db.get("wrong-public-date"), cutoff);
assert.equal(held.retainedEventCount, 1, "A wrong old public date must not delete a future represented source child.");
const deleted = await deleteExpiredEventWithSavedReferences(fixture, await fixture.db.get("old"), cutoff);
assert.deepEqual(deleted.deletedEventIds, ["old"]);
assert.equal(await fixture.db.get("old"), null, "Receipt-only legacy rows must be discoverable and removable.");
assert.deepEqual(await fixture.db.get("future"), futureBefore, "Retained calendar rows must be byte-for-byte unchanged.");
assert.deepEqual(await fixture.db.get("already-missing"), missingBefore, "Historic dangling receipts are counted, not secretly rewritten.");
assert.deepEqual((await fixture.db.get("shared")).satisfiedOccurrences, [{ eventId: "future", key: "child:future" }]);
assert.deepEqual((await fixture.db.get("shared")).expectedOccurrences, initial.instagramSourceOccurrenceReceipts[0].expectedOccurrences.slice(1));
assert.equal((await fixture.db.get("epoch")).verifiedEpoch, 1, "Retention cannot heal an unrelated verified-frontier gap.");
assert.deepEqual([...fixture.tables.eventDomainMigrationState.values()].filter((row) => row.key === "source-occurrence-receipt-topology-v1"), strictAuditBefore);
await markSourceOccurrenceTopologyMutation(fixture, { verified: true });
const beforeStale = structuredClone(await fixture.db.get("wrong-public-date"));
await assert.rejects(() => deleteExpiredEventWithSavedReferences(fixture, beforeStale, cutoff), /current-epoch retention receipt coverage/);
assert.deepEqual(await fixture.db.get("wrong-public-date"), beforeStale);

const crowded = makeDb({
  events: [event("crowded-old"), ...Array.from({ length: 30 }, (_, index) => ({ ...event(`retained-${index}`, "2026-10-01"), status: "approved" }))],
  instagramSourceOccurrenceReceipts: [receipt("crowded", [["crowded-old", "2026-09-10"], ...Array.from({ length: 30 }, (_, index) => [`retained-${index}`, "2026-10-01"])])],
  sourceOccurrences: [["crowded-old", "2026-09-10"], ...Array.from({ length: 30 }, (_, index) => [`retained-${index}`, "2026-10-01"])].map(([eventId, date], index) => ({
    _id: `crowded-occurrence-${index}`, _creationTime: 1, canonicalEventId: eventId,
    sourceIdentity: "source:crowded", sourceFingerprint: "fingerprint:crowded", sourceOccurrenceKey: `child:${eventId}`,
    state: "satisfied", occurrenceDateKey: date,
    factsJson: JSON.stringify({ date, time: "21:00", title: eventId, artists: [], venue: "QA Venue" }),
    normalizedOccurrenceJson: JSON.stringify({ date, time: "21:00", title: eventId, artists: [], venue: "QA Venue" }),
  })),
});
await audit(crowded);
const crowdedBefore = structuredClone([...crowded.tables.events.values()].filter((row) => row._id !== "crowded-old"));
const crowdedResult = await deleteExpiredEventWithSavedReferences(crowded, await crowded.db.get("crowded-old"), cutoff);
assert.equal(crowdedResult.deletedEventIds.length, 1);
assert.deepEqual([...crowded.tables.events.values()], crowdedBefore, "A large ordinary monthly schedule must make progress without changing any of its 30 approved future siblings.");
assert.equal(crowded.tables.sourceOccurrences.get("crowded-occurrence-0").state, "superseded");
assert.equal(crowded.tables.sourceOccurrences.size, 31, "Superseding must preserve the source query cardinality and its read-budget behavior.");
const special = makeDb({
  events: [event("special-old"), ...Array.from({ length: 5 }, (_, index) => ({ ...event(`special-retained-${index}`, "2026-10-01"), normalizedFieldsJson: JSON.stringify({ reviewedPromotionVariantFold: {} }) }))],
  instagramSourceOccurrenceReceipts: [receipt("special", [["special-old", "2026-09-10"], ...Array.from({ length: 5 }, (_, index) => [`special-retained-${index}`, "2026-10-01"])])],
});
await audit(special);
const specialBefore = structuredClone(Object.fromEntries(Object.entries(special.tables).map(([name, rows]) => [name, [...rows.values()]])));
const specialResult = await deleteExpiredEventWithSavedReferences(special, await special.db.get("special-old"), cutoff);
assert.equal(specialResult.retainedEventCount, 1);
assert.deepEqual(Object.fromEntries(Object.entries(special.tables).map(([name, rows]) => [name, [...rows.values()]])), specialBefore, "An over-budget special-lineage sibling set must fail closed before every write.");

const contradictoryFacts = makeDb({
  events: [event("contradictory")],
  instagramSourceOccurrenceReceipts: [receipt("contradictory-receipt", [["contradictory", "2026-09-10"]])],
  sourceOccurrences: [{ _id: "contradictory-occurrence", _creationTime: 1, canonicalEventId: "contradictory", sourceIdentity: "source:contradictory-receipt", sourceFingerprint: "fingerprint:contradictory-receipt", sourceOccurrenceKey: "child:contradictory", state: "satisfied", occurrenceDateKey: "2026-09-10", normalizedOccurrenceJson: JSON.stringify({ date: "2026-09-10", time: "21:00", artists: [], title: "contradictory", venue: "QA Venue" }), factsJson: JSON.stringify({ date: "2026-10-01", time: "21:00", artists: [], title: "contradictory", venue: "QA Venue" }) }],
});
assert.equal(await sourceOccurrenceProvenanceRepository.prepareExpiredEventGroupTopology(contradictoryFacts, [await contradictoryFacts.db.get("contradictory")], [...contradictoryFacts.tables.instagramSourceOccurrenceReceipts.values()], cutoff), null, "An old normalized date must not hide explicit future immutable evidence.");
const oldOccurrence = contradictoryFacts.tables.sourceOccurrences.get("contradictory-occurrence");
oldOccurrence.factsJson = oldOccurrence.normalizedOccurrenceJson;
contradictoryFacts.tables.sourceOccurrences.set("source-only-sibling", {
  ...oldOccurrence, _id: "source-only-sibling", canonicalEventId: "future-without-receipt",
  sourceOccurrenceKey: "source-only-sibling-key", occurrenceDateKey: "2026-10-01",
});
const sourceOnlyClosure = await sourceOccurrenceProvenanceRepository.prepareExpiredEventGroupTopology(contradictoryFacts, [await contradictoryFacts.db.get("contradictory")], [...contradictoryFacts.tables.instagramSourceOccurrenceReceipts.values()], cutoff);
assert.deepEqual(sourceOnlyClosure.remainingRepresentativeEventIds, ["future-without-receipt"], "Source-only retained siblings must participate in the before/after publication guard.");
oldOccurrence.state = "expected";
assert.equal(await sourceOccurrenceProvenanceRepository.prepareExpiredEventGroupTopology(contradictoryFacts, [await contradictoryFacts.db.get("contradictory")], [...contradictoryFacts.tables.instagramSourceOccurrenceReceipts.values()], cutoff), null, "An unsatisfied first-class occurrence cannot be retired behind a contradictory satisfied receipt.");

export let snapshotSimulationState = null;
const snapshot = process.argv[2];
if (snapshot) {
  assert.ok(snapshot.endsWith(".zip") && snapshot.startsWith("/"), "Snapshot path must be an explicit absolute ZIP path.");
  const members = new Set(execFileSync("/usr/bin/unzip", ["-Z1", snapshot], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n"));
  const tables = Object.fromEntries(tableNames.map((table) => [table, members.has(`${table}/documents.jsonl`)
    ? execFileSync("/usr/bin/unzip", ["-p", snapshot, `${table}/documents.jsonl`], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim().split("\n").filter(Boolean).map(JSON.parse)
    : [],
  ]));
  const state = makeDb(tables);
  const snapshotCutoff = getEventExpiryCutoff(new Date(), "Europe/Belgrade");
  const beforeEvents = new Map(tables.events.map((row) => [row._id, row]));
  const beforeStrictAudit = structuredClone(tables.eventDomainMigrationState.filter((row) => row.key === "source-occurrence-receipt-topology-v1"));
  const retainedPublicationBefore = new Map();
  for (const row of tables.events) if (!isEventExpiredAtCutoff(row, snapshotCutoff)) {
    retainedPublicationBefore.set(row._id, JSON.stringify(await evaluateEventPublication(state, row)));
  }
  const auditResult = await audit(state);
  await state.db.insert("eventRetentionCursors", {
    key: "expired-events-v1", cutoffDate: snapshotCutoff.isoDate,
    cutoffMinutesSinceMidnight: snapshotCutoff.minutesSinceMidnight,
    beforeDateScanComplete: false, sameDayScanComplete: false, createdAt: 1, updatedAt: 1,
  });
  let deletedCount = 0; let retainedCount = 0;
  for (let iteration = 0; ; iteration += 1) {
    assert.ok(iteration < tables.events.length + 10, "Snapshot cleanup must advance.");
    const result = await runMutation(deleteExpiredEventsHandler, state, { batchSize: 1 });
    deletedCount += result.deletedEventCount;
    retainedCount += result.retainedCampaignEventCount;
    if (!result.hasMore) break;
  }
  const remainingExpired = [...state.tables.events.values()].filter((row) => isEventExpiredAtCutoff(row, snapshotCutoff));
  const changedUnexpired = tables.events.filter((row) => !isEventExpiredAtCutoff(row, snapshotCutoff) && JSON.stringify(state.tables.events.get(row._id)) !== JSON.stringify(row));
  assert.deepEqual(changedUnexpired, [], "Snapshot simulation must preserve every unexpired event exactly.");
  for (const [id, decision] of retainedPublicationBefore) {
    assert.equal(JSON.stringify(await evaluateEventPublication(state, await state.db.get(id))), decision,
      `Retained snapshot event ${id} must have the exact same evaluated publication decision.`);
  }
  assert.deepEqual([...state.tables.eventDomainMigrationState.values()].filter((row) => row.key === "source-occurrence-receipt-topology-v1"), beforeStrictAudit);
  for (const before of beforeEvents.values()) if (!state.tables.events.has(before._id)) assert.equal(isEventExpiredAtCutoff(before, snapshotCutoff), true);
  console.log(JSON.stringify({ mode: "snapshot-in-memory-only", cutoff: snapshotCutoff, originalEvents: beforeEvents.size, deletedCount, retainedCount, remainingExpired: remainingExpired.map((row) => ({ id: row._id, date: row.date, status: row.status })), changedUnexpired: changedUnexpired.length, unchangedPublicationDecisions: retainedPublicationBefore.size, auditResult }));
  snapshotSimulationState = state;
}
console.log("Event retention integrity QA passed: receipt-only legacy refs, future children, exact-epoch fencing, preserved siblings, and untouched generic guards.");
