import assert from "node:assert/strict";

// This deliberately calls the registered Convex mutation handlers through a
// tiny in-memory DB.  Static source checks are useful, but they cannot prove
// that queueing, leases, chunks, and terminal accounting keep their promises
// together when a run is interrupted.
process.env.CRON_SECRET = "qa-durable-controller-secret";

const {
  queueRun,
  buildQueueBatch,
  executeNext,
  completeReceipt,
  releaseReceiptForRetry,
  markReceiptProviderAttemptStarted,
  markReceiptPostsPersisted,
  claimNextProcessingReceipt,
  releaseProcessingReceiptForRetry,
  completeProcessingReceipt,
  prepareReceiptSlotsBatch,
  linkPersistedReceiptPostForRecovery,
  abortInactiveRun,
  abortOnlyInactiveCatchUpRun,
  getCanaryAccounting,
} = await import("../convex/durableIngestionRuns.ts");
const { createEvent } = await import("../convex/events.ts");
const { refreshAndAttach } = await import("../convex/mediaAssets.ts");
const { recordProcessingResult } = await import("../convex/scrapedPosts.ts");

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
          gte(field, value) {
            conditions.push((row) => row[field] !== undefined && row[field] >= value);
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
      async collect() { return query.rows(); },
      async unique() {
        const rows = query.rows();
        if (rows.length > 1) throw new Error(`Expected one ${tableName} row, received ${rows.length}.`);
        return rows[0] ?? null;
      },
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
  const runId = await queueRun._handler(ctx(db), {
    mode,
    sourceSnapshotKey: `snapshot:${mode}`,
    handles,
    resumeDaily,
    serviceSecret: process.env.CRON_SECRET,
  });
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const result = await buildQueueBatch._handler(ctx(db), {
      runId,
      serviceSecret: process.env.CRON_SECRET,
    });
    if (result.complete) return runId;
  }
  throw new Error("Queue construction did not finish in bounded QA loop.");
}

async function createBuildingRun(db, mode, handles, { resumeDaily = false } = {}) {
  return queueRun._handler(ctx(db), {
    mode,
    sourceSnapshotKey: `snapshot:${mode}`,
    handles,
    resumeDaily,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function claim(db, runId, workerId) {
  const slot = Number(workerId.match(/(\d+)/)?.[1] ?? 0) % 6;
  return executeNext._handler(ctx(db), { runId, workerId, workerSlot: slot, serviceSecret: process.env.CRON_SECRET });
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

async function claimProcessing(db, runId, workerId) {
  return claimNextProcessingReceipt._handler(ctx(db), {
    runId,
    workerId,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function startProviderAttempt(db, runId, receiptId, workerId) {
  return markReceiptProviderAttemptStarted._handler(ctx(db), {
    runId,
    receiptId,
    workerId,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function insertSavedPost(db, handle, overrides = {}) {
  const now = Date.now();
  return db.insert("scrapedPosts", {
    handle,
    postId: `${handle}-post`,
    imageUrls: [],
    instagramPostUrl: `https://www.instagram.com/p/${handle}-post/`,
    username: handle,
    sourceRevision: 1,
    processingStatus: "pending",
    processingAttempts: 0,
    blocksPaidFetch: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function markPersisted(db, runId, receiptId, workerId, scrapedPostId) {
  const post = await db.get(scrapedPostId);
  return markReceiptPostsPersisted._handler(ctx(db), {
    runId,
    receiptId,
    workerId,
    postCount: 1,
    scrapedPostId,
    scrapedPostSourceRevision: post.sourceRevision ?? 1,
    postId: post.postId,
    instagramPostUrl: post.instagramPostUrl,
    processingProtocolVersion: 1,
    serviceSecret: process.env.CRON_SECRET,
  });
}

async function linkPersistedPost(db, runId, receiptId, scrapedPostId) {
  return linkPersistedReceiptPostForRecovery._handler(ctx(db), {
    runId,
    receiptId,
    scrapedPostId,
    serviceSecret: process.env.CRON_SECRET,
  });
}

const handles = Array.from({ length: 632 }, (_, index) => `venue_${String(index).padStart(3, "0")}`);

// A large snapshot is created as a durable parent first, then materialized in
// small idempotent transactions. A crash between batches neither creates a
// second run nor permits an executor to make a provider call early.
{
  const db = new MemoryDb();
  const fullHandles = Array.from({ length: 633 }, (_, index) => `full_${String(index).padStart(3, "0")}`);
  const runId = await createBuildingRun(db, "catch_up", fullHandles);
  assert.equal((await db.get(runId)).status, "building");
  assert.equal(await claim(db, runId, "must-not-fetch"), null, "building run must not expose provider work");
  const first = await buildQueueBatch._handler(ctx(db), { runId, serviceSecret: process.env.CRON_SECRET });
  assert.equal(first.builtCount, 32, "construction must be bounded");
  assert.equal(db.rows("ingestionRunHandleReceipts").length, 32);
  // Retrying the initial queue call after a client crash returns this same
  // frozen parent. It must not create a second receipt set.
  assert.equal(await createBuildingRun(db, "catch_up", fullHandles), runId);
  let built = first;
  while (!built.complete) {
    built = await buildQueueBatch._handler(ctx(db), { runId, serviceSecret: process.env.CRON_SECRET });
  }
  assert.equal(built.builtCount, 633);
  assert.equal(db.rows("ingestionRunHandleReceipts").length, 633, "exact snapshot receipt coverage is required before execution");
  assert.equal((await db.get(runId)).status, "queued");
}

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

  // Each concurrent host worker owns one fixed lane. They do not contend for
  // the same first queued receipt or a shared run counter.
  const claims = [];
  for (let index = 0; index < 6; index += 1) claims.push(await claim(db, runId, `worker-${index}`));
  assert.equal(claims.filter(Boolean).length, 6, "six fixed lanes must be claimable concurrently");
  assert.equal(new Set(claims.filter(Boolean).map((claim) => claim.receiptId)).size, 6, "concurrent lanes must never double-claim a receipt");
  assert.equal(await claim(db, runId, "worker-overflow"), null, "ninth worker must not exceed the semaphore");

  // A restarted worker must requeue an expired lease, then continue it rather
  // than losing the selected venue.
  const expired = db.rows("ingestionRunHandleReceipts").find((row) => row.status === "running");
  await db.patch(expired._id, { leaseExpiresAt: Date.now() - 1 });
  assert.equal(await claim(db, runId, `worker-${expired.executionSlot}`), null);
  assert.equal((await db.get(expired._id)).status, "queued");
  assert.ok(await claim(db, runId, `worker-${expired.executionSlot}`));

}

// An already-started run from the preceding release has five provider-paid
// receipts. The lane migration must preserve those receipts and make the run
// dispatchable without re-fetching them. Six workers can then claim distinct
// remaining receipts without an OCC-prone shared queue head.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const receipts = db.rows("ingestionRunHandleReceipts");
  const savedPostIds = new Map();
  for (const receipt of receipts) await db.patch(receipt._id, { executionSlot: undefined });
  await db.patch(runId, { dispatchReadyAt: undefined });
  for (const receipt of receipts.slice(0, 5)) {
    savedPostIds.set(receipt._id, await insertSavedPost(db, receipt.handle));
    await db.patch(receipt._id, {
      providerAttemptCount: 1,
      chargedMicros: 10_000,
      providerResultStatus: "persisted",
      persistedPostCount: 1,
      updatedAt: Date.now() + 1,
    });
  }
  let prepared;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    prepared = await prepareReceiptSlotsBatch._handler(ctx(db), { runId, serviceSecret: process.env.CRON_SECRET });
    if (prepared.complete) break;
  }
  assert.equal(prepared.complete, true, "legacy receipt lanes must finish in bounded batches");
  assert.equal((await db.get(runId)).dispatchReadyAt !== undefined, true);
  const migrated = db.rows("ingestionRunHandleReceipts");
  assert.equal(migrated.filter((receipt) => receipt.executionSlot === undefined).length, 0);
  assert.equal(migrated.filter((receipt) => receipt.providerAttemptCount === 1).length, 5, "paid attempts must survive lane migration");
  const claims = await Promise.all(Array.from({ length: 6 }, (_, slot) => claim(db, runId, `lane-${slot}`)));
  assert.equal(
    claims.filter(Boolean).every((claimResult) => claimResult.providerAttemptCount === 0),
    true,
    "a paid persisted legacy receipt must never re-enter a fetch lane",
  );
  assert.equal(
    db.rows("ingestionRunHandleReceipts").filter((receipt) => receipt.status === "processing_pending").length,
    5,
    "fetch lanes must migrate all already-paid live receipts to the AI queue",
  );
  const processing = await claimProcessing(db, runId, "legacy-ai-consumer");
  assert.equal(processing, null, "an unlinked legacy receipt must never guess a post from timestamps");
  const recoveredReceipt = db
    .rows("ingestionRunHandleReceipts")
    .find((candidate) => candidate.providerAttemptCount === 1);
  await linkPersistedPost(
    db,
    runId,
    recoveredReceipt._id,
    savedPostIds.get(recoveredReceipt._id),
  );
  const exactProcessing = await claimProcessing(db, runId, "legacy-ai-consumer");
  assert.ok(exactProcessing, "authenticated exact-ID recovery must make legacy work claimable");
  assert.equal(exactProcessing.scrapedPostId, savedPostIds.get(recoveredReceipt._id));
  assert.equal(exactProcessing.providerAttemptCount, 1, "AI recovery must retain the original paid attempt");
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
  const wrongCandidate = await insertSavedPost(db, legacyQueued.handle, {
    postId: "legacy-wrong-post",
    instagramPostUrl: "https://www.instagram.com/p/legacy-wrong-post/",
  });
  const exactCandidate = await insertSavedPost(db, legacyQueued.handle, {
    postId: "legacy-exact-post",
    instagramPostUrl: "https://www.instagram.com/p/legacy-exact-post/",
  });
  await db.patch(legacyQueued._id, {
    retryNotBeforeAt: undefined,
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    chargedMicros: 10_000,
    updatedAt: Date.now() + 1,
  });
  const resumed = await claim(db, runId, "legacy-recovery");
  assert.equal(resumed, null, "the fetch selector must divert a persisted receipt to processing");
  assert.equal(
    await claimProcessing(db, runId, "legacy-processing-before-link"),
    null,
    "multiple same-handle posts must not be resolved by recency",
  );
  assert.equal((await db.get(legacyQueued._id)).scrapedPostId, undefined);
  await linkPersistedPost(db, runId, legacyQueued._id, exactCandidate);
  const processing = await claimProcessing(db, runId, "legacy-processing");
  assert.equal(processing.receiptId, legacyQueued._id);
  assert.equal(processing.scrapedPostId, exactCandidate, "only the operator-attested exact ID may be claimed");
  assert.notEqual(processing.scrapedPostId, wrongCandidate);
  assert.equal(processing.providerAttemptCount, 1, "resumed work must retain its original paid attempt");
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
  assert.equal(resumed, null);
  const uncertain = await db.get(first.receiptId);
  assert.equal(uncertain.status, "deferred");
  assert.equal(uncertain.outcomeDetail, "provider_attempt_persistence_unconfirmed");
  assert.equal(uncertain.providerAttemptCount, 1);
}

// If persistence committed but its receipt marker did not, the exact-ID
// attestation path can recover the charged boundary without an Apify replay or
// a manual database edit. Timing and source revision are captured atomically.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["persistence_marker_crash"]);
  const fetched = await claim(db, runId, "marker-crash-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "marker-crash-fetch");
  const exactSavedPostId = await insertSavedPost(db, fetched.handle);
  await complete(db, runId, fetched.receiptId, "marker-crash-fetch", "deferred");
  await db.patch(fetched.receiptId, {
    outcomeDetail: "provider_attempt_persistence_unconfirmed",
    updatedAt: Date.now() + 1,
  });
  assert.equal(await claimProcessing(db, runId, "unattested-consumer"), null);
  const attested = await linkPersistedPost(db, runId, fetched.receiptId, exactSavedPostId);
  assert.equal(attested.reopened, true);
  const recovered = await claimProcessing(db, runId, "attested-consumer");
  assert.equal(recovered.scrapedPostId, exactSavedPostId);
  assert.equal(recovered.providerAttemptCount, 1);
  assert.equal(recovered.scrapedPostSourceRevision, 1);
}

// Provider evidence is classified before receipt retry exhaustion. A crash on
// the third claim must preserve a durable no-post truth and an unconfirmed
// charged boundary instead of misreporting either as a generic failure.
for (const boundary of ["no_post", "unconfirmed"]) {
  const db = new MemoryDb();
  const runId = await queue(db, "daily", [`third_claim_${boundary}`]);
  const fetched = await claim(db, runId, `third-${boundary}-fetch`);
  await startProviderAttempt(db, runId, fetched.receiptId, `third-${boundary}-fetch`);
  if (boundary === "no_post") {
    await markReceiptPostsPersisted._handler(ctx(db), {
      runId,
      receiptId: fetched.receiptId,
      workerId: `third-${boundary}-fetch`,
      postCount: 0,
      serviceSecret: process.env.CRON_SECRET,
    });
  }
  await db.patch(fetched.receiptId, {
    attemptCount: 3,
    leaseExpiresAt: Date.now() - 1,
  });
  assert.equal(await claim(db, runId, `third-${boundary}-recovery`), null);
  const terminal = await db.get(fetched.receiptId);
  assert.equal(terminal.status, boundary === "no_post" ? "no_post" : "deferred");
  assert.notEqual(terminal.status, "failed");
  assert.equal(terminal.providerAttemptCount, 1);
}

// A live receipt terminalized by the immediately preceding busy-AI patch must
// stay terminal until an authenticated caller supplies the exact saved row.
// Same-handle recency is not immutable identity and must never be inferred.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["legacy_deferred_ai"]);
  const receipt = db.rows("ingestionRunHandleReceipts")[0];
  const savedPostId = await insertSavedPost(db, receipt.handle);
  await db.patch(receipt._id, {
    status: "deferred",
    providerAttemptCount: 1,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    chargedMicros: 10_000,
    outcomeDetail: "OpenAI provider execution lease is busy; retry this saved post later.",
    terminalAt: Date.now(),
    updatedAt: Date.now() + 1,
  });
  await db.patch(runId, {
    status: "completed",
    terminalReceiptCount: 1,
    finishedAt: Date.now(),
  });
  const recovered = await claimProcessing(db, runId, "legacy-deferred-consumer");
  assert.equal(recovered, null, "unlinked deferred work must not be reopened by timestamp inference");
  assert.equal((await db.get(receipt._id)).status, "deferred");
  await linkPersistedPost(db, runId, receipt._id, savedPostId);
  const exactRecovered = await claimProcessing(db, runId, "legacy-deferred-consumer");
  assert.ok(exactRecovered, "the exact-ID recovery must reopen deferred saved-post work");
  assert.equal(exactRecovered.scrapedPostId, savedPostId);
  assert.equal(exactRecovered.providerAttemptCount, 1);
  assert.equal((await db.get(receipt._id)).status, "processing");
  assert.equal((await db.get(runId)).status, "queued");
}

// Exact-ID recovery of a completed run is new admission. It must refuse to
// overlap a newer active run; recovery inside the already-active queued run
// remains valid and does not require a second provider call.
{
  const db = new MemoryDb();
  const completedRunId = await queue(db, "daily", ["completed_recovery"]);
  const completedFetch = await claim(db, completedRunId, "completed-recovery-fetch");
  await startProviderAttempt(
    db,
    completedRunId,
    completedFetch.receiptId,
    "completed-recovery-fetch",
  );
  const completedPostId = await insertSavedPost(db, completedFetch.handle);
  await complete(
    db,
    completedRunId,
    completedFetch.receiptId,
    "completed-recovery-fetch",
    "deferred",
  );
  await db.patch(completedFetch.receiptId, {
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    scrapedPostId: completedPostId,
    scrapedPostSourceRevision: 1,
    outcomeDetail: "OpenAI provider execution lease is busy; retry this saved post later.",
  });
  assert.equal((await db.get(completedRunId)).status, "completed");

  const activeRunId = await queue(db, "catch_up", ["active_recovery"]);
  assert.equal(
    await claimProcessing(db, completedRunId, "late-completed-runner"),
    null,
    "an old runner must not automatically resurrect a completed linked receipt",
  );
  assert.equal((await db.get(completedFetch.receiptId)).status, "deferred");
  assert.equal((await db.get(completedRunId)).status, "completed");
  await assert.rejects(
    () => linkPersistedPost(
      db,
      completedRunId,
      completedFetch.receiptId,
      completedPostId,
    ),
    /another durable ingestion run is already active/i,
    "completed-run recovery must not bypass global paid-run admission",
  );
  assert.equal((await db.get(completedFetch.receiptId)).status, "deferred");
  assert.equal((await db.get(completedRunId)).status, "completed");

  const activeFetch = await claim(db, activeRunId, "active-recovery-fetch");
  await startProviderAttempt(db, activeRunId, activeFetch.receiptId, "active-recovery-fetch");
  const activePostId = await insertSavedPost(db, activeFetch.handle);
  await db.patch(activeFetch.receiptId, {
    status: "queued",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    providerResultStatus: "persisted",
    persistedPostCount: 1,
    updatedAt: Date.now() + 1,
  });
  const queuedRecovery = await linkPersistedPost(
    db,
    activeRunId,
    activeFetch.receiptId,
    activePostId,
  );
  assert.equal(queuedRecovery.reopened, false);
  assert.equal((await db.get(activeFetch.receiptId)).status, "processing_pending");
  assert.equal((await db.get(activeFetch.receiptId)).providerAttemptCount, 1);
}

// The persistence marker is only accepted from the currently leased receipt.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const first = await claim(db, runId, "persisted-worker");
  assert.ok(first);
  assert.equal((await startProviderAttempt(db, runId, first.receiptId, "persisted-worker")).started, true);
  const scrapedPostId = await insertSavedPost(db, first.handle);
  const persistedPost = await db.get(scrapedPostId);
  await assert.rejects(
    () => markReceiptPostsPersisted._handler(ctx(db), {
      runId,
      receiptId: first.receiptId,
      workerId: "persisted-worker",
      postCount: 1,
      scrapedPostId,
      postId: persistedPost.postId,
      instagramPostUrl: persistedPost.instagramPostUrl,
      processingProtocolVersion: 1,
      serviceSecret: process.env.CRON_SECRET,
    }),
    /protocol 1 requires an exact saved-post ID and positive source revision/i,
    "the new lane protocol must attest the exact persisted source revision",
  );
  await markPersisted(db, runId, first.receiptId, "persisted-worker", scrapedPostId);
  const receipt = await db.get(first.receiptId);
  assert.equal(receipt.providerResultStatus, "persisted");
  assert.equal(receipt.scrapedPostId, scrapedPostId);
  assert.equal(receipt.status, "processing_pending", "persistence must stay nonterminal until AI finishes");
}

// Backend-first rolling deployment remains compatible with an old web worker:
// without the explicit lane protocol opt-in, persistence records its durable
// boundary but keeps the old running lease so that worker can truthfully finish
// or release instead of receiving a lease-mismatch 5xx.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["rolling_old_web"]);
  const fetched = await claim(db, runId, "old-web-worker");
  await startProviderAttempt(db, runId, fetched.receiptId, "old-web-worker");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  const post = await db.get(scrapedPostId);
  const marker = await markReceiptPostsPersisted._handler(ctx(db), {
    runId,
    receiptId: fetched.receiptId,
    workerId: "old-web-worker",
    postCount: 1,
    postId: post.postId,
    instagramPostUrl: post.instagramPostUrl,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(marker.processingPending, false);
  assert.equal((await db.get(fetched.receiptId)).status, "running");
  await complete(db, runId, fetched.receiptId, "old-web-worker", "fetched");
  assert.equal((await db.get(fetched.receiptId)).status, "fetched");
}

// End-to-end durable AI lane: paid fetch -> exact saved post -> busy/pending ->
// one consumer -> terminal saved-post outcome -> original receipt terminal.
// Duplicate consumers and a stale prior owner are fenced throughout, and no
// transition can increment or repeat the paid provider attempt.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["durable_ai_venue"]);
  const first = await claim(db, runId, "fetch-worker");
  assert.ok(first);
  assert.equal((await startProviderAttempt(db, runId, first.receiptId, "fetch-worker")).started, true);
  const scrapedPostId = await insertSavedPost(db, first.handle);
  await markPersisted(db, runId, first.receiptId, "fetch-worker", scrapedPostId);

  const aiClaim = await claimProcessing(db, runId, "ai-worker-1");
  assert.ok(aiClaim);
  assert.equal(aiClaim.scrapedPostId, scrapedPostId, "the consumer must process the selected saved post only");
  assert.equal(await claimProcessing(db, runId, "duplicate-ai-worker"), null, "only one AI receipt may be active");
  await assert.rejects(
    () => completeProcessingReceipt._handler(ctx(db), {
      runId,
      receiptId: first.receiptId,
      workerId: "ai-worker-1",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /before its selected saved post is terminal/i,
    "a receipt must not terminalize merely because its AI worker was claimed",
  );

  await db.patch(scrapedPostId, {
    processingStatus: "processing",
    processingLeaseOwner: "ai-worker-1",
    processingLeaseExpiresAt: Date.now() + 5 * 60_000,
    updatedAt: Date.now(),
  });
  const liveReceiptBeforeForeignRelease = await db.get(first.receiptId);
  const livePostBeforeForeignRelease = await db.get(scrapedPostId);
  await assert.rejects(
    () => releaseProcessingReceiptForRetry._handler(ctx(db), {
      runId,
      receiptId: first.receiptId,
      workerId: "foreign-ai-worker",
      reason: "foreign worker must not release a live processing owner",
      retryAfterMs: 6 * 60 * 60_000,
      serviceSecret: process.env.CRON_SECRET,
    }),
    /lease mismatch/i,
    "a foreign worker must not release another live processing owner",
  );
  assert.deepEqual(
    await db.get(first.receiptId),
    liveReceiptBeforeForeignRelease,
    "a rejected foreign release must not mutate the live receipt",
  );
  assert.deepEqual(
    await db.get(scrapedPostId),
    livePostBeforeForeignRelease,
    "a rejected foreign release must not revoke the exact post fence",
  );

  const busyRelease = await releaseProcessingReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId: first.receiptId,
    workerId: "ai-worker-1",
    reason: "OpenAI provider execution lease is busy; retry this saved post later.",
    retryAfterMs: 1_000,
    preserveAttempt: true,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.deepEqual(busyRelease, { terminal: false, status: "processing_pending" });
  const pending = await db.get(first.receiptId);
  assert.equal(pending.status, "processing_pending");
  assert.equal(pending.terminalAt, undefined, "AI contention must not falsely terminalize the receipt");
  assert.equal(pending.processingAttemptCount, 0, "lease contention must not consume the AI retry limit");
  assert.equal(pending.providerAttemptCount, 1, "the original paid attempt must remain exact");
  const releasedPost = await db.get(scrapedPostId);
  const replayInvariant = {
    processingAttemptCount: pending.processingAttemptCount,
    retryNotBeforeAt: pending.retryNotBeforeAt,
    outcomeDetail: pending.outcomeDetail,
    scrapedPostId: pending.scrapedPostId,
    scrapedPostSourceRevision: pending.scrapedPostSourceRevision,
    providerAttemptCount: pending.providerAttemptCount,
  };
  const releaseReplay = await releaseProcessingReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId: first.receiptId,
    workerId: "ai-worker-1",
    reason: "a replay must not replace the original release outcome",
    retryAfterMs: 6 * 60 * 60_000,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.deepEqual(
    releaseReplay,
    { terminal: false, status: "processing_pending" },
    "a release replay after acknowledgement loss must succeed idempotently",
  );
  const replayedPending = await db.get(first.receiptId);
  assert.deepEqual(
    {
      processingAttemptCount: replayedPending.processingAttemptCount,
      retryNotBeforeAt: replayedPending.retryNotBeforeAt,
      outcomeDetail: replayedPending.outcomeDetail,
      scrapedPostId: replayedPending.scrapedPostId,
      scrapedPostSourceRevision: replayedPending.scrapedPostSourceRevision,
      providerAttemptCount: replayedPending.providerAttemptCount,
    },
    replayInvariant,
    "a processing_pending replay must not change attempts, retry timing, outcome, exact post fence, or provider count",
  );
  assert.deepEqual(
    await db.get(scrapedPostId),
    releasedPost,
    "a processing_pending replay must not mutate the already-revoked exact post fence",
  );
  assert.equal(await claim(db, runId, "fetch-worker"), null, "processing-pending work must never be claimed for Apify");
  await assert.rejects(
    () => startProviderAttempt(db, runId, first.receiptId, "fetch-worker"),
    /lease mismatch/i,
    "a processing receipt cannot cross the paid-provider boundary twice",
  );

  await db.patch(first.receiptId, { retryNotBeforeAt: Date.now() - 1 });
  const resumed = await claimProcessing(db, runId, "ai-worker-2");
  assert.ok(resumed, "the durable consumer must reclaim due pending AI work");
  assert.equal(await claimProcessing(db, runId, "duplicate-ai-worker-2"), null);
  await assert.rejects(
    () => completeProcessingReceipt._handler(ctx(db), {
      runId,
      receiptId: first.receiptId,
      workerId: "ai-worker-1",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /lease mismatch/i,
    "a stale prior consumer must not terminalize the receipt",
  );

  // This represents either a successful extraction or the valid-skip path
  // where the exact scraped post was already terminal when the consumer ran.
  await db.patch(scrapedPostId, {
    processingStatus: "completed",
    processingOutcome: "terminal_no_event",
    processingLeaseOwner: undefined,
    processingLeaseExpiresAt: undefined,
    updatedAt: Date.now(),
  });
  const completion = await completeProcessingReceipt._handler(ctx(db), {
    runId,
    receiptId: first.receiptId,
    workerId: "ai-worker-2",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(completion.complete, true);
  assert.equal(completion.status, "fetched", "terminal_no_event is a truthful processed-post skip");
  assert.equal(completion.processingOutcome, "terminal_no_event");
  const terminal = await db.get(first.receiptId);
  assert.equal(terminal.status, "fetched");
  assert.equal(terminal.providerAttemptCount, 1, "AI completion must not cause a paid refetch");
  assert.equal((await db.get(runId)).status, "completed");
}

// If the exact saved post became terminal before the receipt consumer (for
// example, a prior worker committed the result and crashed before receipt
// completion), the next consumer performs a valid skip and terminalizes the
// original receipt without another AI or Apify attempt.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["valid_skip_venue"]);
  const fetched = await claim(db, runId, "valid-skip-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "valid-skip-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle, {
    processingStatus: "completed",
    processingOutcome: "receipt_complete",
    blocksPaidFetch: false,
  });
  await markPersisted(db, runId, fetched.receiptId, "valid-skip-fetch", scrapedPostId);
  const consumer = await claimProcessing(db, runId, "valid-skip-consumer");
  assert.ok(consumer);
  await completeProcessingReceipt._handler(ctx(db), {
    runId,
    receiptId: fetched.receiptId,
    workerId: "valid-skip-consumer",
    serviceSecret: process.env.CRON_SECRET,
  });
  const terminal = await db.get(fetched.receiptId);
  assert.equal(terminal.status, "fetched");
  assert.equal(terminal.providerAttemptCount, 1);
  assert.equal(terminal.processingAttemptCount, 1);
}

// A crashed AI consumer is recovered only after its lease expires. A duplicate
// cannot claim early, and the stale owner cannot finish after recovery.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["stale_ai_venue"]);
  const fetched = await claim(db, runId, "fetch-stale");
  await startProviderAttempt(db, runId, fetched.receiptId, "fetch-stale");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "fetch-stale", scrapedPostId);
  assert.ok(await claimProcessing(db, runId, "crashed-ai"));
  assert.equal(await claimProcessing(db, runId, "too-early-ai"), null);
  await db.patch(fetched.receiptId, { leaseExpiresAt: Date.now() - 1 });
  assert.equal(await claimProcessing(db, runId, "recovery-probe"), null, "first pass must durably requeue the stale lease");
  const recovered = await claimProcessing(db, runId, "recovered-ai");
  assert.ok(recovered);
  await assert.rejects(
    () => completeProcessingReceipt._handler(ctx(db), {
      runId,
      receiptId: fetched.receiptId,
      workerId: "crashed-ai",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /lease mismatch/i,
  );
}

// Permanent saved-post extraction/media failure is terminal but not success.
// Server-side mapping must surface it in failed receipt/run accounting, while
// terminal_no_event above remains an explicit successful fetched-post skip.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["permanent_processing_failure"]);
  const fetched = await claim(db, runId, "permanent-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "permanent-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "permanent-fetch", scrapedPostId);
  await claimProcessing(db, runId, "permanent-ai");
  await db.patch(scrapedPostId, {
    processingStatus: "completed",
    processingOutcome: "terminal_permanent_failure",
  });
  const completion = await completeProcessingReceipt._handler(ctx(db), {
    runId,
    receiptId: fetched.receiptId,
    workerId: "permanent-ai",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(completion.status, "failed");
  assert.equal(completion.processingOutcome, "terminal_permanent_failure");
  assert.equal((await db.get(fetched.receiptId)).status, "failed");
  assert.equal((await db.get(runId)).failedReceiptCount, 1);
}

// Receipt retry exhaustion also revokes the still-valid exact post fence
// before terminalizing. The old worker cannot commit a post result or event in
// the interval where the scraped-post lease would otherwise outlive receipt.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["released_terminal_ai"]);
  const fetched = await claim(db, runId, "released-terminal-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "released-terminal-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "released-terminal-fetch", scrapedPostId);
  await claimProcessing(db, runId, "released-terminal-ai");
  const post = await db.get(scrapedPostId);
  await db.patch(scrapedPostId, {
    processingStatus: "processing",
    processingLeaseOwner: "released-terminal-ai",
    processingLeaseExpiresAt: Date.now() + 5 * 60_000,
    updatedAt: 1,
  });
  await db.patch(fetched.receiptId, { processingAttemptCount: 3 });
  const released = await releaseProcessingReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId: fetched.receiptId,
    workerId: "released-terminal-ai",
    reason: "third explicit AI processing failure",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.deepEqual(released, { terminal: true, status: "failed" });
  assert.equal((await db.get(fetched.receiptId)).status, "failed");
  assert.equal((await db.get(scrapedPostId)).processingLeaseOwner, undefined);
  assert.ok((await db.get(scrapedPostId)).updatedAt > 1);
  await assert.rejects(
    () => recordProcessingResult._handler(ctx(db), {
      handle: fetched.handle,
      scrapedPostId,
      postId: post.postId,
      instagramPostUrl: post.instagramPostUrl,
      status: "completed",
      outcome: "terminal_no_event",
      owner: "released-terminal-ai",
      sourceRevision: 1,
      serviceSecret: process.env.CRON_SECRET,
    }),
    /stale processing fence/i,
  );
}

// Receipt lease expiry follows the same exact-fence revocation rule.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["expired_terminal_ai"]);
  const fetched = await claim(db, runId, "expired-terminal-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "expired-terminal-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "expired-terminal-fetch", scrapedPostId);
  await claimProcessing(db, runId, "expired-terminal-ai");
  const post = await db.get(scrapedPostId);
  await db.patch(scrapedPostId, {
    processingStatus: "processing",
    processingLeaseOwner: "expired-terminal-ai",
    processingLeaseExpiresAt: Date.now() + 5 * 60_000,
  });
  await db.patch(fetched.receiptId, {
    processingAttemptCount: 3,
    leaseExpiresAt: Date.now() - 1,
  });
  assert.equal(await claimProcessing(db, runId, "expired-terminal-recovery"), null);
  assert.equal((await db.get(fetched.receiptId)).status, "failed");
  assert.equal((await db.get(scrapedPostId)).processingLeaseOwner, undefined);
  await assert.rejects(
    () => recordProcessingResult._handler(ctx(db), {
      handle: fetched.handle,
      scrapedPostId,
      postId: post.postId,
      instagramPostUrl: post.instagramPostUrl,
      status: "completed",
      outcome: "terminal_no_event",
      owner: "expired-terminal-ai",
      sourceRevision: 1,
      serviceSecret: process.env.CRON_SECRET,
    }),
    /stale processing fence/i,
  );
  await assert.rejects(
    () => createEvent._handler(ctx(db), {
      title: "Must not survive retry exhaustion",
      date: "2026-08-15",
      venue: "Expired venue",
      artists: [],
      eventType: "other",
      status: "pending",
      processingFence: {
        handle: fetched.handle,
        scrapedPostId,
        postId: post.postId,
        instagramPostUrl: post.instagramPostUrl,
        owner: "expired-terminal-ai",
        sourceRevision: 1,
      },
      serviceSecret: process.env.CRON_SECRET,
    }),
    /processing fence is stale/i,
  );
}

// The source revision recorded at persistence is immutable for this receipt.
// If an upsert changes the row after claim, neither a newer terminal outcome
// nor a stale worker may be credited to the older fetched payload.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["revision_race_venue"]);
  const fetched = await claim(db, runId, "revision-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "revision-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "revision-fetch", scrapedPostId);
  const processing = await claimProcessing(db, runId, "revision-ai");
  assert.equal(processing.scrapedPostSourceRevision, 1);
  await db.patch(scrapedPostId, {
    sourceRevision: 2,
    processingStatus: "completed",
    processingOutcome: "receipt_complete",
    updatedAt: Date.now() + 10_000,
  });
  await assert.rejects(
    () => completeProcessingReceipt._handler(ctx(db), {
      runId,
      receiptId: fetched.receiptId,
      workerId: "revision-ai",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /source revision changed/i,
  );
  await releaseProcessingReceiptForRetry._handler(ctx(db), {
    runId,
    receiptId: fetched.receiptId,
    workerId: "revision-ai",
    reason: "Durable saved-post source revision changed during processing; exact recovery is required.",
    preserveAttempt: true,
    retryAfterMs: 1_000,
    serviceSecret: process.env.CRON_SECRET,
  });
  await db.patch(fetched.receiptId, { retryNotBeforeAt: Date.now() - 1 });
  assert.equal(await claimProcessing(db, runId, "revision-ai-retry"), null);
  const pending = await db.get(fetched.receiptId);
  assert.equal(pending.status, "processing_pending");
  assert.equal(pending.scrapedPostSourceRevision, 1);
  assert.equal(pending.providerAttemptCount, 1);
  assert.match(pending.outcomeDetail, /revision_changed_recovery_required/);
  await assert.rejects(
    () => linkPersistedPost(db, runId, fetched.receiptId, scrapedPostId),
    /fetch window/i,
    "a later upsert cannot be silently adopted as the originally fetched revision",
  );
}

// Run aborts are fenced against live AI workers. Once the AI lease is stale,
// abort atomically revokes its owner; completion and release both reject the
// failed parent run even if that worker resumes afterward.
{
  const db = new MemoryDb();
  const runId = await queue(db, "daily", ["abort_ai_venue"]);
  const fetched = await claim(db, runId, "abort-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "abort-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "abort-fetch", scrapedPostId);
  await claimProcessing(db, runId, "abort-ai");
  await db.patch(scrapedPostId, {
    processingStatus: "processing",
    processingLeaseOwner: "abort-ai",
    processingLeaseExpiresAt: Date.now() + 5 * 60_000,
  });
  await assert.rejects(
    () => abortInactiveRun._handler(ctx(db), {
      runId,
      reason: "qa_abort",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /active receipt lease/i,
  );
  await db.patch(fetched.receiptId, { leaseExpiresAt: Date.now() - 1 });
  const aborted = await abortInactiveRun._handler(ctx(db), {
    runId,
    reason: "qa_abort",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(aborted.status, "failed");
  assert.equal((await db.get(fetched.receiptId)).leaseOwner, undefined);
  const revokedPost = await db.get(scrapedPostId);
  assert.equal(revokedPost.processingStatus, "retryable_failure");
  assert.equal(revokedPost.processingLeaseOwner, undefined);
  await assert.rejects(
    () => completeProcessingReceipt._handler(ctx(db), {
      runId,
      receiptId: fetched.receiptId,
      workerId: "abort-ai",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /failed run|lease mismatch/i,
  );
  await assert.rejects(
    () => releaseProcessingReceiptForRetry._handler(ctx(db), {
      runId,
      receiptId: fetched.receiptId,
      workerId: "abort-ai",
      reason: "stale worker",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /failed run/i,
  );
  const staleFence = {
    handle: fetched.handle,
    scrapedPostId,
    postId: revokedPost.postId,
    instagramPostUrl: revokedPost.instagramPostUrl,
    owner: "abort-ai",
    sourceRevision: 1,
  };
  await assert.rejects(
    () => createEvent._handler(ctx(db), {
      title: "Must not survive abort",
      date: "2026-08-15",
      venue: "Abort venue",
      artists: [],
      eventType: "other",
      status: "pending",
      processingFence: staleFence,
      serviceSecret: process.env.CRON_SECRET,
    }),
    /processing fence is stale/i,
    "an event write cannot outlive the aborted receipt lease",
  );
  const assetId = await db.insert("mediaAssets", {
    storageId: "abort-storage",
    url: "https://example.com/abort.jpg",
    checksumSha256: "abort-checksum",
  });
  await assert.rejects(
    () => refreshAndAttach._handler(ctx(db), {
      postId: revokedPost.postId,
      instagramPostUrl: revokedPost.instagramPostUrl,
      assetId,
      storageId: "abort-storage",
      url: "https://example.com/abort-new.jpg",
      actor: "qa-abort",
      processingFence: staleFence,
    }),
    /processing fence is stale/i,
    "a media write cannot outlive the aborted receipt lease",
  );
}

{
  const db = new MemoryDb();
  const runId = await queue(db, "catch_up", ["abort_catchup_ai"]);
  const fetched = await claim(db, runId, "abort-catchup-fetch");
  await startProviderAttempt(db, runId, fetched.receiptId, "abort-catchup-fetch");
  const scrapedPostId = await insertSavedPost(db, fetched.handle);
  await markPersisted(db, runId, fetched.receiptId, "abort-catchup-fetch", scrapedPostId);
  await claimProcessing(db, runId, "abort-catchup-ai");
  await db.patch(scrapedPostId, {
    processingStatus: "processing",
    processingLeaseOwner: "abort-catchup-ai",
    processingLeaseExpiresAt: Date.now() + 5 * 60_000,
  });
  await assert.rejects(
    () => abortOnlyInactiveCatchUpRun._handler(ctx(db), {
      reason: "qa_abort_catchup",
      serviceSecret: process.env.CRON_SECRET,
    }),
    /active receipt lease/i,
  );
  await db.patch(fetched.receiptId, { leaseExpiresAt: Date.now() - 1 });
  const aborted = await abortOnlyInactiveCatchUpRun._handler(ctx(db), {
    reason: "qa_abort_catchup",
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(aborted.status, "failed");
  assert.equal((await db.get(fetched.receiptId)).leaseOwner, undefined);
  assert.equal((await db.get(scrapedPostId)).processingLeaseOwner, undefined);
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

// The paid canary exposes a served, read-only receipt/token ledger so the
// operator can prove max-one provider attempts and calculate actual model cost.
{
  const db = new MemoryDb();
  const runId = await queue(db, "canary", handles.slice(0, 16));
  const run = await db.get(runId);
  const claimed = await claim(db, runId, "accounting-fetch");
  await startProviderAttempt(db, runId, claimed.receiptId, "accounting-fetch");
  const scrapedPostId = await insertSavedPost(db, claimed.handle);
  await db.patch(scrapedPostId, {
    analysisAttemptStartedAt: run.createdAt + 1,
    analysisCompletedAt: run.createdAt + 2,
    analysisModel: "gpt-5-mini-2025-08-07",
    analysisInputTokens: 1_200,
    analysisOutputTokens: 300,
    analysisTotalTokens: 1_500,
    processingOutcome: "receipt_complete",
  });
  await markPersisted(db, runId, claimed.receiptId, "accounting-fetch", scrapedPostId);
  const accounting = await getCanaryAccounting._handler(ctx(db), {
    runId,
    serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(accounting.receiptCount, 16);
  assert.equal(accounting.providerAttemptCountTotal, 1);
  assert.equal(accounting.providerAttemptCountMax, 1);
  assert.equal(accounting.chargedMicrosTotal, 10_000);
  assert.equal(accounting.openAiAttemptsStartedDuringRun, 1);
  assert.equal(accounting.openAiAnalysesCompletedDuringRun, 1);
  assert.equal(accounting.attributedInputTokens, 1_200);
  assert.equal(accounting.attributedOutputTokens, 300);
  assert.equal(accounting.attributedTotalTokens, 1_500);
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
  assert.equal(catchUpDb.rows("ingestionRunChunks").length, 632, "each receipt must have its own durable accounting shard");

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
assert.ok(/executionSlot/.test(controllerSource), "receipt claims need fixed execution lanes to avoid OCC contention");
assert.ok(/workerSlot/.test(executorSource), "the VPS executor must identify its fixed lane");

// Admission validates the entire frozen snapshot against budget before any
// receipt exists. This avoids a shared live budget counter and prevents a run
// from charging a selected profile beyond its immutable allowance.
assert.ok(/Selected profiles exceed this run's frozen budget/.test(controllerSource), "queue admission must reject a snapshot that exceeds budget");

console.log("Durable ingestion controller behavioral QA passed.");
