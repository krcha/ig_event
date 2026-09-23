import assert from "node:assert/strict";
import {
  RETENTION_RECEIPT_COVERAGE_KEY,
  advanceRetentionReceiptCoverage,
  assertCompleteRetentionReceiptCoverage,
  auditRetentionReceiptCoverageBatch,
  loadCompleteRetentionReceiptReferences,
} from "../convex/internal/retentionReceiptCoverage.ts";

const receipt = (id, eventIds = ["event-1"]) => ({
  _id: id, _creationTime: 1, sourceIdentity: `source-${id}`, sourceFingerprint: `fingerprint-${id}`,
  expectedKeys: eventIds.map((_, index) => `child-${index}`),
  expectedOccurrences: eventIds.map((_, index) => ({
    key: `child-${index}`, date: "2026-09-01", time: "20:00", venue: "Venue", title: "Event", artists: [],
  })),
  satisfiedKeys: eventIds.map((_, index) => `child-${index}`),
  satisfiedOccurrences: eventIds.map((eventId, index) => ({ key: `child-${index}`, eventId })),
  deferredChildKeys: [], deferredChildCount: 0, createdAt: 1, updatedAt: 1,
});

function database(initial = {}) {
  let sequence = 1000;
  const tables = new Map(Object.entries({
    events: [{ _id: "event-1", _creationTime: 1 }],
    instagramSourceOccurrenceReceipts: [receipt("receipt-1")],
    sourceOccurrenceTopologyEpoch: [{
      _id: "epoch", key: "source-occurrence-topology-v1", currentEpoch: 10,
      verifiedEpoch: 4, lastUnverifiedEpoch: 10, createdAt: 1, updatedAt: 1,
    }],
    eventDomainMigrationState: [], eventRetentionReceiptReferences: [], ...initial,
  }).map(([name, rows]) => [name, structuredClone(rows)]));
  const writes = [];
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const get = (id) => [...tables.values()].flat().find((row) => row._id === id) ?? null;
  const db = {
    async get(id) { return structuredClone(get(id)); },
    query(name) {
      const filters = [];
      const ordered = () => table(name).filter((row) => filters.every(([key, value]) => row[key] === value))
        .sort((a, b) => a._id.localeCompare(b._id));
      const query = {
        withIndex(_index, build) {
          const q = { eq(key, value) { filters.push([key, value]); return q; } };
          build(q); return query;
        },
        order(direction) { assert.equal(direction, "asc"); return query; },
        async take(count) { return structuredClone(ordered().slice(0, count)); },
        async paginate({ cursor, numItems }) {
          const rows = ordered().filter((row) => !cursor || row._id.localeCompare(cursor) > 0);
          const page = rows.slice(0, numItems);
          return { page: structuredClone(page), continueCursor: page.at(-1)?._id ?? cursor ?? "", isDone: rows.length <= numItems };
        },
      };
      return query;
    },
    async insert(name, value) {
      const id = `${name}-${++sequence}`;
      table(name).push({ _id: id, _creationTime: sequence, ...structuredClone(value) });
      writes.push({ table: name, operation: "insert", id }); return id;
    },
    async patch(id, value) {
      const row = get(id); assert.ok(row, `missing patch ${id}`);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) delete row[key]; else row[key] = structuredClone(item);
      }
      writes.push({ operation: "patch", id });
    },
    async delete(id) {
      for (const rows of tables.values()) {
        const index = rows.findIndex((row) => row._id === id);
        if (index >= 0) { rows.splice(index, 1); writes.push({ operation: "delete", id }); return; }
      }
      throw new Error(`missing delete ${id}`);
    },
  };
  return { db, table, writes };
}

const audit = (ctx, args = {}) => auditRetentionReceiptCoverageBatch._handler(ctx, args);
async function finish(ctx) {
  for (let count = 0; count < 100; count += 1) {
    const result = await audit(ctx);
    if (result.isDone) return result;
  }
  throw new Error("Audit did not finish within deterministic bound");
}

assert.equal(auditRetentionReceiptCoverageBatch.isInternal, true);
assert.equal(auditRetentionReceiptCoverageBatch.isMutation, true);
assert.equal(JSON.parse(auditRetentionReceiptCoverageBatch.exportReturns()).type, "object");

{
  const ctx = database({ instagramSourceOccurrenceReceipts: [
    receipt("r-1", ["event-1", "event-1", "missing-event"]),
    ...Array.from({ length: 8 }, (_, index) => receipt(`r-${index + 2}`)),
  ] });
  const beforeReceipts = structuredClone(ctx.table("instagramSourceOccurrenceReceipts"));
  const originalEpoch = structuredClone(ctx.table("sourceOccurrenceTopologyEpoch"));
  await assert.rejects(assertCompleteRetentionReceiptCoverage(ctx), /waiting/);
  const first = await audit(ctx, { limit: 500 });
  assert.equal(first.scannedCount, 4, "native receipt work has a hard cap");
  assert.equal(first.ready, false);
  assert.equal(first.missingEventReferenceCount, 1);
  const second = await audit(ctx);
  assert.equal(second.scannedCount, 8, "new invocation resumes durable cursor");
  const receiptEnd = await audit(ctx);
  assert.equal(receiptEnd.phase, "retention_reference_sweep");
  assert.equal(receiptEnd.ready, false, "full receipt scan alone does not certify old index rows");
  const completed = await audit(ctx);
  assert.equal(completed.ready, true);
  assert.equal(completed.scannedCount, 9);
  assert.equal(completed.indexedReferenceCount, 9, "one reverse row per event/receipt, not child");
  const proof = await assertCompleteRetentionReceiptCoverage(ctx);
  const references = await loadCompleteRetentionReceiptReferences(ctx, "event-1", proof);
  assert.equal(references.receipts.length, 9);
  assert.equal(references.referenceRows.length, 9);
  assert.deepEqual(ctx.table("instagramSourceOccurrenceReceipts"), beforeReceipts);
  assert.deepEqual(ctx.table("sourceOccurrenceTopologyEpoch"), originalEpoch, "never launder semantic verification");
  assert.equal(ctx.table("eventDomainMigrationState")[0].key, RETENTION_RECEIPT_COVERAGE_KEY);
  const writes = ctx.writes.length;
  assert.equal((await audit(ctx)).ready, true);
  assert.equal(ctx.writes.length, writes, "ready exact-epoch coverage is a read-only fast path");

  // Simulate the expiry transaction's already-validated topology mutation.
  ctx.table("sourceOccurrenceTopologyEpoch")[0].currentEpoch = 11;
  await advanceRetentionReceiptCoverage(ctx, proof);
  const advanced = await assertCompleteRetentionReceiptCoverage(ctx);
  assert.equal(advanced.topologyEpoch, 11);
  assert.equal(advanced.auditGeneration, proof.auditGeneration);
  assert.equal(ctx.table("sourceOccurrenceTopologyEpoch")[0].verifiedEpoch, 4);
  await assert.rejects(loadCompleteRetentionReceiptReferences(ctx, "event-1", proof), /stale/);
  assert.equal((await loadCompleteRetentionReceiptReferences(ctx, "event-1", advanced)).receipts.length, 9);
}

{
  const ctx = database({ instagramSourceOccurrenceReceipts: [
    receipt("receipt-a"), receipt("receipt-b"), receipt("receipt-c"), receipt("receipt-d"), receipt("receipt-e"),
  ] });
  const first = await audit(ctx);
  const epoch = ctx.table("sourceOccurrenceTopologyEpoch")[0];
  epoch.currentEpoch += 1;
  ctx.table("instagramSourceOccurrenceReceipts").splice(0, 1);
  const restarted = await audit(ctx);
  assert.equal(restarted.restarted, true);
  assert.equal(restarted.scannedCount, 4, "old scan count must reset after topology writes");
  assert.ok(restarted.auditGeneration > first.auditGeneration, "generation is strictly monotonic even same millisecond");
  assert.equal((await finish(ctx)).ready, true);
  assert.equal(ctx.table("eventRetentionReceiptReferences").length, 4);
  assert.ok(ctx.table("eventRetentionReceiptReferences").every((row) => row.auditGeneration === restarted.auditGeneration));
}

for (const invalid of ["shape", "duplicate_identity"]) {
  const first = receipt("a");
  const second = receipt("b");
  if (invalid === "shape") first.satisfiedKeys = [];
  else second.sourceIdentity = first.sourceIdentity;
  const ctx = database({ instagramSourceOccurrenceReceipts: [first, second] });
  const result = await finish(ctx);
  assert.equal(result.ready, false);
  assert.equal(result.phase, "retention_reference_blocked");
  assert.ok(result.mismatchCount > 0);
  const details = JSON.parse(ctx.table("eventDomainMigrationState")[0].auditDetailsJson);
  assert.ok(details.mismatchExamples.length > 0);
  await assert.rejects(assertCompleteRetentionReceiptCoverage(ctx), /waiting/);
}

{
  const ctx = database(); await finish(ctx);
  const proof = await assertCompleteRetentionReceiptCoverage(ctx);
  ctx.table("instagramSourceOccurrenceReceipts")[0].satisfiedOccurrences = [];
  ctx.table("instagramSourceOccurrenceReceipts")[0].satisfiedKeys = [];
  await assert.rejects(loadCompleteRetentionReceiptReferences(ctx, "event-1", proof), /stale/);
}

{
  const ctx = database({ instagramSourceOccurrenceReceipts: Array.from({ length: 65 }, (_, index) => receipt(`r-${index}`)) });
  await finish(ctx);
  const proof = await assertCompleteRetentionReceiptCoverage(ctx);
  await assert.rejects(loadCompleteRetentionReceiptReferences(ctx, "event-1", proof), /bounded/);
}

{
  const stale = Array.from({ length: 205 }, (_, index) => ({
    _id: `stale-${String(index).padStart(3, "0")}`, receiptId: "missing", eventId: "event-1",
    auditGeneration: 1, createdAt: 1, updatedAt: 1,
  }));
  const ctx = database({ eventRetentionReceiptReferences: stale });
  await audit(ctx);
  const sweep = await audit(ctx);
  assert.equal(sweep.ready, false);
  assert.ok(sweep.sweptReferenceCount <= 100);
  const result = await finish(ctx);
  assert.equal(result.ready, true);
  assert.equal(result.sweptReferenceCount, 205);
  assert.equal(ctx.table("eventRetentionReceiptReferences").length, 1);
}

console.log("Retention reverse-receipt coverage QA passed (bounded, epoch-fenced, no network or production writes).");
