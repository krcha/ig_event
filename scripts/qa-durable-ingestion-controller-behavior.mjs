import assert from "node:assert/strict";

// This deliberately calls the registered Convex mutation handlers through a
// tiny in-memory DB.  Static source checks are useful, but they cannot prove
// that queueing, leases, chunks, and terminal accounting keep their promises
// together when a run is interrupted.
process.env.CRON_SECRET = "qa-durable-controller-secret";

const {
  queueRun,
  executeNext,
  completeReceipt,
  releaseReceiptForRetry,
  markReceiptPostsPersisted,
} = await import("../convex/durableIngestionRuns.ts");

class MemoryDb {
  #tables = new Map();
  #sequence = 0;

  table(name) {
    if (!this.#tables.has(name)) this.#tables.set(name, new Map());
    return this.#tables.get(name);
  }

  async insert(table, value) {
    const id = `${table}:${++this.#sequence}`;
    this.table(table).set(id, { _id: id, ...structuredClone(value) });
    return id;
  }

  async get(id) {
    for (const table of this.#tables.values()) {
      const row = table.get(id);
      if (row) return structuredClone(row);
    }
    return null;
  }

  async patch(id, value) {
    for (const table of this.#tables.values()) {
      const row = table.get(id);
      if (row) {
        table.set(id, { ...row, ...structuredClone(value) });
        return;
      }
    }
    throw new Error(`Unknown row ${id}`);
  }

  query(tableName) {
    const db = this;
    const conditions = [];
    const query = {
      withIndex(_name, callback) {
        const builder = {
          eq(field, value) {
            conditions.push((row) => row[field] === value);
            return builder;
          },
          lte(field, value) {
            conditions.push((row) => row[field] !== undefined && row[field] <= value);
            return builder;
          },
        };
        callback(builder);
        return query;
      },
      order(direction) {
        query.direction = direction;
        return query;
      },
      rows() {
        const rows = [...db.table(tableName).values()].filter((row) => conditions.every((test) => test(row)));
        rows.sort((a, b) => String(a._id).localeCompare(String(b._id)) * (query.direction === "desc" ? -1 : 1));
        return rows.map((row) => structuredClone(row));
      },
      async take(limit) { return query.rows().slice(0, limit); },
      async first() { return query.rows()[0] ?? null; },
    };
    return query;
  }

  rows(table) {
    return [...this.table(table).values()].map((row) => structuredClone(row));
  }
}

function ctx(db) {
  return { db, auth: { getUserIdentity: async () => null } };
}

async function queue(db, mode, handles, { resumeDaily = false } = {}) {
  return queueRun._handler(ctx(db), {
    mode,
    sourceSnapshotKey: `snapshot:${mode}`,
    handles,
    resumeDaily,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function claim(db, runId, workerId) {
  return executeNext._handler(ctx(db), { runId, workerId, serviceSecret: process.env.CRON_SECRET });
}

async function complete(db, runId, receiptId, workerId, outcome) {
  return completeReceipt._handler(ctx(db), {
    runId,
    receiptId,
    workerId,
    outcome,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function releaseForProcessingLease(db, runId, receiptId, workerId) {
  return releaseReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId,
    workerId,
    reason: "Saved post processing is busy; retry this saved post later.",
    retryAfterMs: 30_000,
    preserveAttempt: true,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function markPersisted(db, runId, receiptId, workerId, postCount) {
  return markReceiptPostsPersisted._handler(ctx(db), {
    runId,
    receiptId,
    workerId,
    postCount,
    serviceSecret: process.env.CRON_SECRET,
  });
}

const handles = Array.from({ length: 632 }, (_, index) => `venue_${String(index).padStart(3, "0")}`);

// The canary contract is exact: sixteen frozen rows and no room for a broad
// paid request to appear because a caller supplied too many handles.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const run = await db.get(runId);
  assert.equal(run.selectedHandleCount, 16);
  assert.equal(run.controls.budgetMicros, 160_000);
  assert.equal(run.controls.daysBack, 1);
  assert.equal(db.rows("ingestionRunHandleReceipts").length, 16);
  await assert.rejects(() => queue(db, "canary", handles.slice(0, 17)), /already active|exactly 16/i);

  // Convex retries conflicting mutations transactionally. Claim sequentially in
  // this deterministic harness, which verifies the persisted semaphore state
  // that those concurrent transactions contend on.
  const claims = [];
  for (let index = 0; index < 8; index += 1) claims.push(await claim(db, runId, `worker-${index}`));
  assert.equal(claims.filter(Boolean).length, 8, "eight slots must be claimable concurrently");
  assert.equal(await claim(db, runId, "worker-overflow"), null, "ninth worker must not exceed the semaphore");

  // A restarted worker must requeue an expired lease, then continue it rather
  // than losing the selected venue.
  const expired = db.rows("ingestionRunHandleReceipts").find((row) => row.status === "running");
  await db.patch(expired._id, { leaseExpiresAt: Date.now() - 1 });
  assert.equal(await claim(db, runId, "recovery"), null);
  assert.equal((await db.get(expired._id)).status, "queued");
  assert.ok(await claim(db, runId, "recovery-next"));

}

// A release upgrade must resume an already-paid canary receipt row that
// predates retryNotBeforeAt. It must not require a second paid canary.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  for (const queued of db.rows("ingestionRunHandleReceipts").slice(1)) {
    await db.patch(queued._id, { retryNotBeforeAt: Date.now() + 60_000 });
  }
  const legacyQueued = db.rows("ingestionRunHandleReceipts")[0];
  await db.patch(legacyQueued._id, { retryNotBeforeAt: undefined, providerAttemptCount: 1, chargedMicros: 10_000 });
  const resumed = await claim(db, runId, "legacy-recovery");
  assert.ok(resumed);
  assert.equal(resumed.receiptId, legacyQueued._id);
  assert.equal(resumed.providerAttemptCount, 1, "resumed work must retain its original paid attempt");
}

// A crash after the paid provider boundary but before persistence has no proof
// of a saved post. The executor must see an explicit unconfirmed state, never
// convert it to `fetched`, and never make a second paid request automatically.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  for (const queued of db.rows("ingestionRunHandleReceipts").slice(1)) {
    await db.patch(queued._id, { retryNotBeforeAt: Date.now() + 60_000 });
  }
  const first = await claim(db, runId, "crash-boundary-worker");
  assert.ok(first);
  await db.patch(first.receiptId, { providerAttemptCount: 1, chargedMicros: 10_000 });
  await releaseReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId: first.receiptId,
    workerId: "crash-boundary-worker",
    reason: "worker_restart",
    serviceSecret: process.env.CRON_SECRET,
  });
  const resumed = await claim(db, runId, "crash-boundary-recovery");
  assert.ok(resumed);
  assert.equal(resumed.providerAttemptCount, 1);
  assert.equal(resumed.providerResultStatus, undefined, "a charged request alone cannot claim saved posts");
}

// The persistence marker is only accepted from the currently leased receipt.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const first = await claim(db, runId, "persisted-worker");
  assert.ok(first);
  await db.patch(first.receiptId, { providerAttemptCount: 1, chargedMicros: 10_000 });
  await markPersisted(db, runId, first.receiptId, "persisted-worker", 1);
  assert.equal((await db.get(first.receiptId)).providerResultStatus, "persisted");
}

// A paid fetch can finish while another worker owns the saved post's AI
// lease. This is not a failed provider attempt: keep the durable receipt
// non-terminal, defer its retry, and resume without consuming the retry cap.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const first = await claim(db, runId, "ai-busy-worker");
  assert.ok(first);
  await db.patch(first.receiptId, { providerAttemptCount: 1, chargedMicros: 10_000 });
  await releaseForProcessingLease(db, runId, first.receiptId, "ai-busy-worker");
  const deferred = await db.get(first.receiptId);
  assert.equal(deferred.status, "queued");
  assert.equal(deferred.attemptCount, 0, "AI lease waiting must not exhaust controller retries");
  assert.equal(deferred.providerAttemptCount, 1, "the paid fetch must remain recorded");
  assert.ok(deferred.retryNotBeforeAt > Date.now(), "AI lease waiting needs a bounded backoff");
}

// A clean "no post" response is terminal and must advance run completion;
// this distinguishes a real empty provider result from a retryable error.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  for (let index = 0; index < 16; index += 1) {
    const workerId = `no-post-${index}`;
    const receipt = await claim(db, runId, workerId);
    assert.ok(receipt, "each selected canary profile must receive a receipt");
    await complete(db, runId, receipt.receiptId, workerId, "no_post");
  }
  const run = await db.get(runId);
  assert.equal(run.status, "completed");
  assert.equal(run.terminalReceiptCount, 16);
  assert.equal(db.rows("ingestionRunHandleReceipts").filter((row) => row.status === "no_post").length, 16);
}

// Catch-up is one all-profile snapshot with no time cutoff/checkpoint.  Daily
// remains an isolated 24-hour mode and must not inherit catch-up bypasses.
{
  const catchUpDb = new MemoryDb();
  const runId = await queue(catchUpDb, "catch_up", handles);
  const run = await catchUpDb.get(runId);
  assert.equal(run.selectedHandleCount, 632);
  assert.equal(run.controls.daysBack, undefined);
  assert.equal(run.controls.ignoreCheckpoint, true);
  assert.equal(run.controls.ignoreCooldown, true);
  assert.equal(catchUpDb.rows("ingestionRunChunks").length, 2, "632 profiles must be chunked durably");

  const dailyDb = new MemoryDb();
  const dailyId = await queue(dailyDb, "daily", handles);
  const daily = await dailyDb.get(dailyId);
  assert.equal(daily.controls.daysBack, 1);
  assert.equal(daily.controls.ignoreCheckpoint, false);
  assert.equal(daily.controls.ignoreCooldown, false);
  assert.equal(
    await queue(dailyDb, "daily", [...handles].reverse(), { resumeDaily: true }),
    dailyId,
    "a restart must resume the frozen daily checklist, not create another paid run",
  );
}

// Retry accounting must be explicit. The controller must mark a provider
// attempt immediately before the outbound request and charge it exactly once;
// a release-for-retry must never make a second paid request look free.
const controllerSource = await (await import("node:fs/promises")).readFile("convex/durableIngestionRuns.ts", "utf8");
const executorSource = await (await import("node:fs/promises")).readFile("app/api/cron/durable-ingestion/execute/route.ts", "utf8");
assert.ok(/markReceiptProviderAttemptStarted/.test(controllerSource), "controller needs a durable pre-transport attempt receipt");
assert.ok(/convex\.mutation\(markProviderAttempt,[\s\S]{0,1800}scrapeInstagramAccount/.test(executorSource), "executor must write that receipt before Apify is called");
assert.ok(/providerAttemptCount/.test(controllerSource), "each receipt must retain its provider attempt count");

// When a frozen budget cannot admit a remaining selected profile, the run must
// finish with an auditable deferred receipt. Leaving it queued forever makes a
// completed all-profile claim impossible after restart.
assert.ok(/status:\s*["']deferred["'][\s\S]{0,500}budget_exhausted/.test(controllerSource), "budget exhaustion must create a terminal deferred outcome");

console.log("Durable ingestion controller behavioral QA passed.");
