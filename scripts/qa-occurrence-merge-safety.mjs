import assert from "node:assert/strict";

import { mergeApprovedEvents } from "../convex/events.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-merge-admin";

function approvedEvent(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    title: "Canonical concert",
    date: "2026-08-07",
    time: "20:00",
    venue: "Occurrence Venue",
    venueId: "venue-occurrence",
    venueInstagramHandle: "occurrence_venue",
    artists: ["Canonical Artist"],
    eventType: "music",
    instagramPostId: "shared-post",
    instagramPostUrl: "https://www.instagram.com/p/shared-post/",
    sourceOccurrenceKey: "shared-occurrence",
    status: "approved",
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function makeDb({ events: eventRows, links = [], receipts = [] }) {
  const tables = {
    events: new Map(eventRows.map((row) => [row._id, structuredClone(row)])),
    instagramEventSources: new Map(links.map((row) => [row._id, structuredClone(row)])),
    instagramSourceOccurrenceReceipts: new Map(
      receipts.map((row) => [row._id, structuredClone(row)]),
    ),
    userSavedEvents: new Map(),
    savedEvents: new Map(),
    eventAuditLog: new Map(),
  };
  let auditCounter = 0;
  const rows = (table) => [...(tables[table]?.values() ?? [])];
  const query = (table) => ({
    withIndex(_index, configure) {
      const filters = [];
      const builder = {
        eq(field, value) {
          filters.push([field, value]);
          return builder;
        },
      };
      configure(builder);
      const matches = () =>
        rows(table).filter((row) => filters.every(([field, value]) => row[field] === value));
      return {
        async collect() {
          return matches();
        },
        async unique() {
          const found = matches();
          if (found.length > 1) throw new Error(`Expected unique ${table} row.`);
          return found[0] ?? null;
        },
        async first() {
          return matches()[0] ?? null;
        },
      };
    },
  });
  return {
    tables,
    db: {
      async get(id) {
        for (const table of Object.values(tables)) {
          if (table.has(id)) return table.get(id);
        }
        return null;
      },
      query,
      async patch(id, patch) {
        for (const table of Object.values(tables)) {
          if (!table.has(id)) continue;
          table.set(id, { ...table.get(id), ...patch });
          return;
        }
        throw new Error(`Missing row ${id}.`);
      },
      async delete(id) {
        for (const table of Object.values(tables)) {
          if (table.delete(id)) return;
        }
        throw new Error(`Missing row ${id}.`);
      },
      async insert(table, value) {
        assert.equal(table, "eventAuditLog");
        auditCounter += 1;
        const id = `audit-${auditCounter}`;
        tables.eventAuditLog.set(id, { _id: id, ...value });
        return id;
      },
    },
  };
}

const distinctState = makeDb({
  events: [
    approvedEvent("distinct-primary", { sourceOccurrenceKey: "occurrence-20" }),
    approvedEvent("distinct-later", {
      time: "22:00",
      sourceOccurrenceKey: "occurrence-22",
      updatedAt: 11,
    }),
  ],
});
await assert.rejects(
  mergeApprovedEvents._handler(
    { auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) }, db: distinctState.db },
    {
      primaryId: "distinct-primary",
      duplicateIds: ["distinct-later"],
      patch: {},
    },
  ),
  /every pair to be a proven duplicate/i,
);
assert.equal(distinctState.tables.events.has("distinct-later"), true);

const duplicateState = makeDb({
  events: [approvedEvent("duplicate-primary"), approvedEvent("duplicate-row", { updatedAt: 11 })],
  links: [
    {
      _id: "source-link-duplicate",
      eventId: "duplicate-row",
      sourceIdentity: "instagram:occurrence_venue:shared-post",
      sourceFingerprint: "fingerprint-1",
      sourceOccurrenceKey: "shared-occurrence",
      instagramPostId: "shared-post",
      instagramPostUrl: "https://www.instagram.com/p/shared-post/",
      sourceHandle: "occurrence_venue",
      linkedAt: 1,
      updatedAt: 1,
    },
  ],
  receipts: [
    {
      _id: "receipt-1",
      sourceIdentity: "instagram:occurrence_venue:shared-post",
      sourceFingerprint: "fingerprint-1",
      expectedKeys: ["shared-occurrence"],
      expectedOccurrences: [
        {
          key: "shared-occurrence",
          date: "2026-08-07",
          time: "20:00",
          venue: "Occurrence Venue",
          title: "Canonical concert",
          artists: ["Canonical Artist"],
        },
      ],
      satisfiedKeys: ["shared-occurrence"],
      deferredChildCount: 0,
      deferredChildKeys: [],
      satisfiedOccurrences: [{ key: "shared-occurrence", eventId: "duplicate-row" }],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});
const merged = await mergeApprovedEvents._handler(
  { auth: { getUserIdentity: async () => ({ subject: "qa-merge-admin" }) }, db: duplicateState.db },
  {
    primaryId: "duplicate-primary",
    duplicateIds: ["duplicate-row"],
    patch: {},
  },
);
assert.deepEqual(merged, { primaryId: "duplicate-primary", deletedDuplicateCount: 1 });
assert.equal(duplicateState.tables.events.has("duplicate-row"), false);
assert.equal(
  duplicateState.tables.instagramEventSources.get("source-link-duplicate").eventId,
  "duplicate-primary",
);
assert.deepEqual(
  duplicateState.tables.instagramSourceOccurrenceReceipts.get("receipt-1").satisfiedOccurrences,
  [{ key: "shared-occurrence", eventId: "duplicate-primary" }],
);

console.log("Occurrence merge safety QA passed: distinct rows survive and duplicate ledgers rewire.");
