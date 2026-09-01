import assert from "node:assert/strict";

import { recordSourceOccurrenceSatisfaction } from "../convex/internal/sourceOccurrenceReceipts.ts";

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

function rowsFor(table, filters) {
  const rows = tables[table] ? [...tables[table].values()] : [];
  return rows.filter((row) =>
    Object.entries(filters).every(([field, value]) => row[field] === value),
  );
}

const db = {
  query(table) {
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
        return rowsFor(table, filters).slice(0, limit);
      },
      async unique() {
        const matches = rowsFor(table, filters);
        assert.ok(matches.length <= 1, `${table} lookup must remain unique.`);
        return matches[0] ?? null;
      },
    };
    return chain;
  },
  async get(id) {
    for (const table of Object.values(tables)) {
      if (table.has(id)) return table.get(id);
    }
    return null;
  },
  async patch(id, patch) {
    for (const table of Object.values(tables)) {
      if (!table.has(id)) continue;
      table.set(id, { ...table.get(id), ...structuredClone(patch) });
      return;
    }
    throw new Error(`Missing QA row ${id}.`);
  },
  async insert(table) {
    throw new Error(`Unexpected ${table} insert in retained-sibling QA.`);
  },
  async delete(id) {
    for (const table of Object.values(tables)) {
      if (table.delete(id)) return;
    }
    throw new Error(`Unexpected delete for ${id}.`);
  },
};

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
