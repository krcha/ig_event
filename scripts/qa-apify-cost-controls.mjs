import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocumentSize } from "convex/values";
import {
  buildApifyInstagramScrapeRequest,
  mapApifyItemToInstagramPost,
} from "../lib/scraper/instagram-scraper.ts";
import {
  classifyOpenAiHttpFailure,
  extractEventDataFromInstagramPost,
  isOpenAiPermanentError,
  isOpenAiProviderBlockedError,
} from "../lib/ai/extract-event-data.ts";
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
  MAX_CRON_INGESTION_JOB_HANDLES,
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
assert.equal(request.input.resultsLimit, 3);
assert.equal(request.input.onlyPostsNewerThan, "10 days");
assert.equal(request.runOptions.maxItems, 3);
assert.equal(request.runOptions.timeout, 120);
assert.equal(request.runOptions.memory, undefined);
assert.ok(
  request.runOptions.maxTotalChargeUsd > 0 && request.runOptions.maxTotalChargeUsd <= 0.01,
  "default Apify per-run charge cap should stay low",
);

const persistedHighWaterRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 1,
  daysBack: 10,
  onlyPostsNewerThan: "2026-07-26T12:34:56.000Z",
  env: {},
});
assert.equal(
  persistedHighWaterRequest.input.onlyPostsNewerThan,
  "2026-07-26T12:34:56.000Z",
  "a persisted per-handle timestamp must replace the broad relative window so Apify does not return already-saved posts",
);

const invalidHighWaterRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 1,
  daysBack: 10,
  onlyPostsNewerThan: "not-a-date",
  env: {},
});
assert.equal(
  invalidHighWaterRequest.input.onlyPostsNewerThan,
  "10 days",
  "invalid persisted timestamps must retain the bounded relative fallback",
);

const originalOpenAiFetch = globalThis.fetch;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenAiVisionModel = process.env.OPENAI_VISION_MODEL;
let blockedProviderCalls = 0;
try {
  process.env.OPENAI_API_KEY = "qa-placeholder";
  process.env.OPENAI_VISION_MODEL = "qa-model";
  globalThis.fetch = async () => {
    blockedProviderCalls += 1;
    return new Response(
      JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }),
      { status: 429, statusText: "Too Many Requests" },
    );
  };
  await assert.rejects(
    () =>
      extractEventDataFromInstagramPost({
        caption: "QA fixture",
        instagramPostUrl: "https://www.instagram.com/p/qa-fixture/",
        instagramHandle: "qa_venue",
      }),
    (error) => isOpenAiProviderBlockedError(error),
  );
  assert.equal(
    blockedProviderCalls,
    1,
    "quota/auth failures must not be retried per post before stopping the ingestion job",
  );
} finally {
  globalThis.fetch = originalOpenAiFetch;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalOpenAiVisionModel === undefined) delete process.env.OPENAI_VISION_MODEL;
  else process.env.OPENAI_VISION_MODEL = originalOpenAiVisionModel;
}

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
assert.equal(detailedRequest.runOptions.maxTotalChargeUsd, 0.04);
assert.equal(detailedRequest.runOptions.timeout, 90);
assert.equal(detailedRequest.runOptions.memory, 8192);

const adversarialChargeRequest = buildApifyInstagramScrapeRequest({
  actorUsernameInput: "clubdrugstore",
  resultsLimit: 5,
  env: { APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN: "50" },
});
assert.equal(
  adversarialChargeRequest.runOptions.maxTotalChargeUsd,
  0.04,
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
  resultsLimit: 3,
  daysBack: 10,
  maxHandlesPerRun: 2000,
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
const scrapedPostsSource = readFileSync(
  new URL("../convex/scrapedPosts.ts", import.meta.url),
  "utf8",
);
const convexSchemaSource = readFileSync(
  new URL("../convex/schema.ts", import.meta.url),
  "utf8",
);
const ingestionRunnerSource = readFileSync(
  new URL("../lib/pipeline/run-instagram-ingestion.ts", import.meta.url),
  "utf8",
);
const extractionSource = readFileSync(
  new URL("../lib/ai/extract-event-data.ts", import.meta.url),
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
const recentFullScrapeHandlesSource = readFileSync(
  new URL("../lib/pipeline/recent-full-scrape-handles.ts", import.meta.url),
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
assert.match(operationalVenuesSource, /seenCursors/);
assert.doesNotMatch(operationalVenuesSource, /MAX_OPERATIONAL_VENUE_PAGE_REQUESTS/);
assert.doesNotMatch(ingestionRunnerSource, /"venues:listActiveVenues"/);
assert.match(convexSchemaSource, /processingStatus:[\s\S]{0,220}retryable_failure/);
assert.match(scrapedPostsSource, /processingStatus: "pending"/);
assert.match(scrapedPostsSource, /recordProcessingResult/);
assert.match(
  ingestionRunnerSource,
  /recordScrapedPostProcessingResultMutation/,
  "processing completion/failure must be durable and independent from fetch and event approval state",
);
assert.match(
  ingestionRunnerSource,
  /record\.processingStatus === "completed"[\s\S]{0,320}\["terminal_no_event", "terminal_permanent_failure", "receipt_complete"\]\.includes/,
  "saved-post replay may skip only explicit terminal rows or circuit-delayed retries",
);
assert.match(
  ingestionRunnerSource,
  /scrapedPosts:getManyByHandleAndPostRefs/,
  "fresh scrape results must be checked against durable scraped-post identities before persistence or extraction",
);
assert.match(
  ingestionRunnerSource,
  /onlyPostsNewerThan:\s*onlyPostsNewerThan \?\? undefined/,
  "full scrapes must pass the latest persisted per-handle timestamp into Apify",
);
assert.match(scrapedPostsSource, /getLatestIngestionBoundaryByHandle/);
assert.match(scrapedPostsSource, /Date\.now\(\) \+ 5 \* 60 \* 1_000/);
assert.match(scrapedPostsSource, /by_handle_postedAtMs/);
assert.doesNotMatch(
  ingestionRunnerSource,
  /runInstagramIngestionWithConcurrentFullScrape/,
  "direct full scrapes must use the same per-handle fetch-persist-process circuit-breaker path",
);
assert.match(
  ingestionRunnerSource,
  /throw persistError/,
  "raw persistence failure must stop extraction and cursor advancement",
);
assert.match(
  ingestionRunnerSource,
  /processSavedBacklogBeforeFreshFetch/,
  "the full saved backlog must drain before another paid Apify request",
);
assert.match(
  recentFullScrapeHandlesSource,
  /ingestionJobs:listRecentFullScrapeAttemptMetadata/,
  "daily cooldown checks must use projected attempt metadata instead of transferring full job summaries",
);
assert.doesNotMatch(
  recentFullScrapeHandlesSource,
  /ingestionJobs:listRecentFullScrapeJobs/,
  "daily cooldown checks must not repeatedly transfer high-cardinality summaryJson payloads",
);
assert.match(
  cronRouteSource,
  /ingestionJobs:findLatestResumableFullScrapeJob/,
  "daily resume lookup must use an indexed projected query",
);
assert.doesNotMatch(
  cronRouteSource,
  /ingestionJobs:listRecentFullScrapeJobs/,
  "the request-per-step route must not repeatedly transfer full job summaries",
);
assert.match(hostCronRunnerSource, /run_request_with_retry/);
assert.match(hostCronRunnerSource, /MAX_TRANSIENT_REQUEST_ATTEMPTS/);
assert.match(
  ingestionRunnerSource,
  /isOpenAiProviderBlockedError\(error\)[\s\S]{0,160}throw error/,
  "provider quota/auth failures must stop the job instead of scraping the remaining handles",
);
assert.match(extractionSource, /classifyOpenAiHttpFailure/);
assert.equal(classifyOpenAiHttpFailure(401, "unauthorized"), "blocked");
assert.equal(classifyOpenAiHttpFailure(403, "permission denied"), "blocked");
assert.equal(classifyOpenAiHttpFailure(429, "insufficient_quota billing_hard_limit"), "blocked");
assert.equal(
  classifyOpenAiHttpFailure(429, "rate_limit_exceeded; retry later"),
  "transient",
  "ordinary rate limiting must retry with backoff rather than opening the durable account circuit",
);
assert.equal(classifyOpenAiHttpFailure(500, "server error"), "transient");
assert.equal(classifyOpenAiHttpFailure(400, "invalid request"), "permanent");

const previousOpenAiEnv = {
  key: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_VISION_MODEL,
  attempts: process.env.OPENAI_MAX_ATTEMPTS_PER_POST,
};
const originalFailureQaFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = "qa-openai-key";
process.env.OPENAI_VISION_MODEL = "qa-openai-model";
process.env.OPENAI_MAX_ATTEMPTS_PER_POST = "3";
const extractionInput = {
  instagramHandle: "qa.source",
  instagramPostUrl: "https://www.instagram.com/p/qa-openai-failure/",
  instagramPostTimestamp: "2026-07-27T10:00:00.000Z",
  caption: "QA",
  altText: "",
  instagramLocationName: "",
  canonicalVenueName: "",
  sourceImageUrl: "",
  extractionMode: "caption_only",
};
try {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":"bad request"}', { status: 400, statusText: "Bad Request" });
  };
  await assert.rejects(
    extractEventDataFromInstagramPost(extractionInput),
    (error) => isOpenAiPermanentError(error),
  );
  assert.equal(calls, 1, "Permanent OpenAI failures must not be retried.");

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":"server error"}', { status: 500, statusText: "Server Error" });
  };
  await assert.rejects(extractEventDataFromInstagramPost(extractionInput), /server error/i);
  assert.equal(calls, 3, "Transient OpenAI failures must use the bounded retry limit.");

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":"insufficient_quota"}', {
      status: 429,
      statusText: "Too Many Requests",
    });
  };
  await assert.rejects(extractEventDataFromInstagramPost(extractionInput), /429/);
  assert.equal(calls, 1, "Blocked/quota failures must not be retried.");

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ output_text: "not valid extraction JSON" });
  };
  await assert.rejects(
    extractEventDataFromInstagramPost(extractionInput),
    (error) => isOpenAiPermanentError(error),
  );
  assert.equal(calls, 1, "Schema/JSON response failures must be terminal and non-retrying.");
} finally {
  globalThis.fetch = originalFailureQaFetch;
  for (const [key, value] of Object.entries({
    OPENAI_API_KEY: previousOpenAiEnv.key,
    OPENAI_VISION_MODEL: previousOpenAiEnv.model,
    OPENAI_MAX_ATTEMPTS_PER_POST: previousOpenAiEnv.attempts,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const savedCursorBlock = ingestionRunnerSource.slice(
  ingestionRunnerSource.indexOf("const idsToLoad = ids.slice("),
  ingestionRunnerSource.indexOf("const done = state.handleIndex", ingestionRunnerSource.indexOf("const idsToLoad = ids.slice(")),
);
assert.ok(
  savedCursorBlock.indexOf("await processLoadedPostsForHandle") <
    savedCursorBlock.indexOf("state.currentScrapedPostIdIndex = idsStartIndex + idsToLoad.length"),
  "saved-post cursor must advance only after nonfatal processing returns",
);

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

let cyclePageCalls = 0;
await assert.rejects(
  () =>
    loadOperationalVenueRecords({
      client: {
        query: async () => {
          cyclePageCalls += 1;
          return {
            page: [],
            isDone: false,
            continueCursor: cyclePageCalls === 1 ? "cursor-a" : cyclePageCalls === 2 ? "cursor-b" : "cursor-a",
          };
        },
      },
      serviceSecret: "service-secret",
      activeOnly: true,
    }),
  /cursor cycle/,
);
assert.equal(cyclePageCalls, 3, "cursor cycles must fail closed without a venue-count cap");

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
  /freshAttemptHandles:[\s\S]*getFreshCompletedAttemptHandles\(job\.handles, job\.summaryJson\)/,
  "recent full-scrape metadata should derive cooldown handles server-side",
);
assert.doesNotMatch(
  recentFullScrapeHandlesSource,
  /summaryJson/,
  "the request-per-step cooldown helper must not transfer or parse full summaries",
);
assert.doesNotMatch(
  cronRouteSource,
  /Math\.max\(FULL_SCRAPE_COOLDOWN_MS/,
  "cron route must not force the old 24-hour minimum cooldown over the daily config",
);
assert.equal(
  MAX_INGESTION_JOB_HANDLES,
  500,
  "the historical hard bound must remain rollout-compatible for queued and manual jobs",
);
assert.equal(
  MAX_CRON_INGESTION_JOB_HANDLES,
  200,
  "scheduled cron jobs must use the mutation-time-safe handle bound",
);
assert.match(
  cronRouteSource,
  /MAX_CRON_INGESTION_JOB_HANDLES/,
  "new cron jobs must use the scheduled mutation-time-safe boundary",
);
assert.match(
  cronRouteSource,
  /maxHandles: Math\.min\(hostRunRemaining, MAX_INGESTION_JOB_HANDLES\)/,
  "cron must still resume rollout-era jobs up to the historical hard boundary",
);
for (const [label, source] of [
  ["admin all-venues scrape", adminVenueScrapeRouteSource],
  ["admin repair scrape", adminRepairRouteSource],
]) {
  assert.match(
    source,
    /MAX_INGESTION_JOB_HANDLES/,
    `${label} must retain the rollout-compatible 500-handle hard boundary`,
  );
  assert.match(source, /serializeSafeIngestionJobPayload/);
}
assert.match(
  cronRouteSource,
  /const hostRunMaxHandles = activeVenueHandles\.length/,
  "scheduled ingestion must size the host run from the complete active venue set",
);
assert.match(
  cronRouteSource,
  /normalizeHostRunRemaining\(request, hostRunMaxHandles\)/,
  "scheduled ingestion must not apply the compatibility max-handle setting to the all-active run",
);
assert.match(
  hostCronRunnerSource,
  /required_chunks=.*HOST_RUN_MAX_HANDLES.*RESPONSE_JOB_CHUNK/,
  "host runner safety must scale from the live active count instead of capping venue coverage",
);
assert.doesNotMatch(hostCronRunnerSource, /INGEST_CRON_MAX_REQUESTS_PER_RUN/);
assert.match(hostCronRunnerSource, /skippedDueToRunLimit/);
assert.match(hostCronRunnerSource, /hostRunRemaining/);
assert.match(hostCronRunnerSource, /HOST_RUN_MAX_HANDLES - TOTAL_SELECTED/);
assert.match(hostCronRunnerSource, /declare -A COUNTED_JOB_IDS=\(\)/);
assert.match(hostCronRunnerSource, /COUNTED_JOB_IDS\[\$RESPONSE_JOB_ID\]=1/);
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
    activeVenueHandles: Array.from({ length: 2000 }, (_, index) => `venue-${index + 1}`),
    recentlyAttemptedHandles: [],
    maxHandlesPerRun: cronConfig.maxHandlesPerRun,
  }),
  {
    handles: Array.from({ length: 2000 }, (_, index) => `venue-${index + 1}`),
    skippedRecentlyAttempted: 0,
    skippedDueToRunLimit: 0,
  },
  "default cron selection should cover every active handle up to the configured cap",
);

const boundaryHandles = Array.from(
  { length: MAX_INGESTION_JOB_HANDLES },
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
  `${MAX_INGESTION_JOB_HANDLES}-handle legacy-compatible job with adversarial provider errors should retain document-size headroom, got ${boundaryDocumentSize} bytes`,
);
const cronHandles = Array.from(
  { length: MAX_CRON_INGESTION_JOB_HANDLES },
  (_, index) => `auto-${index}`,
);
const cronPayload = serializeSafeIngestionJobPayload({
  handles: cronHandles,
  summary: createEmptyIngestionSummary(cronHandles),
  state: createInitialIngestionBatchState(),
});
assert.ok(
  Buffer.byteLength(cronPayload.summaryJson) < 150_000,
  "cron empty summaries must retain ample mutation-time headroom",
);
assert.throws(
  () =>
    serializeSafeIngestionJobPayload({
      handles: Array.from(
        { length: MAX_INGESTION_JOB_HANDLES + 1 },
        (_, index) => `too-many-${index}`,
      ),
      summary: createEmptyIngestionSummary(
        Array.from(
          { length: MAX_INGESTION_JOB_HANDLES + 1 },
          (_, index) => `too-many-${index}`,
        ),
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
    freshAttemptHandles: ["good-zero", "good-fetched", "legacy-no-summary"],
  }),
  ["good-zero", "good-fetched", "legacy-no-summary"],
  "completed jobs should not cool down handles that only recorded scraper/API errors",
);

function runCronRunnerCapFixture(mode, activeCount = 2400, job = "ingest-venues") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ig-event-cron-cap-"));
  const fakeBin = join(fixtureRoot, "bin");
  const logDir = join(fixtureRoot, "logs");
  const envFile = join(fixtureRoot, "cron.env");
  const stateFile = join(fixtureRoot, "curl-state.json");
  mkdirSync(fakeBin);
  mkdirSync(logDir);
  writeFileSync(
    envFile,
    [
      "APP_ORIGIN=https://example.invalid",
      "CRON_SECRET=fixture-secret",
      "INGEST_CRON_TIMEOUT_SECONDS=10",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const fakeCurlPath = join(fakeBin, "curl");
  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = readFileSync(configPath, "utf8");
const outputPath = config.match(/^output = "([^"]+)"$/m)?.[1];
const url = config.match(/^url = "([^"]+)"$/m)?.[1];
if (!outputPath || !url) process.exit(2);
let state = { count: 0, requests: [], failedOnce: false };
try { state = JSON.parse(readFileSync(process.env.FAKE_CURL_STATE, "utf8")); } catch {}
state.count += 1;
if (process.env.FAKE_CURL_MODE === "transient-500" && !state.failedOnce) {
  state.failedOnce = true;
  state.requests.push({ attempt: state.count, httpCode: 500 });
  writeFileSync(process.env.FAKE_CURL_STATE, JSON.stringify(state));
  writeFileSync(outputPath, JSON.stringify({ error: "terminated" }));
  process.stdout.write("500");
  process.exit(0);
}
if (process.env.FAKE_CURL_MODE === "permanent-401") {
  state.requests.push({ attempt: state.count, httpCode: 401 });
  writeFileSync(process.env.FAKE_CURL_STATE, JSON.stringify(state));
  writeFileSync(outputPath, JSON.stringify({ error: "unauthorized" }));
  process.stdout.write("401");
  process.exit(0);
}
const successfulRequests = state.requests.filter((request) => request.httpCode === 200).length;
const requestIndex = successfulRequests + 1;
const parsedUrl = new URL(url);
const activeCount = Number(process.env.FAKE_CURL_ACTIVE_COUNT ?? "2400");
const remaining = Number(parsedUrl.searchParams.get("hostRunRemaining") ?? String(activeCount));
const selected = Math.min(200, Math.max(0, remaining));
const repeat = process.env.FAKE_CURL_MODE === "repeat-resume";
const singleHandleProgress = process.env.FAKE_CURL_MODE === "single-handle-progress";
const zeroProgress = process.env.FAKE_CURL_MODE === "zero-progress";
const jobId = singleHandleProgress || zeroProgress
  ? process.env.FAKE_CURL_MODE + "-job"
  : repeat && requestIndex <= 2
    ? "resumed-job"
    : "job-" + requestIndex;
const done = zeroProgress
  ? false
  : singleHandleProgress
    ? requestIndex >= selected
    : !(repeat && requestIndex === 1);
const payload = {
  jobId,
  resumedJob: requestIndex === 1 || (repeat && requestIndex === 2),
  status: done ? "completed" : "running",
  done,
  handles: Array.from({ length: selected }, (_, index) => "handle-" + requestIndex + "-" + index),
  skippedDueToRunLimit: remaining > selected ? 1 : 0,
  hostRunMaxHandles: activeCount,
  maxHandlesPerJob: 200,
  effectiveBatchSize: singleHandleProgress || zeroProgress ? 1 : selected,
  maxSteps: 1,
  stepsAdvanced: zeroProgress ? 0 : 1,
};
state.requests.push({
  attempt: state.count,
  httpCode: 200,
  requestIndex,
  remaining,
  selected,
  jobId,
  done,
});
writeFileSync(process.env.FAKE_CURL_STATE, JSON.stringify(state));
writeFileSync(outputPath, JSON.stringify(payload));
process.stdout.write("200");
`,
    { mode: 0o755 },
  );
  chmodSync(fakeCurlPath, 0o755);
  const fakeSleepPath = join(fakeBin, "sleep");
  writeFileSync(fakeSleepPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(fakeSleepPath, 0o755);

  // The fixture exercises request budgeting and no-progress handling, not the
  // host-wide singleton lock. Stub flock so a live production runner cannot
  // make this otherwise isolated fixture exit before invoking fake curl.
  const fakeFlockPath = join(fakeBin, "flock");
  writeFileSync(fakeFlockPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(fakeFlockPath, 0o755);

  try {
    const result = spawnSync("bash", ["scripts/ig-event-cron-runner", job], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CURL_ACTIVE_COUNT: String(activeCount),
        FAKE_CURL_MODE: mode,
        FAKE_CURL_STATE: stateFile,
        IG_EVENT_CRON_ENV: envFile,
        IG_EVENT_CRON_LOG_DIR: logDir,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    return { result, state };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

const resumedCapFixture = runCronRunnerCapFixture("single-resume");
assert.equal(resumedCapFixture.result.status, 0, resumedCapFixture.result.stderr);
assert.match(
  resumedCapFixture.result.stdout,
  /status=ok requests=12 selected=2400 host_run_max=2400/,
  "the runner must cover a live active set larger than the 2000-handle compatibility default",
);
assert.deepEqual(
  resumedCapFixture.state.requests.map((request) => request.remaining),
  [2400, 2200, 2000, 1800, 1600, 1400, 1200, 1000, 800, 600, 400, 200],
);

const repeatedResumeFixture = runCronRunnerCapFixture("repeat-resume");
assert.equal(repeatedResumeFixture.result.status, 0, repeatedResumeFixture.result.stderr);
assert.match(
  repeatedResumeFixture.result.stdout,
  /status=ok requests=13 selected=2400 host_run_max=2400/,
  "multiple steps for one resumed job must count that job's handles only once while covering all venues",
);
assert.deepEqual(
  repeatedResumeFixture.state.requests.slice(0, 3).map((request) => request.remaining),
  [2400, 2200, 2200],
  "the same resumed job ID must not consume the host budget twice",
);

const singleHandleProgressFixture = runCronRunnerCapFixture("single-handle-progress", 47);
assert.equal(
  singleHandleProgressFixture.result.status,
  0,
  singleHandleProgressFixture.result.stderr,
);
assert.match(
  singleHandleProgressFixture.result.stdout,
  /status=ok requests=47 selected=47 host_run_max=47/,
  "a one-handle-per-request route must finish the selected job instead of exhausting a chunk-based request budget",
);
assert.equal(singleHandleProgressFixture.state.requests.length, 47);
assert.deepEqual(
  [...new Set(singleHandleProgressFixture.state.requests.map((request) => request.remaining))],
  [47],
  "an incomplete final job must retain enough host-run allowance to resume until done",
);

const zeroProgressFixture = runCronRunnerCapFixture("zero-progress", 47);
assert.equal(zeroProgressFixture.result.status, 1);
assert.match(
  zeroProgressFixture.result.stderr,
  /reason=no_progress consecutive=6/,
  "a leased or stalled job must stop after a bounded number of no-progress responses",
);
assert.equal(
  zeroProgressFixture.state.requests.length,
  6,
  "zero-progress responses must not consume the full throughput-sized request budget",
);

const transientHttpFixture = runCronRunnerCapFixture("transient-500", 200);
assert.equal(transientHttpFixture.result.status, 0, transientHttpFixture.result.stderr);
assert.deepEqual(
  transientHttpFixture.state.requests.map((request) => request.httpCode),
  [500, 200],
  "a transient HTTP 500 must be retried idempotently within the same scheduled run",
);
assert.match(transientHttpFixture.result.stdout, /status=ok requests=1 selected=200/);

const nonIdempotentDiscoveryFixture = runCronRunnerCapFixture(
  "transient-500",
  200,
  "discover-following",
);
assert.notEqual(nonIdempotentDiscoveryFixture.result.status, 0);
assert.equal(
  nonIdempotentDiscoveryFixture.state.requests.length,
  1,
  "an ambiguous following-discovery failure must not automatically repeat paid provider work",
);

const permanentHttpFixture = runCronRunnerCapFixture("permanent-401", 200);
assert.notEqual(permanentHttpFixture.result.status, 0);
assert.equal(permanentHttpFixture.state.requests.length, 1);
assert.equal(permanentHttpFixture.state.requests[0].httpCode, 401);

console.log("Apify cost-control QA passed.");
