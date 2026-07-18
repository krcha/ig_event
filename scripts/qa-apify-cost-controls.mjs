import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocumentSize } from "convex/values";
import {
  buildApifyInstagramScrapeRequest,
  mapApifyItemToInstagramPost,
} from "../lib/scraper/instagram-scraper.ts";
import {
  getCronIngestionConfig,
  isAuthorizedCronRequestHeader,
  selectCronIngestionHandles,
} from "../lib/pipeline/cron-ingestion-config.ts";
import { getAttemptedHandlesFromRecentJob } from "../lib/pipeline/recent-full-scrape-handles.ts";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { loadOperationalVenueRecords } from "../lib/pipeline/operational-venues.ts";
import {
  MAX_INGESTION_JOB_HANDLES,
  MAX_INGESTION_JOB_PERSISTED_JSON_BYTES,
  serializeSafeIngestionJobPayload,
} from "../lib/pipeline/ingestion-job-safety.ts";

const request = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: undefined,
  daysBack: undefined,
  env: {},
});

assert.equal(request.input.dataDetailLevel, "basicData");
assert.equal(request.input.skipPinnedPosts, false);
assert.equal(request.input.resultsLimit, 2);
assert.equal(request.input.onlyPostsNewerThan, "10 days");
assert.equal(request.runOptions.maxItems, 2);
assert.equal(request.runOptions.timeout, 120);
assert.equal(request.runOptions.memory, undefined);
assert.ok(
  request.runOptions.maxTotalChargeUsd > 0 && request.runOptions.maxTotalChargeUsd <= 0.01,
  "default Apify per-run charge cap should stay low",
);

assert.equal(
  mapApifyItemToInstagramPost(
    {
      id: "not-a-post",
      url: "https://www.instagram.com/private_venue/",
      username: "private_venue",
      error: "no_items",
      errorDescription: "Empty, private, or restricted profile.",
    },
    "private_venue",
  ),
  null,
  "Apify error/result-marker rows must never become fetched Instagram posts.",
);

const detailedRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 5,
  daysBack: 30,
  env: {
    APIFY_DATA_DETAIL_LEVEL: "detailedData",
    APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN: "0.04",
    APIFY_RUN_TIMEOUT_SECONDS: "90",
    APIFY_MEMORY_MBYTES: "8192",
    APIFY_SKIP_PINNED_POSTS: "true",
  },
});
assert.equal(detailedRequest.input.dataDetailLevel, "detailedData");
assert.equal(detailedRequest.input.skipPinnedPosts, true);
assert.equal(detailedRequest.input.resultsLimit, 5);
assert.equal(detailedRequest.input.onlyPostsNewerThan, "30 days");
assert.equal(detailedRequest.runOptions.maxTotalChargeUsd, 0.01);
assert.equal(detailedRequest.runOptions.timeout, 90);
assert.equal(detailedRequest.runOptions.memory, 8192);

const adversarialChargeRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 5,
  env: { APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN: "50" },
});
assert.equal(
  adversarialChargeRequest.runOptions.maxTotalChargeUsd,
  0.01,
  "configured Apify charge values must not bypass the hard per-account cap",
);

const normalizedMemoryRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 3,
  daysBack: 10,
  env: {
    APIFY_MEMORY_MBYTES: "4gb",
  },
});
assert.equal(normalizedMemoryRequest.runOptions.memory, 4096);

const cronConfig = getCronIngestionConfig({});
assert.deepEqual(cronConfig, {
  resultsLimit: 1,
  daysBack: 10,
  maxHandlesPerRun: 1500,
  fullScrapeCooldownHours: 23,
});

const vercelConfig = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
assert.deepEqual(
  vercelConfig.crons,
  [],
  "Vercel Cron should stay disabled; the VPS host cron owns ingestion scheduling.",
);

const cronRouteSource = readFileSync(
  new URL("../app/api/cron/ingest-venues/route.ts", import.meta.url),
  "utf8",
);
const instagramScraperSource = readFileSync(
  new URL("../lib/scraper/instagram-scraper.ts", import.meta.url),
  "utf8",
);
const followDiscoverySource = readFileSync(
  new URL("../lib/pipeline/follow-discovery.ts", import.meta.url),
  "utf8",
);
const ingestionJobsSource = readFileSync(
  new URL("../convex/ingestionJobs.ts", import.meta.url),
  "utf8",
);
const ingestionRunnerSource = readFileSync(
  new URL("../lib/pipeline/run-instagram-ingestion.ts", import.meta.url),
  "utf8",
);
const operationalVenuesSource = readFileSync(
  new URL("../lib/pipeline/operational-venues.ts", import.meta.url),
  "utf8",
);
const hostCronRunnerSource = readFileSync(
  new URL("./ig-event-cron-runner", import.meta.url),
  "utf8",
);
const adminVenueScrapeRouteSource = readFileSync(
  new URL("../app/api/admin/scrape/venues/route.ts", import.meta.url),
  "utf8",
);
const adminRepairRouteSource = readFileSync(
  new URL("../app/api/admin/scrape/repair/route.ts", import.meta.url),
  "utf8",
);

assert.match(operationalVenuesSource, /venues:listActiveVenueIngestionFieldsPaginated/);
assert.match(operationalVenuesSource, /venues:listVenueIngestionFieldsPaginated/);
assert.match(operationalVenuesSource, /continueCursor/);
assert.doesNotMatch(ingestionRunnerSource, /"venues:listActiveVenues"/);

let operationalPageCalls = 0;
const operationalRecords = await loadOperationalVenueRecords({
  client: {
    query: async (query, args) => {
      operationalPageCalls += 1;
      assert.match(String(query), /listActiveVenueIngestionFieldsPaginated/);
      assert.equal(args.serviceSecret, "service-secret");
      if (operationalPageCalls === 1) {
        assert.equal(args.paginationOpts.cursor, null);
        return {
          page: [{ name: "Venue One", instagramHandle: "venue.one" }],
          isDone: false,
          continueCursor: "cursor-1",
        };
      }
      assert.equal(args.paginationOpts.cursor, "cursor-1");
      return {
        page: [{ name: "Venue Two", instagramHandle: "venue.two" }],
        isDone: true,
        continueCursor: "",
      };
    },
  },
  serviceSecret: "service-secret",
  activeOnly: true,
});
assert.equal(operationalPageCalls, 2);
assert.deepEqual(operationalRecords.map((venue) => venue.instagramHandle), [
  "venue.one",
  "venue.two",
]);

let splitPageCalls = 0;
const splitOperationalRecords = await loadOperationalVenueRecords({
  client: {
    query: async (_query, args) => {
      splitPageCalls += 1;
      if (splitPageCalls === 1) {
        assert.equal(args.paginationOpts.cursor, null);
        assert.equal(args.paginationOpts.endCursor, undefined);
        return {
          page: [{ name: "Incomplete", instagramHandle: "must.not.persist" }],
          isDone: true,
          continueCursor: "cursor-end",
          splitCursor: "cursor-half",
          pageStatus: "SplitRequired",
        };
      }
      if (splitPageCalls === 2) {
        assert.equal(args.paginationOpts.cursor, null);
        assert.equal(args.paginationOpts.endCursor, "cursor-half");
        return {
          page: [{ name: "Split One", instagramHandle: "split.one" }],
          isDone: true,
          continueCursor: "cursor-half",
        };
      }
      assert.equal(args.paginationOpts.cursor, "cursor-half");
      assert.equal(args.paginationOpts.endCursor, "cursor-end");
      return {
        page: [{ name: "Split Two", instagramHandle: "split.two" }],
        isDone: true,
        continueCursor: "cursor-end",
      };
    },
  },
  serviceSecret: "service-secret",
  activeOnly: true,
});
assert.equal(splitPageCalls, 3);
assert.deepEqual(
  splitOperationalRecords.map((venue) => venue.instagramHandle),
  ["split.one", "split.two"],
  "SplitRequired pages must be replaced by both complete cursor ranges",
);

for (const [label, source] of [
  ["instagram scraper", instagramScraperSource],
  ["follow discovery", followDiscoverySource],
]) {
  assert.doesNotMatch(
    source,
    /new URLSearchParams\(\{\s*token:|searchParams\.set\(["']token["']/s,
    `${label} must not put APIFY_API_TOKEN into request URLs`,
  );
}

assert.match(
  cronRouteSource,
  /const minCreatedAt = Date\.now\(\) - cronConfig\.fullScrapeCooldownHours \* MS_PER_HOUR/,
  "cron route should honor the configured cooldown instead of forcing a longer interval",
);
assert.match(
  cronRouteSource,
  /findResumableCronJob/,
  "cron route should resume recent cron jobs before applying cooldown skips",
);
assert.match(
  ingestionJobsSource,
  /summaryJson: job\.summaryJson/,
  "recent full-scrape job records should expose summaries for cooldown decisions",
);
assert.doesNotMatch(
  cronRouteSource,
  /Math\.max\(FULL_SCRAPE_COOLDOWN_MS/,
  "cron route must not force the old 24-hour minimum cooldown over the daily config",
);
assert.equal(
  MAX_INGESTION_JOB_HANDLES,
  500,
  "all ingestion job creation paths must share the Convex-safe handle bound",
);
assert.match(
  cronRouteSource,
  /MAX_INGESTION_JOB_HANDLES/,
  "cron jobs must use the central Convex document-size boundary",
);
for (const [label, source] of [
  ["admin all-venues scrape", adminVenueScrapeRouteSource],
  ["admin repair scrape", adminRepairRouteSource],
]) {
  assert.match(
    source,
    /MAX_INGESTION_JOB_HANDLES/,
    `${label} must use the central 500-handle job boundary`,
  );
  assert.match(source, /serializeSafeIngestionJobPayload/);
}
assert.match(
  cronRouteSource,
  /maxHandlesPerRun: maxHandlesPerJob/,
  "cron route should chunk the 1500-handle run into bounded jobs",
);
assert.match(
  hostCronRunnerSource,
  /INGEST_CRON_MAX_REQUESTS_PER_RUN:-3/,
  "host runner should complete three 500-handle chunks per scheduled run",
);
assert.match(hostCronRunnerSource, /skippedDueToRunLimit/);
assert.match(hostCronRunnerSource, /hostRunRemaining/);
assert.match(hostCronRunnerSource, /HOST_RUN_MAX_HANDLES - TOTAL_SELECTED/);
assert.match(hostCronRunnerSource, /trap cleanup_sensitive_temp_file EXIT/);
assert.match(
  ingestionJobsSource,
  /assertIngestionJobPayloadWithinBounds/,
  "the central Convex mutation boundary must reject oversized job documents",
);
assert.match(
  cronRouteSource,
  /includeErroredCompletedHandles: true/,
  "same host run should advance past errored handles instead of retrying one chunk",
);

assert.equal(
  isAuthorizedCronRequestHeader(null, { NODE_ENV: "production", CRON_SECRET: "" }),
  false,
  "production cron must not be public when CRON_SECRET is blank",
);
assert.equal(
  isAuthorizedCronRequestHeader("Bearer secret", {
    NODE_ENV: "production",
    CRON_SECRET: "secret",
  }),
  true,
);
assert.equal(
  isAuthorizedCronRequestHeader(null, { NODE_ENV: "development", CRON_SECRET: "" }),
  true,
);

assert.deepEqual(
  selectCronIngestionHandles({
    activeVenueHandles: Array.from({ length: 1500 }, (_, index) => `venue-${index + 1}`),
    recentlyAttemptedHandles: [],
    maxHandlesPerRun: cronConfig.maxHandlesPerRun,
  }),
  {
    handles: Array.from({ length: 1500 }, (_, index) => `venue-${index + 1}`),
    skippedRecentlyAttempted: 0,
    skippedDueToRunLimit: 0,
  },
  "default cron selection should cover every active handle up to the configured cap",
);

const boundaryHandles = Array.from(
  { length: 500 },
  (_, index) => `v${String(index).padStart(29, "0")}`,
);
const boundarySummary = createEmptyIngestionSummary(boundaryHandles);
for (const handleSummary of boundarySummary.handles) {
  handleSummary.errors = [`provider failure: ${"x".repeat(2_048)}`];
}
const boundaryState = createInitialIngestionBatchState();
boundaryState.seenSourceKeysByHandle = Object.fromEntries(
  boundaryHandles.map((handle) => [handle, [`${handle}:ordinary-source-key`]]),
);
const boundaryPayload = serializeSafeIngestionJobPayload({
  handles: boundaryHandles,
  summary: boundarySummary,
  state: boundaryState,
});
assert.ok(
  Buffer.byteLength(boundaryPayload.summaryJson) + Buffer.byteLength(boundaryPayload.stateJson) <=
    MAX_INGESTION_JOB_PERSISTED_JSON_BYTES,
);
const boundaryDocumentSize = getDocumentSize({
  source: "cron_active_venues",
  mode: "full_scrape",
  status: "running",
  handles: boundaryHandles,
  resultsLimit: 1,
  daysBack: 10,
  batchSize: 64,
  summaryJson: boundaryPayload.summaryJson,
  stateJson: boundaryPayload.stateJson,
  stateVersion: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
assert.ok(
  boundaryDocumentSize < 850_000,
  `500-handle job with adversarial provider errors should retain document-size headroom, got ${boundaryDocumentSize} bytes`,
);
assert.throws(
  () =>
    serializeSafeIngestionJobPayload({
      handles: Array.from({ length: 501 }, (_, index) => `too-many-${index}`),
      summary: createEmptyIngestionSummary(
        Array.from({ length: 501 }, (_, index) => `too-many-${index}`),
      ),
      state: createInitialIngestionBatchState(),
    }),
  /limited to 500 handles/,
);
assert.throws(
  () =>
    serializeSafeIngestionJobPayload({
      handles: ["x".repeat(129)],
      summary: createEmptyIngestionSummary(["x".repeat(129)]),
      state: createInitialIngestionBatchState(),
    }),
  /at most 128 UTF-8 bytes/,
);

assert.deepEqual(
  selectCronIngestionHandles({
    activeVenueHandles: ["a", "b", "c", "d", "e"],
    recentlyAttemptedHandles: ["b", "d"],
    maxHandlesPerRun: 2,
  }),
  {
    handles: ["a", "c"],
    skippedRecentlyAttempted: 2,
    skippedDueToRunLimit: 1,
  },
);

assert.deepEqual(
  getAttemptedHandlesFromRecentJob({
    _id: "job_ok",
    source: "cron_active_venues",
    status: "completed",
    handles: ["good-zero", "good-fetched", "apify-hard-limit", "legacy-no-summary"],
    stateJson: "{}",
    createdAt: Date.now(),
    summaryJson: JSON.stringify({
      handles: [
        { handle: "good-zero", fetchedPosts: 0, errors: [] },
        { handle: "good-fetched", fetchedPosts: 1, errors: [] },
        {
          handle: "apify-hard-limit",
          fetchedPosts: 0,
          errors: ["Apify scraper request failed: 403 Monthly usage hard limit exceeded"],
        },
      ],
    }),
  }),
  ["good-zero", "good-fetched", "legacy-no-summary"],
  "completed jobs should not cool down handles that only recorded scraper/API errors",
);

console.log("Apify cost-control QA passed.");
