import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_INGESTION_FETCH_PAGE_SIZE,
  DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
  evaluateFetchWindow,
  getFetchBoundary,
  getLatestPost24hSamplingPolicy,
  isLatestPost24hSamplingEnabled,
  isPaidIngestionEnabled,
  nextContinuationResultsLimit,
  selectSourcesFairly,
} from "../lib/pipeline/instagram-ingestion-durability.ts";
import {
  claimPaidFetchLease,
  claimProcessing,
  getBacklogStateByHandle,
  markPaidFetchRequestStarted,
  markOpenAiAnalysisAttemptStarted,
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
assert.equal(isLatestPost24hSamplingEnabled({}), false);
assert.equal(
  isLatestPost24hSamplingEnabled({ INGESTION_LATEST_POST_24H_SAMPLING: "yes" }),
  true,
);
assert.equal(
  getLatestPost24hSamplingPolicy({ fetchStartedAt: startedAt }),
  null,
  "Latest-one sampling must remain opt-in so the high-recall protocol is unchanged by default.",
);
assert.deepEqual(
  getLatestPost24hSamplingPolicy({
    fetchStartedAt: startedAt,
    samplingMode: "latest_one_24h",
  }),
  {
    enabled: true,
    resultsLimit: 1,
    daysBack: 1,
    bootstrapDays: 1,
    cutoffAtMs: startedAt - 24 * 60 * 60_000,
    upperBoundAtMs: startedAt,
    onlyPostsNewerThan: "2026-07-26T10:00:00.000Z",
  },
  "The sampling policy must use one result and one exact UTC 24-hour cutoff.",
);
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
const dailyCronRouteSource = readFileSync(
  new URL("../app/api/cron/ingest-venues/route.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  runnerSource,
  /isLatestPost24hSamplingEnabled/,
  "The shared ingestion runner must not turn admin or discovery scrapes into daily sampling.",
);
assert.match(
  dailyCronRouteSource,
  /const samplingMode = isLatestPost24hSamplingEnabled\(\)[\s\S]*samplingMode,/,
  "Only the daily venue cron route should opt into latest-one sampling.",
);
assert.match(
  dailyCronRouteSource,
  /resultsLimit: effectiveResultsLimit,[\s\S]*daysBack: effectiveDaysBack,[\s\S]*samplingMode,/,
  "The daily route must override resumable legacy 3/10 jobs with the strict 1/1 sampling policy.",
);
assert.doesNotMatch(dailyCronRouteSource, /resultsLimit: claimedJob\.resultsLimit/);
assert.doesNotMatch(dailyCronRouteSource, /daysBack: claimedJob\.daysBack/);
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
  freshFetchBlock,
  /latestPostSampling === null && rawItemCount >= requestedResultsLimit/,
  "Intentional latest-one sampling must mark a one-row response complete instead of scheduling a deeper continuation.",
);
assert.match(
  runnerSource,
  /requirePostedAt: latestPostSampling\?\.enabled/,
  "Latest-one sampling must fail closed when Apify does not provide a post timestamp.",
);
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
        handle: "source.one",
        postId: "terminal-post",
        blocksPaidFetch: true,
        processingStatus: "completed",
        processingOutcome: "receipt_complete",
      },
      {
        _id: "retryable-stale-blocker",
        handle: "source.one",
        postId: "retry-post",
        blocksPaidFetch: true,
        processingStatus: "retryable_failure",
        processingAttempts: 2,
      },
      {
        _id: "expired-processing-blocker",
        handle: "source.one",
        postId: "expired-post",
        blocksPaidFetch: true,
        processingStatus: "processing",
        processingAttempts: 1,
        processingLeaseOwner: "dead-owner",
        processingLeaseExpiresAt: mutationFetchStartedAt - 1,
      },
      {
        _id: "old-out-of-horizon-blocker",
        handle: "source.one",
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
    attemptCooldownMs: 0,
    requestBoundaryVersion: 1,
    serviceSecret: "qa-durability-secret",
  };

  const firstClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-a" });
  assert.equal(firstClaim.claimed, true);
  assert.equal(
    tables.instagramSources[0].lastFetchAttemptAt,
    undefined,
    "claiming budget and a lease must not record a provider attempt before the network boundary",
  );
  assert.equal(
    tables.ingestionCostReservations[0].requestStartedAt,
    undefined,
    "boundary-aware claims must leave the budget reservation explicitly pre-request",
  );
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
  const lostClaimAcknowledgementRetry = await claimPaidFetchLease._handler(ctx, {
    ...common,
    owner: "owner-a",
  });
  assert.equal(lostClaimAcknowledgementRetry.claimed, true);
  assert.equal(lostClaimAcknowledgementRetry.reason, "resumed_claim");
  assert.equal(lostClaimAcknowledgementRetry.reservationId, firstClaim.reservationId);
  assert.equal(
    tables.ingestionCostReservations.length,
    1,
    "a lost claim acknowledgement must resume the exact reservation without double spending",
  );
  const busyClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-b" });
  assert.deepEqual(busyClaim, { claimed: false, reason: "busy" });
  const releasedUnused = await releasePaidFetchLease._handler(ctx, {
    owner: "owner-a",
    requestStarted: false,
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(releasedUnused.chargedMicros, 0);
  assert.equal(releasedUnused.releasedMicros, 40_000);
  assert.equal(
    tables.instagramSources[0].lastFetchAttemptAt,
    undefined,
    "a claim released before transport starts must not create source cooldown",
  );

  const secondClaim = await claimPaidFetchLease._handler(ctx, { ...common, owner: "owner-b" });
  assert.equal(secondClaim.claimed, true);
  const requestReceipt = await markPaidFetchRequestStarted._handler(ctx, {
    handle: "source.one",
    owner: "owner-b",
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(requestReceipt.marked, true);
  assert.equal(
    tables.instagramSources[0].lastFetchAttemptAt,
    requestReceipt.requestStartedAt,
    "the source attempt receipt must appear exactly when provider execution begins",
  );
  assert.equal(
    tables.ingestionCostReservations.find((row) => row.owner === "owner-b").requestStartedAt,
    requestReceipt.requestStartedAt,
    "the budget reservation must durably record the same provider request boundary",
  );
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
  await markPaidFetchRequestStarted._handler(ctx, {
    handle: "source.one",
    owner: "owner-c",
    serviceSecret: "qa-durability-secret",
  });
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

  const createPaidFetchCrashFixture = (handle) => {
    const fixture = createDb({
      instagramPaidFetchControl: [
        {
          _id: `control-${handle}`,
          key: "apify",
          backlogIndexReady: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      scrapedPosts: [],
      instagramSources: [
        { _id: `source-${handle}`, handle, active: true, createdAt: 1, updatedAt: 1 },
      ],
      ingestionCostReservations: [],
      ingestionDailyBudgets: [],
      instagramHandleFetchStates: [],
    });
    return {
      ...fixture,
      ctx: { auth: { getUserIdentity: async () => null }, db: fixture.db },
    };
  };

  const samplingIsolation = createPaidFetchCrashFixture("source.sample-isolation");
  const samplingSource = samplingIsolation.tables.instagramSources[0];
  samplingSource.lastSuccessfulFetchThroughAt = checkpointBefore;
  samplingSource.continuationActive = true;
  samplingSource.continuationBoundaryAt = checkpointBefore;
  samplingSource.continuationResultsLimit = 50;
  samplingSource.continuationReason = "provider_result_cap_at_configured_max";
  samplingSource.deferredAt = checkpointBefore + 1;
  samplingIsolation.tables.instagramHandleFetchStates.push({
    _id: "sample-isolation-high-recall-state",
    handle: "source.sample-isolation",
    boundaryKey: String(checkpointBefore),
    nextResultsLimit: 50,
    hardBlocked: true,
    lastRequestedMaxItems: 50,
    lastRawItemCount: 50,
    createdAt: 1,
    updatedAt: 1,
  });
  const sampleFetchStartedAt = Date.parse("2026-07-27T12:00:00.000Z");
  const sampleClaim = await claimPaidFetchLease._handler(samplingIsolation.ctx, {
    ...common,
    handle: "source.sample-isolation",
    owner: "sample-isolation-owner",
    requestedResultsLimit: 50,
    fetchStartedAt: sampleFetchStartedAt,
    horizonCutoffMs: sampleFetchStartedAt - 24 * 60 * 60_000,
    dayKey: "2026-07-27-sample-isolation",
    dailyBudgetUsd: 0.1,
    maxChargeUsd: 0.01,
    samplingMode: "latest_one_24h",
  });
  assert.equal(sampleClaim.claimed, true, "sampling must ignore a high-recall hard block");
  assert.equal(sampleClaim.resultsLimit, 1, "the durable sample lease must itself be capped at one");
  assert.equal(sampleClaim.boundaryKey, `latest24h:${sampleFetchStartedAt}`);
  assert.equal(
    sampleClaim.onlyPostsNewerThan,
    "2026-07-26T12:00:00.000Z",
    "the durable sample lease must retain the exact fetch-start-minus-24h cutoff",
  );
  await assert.rejects(
    recordPaidFetchWindowSaturation._handler(samplingIsolation.ctx, {
      handle: "source.sample-isolation",
      owner: "sample-isolation-owner",
      rawItemCount: 1,
      serviceSecret: "qa-durability-secret",
    }),
    /cannot create high-recall continuation/i,
  );
  await markPaidFetchRequestStarted._handler(samplingIsolation.ctx, {
    handle: "source.sample-isolation",
    owner: "sample-isolation-owner",
    serviceSecret: "qa-durability-secret",
  });
  const sampleSuccess = await recordPaidFetchWindowSuccess._handler(samplingIsolation.ctx, {
    handle: "source.sample-isolation",
    owner: "sample-isolation-owner",
    serviceSecret: "qa-durability-secret",
  });
  assert.deepEqual(sampleSuccess, {
    recorded: true,
    checkpointAdvanced: false,
    checkpointAt: null,
    sampleCompleted: true,
  });
  assert.equal(samplingSource.lastSuccessfulFetchThroughAt, checkpointBefore);
  assert.equal(samplingSource.continuationActive, true);
  assert.equal(samplingSource.continuationResultsLimit, 50);
  assert.equal(samplingSource.deferredAt, checkpointBefore + 1);
  assert.equal(samplingIsolation.tables.instagramHandleFetchStates.length, 1);
  assert.equal(samplingIsolation.tables.instagramHandleFetchStates[0].hardBlocked, true);
  await releasePaidFetchLease._handler(samplingIsolation.ctx, {
    owner: "sample-isolation-owner",
    requestStarted: true,
    actualChargeUsd: 0.01,
    serviceSecret: "qa-durability-secret",
  });
  samplingSource.lastFetchAttemptAt = Date.now() - 24 * 60 * 60_000;
  const nextDaySampleClaim = await claimPaidFetchLease._handler(samplingIsolation.ctx, {
    ...common,
    handle: "source.sample-isolation",
    owner: "next-day-sample-owner",
    requestedResultsLimit: 50,
    fetchStartedAt: sampleFetchStartedAt + 24 * 60 * 60_000,
    horizonCutoffMs: sampleFetchStartedAt,
    attemptCooldownMs: 23 * 60 * 60_000,
    dayKey: "2026-07-28-sample-isolation",
    dailyBudgetUsd: 0.1,
    maxChargeUsd: 0.01,
    samplingMode: "latest_one_24h",
  });
  assert.equal(nextDaySampleClaim.claimed, true);
  assert.equal(nextDaySampleClaim.resultsLimit, 1);
  await releasePaidFetchLease._handler(samplingIsolation.ctx, {
    owner: "next-day-sample-owner",
    requestStarted: false,
    serviceSecret: "qa-durability-secret",
  });
  const preservedHighRecallClaim = await claimPaidFetchLease._handler(samplingIsolation.ctx, {
    ...common,
    handle: "source.sample-isolation",
    owner: "high-recall-owner",
    attemptCooldownMs: 0,
    dayKey: "2026-07-27-high-recall",
    dailyBudgetUsd: 0.1,
    maxChargeUsd: 0.01,
  });
  assert.equal(preservedHighRecallClaim.claimed, false);
  assert.equal(
    preservedHighRecallClaim.reason,
    "hard_cap_saturated",
    "sampling must leave the legacy high-recall continuation lane untouched",
  );

  const preBoundary = createPaidFetchCrashFixture("source.pre-boundary");
  const preBoundaryArgs = {
    ...common,
    handle: "source.pre-boundary",
    owner: "pre-boundary-owner-a",
    dayKey: "2026-07-29",
    attemptCooldownMs: 23 * 60 * 60_000,
  };
  const preBoundaryClaim = await claimPaidFetchLease._handler(preBoundary.ctx, preBoundaryArgs);
  assert.equal(preBoundaryClaim.claimed, true);
  assert.equal(preBoundary.tables.ingestionCostReservations[0].requestStartedAt, undefined);
  preBoundary.tables.instagramPaidFetchControl[0].leaseExpiresAt = Date.now() - 1;
  const preBoundaryRetry = await claimPaidFetchLease._handler(preBoundary.ctx, {
    ...preBoundaryArgs,
    owner: "pre-boundary-owner-b",
    fetchStartedAt: Date.now(),
  });
  assert.equal(preBoundaryRetry.claimed, true, "a pre-boundary crash may safely retry");
  assert.equal(preBoundary.tables.ingestionCostReservations[0].status, "released");
  assert.equal(preBoundary.tables.ingestionCostReservations[0].chargedMicros, 0);
  assert.equal(preBoundary.tables.ingestionCostReservations[0].releasedMicros, 40_000);
  assert.equal(preBoundary.tables.ingestionDailyBudgets[0].chargedMicros, 0);
  assert.equal(preBoundary.tables.ingestionDailyBudgets[0].releasedMicros, 40_000);
  assert.equal(
    preBoundary.tables.instagramSources[0].lastFetchAttemptAt,
    undefined,
    "a pre-transport crash must not create a false provider cooldown receipt",
  );
  await releasePaidFetchLease._handler(preBoundary.ctx, {
    owner: "pre-boundary-owner-b",
    requestStarted: false,
    serviceSecret: "qa-durability-secret",
  });

  const postBoundary = createPaidFetchCrashFixture("source.post-boundary");
  const postBoundaryArgs = {
    ...common,
    handle: "source.post-boundary",
    owner: "post-boundary-owner-a",
    dayKey: "2026-07-30",
    attemptCooldownMs: 23 * 60 * 60_000,
  };
  assert.equal(
    (await claimPaidFetchLease._handler(postBoundary.ctx, postBoundaryArgs)).claimed,
    true,
  );
  await markPaidFetchRequestStarted._handler(postBoundary.ctx, {
    handle: "source.post-boundary",
    owner: "post-boundary-owner-a",
    serviceSecret: "qa-durability-secret",
  });
  const sameOwnerRetry = await claimPaidFetchLease._handler(postBoundary.ctx, postBoundaryArgs);
  assert.equal(sameOwnerRetry.claimed, false);
  assert.equal(sameOwnerRetry.reason, "recent_provider_attempt");
  assert.equal(postBoundary.tables.ingestionCostReservations.length, 1);
  postBoundary.tables.instagramPaidFetchControl[0].leaseExpiresAt = Date.now() - 1;
  const postBoundaryRetry = await claimPaidFetchLease._handler(postBoundary.ctx, {
    ...postBoundaryArgs,
    owner: "post-boundary-owner-b",
    fetchStartedAt: Date.now(),
  });
  assert.equal(postBoundaryRetry.claimed, false);
  assert.equal(postBoundaryRetry.reason, "recent_provider_attempt");
  assert.equal(
    postBoundary.tables.ingestionCostReservations.length,
    1,
    "a post-boundary crash must not create a second paid reservation inside cooldown",
  );
  assert.equal(postBoundary.tables.ingestionCostReservations[0].status, "reconciled");
  assert.equal(postBoundary.tables.ingestionDailyBudgets[0].chargedMicros, 40_000);
  assert.equal(postBoundary.tables.ingestionDailyBudgets[0].reservedMicros, 0);

  const boundaryAwareFinalize = createPaidFetchCrashFixture("source.boundary-aware-finalize");
  const boundaryAwareFinalizeArgs = {
    ...common,
    handle: "source.boundary-aware-finalize",
    owner: "boundary-aware-finalize-owner",
    dayKey: "2026-07-30-finalize",
  };
  assert.equal(
    (await claimPaidFetchLease._handler(boundaryAwareFinalize.ctx, boundaryAwareFinalizeArgs)).claimed,
    true,
  );
  await markPaidFetchRequestStarted._handler(boundaryAwareFinalize.ctx, {
    handle: boundaryAwareFinalizeArgs.handle,
    owner: boundaryAwareFinalizeArgs.owner,
    serviceSecret: "qa-durability-secret",
  });
  const provenNoTransportRelease = await releasePaidFetchLease._handler(
    boundaryAwareFinalize.ctx,
    {
      owner: boundaryAwareFinalizeArgs.owner,
      requestStarted: false,
      serviceSecret: "qa-durability-secret",
    },
  );
  assert.equal(
    provenNoTransportRelease.chargedMicros,
    0,
    "a surviving boundary-aware worker must retract a marker when transport was never invoked",
  );
  assert.equal(provenNoTransportRelease.releasedMicros, 40_000);
  assert.equal(
    boundaryAwareFinalize.tables.instagramSources[0].lastFetchAttemptAt,
    undefined,
    "marker retraction must remove the false source cooldown receipt",
  );
  assert.equal(
    boundaryAwareFinalize.tables.instagramSources[0].lastFetchStatus,
    "preflight_released",
  );

  const legacyBridge = createPaidFetchCrashFixture("source.legacy-bridge");
  const legacyClaim = await claimPaidFetchLease._handler(legacyBridge.ctx, {
    ...common,
    handle: "source.legacy-bridge",
    owner: "legacy-owner",
    dayKey: "2026-07-31",
    attemptCooldownMs: 0,
    requestBoundaryVersion: undefined,
  });
  assert.equal(legacyClaim.claimed, true);
  assert.equal(
    typeof legacyBridge.tables.instagramSources[0].lastFetchAttemptAt,
    "number",
    "older web images must retain a conservative source-level cooldown receipt",
  );
  assert.equal(
    legacyBridge.tables.ingestionCostReservations[0].requestStartedAt,
    legacyBridge.tables.instagramSources[0].lastFetchAttemptAt,
    "older web claims must remain crash-conservative during mixed-version rollout",
  );
  const legacyPreflightRelease = await releasePaidFetchLease._handler(legacyBridge.ctx, {
    owner: "legacy-owner",
    requestStarted: false,
    serviceSecret: "qa-durability-secret",
  });
  assert.equal(legacyPreflightRelease.chargedMicros, 0);
  assert.equal(legacyPreflightRelease.releasedMicros, 40_000);
  assert.equal(
    legacyBridge.tables.instagramSources[0].lastFetchAttemptAt,
    undefined,
    "an older web caller's clean preflight release must remove its conservative claim receipt",
  );
  assert.equal(legacyBridge.tables.instagramSources[0].lastFetchStatus, "preflight_released");

  const legacyCrashBridge = createPaidFetchCrashFixture("source.legacy-crash");
  const legacyCrashArgs = {
    ...common,
    handle: "source.legacy-crash",
    owner: "legacy-crash-owner",
    dayKey: "2026-08-01",
    attemptCooldownMs: 23 * 60 * 60_000,
    requestBoundaryVersion: undefined,
  };
  assert.equal((await claimPaidFetchLease._handler(legacyCrashBridge.ctx, legacyCrashArgs)).claimed, true);
  legacyCrashBridge.tables.instagramPaidFetchControl[0].leaseExpiresAt = Date.now() - 1;
  const afterWebCutoverRetry = await claimPaidFetchLease._handler(legacyCrashBridge.ctx, {
    ...legacyCrashArgs,
    owner: "boundary-aware-owner-after-cutover",
    requestBoundaryVersion: 1,
    fetchStartedAt: Date.now(),
  });
  assert.equal(afterWebCutoverRetry.claimed, false);
  assert.equal(afterWebCutoverRetry.reason, "recent_provider_attempt");
  assert.equal(legacyCrashBridge.tables.ingestionCostReservations.length, 1);
  assert.equal(legacyCrashBridge.tables.ingestionCostReservations[0].status, "reconciled");
  assert.equal(legacyCrashBridge.tables.ingestionDailyBudgets[0].chargedMicros, 40_000);

  const nPlusOneOldPosts = [
    ...Array.from({ length: 101 }, (_, index) => ({
      _id: `old-blocker-${index}`,
      handle: "source.n1",
      postId: `old-post-${index}`,
      postedAtMs: horizonCutoffMs - index - 1,
      blocksPaidFetch: true,
      processingStatus: "pending",
    })),
    {
      _id: "unrelated-inactive-blocker",
      handle: "inactive.source",
      postId: "unrelated-post",
      postedAtMs: horizonCutoffMs + 1,
      blocksPaidFetch: true,
      processingStatus: "pending",
    },
  ];
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
    nPlusOneTables.scrapedPosts.filter(
      (post) => post.handle === "source.n1" && post.blocksPaidFetch,
    ).length,
    1,
    "the first bounded mutation should leave exactly the N+1 row for same-step maintenance",
  );
  const nPlusOneClaim = await claimPaidFetchLease._handler(nPlusOneCtx, nPlusOneArgs);
  assert.equal(nPlusOneClaim.claimed, true);
  assert.equal(
    nPlusOneTables.scrapedPosts.some(
      (post) => post.handle === "source.n1" && post.blocksPaidFetch,
    ),
    false,
  );
  assert.equal(
    nPlusOneTables.scrapedPosts.some(
      (post) => post.handle === "inactive.source" && post.blocksPaidFetch,
    ),
    true,
    "an unrelated inactive source may retain backlog without starving this handle's paid fetch",
  );

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
    ingestionDailyBudgets: [],
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
  const startArgs = {
    handle: "source.one",
    postId: "post-one",
    owner: "analysis-owner",
    sourceRevision: 3,
    protocol: "qa-protocol-v1",
    budgetDayKey: "2026-07-28",
    dailyRequestLimit: 2,
    serviceSecret: "qa-durability-secret",
  };
  assert.equal(
    (await markOpenAiAnalysisAttemptStarted._handler(analysisCtx, startArgs)).recorded,
    true,
  );
  assert.equal(analysisTables.ingestionDailyBudgets[0].chargedMicros, 1);
  assert.deepEqual(
    await markOpenAiAnalysisAttemptStarted._handler(analysisCtx, startArgs),
    { recorded: false, reason: "already_started" },
    "a repeated start marker must not create a second daily charge",
  );
  assert.equal(analysisTables.ingestionDailyBudgets[0].chargedMicros, 1);
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
