import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConvexError } from "convex/values";

import { recordSourceOccurrenceSatisfaction } from "../convex/internal/sourceOccurrenceReceipts.ts";
import {
  createEvent,
  recordInstagramSourceOccurrenceSatisfaction,
  updateEventAndRecordInstagramSourceOccurrenceSatisfaction,
} from "../convex/events.ts";
import {
  classifySavedPostCompletionForTesting,
  getRetryableProcessingFailureCount,
  resolveSavedPostProcessingOutcomeForTesting,
} from "../lib/pipeline/ingestion/reporting.ts";
import { buildSourceOccurrenceIdentity, isCompleteSourceOccurrenceReceipt } from "../lib/pipeline/source-occurrence-planning.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";

const sourceIdentity = "instagram:epoch-venue:epoch-fingerprint";
const oldFingerprint = "epoch-fingerprint-old";
const newFingerprint = "epoch-fingerprint-new";
const keyA = "occurrence:epoch:a";
const keyB = "occurrence:epoch:b";
const canonicalSourceUrl = "https://www.instagram.com/p/epoch-fingerprint/";

const expectedA = {
  artists: ["Artist A"],
  date: "2026-09-12",
  key: keyA,
  title: "Epoch Event A",
  venue: "",
};
const expectedB = {
  artists: ["Artist B"],
  date: "2026-09-13",
  key: keyB,
  title: "Epoch Event B",
  venue: "",
};
const eventA = {
  _id: "epoch-event-a",
  artists: expectedA.artists,
  date: expectedA.date,
  eventType: "music",
  instagramPostId: "epoch-fingerprint",
  instagramPostUrl: canonicalSourceUrl,
  status: "approved",
  title: expectedA.title,
  venue: expectedA.venue,
};
const eventB = {
  ...eventA,
  _id: "epoch-event-b",
  artists: expectedB.artists,
  date: expectedB.date,
  title: expectedB.title,
};
const sourceDocument = {
  _id: "epoch-source-document",
  handle: "epoch-venue",
  instagramPostUrl: canonicalSourceUrl,
  postId: "epoch-fingerprint",
  sourceRevision: 2,
};

const tables = {
  events: new Map([
    [eventA._id, structuredClone(eventA)],
    [eventB._id, structuredClone(eventB)],
  ]),
  eventDomainMigrationState: new Map([
    [
      "venue-identity-migration",
      {
        _id: "venue-identity-migration",
        key: "venue-identities-v1",
        completedAt: 1,
        mismatchCount: 0,
        errorCount: 0,
      },
    ],
  ]),
  instagramEventSources: new Map([
    [
      "epoch-link-a",
      {
        _id: "epoch-link-a",
        canonicalSourceUrl,
        eventId: eventA._id,
        instagramPostId: eventA.instagramPostId,
        instagramPostUrl: eventA.instagramPostUrl,
        linkedAt: 1,
        sourceFingerprint: oldFingerprint,
        sourceIdentity,
        sourceOccurrenceId: "epoch-occurrence-a",
        sourceOccurrenceKey: keyA,
        updatedAt: 1,
      },
    ],
    [
      "epoch-link-b",
      {
        _id: "epoch-link-b",
        canonicalSourceUrl,
        eventId: eventB._id,
        instagramPostId: eventB.instagramPostId,
        instagramPostUrl: eventB.instagramPostUrl,
        linkedAt: 1,
        sourceFingerprint: oldFingerprint,
        sourceIdentity,
        sourceOccurrenceId: "epoch-occurrence-b",
        sourceOccurrenceKey: keyB,
        updatedAt: 1,
      },
    ],
  ]),
  instagramSourceOccurrenceReceipts: new Map([
    [
      "epoch-receipt",
      {
        _id: "epoch-receipt",
        createdAt: 1,
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [keyA, keyB],
        expectedOccurrences: [expectedA, expectedB],
        satisfiedKeys: [keyA, keyB],
        satisfiedOccurrences: [
          { eventId: eventA._id, key: keyA },
          { eventId: eventB._id, key: keyB },
        ],
        sourceFingerprint: oldFingerprint,
        sourceIdentity,
        updatedAt: 1,
      },
    ],
  ]),
  sourceOccurrences: new Map([
    [
      "epoch-occurrence-a",
      {
        _id: "epoch-occurrence-a",
        canonicalEventId: eventA._id,
        sourceDocumentId: sourceDocument._id,
        sourceFingerprint: oldFingerprint,
        sourceIdentity,
        sourceOccurrenceKey: keyA,
        sourceRevision: 1,
        state: "satisfied",
      },
    ],
    [
      "epoch-occurrence-b",
      {
        _id: "epoch-occurrence-b",
        canonicalEventId: eventB._id,
        sourceDocumentId: sourceDocument._id,
        sourceFingerprint: oldFingerprint,
        sourceIdentity,
        sourceOccurrenceKey: keyB,
        sourceRevision: 1,
        state: "satisfied",
      },
    ],
  ]),
  sourceOccurrenceTopologyEpoch: new Map([
    [
      "epoch-state",
      {
        _id: "epoch-state",
        key: "source-occurrence-topology-v1",
        currentEpoch: 10,
        verifiedEpoch: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ]),
};

const pristineTables = structuredClone(tables);

function rowsFor(table, filters, state) {
  const rows = state[table] ? [...state[table].values()] : [];
  return rows.filter((row) =>
    Object.entries(filters).every(([field, value]) => row[field] === value),
  );
}

function makeHarness(state = structuredClone(pristineTables), failQueryTable) {
  const operations = [];
  let insertedId = 0;
  const db = {
    query(table) {
      if (table === failQueryTable) throw new Error("Unexpected indexed admission failure.");
      const filters = {};
      const chain = {
        withIndex(_index, configure) {
          const builder = {
            eq(field, value) {
              filters[field] = value;
              return builder;
            },
          };
          configure(builder);
          return chain;
        },
        async take(limit) {
          operations.push({ kind: "read", table, limit, filters: structuredClone(filters) });
          return rowsFor(table, filters, state).slice(0, limit);
        },
        async unique() {
          const matches = rowsFor(table, filters, state);
          assert.ok(matches.length <= 1, `${table} lookup must remain unique.`);
          return matches[0] ?? null;
        },
        async first() {
          return rowsFor(table, filters, state)[0] ?? null;
        },
      };
      return chain;
    },
    async get(id) {
      for (const table of Object.values(state)) {
        if (table.has(id)) return table.get(id);
      }
      return null;
    },
    async patch(id, patch) {
      for (const table of Object.values(state)) {
        if (!table.has(id)) continue;
        table.set(id, { ...table.get(id), ...structuredClone(patch) });
        operations.push({ kind: "patch", id, patch: structuredClone(patch) });
        return;
      }
      throw new Error(`Missing QA row ${id}.`);
    },
    async insert(table, row) {
      const id = `epoch-inserted-${table}-${++insertedId}`;
      state[table] ??= new Map();
      state[table].set(id, { ...structuredClone(row), _id: id });
      operations.push({ kind: "insert", table, id });
      return id;
    },
    async delete(id) {
      for (const table of Object.values(state)) {
        if (table.delete(id)) {
          operations.push({ kind: "delete", id });
          return;
        }
      }
      throw new Error(`Unexpected delete for ${id}.`);
    },
  };
  return {
    tables: state,
    operations,
    db,
    ctx: { auth: { getUserIdentity: async () => null }, db },
  };
}

const db = makeHarness(tables).db;

const revisedPlan = {
  confirmedPastKeys: [],
  deferredChildCount: 0,
  deferredChildKeys: [],
  expectedKeys: [keyA, keyB],
  expectedOccurrences: [expectedA, expectedB],
  observedChildKeys: [keyA, keyB],
  previousSourceFingerprint: oldFingerprint,
  sourceFingerprint: newFingerprint,
  sourceIdentity,
};
const refusalData =
  "Revised multi-occurrence sources require complete re-attestation before changing verified publication topology.";

function enableAuthority(harness, authority) {
  if (authority === "publication" || authority === "both") {
    harness.tables.publicationMigrationState = new Map([
      ["publication-state", {
        _id: "publication-state",
        key: "materialized-publication-v1",
        readCutoverEnabled: true,
      }],
    ]);
  }
  if (authority === "coverage" || authority === "both") {
    harness.tables.eventDomainMigrationState.set("receipt-topology-coverage", {
      _id: "receipt-topology-coverage",
      key: "source-occurrence-receipt-topology-v1",
      phase: "receipt_topology_audit",
      isDone: true,
      completedAt: 1,
      topologyEpoch: 10,
      mismatchCount: 0,
      errorCount: 0,
      updatedCount: 0,
      scannedCount: 2,
      unchangedCount: 2,
    });
  }
}

function isRefusal(error) {
  assert.ok(error instanceof ConvexError, "The refusal must survive client-log redaction as ConvexError.data.");
  assert.equal(error.data, refusalData);
  return true;
}

async function record(harness, plan = revisedPlan, target = eventA._id, key = keyA) {
  return recordSourceOccurrenceSatisfaction(
    harness.ctx, structuredClone(plan), key, target, sourceDocument,
  );
}

for (const authority of ["publication", "coverage", "both"]) {
  const harness = makeHarness();
  enableAuthority(harness, authority);
  const before = structuredClone(harness.tables);
  await assert.rejects(record(harness), isRefusal);
  assert.deepEqual(harness.tables, before, `${authority} refusal must precede all source/event/topology writes.`);
  assert.equal(harness.operations.filter((operation) => operation.kind !== "read").length, 0);
  const authorityReads = harness.operations.filter((operation) => operation.kind === "read");
  assert.ok(authorityReads.some((operation) => operation.table === "publicationMigrationState" && operation.limit === 2));
  assert.ok(authorityReads.some((operation) => operation.table === "eventDomainMigrationState" && operation.limit === 2));
}

for (const table of ["publicationMigrationState", "sourceOccurrenceTopologyEpoch"]) {
  const harness = makeHarness(undefined, table);
  const before = structuredClone(harness.tables);
  await assert.rejects(record(harness), /Unexpected indexed admission failure/);
  assert.deepEqual(harness.tables, before, "Unexpected admission errors must fail closed, not fall back to bootstrap writes.");
}

{
  const harness = makeHarness();
  enableAuthority(harness, "publication");
  harness.tables.publicationMigrationState.set("duplicate-publication-state", {
    _id: "duplicate-publication-state", key: "materialized-publication-v1", readCutoverEnabled: true,
  });
  const before = structuredClone(harness.tables);
  await assert.rejects(record(harness), /Publication migration state is not unique/);
  assert.deepEqual(harness.tables, before);
}

// Established authority does not prohibit safe new, unchanged, or single-child
// writes: each can certify all affected fingerprint bindings within this write.
for (const branch of ["new", "unchanged", "single-child", "retired-sibling"]) {
  const harness = makeHarness();
  enableAuthority(harness, "both");
  const plan = structuredClone(revisedPlan);
  if (branch === "new") {
    harness.tables.instagramSourceOccurrenceReceipts.clear();
    harness.tables.instagramEventSources.clear();
    harness.tables.sourceOccurrences.clear();
  } else if (branch === "unchanged") {
    plan.sourceFingerprint = oldFingerprint;
  } else if (branch === "single-child") {
    const receipt = harness.tables.instagramSourceOccurrenceReceipts.get("epoch-receipt");
    receipt.expectedKeys = [keyA];
    receipt.expectedOccurrences = [expectedA];
    receipt.satisfiedKeys = [keyA];
    receipt.satisfiedOccurrences = [{ key: keyA, eventId: eventA._id }];
    harness.tables.instagramEventSources.delete("epoch-link-b");
    harness.tables.sourceOccurrences.delete("epoch-occurrence-b");
    plan.expectedKeys = [keyA];
    plan.expectedOccurrences = [expectedA];
    plan.observedChildKeys = [keyA];
  } else {
    plan.confirmedPastKeys = [keyB];
    plan.expectedKeys = [keyA];
    plan.expectedOccurrences = [expectedA];
    plan.observedChildKeys = [keyA];
  }
  await record(harness, plan);
  const epoch = harness.tables.sourceOccurrenceTopologyEpoch.get("epoch-state");
  assert.equal(epoch.currentEpoch, epoch.verifiedEpoch, `${branch} must retain the clean topology frontier.`);
  assert.equal(epoch.lastUnverifiedEpoch, 10, "Safe writes must not erase or forge the historical unverified frontier.");
}

{
  const harness = makeHarness();
  enableAuthority(harness, "both");
  harness.tables.publicationMigrationState.get("publication-state").readCutoverEnabled = false;
  harness.tables.eventDomainMigrationState.get("receipt-topology-coverage").isDone = false;
  await record(harness);
  const epoch = harness.tables.sourceOccurrenceTopologyEpoch.get("epoch-state");
  assert.ok(epoch.currentEpoch > epoch.verifiedEpoch, "Incomplete authority must preserve the bootstrap dirty behavior.");
  assert.equal(epoch.lastUnverifiedEpoch, epoch.currentEpoch);
}

// Call the real registered mutation handlers, staging database/scheduler writes
// in an isolated transaction. A failure discards the staged state, modeling the
// single Convex mutation rollback boundary; this is not a live-server test.
async function invokeRegisteredMutationAtomically(mutation, harness, args) {
  assert.equal(mutation.isMutation, true);
  const transaction = makeHarness(structuredClone(harness.tables));
  harness.lastTransaction = transaction;
  transaction.ctx.scheduler = {
    async runAfter() {
      transaction.operations.push({ kind: "scheduled" });
    },
  };
  const result = await mutation._handler(transaction.ctx, args);
  for (const key of Object.keys(harness.tables)) delete harness.tables[key];
  Object.assign(harness.tables, transaction.tables);
  return result;
}

const serviceSecret = "qa-epoch-integrity-only-secret";
const previousCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = serviceSecret;
try {
  for (const authority of ["publication", "coverage"]) {
    for (const branch of ["attach", "update", "create", "create-existing"]) {
      const harness = makeHarness();
      enableAuthority(harness, authority);
      // Pending representatives avoid invoking unrelated approval policy gates;
      // they still have the exact semantic bindings required by the shared guard.
      harness.tables.events.get(eventA._id).status = "pending";
      harness.tables.events.get(eventA._id).updatedAt = 1;
      if (branch === "create-existing") {
        harness.tables.events.get(eventA._id).sourceOccurrenceKey = keyA;
      }
      const leasedSource = {
        ...sourceDocument,
        processingStatus: "processing",
        processingLeaseOwner: "qa-epoch-integrity-worker",
        processingLeaseExpiresAt: Date.now() + 60_000,
      };
      harness.tables.scrapedPosts = new Map([[leasedSource._id, leasedSource]]);
      const processingFence = {
        handle: leasedSource.handle,
        scrapedPostId: leasedSource._id,
        owner: leasedSource.processingLeaseOwner,
        sourceRevision: leasedSource.sourceRevision,
      };
      let mutation;
      let args;
      if (branch === "attach") {
        mutation = recordInstagramSourceOccurrenceSatisfaction;
        args = {
          plan: revisedPlan, satisfiedKey: keyA, representativeEventId: eventA._id,
          processingFence, serviceSecret,
        };
      } else if (branch === "update") {
        mutation = updateEventAndRecordInstagramSourceOccurrenceSatisfaction;
        args = {
          id: eventA._id, patch: { description: "Changed before the guarded source write." },
          expectedStatus: "pending", expectedUpdatedAt: 1,
          plan: revisedPlan, satisfiedKey: keyA, processingFence, serviceSecret,
        };
      } else {
        mutation = createEvent;
        args = {
          title: expectedA.title, date: expectedA.date, venue: expectedA.venue,
          artists: expectedA.artists, eventType: "music", status: "pending",
          instagramPostId: eventA.instagramPostId, instagramPostUrl: canonicalSourceUrl,
          sourceOccurrenceKey: keyA, sourceOccurrencePlan: revisedPlan,
          processingFence, returnCreateDisposition: true, serviceSecret,
        };
      }
      const before = structuredClone(harness.tables);
      await assert.rejects(invokeRegisteredMutationAtomically(mutation, harness, args), isRefusal);
      assert.deepEqual(harness.tables, before, `${branch}/${authority} may not commit earlier writes on refusal.`);
      const writes = harness.lastTransaction.operations.filter((operation) => operation.kind !== "read");
      assert.equal(writes.some((operation) => operation.kind === "scheduled"), false);
      if (branch === "update") {
        assert.ok(writes.some((operation) => operation.kind === "patch" && operation.id === eventA._id), "Update must exercise an earlier staged event write, not merely fail a precondition.");
        assert.ok(writes.some((operation) => operation.kind === "insert" && operation.table === "eventAuditLog"), "The earlier audit write must roll back with the event.");
      } else if (branch === "create") {
        assert.ok(writes.some((operation) => operation.kind === "insert" && operation.table === "events"), "Creation must exercise an earlier staged event insert.");
      } else {
        assert.equal(writes.length, 0, "Attach/existing-create refusal must precede any write.");
      }
      for (const table of ["instagramSourceOccurrenceReceipts", "instagramEventSources", "sourceOccurrences", "sourceOccurrenceTopologyEpoch"]) {
        assert.deepEqual(harness.lastTransaction.tables[table], before[table], `${table} must remain unchanged even inside the refused transaction.`);
      }
    }
  }
} finally {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
}

// A refused current revision leaves the prior receipt incomplete for the new
// fingerprint. Existing completion policy must retry it, not report a clean
// duplicate or terminal no-event success even when duplicate counters changed.
const priorPost = { ...sourceDocument, caption: "Previous caption" };
const currentPost = { ...priorPost, caption: "Revised caption" };
const priorReceipt = {
  ...pristineTables.instagramSourceOccurrenceReceipts.get("epoch-receipt"),
  sourceIdentity: buildSourceOccurrenceIdentity(priorPost),
  sourceFingerprint: buildInstagramSourceOccurrenceFingerprint(priorPost),
};
assert.equal(isCompleteSourceOccurrenceReceipt(priorReceipt, currentPost), false);
assert.equal(isCompleteSourceOccurrenceReceipt(priorReceipt, priorPost), true);
const failureCount = getRetryableProcessingFailureCount({
  failedDownloads: 0, failedConversions: 0, failedExtractions: 0,
  failedImagePersistence: 0, duplicate_update_failed: 1,
});
assert.equal(failureCount, 1);
const classification = classifySavedPostCompletionForTesting({
  hasTerminalPermanentFailure: false,
  hasProcessingFailure: failureCount > 0,
  receiptInspectionFailed: false,
  receiptState: "incomplete",
  eventActivityCountBefore: 0,
  eventActivityCountAfter: 1,
  terminalNoEventSkipCountBefore: 0,
  terminalNoEventSkipCountAfter: 1,
  terminalCanonicalDuplicateCountBefore: 0,
  terminalCanonicalDuplicateCountAfter: 1,
});
assert.equal(classification.hasRetryableFailure, true);
assert.equal(classification.hasTerminalCanonicalDuplicateOutcome, false);
assert.equal(classification.hasTerminalNoEventOutcome, false);
assert.equal(resolveSavedPostProcessingOutcomeForTesting({
  ...classification,
  hasTerminalPermanentFailure: false,
  receiptInspectionFailed: false,
  receiptState: "incomplete",
  hasProcessingFailure: true,
}), "incomplete_occurrence_receipt");

const persisterSource = readFileSync(new URL("../lib/pipeline/ingestion/occurrence-persister.ts", import.meta.url), "utf8");
assert.equal((persisterSource.match(/if \(!receiptSatisfactionSucceeded\) \{\s*summary\.duplicate_update_failed \+= 1;\s*continue;/g) ?? []).length, 3, "Every legacy attach branch must treat refusal as failure before counting a clean duplicate.");
assert.match(persisterSource, /catch \(error\) \{\s*summary\.duplicate_update_failed \+= 1;/, "Combined update failures must remain retryable.");
assert.match(persisterSource, /catch \(error\) \{\s*summary\.failedExtractions \+= 1;/, "Combined creation failures must remain retryable.");

const stableSource = { caption: "Caption", altText: "Poster", locationName: "Venue" };
const stableFingerprint = buildInstagramSourceOccurrenceFingerprint(stableSource);
assert.equal(buildInstagramSourceOccurrenceFingerprint({
  ...stableSource, instagramPostUrl: `${canonicalSourceUrl}?img_index=2`,
  imageUrl: "https://cdn.example.test/new-url", likesCount: 123,
}), stableFingerprint, "Provider URL/CDN/metric churn must not change source content identity.");
assert.equal(buildInstagramSourceOccurrenceFingerprint({ caption: "  Caption ", altText: " Poster ", locationName: " Venue " }), stableFingerprint);
assert.notEqual(buildInstagramSourceOccurrenceFingerprint({ ...stableSource, caption: "Revised Caption" }), stableFingerprint, "Actual content revisions must still require re-attestation.");

await recordSourceOccurrenceSatisfaction(
  { db },
  {
    confirmedPastKeys: [],
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [keyA, keyB],
    expectedOccurrences: [expectedA, expectedB],
    observedChildKeys: [keyA, keyB],
    previousSourceFingerprint: oldFingerprint,
    sourceFingerprint: newFingerprint,
    sourceIdentity,
  },
  keyA,
  eventA._id,
  sourceDocument,
);

assert.equal(
  tables.instagramSourceOccurrenceReceipts.get("epoch-receipt").sourceFingerprint,
  newFingerprint,
);
assert.equal(
  tables.instagramEventSources.get("epoch-link-a").sourceFingerprint,
  newFingerprint,
);
assert.equal(
  tables.sourceOccurrences.get("epoch-occurrence-a").sourceFingerprint,
  newFingerprint,
);
assert.equal(
  tables.instagramEventSources.get("epoch-link-b").sourceFingerprint,
  oldFingerprint,
  "The retained sibling demonstrates the temporary receipt/link mismatch.",
);
assert.equal(
  tables.sourceOccurrences.get("epoch-occurrence-b").sourceFingerprint,
  oldFingerprint,
);
const epoch = tables.sourceOccurrenceTopologyEpoch.get("epoch-state");
assert.ok(epoch.currentEpoch > 10);
assert.equal(
  epoch.verifiedEpoch,
  10,
  "A source revision with a retained satisfied sibling must dirty the topology epoch.",
);

console.log("Source-occurrence topology epoch integrity QA passed.");
