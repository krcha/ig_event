import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_INGESTION_FETCH_PAGE_SIZE,
  DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
  evaluateFetchWindow,
  getFetchBoundary,
  isPaidIngestionEnabled,
  nextContinuationResultsLimit,
  selectSourcesFairly,
} from "../lib/pipeline/instagram-ingestion-durability.ts";
import {
  claimPaidFetchLease,
  claimProcessing,
  getBacklogStateByHandle,
  reconcilePaidFetchFlags,
  recordOpenAiAnalysis,
  recordProcessingResult,
  recordPaidFetchWindowSaturation,
  recordPaidFetchWindowSuccess,
  releasePaidFetchLease,
  upsertManyByHandle,
} from "../convex/scrapedPosts.ts";
import {
  isPermanentRemoteMediaFailure,
  resolvePaidFetchLeaseAfterBacklogMaintenance,
  resolveFailedMediaAttemptPolicy,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { RemoteMediaHttpError } from "../lib/ai/prepare-image-for-openai.ts";

const startedAt = Date.parse("2026-07-27T10:00:00.000Z");
assert.equal(
  isPaidIngestionEnabled({}),
  false,
  "Paid ingestion must fail closed unless an enable flag is explicit.",
);
assert.equal(isPaidIngestionEnabled({ PAID_INGESTION_ENABLED: "true" }), true);
assert.equal(isPaidIngestionEnabled({ PAID_INGESTION_ENABLED: "false" }), false);
assert.equal(isPaidIngestionEnabled({ ENABLE_FRESH_APIFY_FETCH: "yes" }), true);
assert.equal(isPermanentRemoteMediaFailure(new RemoteMediaHttpError(403, "Forbidden")), true);
assert.equal(
  isPermanentRemoteMediaFailure(
    new Error("REMOTE_MEDIA_HTTP_STATUS=410; Remote image fetch failed."),
  ),
  true,
);
assert.equal(
  isPermanentRemoteMediaFailure(new Error("Control plane rejected request 403.")),
  false,
  "arbitrary control-plane messages containing an HTTP code must remain retryable",
);
assert.equal(isPermanentRemoteMediaFailure(new Error("Remote image fetch failed with status 503.")), false);
assert.equal(
  resolveFailedMediaAttemptPolicy({
    canFallbackToCaptionOnly: true,
    errors: [new RemoteMediaHttpError(403, "Forbidden")],
  }),
  "caption_fallback",
);
assert.equal(
  resolveFailedMediaAttemptPolicy({
    canFallbackToCaptionOnly: false,
    errors: [new RemoteMediaHttpError(403, "Forbidden")],
  }),
  "terminal_permanent",
);
assert.equal(
  resolveFailedMediaAttemptPolicy({
    canFallbackToCaptionOnly: false,
    errors: [new Error("Image download failed with status 503 Service Unavailable")],
  }),
  "retryable",
);
let maintenanceClaimAttempts = 0;
const maintainedLease = await resolvePaidFetchLeaseAfterBacklogMaintenance(async () => {
  maintenanceClaimAttempts += 1;
  return maintenanceClaimAttempts === 1
    ? { claimed: false, reason: "backlog_maintenance_incomplete" }
    : { claimed: true, reason: "claimed" };
});
assert.equal(maintainedLease.claimed, true);
assert.equal(
  maintenanceClaimAttempts,
  2,
  "bounded backlog maintenance must continue to a fresh-fetch claim in the same handle step",
);
assert.deepEqual(getFetchBoundary({ fetchStartedAt: startedAt }), {
  checkpointAt: null,
  requestNewerThanAt: startedAt - 10 * 24 * 60 * 60_000,
});
assert.deepEqual(
  getFetchBoundary({ successfulFetchThroughAt: startedAt - 60_000, fetchStartedAt: startedAt }),
  {
    checkpointAt: startedAt - 60_000,
    requestNewerThanAt: startedAt - 6 * 60_000,
  },
  "Durable checkpoints must use an inclusive overlap window.",
);

assert.deepEqual(
  evaluateFetchWindow({
    providerSucceeded: true,
    malformed: false,
    interrupted: false,
    leaseCurrent: true,
    budgetReserved: true,
    rawItemCount: 5,
    requestedResultsLimit: 5,
    checkpointAt: 100,
    oldestFetchedAt: 101,
  }),
  { complete: false, saturated: true, reason: "result_cap_before_boundary" },
);
assert.equal(
  evaluateFetchWindow({
    providerSucceeded: true,
    malformed: false,
    interrupted: false,
    leaseCurrent: true,
    budgetReserved: true,
    rawItemCount: 4,
    requestedResultsLimit: 5,
    checkpointAt: 100,
    oldestFetchedAt: 101,
  }).complete,
  true,
);
for (const failure of [
  { budgetReserved: false, reason: "budget_blocked" },
  { leaseCurrent: false, reason: "lease_lost" },
  { interrupted: true, reason: "interrupted" },
  { providerSucceeded: false, reason: "provider_failed" },
  { malformed: true, reason: "malformed_response" },
]) {
  const result = evaluateFetchWindow({
    providerSucceeded: true,
    malformed: false,
    interrupted: false,
    leaseCurrent: true,
    budgetReserved: true,
    rawItemCount: 0,
    requestedResultsLimit: 5,
    checkpointAt: null,
    oldestFetchedAt: null,
    ...failure,
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, failure.reason);
}

const continuationLimits = [DEFAULT_INGESTION_FETCH_PAGE_SIZE];
while (continuationLimits.at(-1) < DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN) {
  continuationLimits.push(
    nextContinuationResultsLimit(
      continuationLimits.at(-1),
      DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
    ),
  );
}
assert.deepEqual(continuationLimits, [5, 10, 20, 40, 50]);
assert.deepEqual(
  selectSourcesFairly(
    [
      { handle: "fresh", active: true, lastFetchAttemptAt: 30 },
      { handle: "inactive", active: false, continuationActive: true },
      { handle: "continued", active: true, continuationActive: true, deferredAt: 20 },
      { handle: "old-deferred", active: true, deferredAt: 10, lastFetchAttemptAt: 50 },
    ],
    10,
  ).map((source) => source.handle),
  ["continued", "old-deferred", "fresh"],
);

const runnerSource = readFileSync(
  new URL("../lib/pipeline/run-instagram-ingestion.ts", import.meta.url),
  "utf8",
);
const freshFetchBlock = runnerSource.slice(
  runnerSource.indexOf("const rawItemCount = getInstagramScrapeRawItemCount(posts)"),
  runnerSource.indexOf("const fetchedSourceKeys", runnerSource.indexOf("const rawItemCount = getInstagramScrapeRawItemCount(posts)")),
);
assert.ok(
  freshFetchBlock.indexOf("await persistScrapedPostsForHandle") <
    freshFetchBlock.indexOf("recordPaidFetchWindowSaturationMutation"),
  "Every returned provider item must become durable before a saturated window is recorded.",
);
assert.match(freshFetchBlock, /if \(saturated\)[\s\S]*recordPaidFetchWindowSaturationMutation[\s\S]*else[\s\S]*recordPaidFetchWindowSuccessMutation/);
assert.match(
  runnerSource,
  /hasTerminalPermanentFailure[\s\S]*\? "terminal_permanent_failure"/,
  "explicit permanent media failures must be recorded as terminal instead of replaying forever",
);

function createDb(initialTables) {
  const tables = Object.fromEntries(
    Object.entries(initialTables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  let nextId = 1;
  function rowsFor(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }
  const db = {
    query(name) {
      let predicates = [];
      const builder = {
        withIndex(_indexName, apply) {
          const q = {
            eq(field, value) {
              predicates.push((row) => row[field] === value);
              return q;
            },
          };
          apply(q);
          return builder;
        },
        filter(apply) {
          const q = {
            field: (name) => ({ field: name }),
            eq: (fieldRef, value) => {
              predicates.push((row) => row[fieldRef.field] === value);
              return true;
            },
          };
          apply(q);
          return builder;
        },
        async unique() {
          const rows = rowsFor(name).filter((row) => predicates.every((fn) => fn(row)));
          assert.ok(rows.length <= 1, `Expected unique ${name} query, received ${rows.length}.`);
          return rows[0] ?? null;
        },
        async first() {
          return rowsFor(name).find((row) => predicates.every((fn) => fn(row))) ?? null;
        },
        async collect() {
          return rowsFor(name).filter((row) => predicates.every((fn) => fn(row)));
        },
        async take(limit) {
          return rowsFor(name)
            .filter((row) => predicates.every((fn) => fn(row)))
            .slice(0, limit);
        },
      };
      return builder;
    },
    async insert(name, value) {
      const row = { _id: `${name}-${nextId++}`, ...value };
      rowsFor(name).push(row);
      return row._id;
    },
    async patch(id, patch) {
      const row = Object.values(tables).flat().find((candidate) => candidate._id === id);
      assert.ok(row, `Missing row ${id}.`);
      Object.assign(row, patch);
    },
    async delete(id) {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((row) => row._id === id);
        if (index >= 0) {
          rows.splice(index, 1);
          return;
        }
      }
      throw new Error(`Missing row ${id}.`);
    },
    async get(id) {
      return Object.values(tables).flat().find((row) => row._id === id) ?? null;
    },
  };
  return { db, tables };
}

const previousCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-durability-secret";
try {
  const horizonCutoffMs = Date.parse("2026-07-20T00:00:00.000Z");
  const mutationFetchStartedAt = Date.now() - 1_000;
  const checkpointBefore = mutationFetchStartedAt - 3_600_000;
  const { db, tables } = createDb({
    instagramPaidFetchControl: [
      {
        _id: "control-apify",
        key: "apify",
        backlogIndexReady: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    scrapedPosts: [
      {
        _id: "terminal-stale-blocker",
        handle: "terminal.source",
        postId: "terminal-post",
        blocksPaidFetch: true,
        processingStatus: "completed",
        processingOutcome: "receipt_complete",
      },
      {
        _id: "retryable-stale-blocker",
        handle: "retry.source",
        postId: "retry-post",
        blocksPaidFetch: true,
        processingStatus: "retryable_failure",
        processingAttempts: 2,
      },
      {
        _id: "expired-processing-blocker",
        handle: "expired.source",
        postId: "expired-post",
        blocksPaidFetch: true,
        processingStatus: "processing",
        processingAttempts: 1,
        processingLeaseOwner: "dead-owner",
        processingLeaseExpiresAt: mutationFetchStartedAt - 1,
      },
      {
        _id: "old-out-of-horizon-blocker",
        handle: "old.source",
        postId: "old-post",
        postedAtMs: horizonCutoffMs - 1,
        blocksPaidFetch: true,
        processingStatus: "pending",
      },
    ],
    instagramSources: [
      {
        _id: "source-one",
        handle: "source.one",
        role: "unknown",
        active: true,
        lastSuccessfulFetchThroughAt: checkpointBefore,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ingestionCostReservations: [],
    ingestionDailyBudgets: [],
    instagramHandleFetchStates: [],
  });
  const ctx = { auth: { getUserIdentity: async () => null }, db };
  const common = {
    handle: "source.one",
    requestedResultsLimit: 5,
    fetchStartedAt: mutationFetchStartedAt,
    dayKey: "2026-07-27",
    dailyBudgetUsd: 0.05,
    maxChargeUsd: 0.04,
    horizonCutoffMs,
    serviceSecret: "qa-durability-secret",
  };

  const firstClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-a" });
  assert.equal(firstClaim.claimed, true);
  assert.equal(
    tables.scrapedPosts.filter((post) => post.blocksPaidFetch === true).length,
    0,
    "terminal, retryable, expired-lease, and out-of-horizon poison rows must all be reconciled before evaluating the paid-fetch gate",
  );
  assert.equal(
    tables.scrapedPosts.find((post) => post._id === "expired-processing-blocker").processingStatus,
    "retryable_failure",
  );
  assert.ok(
    tables.scrapedPosts.find((post) => post._id === "retryable-stale-blocker").processingRetryAt >
      mutationFetchStartedAt,
  );
  assert.equal(firstClaim.resultsLimit, 5);
  assert.equal(Date.parse(firstClaim.onlyPostsNewerThan), checkpointBefore - 5 * 60_000);
  const busyClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-b" });
  assert.deepEqual(busyClaim, { claimed: false, reason: "busy" });
  const releasedUnused = await releasePaidFetchLease._handler(ctx, {
    owner: "owner-a",
    requestStarted: false,
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(releasedUnused.chargedMicros, 0);
  assert.equal(releasedUnused.releasedMicros, 40_000);

  const secondClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-b" });
  assert.equal(secondClaim.claimed, true);
  const saturated = await recordPaidFetchWindowSaturation._handler(ctx, {
    handle: "source.one",
    owner: "owner-b",
    rawItemCount: 5,
    serviceSecret: "qa-durability-secret",
  });
  assert.deepEqual(saturated, {
    recorded: true,
    nextResultsLimit: 10,
    hardBlocked: false,
    checkpointAdvanced: false,
  });
  assert.equal(tables.instagramSources[0].lastSuccessfulFetchThroughAt, checkpointBefore);
  assert.equal(tables.instagramPaidFetchControl[0].leaseWindowStatus, "saturated");
  await assert.rejects(
    recordPaidFetchWindowSuccess._handler(ctx, {
      handle: "source.one",
      owner: "owner-b",
      serviceSecret: "qa-durability-secret",
    }),
    /stale paid-fetch lease/i,
  );
  const charged = await releasePaidFetchLease._handler(ctx, {
    owner: "owner-b",
    requestStarted: true,
    actualChargeUsd: 0.01,
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(charged.chargedMicros, 10_000);
  assert.equal(charged.releasedMicros, 30_000);

  const thirdClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-c" });
  assert.equal(thirdClaim.claimed, true);
  assert.equal(thirdClaim.resultsLimit, 10, "Continuation state must increase the next bounded window.");
  const success = await recordPaidFetchWindowSuccess._handler(ctx, {
    handle: "source.one",
    owner: "owner-c",
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(success.checkpointAt, mutationFetchStartedAt);
  assert.equal(tables.instagramSources[0].lastSuccessfulFetchThroughAt, mutationFetchStartedAt);
  assert.equal(tables.instagramSources[0].continuationActive, false);
  await releasePaidFetchLease._handler(ctx, {
    owner: "owner-c",
    requestStarted: true,
    serviceSecret: "qa-durability-secret",
  });

  const exhausted = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-d" });
  assert.equal(exhausted.claimed, false);
  assert.equal(exhausted.reason, "budget_exhausted");
  assert.equal(tables.ingestionDailyBudgets[0].chargedMicros, 50_000);
  assert.equal(tables.ingestionDailyBudgets[0].reservedMicros, 0);

  const nPlusOneOldPosts = Array.from({ length: 101 }, (_, index) => ({
    _id: `old-blocker-${index}`,
    handle: "old.source",
    postId: `old-post-${index}`,
    postedAtMs: horizonCutoffMs - index - 1,
    blocksPaidFetch: true,
    processingStatus: "pending",
  }));
  const { db: nPlusOneDb, tables: nPlusOneTables } = createDb({
    instagramPaidFetchControl: [
      { _id: "control-apify-n1", key: "apify", backlogIndexReady: true, createdAt: 1, updatedAt: 1 },
    ],
    scrapedPosts: nPlusOneOldPosts,
    instagramSources: [
      { _id: "source-n1", handle: "source.n1", active: true, createdAt: 1, updatedAt: 1 },
    ],
    ingestionCostReservations: [],
    ingestionDailyBudgets: [],
    instagramHandleFetchStates: [],
  });
  const nPlusOneCtx = { auth: { getUserIdentity: async () => null }, db: nPlusOneDb };
  const nPlusOneArgs = {
    ...common,
    handle: "source.n1",
    owner: "owner-n1",
    dayKey: "2026-07-28",
  };
  const maintenanceBatch = await claimPaidFetchLease._handler(nPlusOneCtx, nPlusOneArgs);
  assert.equal(maintenanceBatch.claimed, false);
  assert.equal(maintenanceBatch.reason, "backlog_maintenance_incomplete");
  assert.equal(
    nPlusOneTables.scrapedPosts.filter((post) => post.blocksPaidFetch).length,
    1,
    "the first bounded mutation should leave exactly the N+1 row for same-step maintenance",
  );
  const nPlusOneClaim = await claimPaidFetchLease._handler(nPlusOneCtx, nPlusOneArgs);
  assert.equal(nPlusOneClaim.claimed, true);
  assert.equal(nPlusOneTables.scrapedPosts.some((post) => post.blocksPaidFetch), false);

  const { db: mediaRefreshDb, tables: mediaRefreshTables } = createDb({
    scrapedPosts: [
      {
        _id: "terminal-media-post",
        handle: "source.media",
        postId: "post-media",
        username: "source.media",
        instagramPostUrl: "https://www.instagram.com/p/post-media/",
        imageUrls: ["https://example.com/expired.jpg"],
        sourceRevision: 4,
        blocksPaidFetch: false,
        processingStatus: "completed",
        processingOutcome: "terminal_permanent_failure",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const mediaRefreshCtx = { auth: { getUserIdentity: async () => null }, db: mediaRefreshDb };
  await upsertManyByHandle._handler(mediaRefreshCtx, {
    handle: "source.media",
    posts: [
      {
        handle: "source.media",
        postId: "post-media",
        username: "source.media",
        instagramPostUrl: "https://www.instagram.com/p/post-media/",
        imageUrls: ["https://example.com/current.jpg"],
      },
    ],
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(mediaRefreshTables.scrapedPosts[0].processingStatus, "pending");
  assert.equal(mediaRefreshTables.scrapedPosts[0].processingOutcome, undefined);
  assert.equal(mediaRefreshTables.scrapedPosts[0].blocksPaidFetch, true);
  assert.equal(mediaRefreshTables.scrapedPosts[0].sourceRevision, 5);

  const { db: analysisDb, tables: analysisTables } = createDb({
    scrapedPosts: [
      {
        _id: "saved-post-one",
        handle: "source.one",
        postId: "post-one",
        instagramPostUrl: "https://www.instagram.com/p/post-one/",
        sourceRevision: 3,
        processingStatus: "processing",
        processingLeaseOwner: "analysis-owner",
        processingLeaseExpiresAt: Date.now() + 60_000,
      },
    ],
  });
  const analysisCtx = { auth: { getUserIdentity: async () => null }, db: analysisDb };
  const analysisArgs = {
    handle: "source.one",
    postId: "post-one",
    owner: "analysis-owner",
    sourceRevision: 3,
    resultJson: JSON.stringify({ date: "2026-07-28", title: "Durable analysis" }),
    model: "qa-model",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    serviceSecret: "qa-durability-secret",
  };
  assert.deepEqual(await recordOpenAiAnalysis._handler(analysisCtx, analysisArgs), {
    recorded: true,
    reason: "recorded",
  });
  assert.equal(analysisTables.scrapedPosts[0].analysisRevision, 3);
  assert.equal(analysisTables.scrapedPosts[0].analysisTotalTokens, 30);
  assert.deepEqual(await recordOpenAiAnalysis._handler(analysisCtx, analysisArgs), {
    recorded: false,
    reason: "already_recorded",
  });
  analysisTables.scrapedPosts[0].analysisResultJson = "not-json";
  assert.deepEqual(await recordOpenAiAnalysis._handler(analysisCtx, analysisArgs), {
    recorded: true,
    reason: "recorded",
  });
  assert.deepEqual(JSON.parse(analysisTables.scrapedPosts[0].analysisResultJson), {
    date: "2026-07-28",
    title: "Durable analysis",
  });
  await assert.rejects(
    recordOpenAiAnalysis._handler(analysisCtx, { ...analysisArgs, resultJson: "not-json" }),
    /json/i,
  );
  analysisTables.scrapedPosts[0].sourceRevision = 4;
  await assert.rejects(
    recordOpenAiAnalysis._handler(analysisCtx, analysisArgs),
    /stale processing fence/i,
  );
  analysisTables.scrapedPosts[0].processingLeaseExpiresAt = Date.now() - 1;
  await assert.rejects(
    recordOpenAiAnalysis._handler(analysisCtx, { ...analysisArgs, sourceRevision: 4 }),
    /stale processing fence/i,
  );

  const retryStartedAt = Date.now();
  const { db: retryDb, tables: retryTables } = createDb({
    scrapedPosts: [
      {
        _id: "saved-post-retry",
        handle: "source.retry",
        postId: "post-retry",
        instagramPostUrl: "https://www.instagram.com/p/post-retry/",
        sourceRevision: 2,
        processingStatus: "processing",
        processingAttempts: 3,
        processingLeaseOwner: "retry-owner",
        processingLeaseExpiresAt: retryStartedAt + 60_000,
        blocksPaidFetch: true,
      },
    ],
  });
  const retryCtx = { auth: { getUserIdentity: async () => null }, db: retryDb };
  await recordProcessingResult._handler(retryCtx, {
    handle: "source.retry",
    postId: "post-retry",
    status: "retryable_failure",
    outcome: "processing_exception",
    error: "transient failure",
    owner: "retry-owner",
    sourceRevision: 2,
    serviceSecret: "qa-durability-secret",
  });
  const retryPost = retryTables.scrapedPosts[0];
  assert.equal(retryPost.blocksPaidFetch, false);
  assert.ok(retryPost.processingRetryAt > retryStartedAt);
  assert.deepEqual(
    await getBacklogStateByHandle._handler(retryCtx, {
      handle: "source.retry",
      horizonCutoffMs: retryStartedAt - 10 * 24 * 60 * 60_000,
      serviceSecret: "qa-durability-secret",
    }),
    { actionable: 0, busy: 0, total: 1 },
    "circuit-delayed retryable rows must not block a fresh fetch for the same handle",
  );
  assert.deepEqual(
    await claimProcessing._handler(retryCtx, {
      handle: "source.retry",
      postId: "post-retry",
      owner: "next-owner",
      serviceSecret: "qa-durability-secret",
    }),
    {
      claimed: false,
      reason: "deferred",
      retryAt: retryPost.processingRetryAt,
    },
  );
  retryPost.processingRetryAt = Date.now() - 1;
  const dueClaim = await claimProcessing._handler(retryCtx, {
    handle: "source.retry",
    postId: "post-retry",
    owner: "next-owner",
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(dueClaim.claimed, true);
  assert.equal(retryPost.blocksPaidFetch, true);
  assert.equal(retryPost.processingRetryAt, undefined);

  const now = Date.now();
  const cutoff = now - 10 * 24 * 60 * 60_000;
  const { db: reconcileDb, tables: reconcileTables } = createDb({
    scrapedPosts: [
      { _id: "retryable", processingStatus: "retryable_failure", processingAttempts: 2, blocksPaidFetch: true },
      { _id: "old-pending", processingStatus: "pending", postedAtMs: cutoff - 1, blocksPaidFetch: true },
      { _id: "expired", processingStatus: "processing", processingLeaseExpiresAt: now - 1, blocksPaidFetch: true },
      { _id: "active", processingStatus: "processing", processingLeaseExpiresAt: now + 60_000, blocksPaidFetch: true },
      { _id: "terminal", processingStatus: "completed", processingOutcome: "terminal_no_event", blocksPaidFetch: true },
      { _id: "recent", processingStatus: "pending", postedAtMs: cutoff + 1, blocksPaidFetch: true },
    ],
  });
  const reconcileCtx = { auth: { getUserIdentity: async () => null }, db: reconcileDb };
  assert.deepEqual(
    await reconcilePaidFetchFlags._handler(reconcileCtx, {
      ids: reconcileTables.scrapedPosts.map((post) => post._id),
      horizonCutoffMs: cutoff,
      serviceSecret: "qa-durability-secret",
    }),
    {
      scanned: 6,
      releasedTerminal: 1,
      releasedRetryable: 1,
      releasedOutOfHorizon: 1,
      releasedExpiredLease: 1,
    },
  );
  assert.equal(reconcileTables.scrapedPosts.find((post) => post._id === "active").blocksPaidFetch, true);
  assert.equal(reconcileTables.scrapedPosts.find((post) => post._id === "recent").blocksPaidFetch, true);
  assert.equal(reconcileTables.scrapedPosts.find((post) => post._id === "expired").processingStatus, "retryable_failure");

  const scrapedPostsSource = readFileSync(
    new URL("../convex/scrapedPosts.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    scrapedPostsSource,
    /hasSourceContentChanged[\s\S]*analysisRevision: undefined[\s\S]*analysisResultJson: undefined/,
    "A changed source revision must invalidate durable cached analysis.",
  );
  assert.match(
    runnerSource,
    /cachedAnalysisJson[\s\S]*JSON\.parse[\s\S]*cached_analysis_invalid/,
    "Malformed cached analysis must fail safely into a fresh analysis attempt.",
  );
} finally {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
}

console.log("Instagram ingestion durability QA passed.");
