import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  auditMaterializedPublicationBatch,
  backfillMaterializedPublicationBatch,
  reviewMaterializedPublicationReadCutover,
} from "../convex/internal/migrations/publication.ts";
import {
  resolvePublicationReadMode,
} from "../convex/publicationCutover.ts";
import {
  decodePublicationCursor,
  encodePublicationCursor,
} from "../lib/domain/publication/cursor.ts";

function makeDb() {
  const tables = {
    events: new Map([
      [
        "event_pending",
        {
          _creationTime: 1,
          _id: "event_pending",
          artists: [],
          date: "2026-09-12",
          eventType: "culture",
          status: "pending",
          title: "Pending QA event",
          updatedAt: 1,
          venue: "QA Venue",
        },
      ],
    ]),
    publicationMigrationState: new Map(),
    venueIdentities: new Map(),
    venues: new Map(),
    sourceOccurrenceTopologyEpoch: new Map([
      [
        "topology",
        {
          _creationTime: 1,
          _id: "topology",
          createdAt: 1,
          currentEpoch: 7,
          key: "source-occurrence-topology-v1",
          updatedAt: 1,
          verifiedEpoch: 7,
        },
      ],
    ]),
  };
  let nextId = 1;

  function rowsFor(table, filters, direction) {
    const rows = [...tables[table].values()].filter((row) =>
      Object.entries(filters).every(([field, condition]) =>
        condition.kind === "gte"
          ? row[field] >= condition.value
          : row[field] === condition.value,
      ),
    );
    rows.sort((left, right) =>
      direction === "desc"
        ? String(right._id).localeCompare(String(left._id))
        : String(left._id).localeCompare(String(right._id)),
    );
    return rows;
  }

  const db = {
    async get(id) {
      for (const table of Object.values(tables)) {
        if (table.has(id)) return table.get(id);
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
        if (!table.has(id)) continue;
        table.set(id, { ...table.get(id), ...structuredClone(patch) });
        return;
      }
      throw new Error(`Missing QA row ${id}.`);
    },
    query(table) {
      const filters = {};
      let direction = "asc";
      const chain = {
        withIndex(_index, apply) {
          const builder = {
            eq(field, value) {
              filters[field] = { kind: "eq", value };
              return builder;
            },
            gte(field, value) {
              filters[field] = { kind: "gte", value };
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
        async first() {
          return rowsFor(table, filters, direction)[0] ?? null;
        },
        async paginate({ cursor, numItems }) {
          const offset = cursor ? Number.parseInt(cursor, 10) : 0;
          const rows = rowsFor(table, filters, direction);
          const page = rows.slice(offset, offset + numItems);
          const nextOffset = offset + page.length;
          return {
            continueCursor: String(nextOffset),
            isDone: nextOffset >= rows.length,
            page,
          };
        },
        async take(limit) {
          return rowsFor(table, filters, direction).slice(0, limit);
        },
      };
      return chain;
    },
  };
  return { db, tables };
}

const state = makeDb();

const preview = await backfillMaterializedPublicationBatch._handler(
  { db: state.db },
  { cursor: null, dryRun: true, limit: 10 },
);
assert.equal(preview.updatedCount, 1);
assert.equal(state.tables.publicationMigrationState.size, 0);
assert.equal(
  state.tables.events.get("event_pending").publicationState,
  undefined,
  "Publication backfill preview must be read-only.",
);

const applied = await backfillMaterializedPublicationBatch._handler(
  { db: state.db },
  { cursor: null, dryRun: false, limit: 10 },
);
assert.equal(applied.isDone, true);
assert.equal(applied.mismatchCount, 0);
assert.equal(applied.phase, "audit");
assert.equal(state.tables.events.get("event_pending").publicationState, "hidden");

const audited = await auditMaterializedPublicationBatch._handler(
  { db: state.db },
  { limit: 10 },
);
assert.equal(audited.isDone, true);
assert.equal(audited.auditDriftCount, 0);
assert.equal(audited.phase, "ready_for_review");
assert.equal(await resolvePublicationReadMode({ db: state.db }), "compatibility");

let migrationState = [...state.tables.publicationMigrationState.values()][0];
const enabled = await reviewMaterializedPublicationReadCutover._handler(
  { db: state.db },
  {
    enable: true,
    expectedStateUpdatedAt: migrationState.updatedAt,
    note: "QA clean indexed publication review",
    reviewedBy: "qa-operator",
  },
);
assert.equal(enabled.phase, "cutover_enabled");
assert.equal(enabled.readCutoverEnabled, true);
assert.equal(await resolvePublicationReadMode({ db: state.db }), "materialized");
const materializedPageCursor = encodePublicationCursor("raw-page-1", "materialized");
assert.equal(
  decodePublicationCursor(materializedPageCursor, "materialized"),
  "raw-page-1",
);

await state.db.patch("topology", { currentEpoch: 8 });
assert.equal(
  await resolvePublicationReadMode({ db: state.db }),
  "compatibility",
  "Any source-topology drift must fail back to the live visibility path.",
);
assert.throws(
  () => decodePublicationCursor(materializedPageCursor, "compatibility"),
  /restart from the first page/iu,
  "A topology fallback must never feed a materialized-index cursor to the compatibility index.",
);
await state.db.patch("topology", { currentEpoch: 7 });

state.tables.venueIdentities.set("identity_after_audit", {
  _creationTime: 2,
  _id: "identity_after_audit",
  active: true,
  createdAt: 1,
  kind: "alias",
  normalizedValue: "qa venue",
  rawValue: "QA Venue",
  source: "manual",
  updatedAt: Date.now() + 1,
  venueId: "venue_qa",
});
migrationState = [...state.tables.publicationMigrationState.values()][0];
await assert.rejects(
  reviewMaterializedPublicationReadCutover._handler(
    { db: state.db },
    {
      enable: true,
      expectedStateUpdatedAt: migrationState.updatedAt,
      note: "QA dependency drift must fail",
      reviewedBy: "qa-operator",
    },
  ),
  /not clean/iu,
  "Venue-identity writes after the audit frontier must block cutover.",
);
state.tables.venueIdentities.clear();

migrationState = [...state.tables.publicationMigrationState.values()][0];
const disabled = await reviewMaterializedPublicationReadCutover._handler(
  { db: state.db },
  {
    enable: false,
    expectedStateUpdatedAt: migrationState.updatedAt,
    note: "QA indexed read rollback",
    reviewedBy: "qa-operator",
  },
);
assert.equal(disabled.readCutoverEnabled, false);
assert.equal(disabled.phase, "ready_for_review");
assert.equal(await resolvePublicationReadMode({ db: state.db }), "compatibility");

await state.db.patch("event_pending", { publicationState: "publishable" });
const driftedAudit = await auditMaterializedPublicationBatch._handler(
  { db: state.db },
  { limit: 10, restartCompleted: true },
);
assert.equal(driftedAudit.auditDriftCount, 1);
assert.equal(driftedAudit.phase, "blocked");
migrationState = [...state.tables.publicationMigrationState.values()][0];
await assert.rejects(
  reviewMaterializedPublicationReadCutover._handler(
    { db: state.db },
    {
      enable: true,
      expectedStateUpdatedAt: migrationState.updatedAt,
      note: "QA must reject drift",
      reviewedBy: "qa-operator",
    },
  ),
  /not clean/iu,
);

{
  const corrupted = makeDb();
  corrupted.tables.publicationMigrationState.set("corrupt_backfill", {
    _creationTime: 1,
    _id: "corrupt_backfill",
    auditDone: false,
    auditDriftCount: 0,
    auditScannedCount: 0,
    backfillDone: false,
    createdAt: 1,
    key: "materialized-publication-v1",
    mismatchCount: 0,
    phase: "backfill",
    policyVersion: 1,
    readCutoverEnabled: false,
    scannedCount: 1,
    updatedAt: 1,
    updatedCount: 1,
  });
  await assert.rejects(
    backfillMaterializedPublicationBatch._handler(
      { db: corrupted.db },
      { dryRun: false, limit: 10 },
    ),
    /no durable cursor/iu,
  );
  await corrupted.db.patch("corrupt_backfill", {
    auditCursor: undefined,
    auditDone: false,
    auditDriftCount: 0,
    auditScannedCount: 1,
    auditStartedAt: 10,
    backfillDone: true,
    mismatchCount: 0,
    phase: "audit",
  });
  await assert.rejects(
    auditMaterializedPublicationBatch._handler(
      { db: corrupted.db },
      { limit: 10 },
    ),
    /no durable cursor/iu,
  );
}

const publicReadsSource = readFileSync("convex/eventDomain/publicReads.ts", "utf8");
assert.match(publicReadsSource, /resolvePublicationReadMode/u);
assert.match(publicReadsSource, /by_publicationState_date/u);
assert.match(publicReadsSource, /isEventPubliclyVisible/u);
assert.match(publicReadsSource, /decodePublicationCursor/u);
assert.match(publicReadsSource, /encodePublicationCursor/u);

console.log(
  "Publication cutover QA passed (dry-run backfill, stable audit, explicit indexed-read review, topology fallback, rollback, and drift blocking).",
);
