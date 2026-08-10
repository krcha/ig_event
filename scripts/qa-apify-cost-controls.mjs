import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  scrapeInstagramAccount,
  selectLatestOriginalNonPinnedPost,
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
import { loadCronIngestionCandidateSnapshot } from "../lib/pipeline/cron-ingestion-resumption.ts";
import {
  createEmptyIngestionSummary,
  createInitialIngestionBatchState,
  markFreshFetchNotAttempted,
} from "../lib/pipeline/run-instagram-ingestion.ts";
import { loadOperationalVenueRecords } from "../lib/pipeline/operational-venues.ts";
import {
  MAX_CRON_INGESTION_JOB_HANDLES,
  MAX_INGESTION_JOB_HANDLES,
  MAX_INGESTION_JOB_PERSISTED_JSON_BYTES,
  serializeSafeIngestionJobPayload,
} from "../lib/pipeline/ingestion-job-safety.ts";
import {
  getFreshCompletedAttemptHandles,
  findLatestResumableFullScrapeJob,
  listJobsForRepairPage,
  listRecentFullScrapeAttemptMetadata,
} from "../convex/ingestionJobs.ts";
import {
  getIngestionContextsByHandles,
  listActiveSourceHandlesPage,
  listActiveSourcesPage,
  listFreshFetchAttemptMetadata,
  listFreshFetchAttemptMetadataPage,
  listLegacyVenueHandlesPage,
  listLegacyVenueSourcesPage,
} from "../convex/instagramSources.ts";
import {
  applyInstagramHandleNormalizationBatch,
  clearInstagramHandleNormalizationBatch,
  listInstagramHandleNormalizationPage,
} from "../convex/venues.ts";

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

const previousApifyToken = process.env.APIFY_API_TOKEN;
const originalApifyBoundaryFetch = globalThis.fetch;
const originalApifyBoundaryConsoleInfo = console.info;
const originalDateNow = Date.now;
process.env.APIFY_API_TOKEN = "qa-apify-boundary-token";
let providerBoundaryMarked = false;
let providerTransportInvoked = false;
let providerBoundaryFetches = 0;
let providerRequestLogs = 0;
console.info = (message, ...args) => {
  if (typeof message === "string" && message.includes('"event":"apify.instagram.request"')) {
    providerRequestLogs += 1;
    return;
  }
  originalApifyBoundaryConsoleInfo(message, ...args);
};
globalThis.fetch = async (_url, init) => {
  assert.equal(
    providerBoundaryMarked,
    true,
    "the durable marker must commit before outbound provider execution",
  );
  assert.equal(
    providerTransportInvoked,
    true,
    "the process-local transport receipt must be set immediately before fetch",
  );
  assert.equal(
    init?.signal?.aborted,
    false,
    "fetch must never receive a signal that expired while the durable marker was awaited",
  );
  providerBoundaryFetches += 1;
  return new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  await scrapeInstagramAccount({
    handle: "qa-provider-boundary",
    resultsLimit: 1,
    daysBack: 1,
    onRequestStarted: async () => {
      providerBoundaryMarked = true;
    },
    onTransportInvoked: () => {
      providerTransportInvoked = true;
    },
  });
  assert.equal(providerBoundaryFetches, 1);
  assert.equal(providerRequestLogs, 1);

  providerBoundaryMarked = false;
  providerTransportInvoked = false;
  providerBoundaryFetches = 0;
  let fakeNow = 10_000;
  Date.now = () => fakeNow;
  await assert.rejects(
    scrapeInstagramAccount({
      handle: "qa-slow-provider-marker",
      resultsLimit: 1,
      daysBack: 1,
      abortAtMs: fakeNow + 5_000,
      onRequestStarted: async () => {
        providerBoundaryMarked = true;
        fakeNow += 6_000;
      },
      onTransportInvoked: () => {
        providerTransportInvoked = true;
      },
    }),
    /deadline expired before transport/,
  );
  assert.equal(providerBoundaryMarked, true);
  assert.equal(providerTransportInvoked, false);
  assert.equal(providerBoundaryFetches, 0);
  assert.equal(providerRequestLogs, 1);
  Date.now = originalDateNow;

  providerBoundaryMarked = false;
  providerTransportInvoked = false;
  providerBoundaryFetches = 0;
  await assert.rejects(
    scrapeInstagramAccount({
      handle: "qa-marker-acknowledgement-loss",
      resultsLimit: 1,
      daysBack: 1,
      onRequestStarted: async () => {
        providerBoundaryMarked = true;
        throw new Error("simulated marker acknowledgement loss");
      },
      onTransportInvoked: () => {
        providerTransportInvoked = true;
      },
    }),
    /simulated marker acknowledgement loss/,
  );
  assert.equal(providerBoundaryMarked, true);
  assert.equal(providerTransportInvoked, false);
  assert.equal(providerBoundaryFetches, 0);
  assert.equal(providerRequestLogs, 1);

  providerBoundaryMarked = false;
  providerTransportInvoked = false;
  await assert.rejects(
    scrapeInstagramAccount({
      handle: "qa-local-preflight",
      resultsLimit: 1,
      daysBack: 1,
      abortAtMs: Date.now() + 1_000,
      onRequestStarted: async () => {
        providerBoundaryMarked = true;
      },
      onTransportInvoked: () => {
        providerTransportInvoked = true;
      },
    }),
    /lease deadline is too close/,
  );
  assert.equal(providerBoundaryMarked, false);
  assert.equal(providerTransportInvoked, false);
  assert.equal(providerBoundaryFetches, 0);
  assert.equal(
    providerRequestLogs,
    1,
    "no-transport paths must not emit provider-request telemetry",
  );
} finally {
  Date.now = originalDateNow;
  globalThis.fetch = originalApifyBoundaryFetch;
  console.info = originalApifyBoundaryConsoleInfo;
  if (previousApifyToken === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = previousApifyToken;
}

const persistedSnapshotJob = {
  _id: "job-resume-fixture",
  handles: ["snapshot.one", "snapshot.two"],
};
const persistedSnapshotCalls = [];
const persistedSnapshot = await loadCronIngestionCandidateSnapshot({
  resumeCapacity: 200,
  findResumableJob: async () => {
    persistedSnapshotCalls.push("resume");
    return persistedSnapshotJob;
  },
  loadActiveHandles: async () => {
    persistedSnapshotCalls.push("global");
    return ["new.global.source"];
  },
});
assert.deepEqual(persistedSnapshotCalls, ["resume"]);
assert.equal(persistedSnapshot.resumableJob, persistedSnapshotJob);
assert.deepEqual(persistedSnapshot.resumableJob.handles, ["snapshot.one", "snapshot.two"]);
assert.deepEqual(persistedSnapshot.activeHandles, []);

const newSnapshotCalls = [];
const newSnapshot = await loadCronIngestionCandidateSnapshot({
  resumeCapacity: 200,
  findResumableJob: async () => {
    newSnapshotCalls.push("resume");
    return null;
  },
  loadActiveHandles: async () => {
    newSnapshotCalls.push("global");
    return ["new.global.source"];
  },
});
assert.deepEqual(newSnapshotCalls, ["resume", "global"]);
assert.deepEqual(newSnapshot.activeHandles, ["new.global.source"]);

let zeroCapacityCalls = 0;
assert.deepEqual(
  await loadCronIngestionCandidateSnapshot({
    resumeCapacity: 0,
    findResumableJob: async () => {
      zeroCapacityCalls += 1;
      return persistedSnapshotJob;
    },
    loadActiveHandles: async () => {
      zeroCapacityCalls += 1;
      return ["unexpected"];
    },
  }),
  { resumableJob: null, activeHandles: [] },
);
assert.equal(zeroCapacityCalls, 0, "an exhausted host run must not query jobs or global sources");

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

const pinnedNewest = mapApifyItemToInstagramPost(
  {
    id: "pinned-newest",
    url: "https://www.instagram.com/p/pinned-newest/",
    username: "qa_venue",
    timestamp: "2026-08-10T10:00:00.000Z",
    isPinned: true,
    displayUrl: "https://images.apifyusercontent.com/pinned.jpg",
  },
  "qa_venue",
);
const newestOriginal = mapApifyItemToInstagramPost(
  {
    id: "newest-original",
    url: "https://www.instagram.com/p/newest-original/",
    username: "qa_venue",
    timestamp: "2026-08-09T10:00:00.000Z",
    is_pinned: false,
    displayUrl: "https://images.apifyusercontent.com/newest.jpg",
  },
  "qa_venue",
);
const olderOriginal = mapApifyItemToInstagramPost(
  {
    id: "older-original",
    url: "https://www.instagram.com/p/older-original/",
    username: "qa_venue",
    timestamp: "2026-08-08T10:00:00.000Z",
    pinned: false,
    displayUrl: "https://images.apifyusercontent.com/older.jpg",
  },
  "qa_venue",
);
const undatedOriginal = mapApifyItemToInstagramPost(
  {
    id: "undated-original",
    url: "https://www.instagram.com/p/undated-original/",
    username: "qa_venue",
    displayUrl: "https://images.apifyusercontent.com/undated.jpg",
  },
  "qa_venue",
);
assert.ok(pinnedNewest && newestOriginal && olderOriginal && undatedOriginal);
assert.deepEqual(
  selectLatestOriginalNonPinnedPost([
    pinnedNewest,
    undatedOriginal,
    olderOriginal,
    newestOriginal,
  ]).map((post) => post.postId),
  ["newest-original"],
  "local selection must skip a newest pinned item and sort original posts by post date",
);
assert.deepEqual(
  selectLatestOriginalNonPinnedPost([pinnedNewest]),
  [],
  "a profile with only pins must truthfully produce no selected post",
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
const instagramSourcesSource = readFileSync(
  new URL("../convex/instagramSources.ts", import.meta.url),
  "utf8",
);
const venuesSource = readFileSync(
  new URL("../convex/venues.ts", import.meta.url),
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
const venueHandleMigrationSource = readFileSync(
  new URL("./migrate-venue-instagram-handles.mjs", import.meta.url),
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
  ingestionRunnerSource,
  /if \(readyForFetch\)[\s\S]{0,180}else[\s\S]{0,180}markFreshFetchNotAttempted\(summary, handle, "saved_backlog_not_ready"\)/,
  "maintenance-only saved backlog work must persist a negative provider-attempt receipt",
);
assert.match(
  ingestionRunnerSource,
  /if \(!lease\.claimed\)[\s\S]{0,500}markFreshFetchNotAttempted\([\s\S]{0,220}denialReason/,
  "a denied lease must persist a negative provider-attempt receipt",
);
assert.match(
  ingestionRunnerSource,
  /requestBoundaryVersion: 1/,
  "boundary-aware web code must explicitly select request-boundary accounting",
);
assert.match(
  ingestionRunnerSource,
  /attemptCooldownMs: options\.ignoreCooldown \? 0 : getProviderAttemptCooldownMs\(\)/,
  "the durable catch-up override may bypass cooldown only when explicitly requested; daily callers retain the provider cooldown",
);
assert.match(
  ingestionRunnerSource,
  /onRequestStarted: async \(\) =>[\s\S]{0,500}markPaidFetchRequestStartedMutation[\s\S]{0,500}providerRequestStarted = true;[\s\S]{0,220}freshFetchAttempted/,
  "positive attempt and budget receipts must be written at the provider network boundary",
);
assert.match(convexSchemaSource, /ingestionCostReservations:[\s\S]{0,500}requestStartedAt: v\.optional\(v\.number\(\)\)/);
assert.match(scrapedPostsSource, /requestBoundaryVersion: v\.optional\(v\.literal\(1\)\)/);
assert.match(
  scrapedPostsSource,
  /requestStartedAt: args\.requestBoundaryVersion === 1 \? undefined : now/,
  "mixed-version claims must preserve conservative legacy accounting without moving new callers off the network boundary",
);
assert.match(scrapedPostsSource, /typeof oldReservation\.requestStartedAt === "number"/);
assert.match(
  scrapedPostsSource,
  /status: requestStarted \? "reconciled" : "released"/,
  "expired reservations must distinguish pre-boundary release from post-boundary charging",
);
assert.match(
  scrapedPostsSource,
  /recent_provider_attempt/,
  "paid lease admission must reject a durable provider attempt inside cooldown",
);
assert.match(
  recentFullScrapeHandlesSource,
  /instagramSources:listFreshFetchAttemptMetadataPage/,
  "daily cooldown checks must use paginated compact source-level provider-attempt receipts",
);
assert.match(recentFullScrapeHandlesSource, /continueCursor/);
assert.match(recentFullScrapeHandlesSource, /MAX_FRESH_ATTEMPT_PAGES/);
assert.match(ingestionRunnerSource, /instagramSources:listActiveSourceHandlesPage/);
assert.match(ingestionRunnerSource, /instagramSources:listLegacyVenueHandlesPage/);
assert.match(ingestionRunnerSource, /instagramSources:getIngestionContextsByHandles/);
assert.match(ingestionRunnerSource, /MAX_ACTIVE_SOURCE_PAGES/);
assert.match(ingestionRunnerSource, /paginationOpts: \{ numItems: ACTIVE_SOURCE_PAGE_SIZE, cursor \}/);
assert.doesNotMatch(
  ingestionRunnerSource,
  /"instagramSources:listActive"/,
  "the current ingestion path must not call the legacy capped active-source query",
);
assert.doesNotMatch(
  recentFullScrapeHandlesSource,
  /ingestionJobs:/,
  "daily cooldown checks must not read high-cardinality ingestion job documents",
);
assert.match(
  instagramSourcesSource,
  /listFreshFetchAttemptMetadataPage[\s\S]{0,700}by_active_lastFetchAttemptAt[\s\S]{0,240}\.paginate\(args\.paginationOpts\)/,
  "active cooldown reads must be indexed and explicitly paginated",
);
assert.match(
  instagramSourcesSource,
  /listActiveSourcesPage[\s\S]{0,500}by_active[\s\S]{0,160}\.paginate\(args\.paginationOpts\)/,
  "active explicit sources must be paginated",
);
assert.match(
  instagramSourcesSource,
  /listLegacyVenueSourcesPage[\s\S]{0,500}by_scrapeActive[\s\S]{0,160}\.paginate\(args\.paginationOpts\)/,
  "legacy venue sources must be paginated",
);
assert.match(
  instagramSourcesSource,
  /listActiveSourceHandlesPage[\s\S]{0,500}by_active[\s\S]{0,180}\.paginate\(args\.paginationOpts\)[\s\S]{0,180}source\.handle/,
  "new-job source discovery must use a compact handle-only active-source page",
);
assert.match(
  instagramSourcesSource,
  /listLegacyVenueHandlesPage[\s\S]{0,500}by_scrapeActive[\s\S]{0,180}\.paginate\(args\.paginationOpts\)/,
  "new-job legacy discovery must use a compact handle-only page",
);
const compatibilityActivePageSource = instagramSourcesSource.slice(
  instagramSourcesSource.indexOf("export const listActiveSourcesPage"),
  instagramSourcesSource.indexOf("export const listActiveSourceHandlesPage"),
);
assert.doesNotMatch(
  compatibilityActivePageSource,
  /ctx\.db\.get/,
  "active-source pagination must not fan out one venue read per source",
);
assert.match(convexSchemaSource, /normalizedInstagramHandle: v\.optional\(v\.string\(\)\)/);
assert.match(convexSchemaSource, /by_normalizedInstagramHandle/);
assert.match(
  instagramSourcesSource,
  /getIngestionContextsByHandles[\s\S]{0,1200}by_normalizedInstagramHandle[\s\S]{0,300}\.take\(2\)/,
  "targeted venue context must use the normalized handle index and fail closed on collisions",
);
assert.match(
  ingestionRunnerSource,
  /ingestion\.sources\.context_load_failed[\s\S]{0,300}throw error/,
  "full-scrape context lookup failures must abort before paid provider transport",
);
assert.match(venuesSource, /normalizedInstagramHandle: instagramHandle/);
assert.match(venuesSource, /applyInstagramHandleNormalizationBatch/);
assert.match(venuesSource, /clearInstagramHandleNormalizationBatch/);
assert.match(venueHandleMigrationSource, /NORMALIZE_VENUE_HANDLES/);
assert.match(venueHandleMigrationSource, /CLEAR_NORMALIZED_VENUE_HANDLES/);
assert.match(venueHandleMigrationSource, /args\.indexOf\("--confirm"\)/);
assert.match(venueHandleMigrationSource, /collisions/);
assert.match(venueHandleMigrationSource, /verificationUpdatesRemaining/);
assert.match(venueHandleMigrationSource, /verifiedIdempotent: true/);
assert.match(
  ingestionJobsSource,
  /listJobsForRepairPage[\s\S]{0,600}by_createdAt[\s\S]{0,180}\.paginate\(args\.paginationOpts\)/,
  "maintenance repair must use its own complete paginated job query",
);
assert.match(instagramSourcesSource, /\.take\(limit \+ 1\)/);
assert.match(
  instagramSourcesSource,
  /Legacy recent-attempt query exceeded its fail-closed limit/,
  "legacy cooldown reads must fail closed instead of truncating",
);
assert.match(
  ingestionJobsSource,
  /MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS = 12/,
  "rollback compatibility must hard-cap full ingestion-job reads",
);
assert.match(ingestionJobsSource, /\.take\(MAX_RECENT_FULL_SCRAPE_JOB_DOCUMENTS \+ 1\)/);
assert.match(
  ingestionJobsSource,
  /Legacy full-scrape history exceeded the fail-closed/,
  "rollback compatibility must fail closed when current-mode history exceeds the shared cap",
);
assert.match(ingestionJobsSource, /\.take\(remaining \+ 1\)/);
assert.match(
  ingestionJobsSource,
  /Legacy optional-mode history exceeded the fail-closed/,
  "rollback compatibility must fail closed when optional-mode history exceeds the remaining cap",
);
assert.match(
  ingestionJobsSource,
  /listRecentFullScrapeAttemptMetadata[\s\S]{0,500}listBoundedRecentFullScrapeJobs/,
  "older web images must retain a bounded fail-closed cooldown function for safe rollback",
);

const cooldownRows = [
  { handle: "recent-active", active: true, lastFetchAttemptAt: 300 },
  { handle: "older-active", active: true, lastFetchAttemptAt: 200 },
  { handle: "recent-inactive", active: false, lastFetchAttemptAt: 400 },
  { handle: "outside-window", active: true, lastFetchAttemptAt: 50 },
];
let cooldownIndexName = null;
let cooldownOrder = null;
let cooldownTakeLimit = null;
const cooldownQueryBuilder = {
  predicates: [],
  withIndex(indexName, apply) {
    cooldownIndexName = indexName;
    const q = {
      eq: (field, value) => {
        cooldownQueryBuilder.predicates.push((row) => row[field] === value);
        return q;
      },
      gte: (field, value) => {
        cooldownQueryBuilder.predicates.push((row) => row[field] >= value);
        return q;
      },
    };
    apply(q);
    return cooldownQueryBuilder;
  },
  order(direction) {
    cooldownOrder = direction;
    return cooldownQueryBuilder;
  },
  async take(limit) {
    cooldownTakeLimit = limit;
    return cooldownRows
      .filter((row) => cooldownQueryBuilder.predicates.every((predicate) => predicate(row)))
      .sort((left, right) => right.lastFetchAttemptAt - left.lastFetchAttemptAt)
      .slice(0, limit);
  },
};
const previousCooldownSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "qa-cooldown-secret";
try {
  const projectedCooldownRows = await listFreshFetchAttemptMetadata._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: {
        query: (table) => {
          assert.equal(table, "instagramSources");
          return cooldownQueryBuilder;
        },
      },
    },
    { minAttemptAt: 100, limit: 2, serviceSecret: "qa-cooldown-secret" },
  );
  assert.deepEqual(projectedCooldownRows, [
    { handle: "recent-active", lastFetchAttemptAt: 300 },
    { handle: "older-active", lastFetchAttemptAt: 200 },
  ]);
  assert.equal(cooldownIndexName, "by_active_lastFetchAttemptAt");
  assert.equal(cooldownOrder, "desc");
  assert.equal(cooldownTakeLimit, 3);
  await assert.rejects(
    listFreshFetchAttemptMetadata._handler(
      {
        auth: { getUserIdentity: async () => null },
        db: { query: () => cooldownQueryBuilder },
      },
      { minAttemptAt: 100, limit: 1, serviceSecret: "qa-cooldown-secret" },
    ),
    /fail-closed limit of 1/i,
    "legacy cooldown reads must reject overflow instead of silently dropping attempts",
  );

  function createPagedDb(rowsByTable) {
    return {
      query(table) {
        const rows = rowsByTable[table] ?? [];
        const predicates = [];
        let direction = "asc";
        const builder = {
          withIndex(_name, apply) {
            const q = {
              eq(field, value) {
                predicates.push((row) => row[field] === value);
                return q;
              },
              gte(field, value) {
                predicates.push((row) => row[field] >= value);
                return q;
              },
            };
            apply(q);
            return builder;
          },
          order(value) {
            direction = value;
            return builder;
          },
          async paginate({ numItems, cursor }) {
            const filtered = rows
              .filter((row) => predicates.every((predicate) => predicate(row)))
              .sort((left, right) => {
                const field =
                  "lastFetchAttemptAt" in left
                    ? "lastFetchAttemptAt"
                    : "createdAt" in left
                      ? "createdAt"
                      : "_id";
                const comparison = left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
                return direction === "desc" ? -comparison : comparison;
              });
            const start = cursor ? Number.parseInt(cursor, 10) : 0;
            const end = Math.min(filtered.length, start + numItems);
            return {
              page: filtered.slice(start, end),
              isDone: end >= filtered.length,
              continueCursor: String(end),
            };
          },
          async take(limit) {
            return rows
              .filter((row) => predicates.every((predicate) => predicate(row)))
              .sort((left, right) =>
                direction === "desc" ? right.createdAt - left.createdAt : left.createdAt - right.createdAt,
              )
              .slice(0, limit);
          },
          async first() {
            return (
              rows
                .filter((row) => predicates.every((predicate) => predicate(row)))
                .sort((left, right) =>
                  direction === "desc"
                    ? right.createdAt - left.createdAt
                    : left.createdAt - right.createdAt,
                )[0] ?? null
            );
          },
        };
        return builder;
      },
      async get() {
        return null;
      },
    };
  }

  async function drainHandler(handler, db, extraArgs = {}) {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const result = await handler(
        { auth: { getUserIdentity: async () => null }, db },
        {
          ...extraArgs,
          paginationOpts: { numItems: 137, cursor },
          serviceSecret: "qa-cooldown-secret",
        },
      );
      rows.push(...result.page);
      if (result.isDone) return rows;
      assert.notEqual(result.continueCursor, cursor, "pagination cursor must advance");
      cursor = result.continueCursor;
    }
    assert.fail("pagination did not terminate within its QA bound");
  }

  const resumableNow = Date.now();
  const resumableJob = await findLatestResumableFullScrapeJob._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: createPagedDb({
        ingestionJobs: [
          {
            _id: "newer-completed-job",
            source: "cron_active_venues",
            status: "completed",
            mode: "full_scrape",
            handles: ["completed"],
            createdAt: resumableNow - 1_000,
          },
          {
            _id: "oversized-queued-job",
            source: "cron_active_venues",
            status: "queued",
            mode: "full_scrape",
            handles: Array.from({ length: 201 }, (_, index) => `large.${index}`),
            createdAt: resumableNow - 2_000,
          },
          {
            _id: "recoverable-running-job",
            source: "cron_active_venues",
            status: "running",
            mode: "full_scrape",
            handles: ["persisted.snapshot"],
            createdAt: resumableNow - 26 * 60 * 60_000,
          },
        ],
      }),
    },
    {
      source: "cron_active_venues",
      minCreatedAt: resumableNow - 7 * 24 * 60 * 60_000,
      maxHandles: 200,
      serviceSecret: "qa-cooldown-secret",
    },
  );
  assert.equal(
    resumableJob?._id,
    "recoverable-running-job",
    "a persisted partial job older than the 23-hour provider cooldown must still resume",
  );
  assert.deepEqual(resumableJob?.handles, ["persisted.snapshot"]);

  const boundarySourceRows = Array.from({ length: 5_001 }, (_, index) => ({
    _id: `source-${String(index).padStart(5, "0")}`,
    handle: `source.${index}`,
    role: "unknown",
    active: true,
    lastFetchAttemptAt: 10_000 + index,
    createdAt: 1,
    updatedAt: 1,
  }));
  const activeSourcePageDb = createPagedDb({ instagramSources: boundarySourceRows });
  let activeSourceVenueJoinReads = 0;
  activeSourcePageDb.get = async () => {
    activeSourceVenueJoinReads += 1;
    return null;
  };
  const drainedSources = await drainHandler(
    listActiveSourcesPage._handler,
    activeSourcePageDb,
  );
  assert.equal(drainedSources.length, 5_001, "all active sources must cross the old 5,000 boundary");
  assert.equal(
    activeSourceVenueJoinReads,
    0,
    "active-source pages must not issue one venue read per source",
  );
  const drainedSourceHandles = await drainHandler(
    listActiveSourceHandlesPage._handler,
    createPagedDb({ instagramSources: boundarySourceRows }),
  );
  assert.equal(drainedSourceHandles.length, 5_001);
  assert.equal(typeof drainedSourceHandles[0], "string");

  const targetedContextQueries = [];
  const targetedContextDb = {
    query(table) {
      return {
        withIndex(indexName, apply) {
          let matchedValue;
          const q = {
            eq(_field, value) {
              matchedValue = value;
              return q;
            },
          };
          apply(q);
          targetedContextQueries.push({ table, indexName, matchedValue });
          return {
            async unique() {
              return table === "instagramSources" && matchedValue === "source.0"
                ? {
                    _id: "source-context-0",
                    handle: "source.0",
                    role: "venue",
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                  }
                : null;
            },
            async take(limit) {
              assert.equal(limit, 2);
              return table === "venues" &&
                indexName === "by_normalizedInstagramHandle" &&
                matchedValue === "source.0"
                ? [
                    {
                      _id: "venue-context-0",
                      name: "Source Zero",
                      instagramHandle: "source.0",
                      normalizedInstagramHandle: "source.0",
                      scrapeActive: true,
                      publicStatus: "published",
                    },
                  ]
                : [];
            },
            async first() {
              assert.fail("the normalized venue index should avoid the legacy exact fallback");
            },
          };
        },
      };
    },
    async get() {
      assert.fail("the indexed venue match should avoid a linked-venue fallback read");
    },
  };
  const targetedContexts = await getIngestionContextsByHandles._handler(
    { auth: { getUserIdentity: async () => null }, db: targetedContextDb },
    { handles: ["source.0"], serviceSecret: "qa-cooldown-secret" },
  );
  assert.deepEqual(targetedContexts, [
    { handle: "source.0", role: "venue", canonicalVenueName: "Source Zero" },
  ]);
  assert.deepEqual(
    targetedContextQueries.map(({ table, indexName }) => [table, indexName]),
    [
      ["instagramSources", "by_handle"],
      ["venues", "by_normalizedInstagramHandle"],
    ],
    "one ingestion step should resolve only its current source and venue",
  );
  await assert.rejects(
    getIngestionContextsByHandles._handler(
      { auth: { getUserIdentity: async () => null }, db: targetedContextDb },
      {
        handles: Array.from({ length: 26 }, (_, index) => `source.${index}`),
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /limited to 25 handles/,
  );

  const legacyMixedCaseVenue = {
    _id: "legacy-mixed-case-venue",
    name: "Legacy Mixed Case Venue",
    instagramHandle: "@Legacy.Handle",
    scrapeActive: true,
    publicStatus: "published",
  };
  const normalizationPreview = await listInstagramHandleNormalizationPage._handler(
    {
      auth: { getUserIdentity: async () => null },
      db: createPagedDb({ venues: [legacyMixedCaseVenue] }),
    },
    {
      paginationOpts: { numItems: 10, cursor: null },
      serviceSecret: "qa-cooldown-secret",
    },
  );
  assert.deepEqual(normalizationPreview.page, [
    {
      id: "legacy-mixed-case-venue",
      instagramHandle: "@Legacy.Handle",
      normalizedInstagramHandle: null,
      expectedNormalizedInstagramHandle: "legacy.handle",
    },
  ]);
  await assert.rejects(
    listInstagramHandleNormalizationPage._handler(
      {
        auth: { getUserIdentity: async () => null },
        db: createPagedDb({ venues: [legacyMixedCaseVenue] }),
      },
      {
        paginationOpts: { numItems: 201, cursor: null },
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /pages must contain 1 to 200 rows/,
  );

  function createVenueNormalizationDb(initialRows) {
    const rows = new Map(initialRows.map((row) => [row._id, { ...row }]));
    let patchCount = 0;
    return {
      rows,
      get patchCount() {
        return patchCount;
      },
      async get(id) {
        return rows.get(id) ?? null;
      },
      async patch(id, patch) {
        const current = rows.get(id);
        assert.ok(current, `missing QA venue ${id}`);
        rows.set(id, { ...current, ...patch });
        patchCount += 1;
      },
      query(table) {
        return {
          withIndex(indexName, apply) {
            let field;
            let matchedValue;
            const q = {
              eq(nextField, value) {
                field = nextField;
                matchedValue = value;
                return q;
              },
            };
            apply(q);
            const matches = () => {
              if (table === "instagramSources") return [];
              assert.equal(table, "venues");
              if (indexName === "by_normalizedInstagramHandle") {
                assert.equal(field, "normalizedInstagramHandle");
              } else if (indexName === "by_instagramHandle") {
                assert.equal(field, "instagramHandle");
              } else {
                assert.fail(`unexpected venue normalization index ${indexName}`);
              }
              return [...rows.values()].filter((row) => row[field] === matchedValue);
            };
            return {
              async unique() {
                const found = matches();
                assert.ok(found.length <= 1);
                return found[0] ?? null;
              },
              async take(limit) {
                return matches().slice(0, limit);
              },
              async first() {
                return matches()[0] ?? null;
              },
            };
          },
        };
      },
    };
  }

  const rollingCanonicalDb = createVenueNormalizationDb([
    {
      ...legacyMixedCaseVenue,
      _id: "rolling-canonical-venue",
      name: "Rolling Canonical Venue",
      instagramHandle: "canonical.handle",
    },
  ]);
  const rollingCanonicalContexts = await getIngestionContextsByHandles._handler(
    { auth: { getUserIdentity: async () => null }, db: rollingCanonicalDb },
    { handles: ["canonical.handle"], serviceSecret: "qa-cooldown-secret" },
  );
  assert.deepEqual(rollingCanonicalContexts, [
    {
      handle: "canonical.handle",
      role: "venue",
      canonicalVenueName: "Rolling Canonical Venue",
    },
  ]);

  await assert.rejects(
    applyInstagramHandleNormalizationBatch._handler(
      { auth: { getUserIdentity: async () => null }, db: rollingCanonicalDb },
      {
        rows: Array.from({ length: 26 }, (_, index) => ({
          id: `oversized-${index}`,
          expectedInstagramHandle: `oversized.${index}`,
          expectedNormalizedInstagramHandle: null,
        })),
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /batches must contain 1 to 25 rows/,
  );

  const legacyNormalizationDb = createVenueNormalizationDb([legacyMixedCaseVenue]);
  const normalizationApply = await applyInstagramHandleNormalizationBatch._handler(
    { auth: { getUserIdentity: async () => null }, db: legacyNormalizationDb },
    {
      rows: [
        {
          id: "legacy-mixed-case-venue",
          expectedInstagramHandle: "@Legacy.Handle",
          expectedNormalizedInstagramHandle: null,
        },
      ],
      serviceSecret: "qa-cooldown-secret",
    },
  );
  assert.deepEqual(normalizationApply, { scanned: 1, updated: 1 });
  assert.equal(
    legacyNormalizationDb.rows.get("legacy-mixed-case-venue").normalizedInstagramHandle,
    "legacy.handle",
  );
  const legacyContexts = await getIngestionContextsByHandles._handler(
    { auth: { getUserIdentity: async () => null }, db: legacyNormalizationDb },
    { handles: ["legacy.handle"], serviceSecret: "qa-cooldown-secret" },
  );
  assert.deepEqual(legacyContexts, [
    {
      handle: "legacy.handle",
      role: "venue",
      canonicalVenueName: "Legacy Mixed Case Venue",
    },
  ]);
  await assert.rejects(
    applyInstagramHandleNormalizationBatch._handler(
      { auth: { getUserIdentity: async () => null }, db: legacyNormalizationDb },
      {
        rows: [
          {
            id: "legacy-mixed-case-venue",
            expectedInstagramHandle: "@Legacy.Handle",
            expectedNormalizedInstagramHandle: null,
          },
        ],
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /changed after normalization preflight/,
    "normalization apply must reject a stale preflight snapshot",
  );
  assert.equal(legacyNormalizationDb.patchCount, 1);
  const normalizationRollback = await clearInstagramHandleNormalizationBatch._handler(
    { auth: { getUserIdentity: async () => null }, db: legacyNormalizationDb },
    {
      rows: [
        {
          id: "legacy-mixed-case-venue",
          expectedInstagramHandle: "@Legacy.Handle",
          expectedNormalizedInstagramHandle: "legacy.handle",
        },
      ],
      serviceSecret: "qa-cooldown-secret",
    },
  );
  assert.deepEqual(normalizationRollback, { scanned: 1, updated: 1 });
  assert.equal(
    legacyNormalizationDb.rows.get("legacy-mixed-case-venue").normalizedInstagramHandle,
    undefined,
  );
  assert.equal(legacyNormalizationDb.patchCount, 2);
  await assert.rejects(
    clearInstagramHandleNormalizationBatch._handler(
      { auth: { getUserIdentity: async () => null }, db: legacyNormalizationDb },
      {
        rows: [
          {
            id: "legacy-mixed-case-venue",
            expectedInstagramHandle: "@Legacy.Handle",
            expectedNormalizedInstagramHandle: "legacy.handle",
          },
        ],
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /changed after normalization rollback preflight/,
  );

  const collisionDb = createVenueNormalizationDb([
    {
      ...legacyMixedCaseVenue,
      _id: "canonical-owner",
      instagramHandle: "legacy.handle",
      normalizedInstagramHandle: "legacy.handle",
    },
    { ...legacyMixedCaseVenue, _id: "collision-target" },
  ]);
  await assert.rejects(
    applyInstagramHandleNormalizationBatch._handler(
      { auth: { getUserIdentity: async () => null }, db: collisionDb },
      {
        rows: [
          {
            id: "collision-target",
            expectedInstagramHandle: "@Legacy.Handle",
            expectedNormalizedInstagramHandle: null,
          },
        ],
        serviceSecret: "qa-cooldown-secret",
      },
    ),
    /normalization collision/,
  );
  assert.equal(collisionDb.patchCount, 0, "colliding migration batches must make no writes");

  const duplicateNormalizedContextDb = createVenueNormalizationDb([
    {
      ...legacyMixedCaseVenue,
      _id: "duplicate-normalized-a",
      normalizedInstagramHandle: "legacy.handle",
    },
    {
      ...legacyMixedCaseVenue,
      _id: "duplicate-normalized-b",
      normalizedInstagramHandle: "legacy.handle",
    },
  ]);
  await assert.rejects(
    getIngestionContextsByHandles._handler(
      { auth: { getUserIdentity: async () => null }, db: duplicateNormalizedContextDb },
      { handles: ["legacy.handle"], serviceSecret: "qa-cooldown-secret" },
    ),
    /multiple venues resolve/i,
    "ambiguous normalized venue context must fail closed",
  );

  const drainedAttempts = await drainHandler(
    listFreshFetchAttemptMetadataPage._handler,
    createPagedDb({ instagramSources: boundarySourceRows }),
    { minAttemptAt: 1 },
  );
  assert.equal(
    drainedAttempts.length,
    5_001,
    "all recent attempts must cross the old 5,000 cooldown boundary",
  );
  assert.equal(new Set(drainedAttempts.map((row) => row.handle)).size, 5_001);

  const legacyVenueRows = Array.from({ length: 311 }, (_, index) => ({
    _id: `venue-${String(index).padStart(4, "0")}`,
    name: `Venue ${index}`,
    instagramHandle: `legacy.${index}`,
    scrapeActive: true,
    publicStatus: "published",
  }));
  const drainedLegacySources = await drainHandler(
    listLegacyVenueSourcesPage._handler,
    createPagedDb({ venues: legacyVenueRows }),
  );
  assert.equal(drainedLegacySources.length, 311, "legacy venue sources must also drain every page");
  const drainedLegacyHandles = await drainHandler(
    listLegacyVenueHandlesPage._handler,
    createPagedDb({ venues: legacyVenueRows }),
  );
  assert.equal(drainedLegacyHandles.length, 311);
  assert.equal(typeof drainedLegacyHandles[0], "string");

  const repairJobRows = Array.from({ length: 5_001 }, (_, index) => ({
    _id: `repair-job-${String(index).padStart(5, "0")}`,
    source: "cron_active_venues",
    mode: "full_scrape",
    status: index % 2 === 0 ? "running" : "completed",
    handles: [`repair.${index}`],
    createdAt: 20_000 + index,
  }));
  const drainedRepairJobs = await drainHandler(
    listJobsForRepairPage._handler,
    createPagedDb({ ingestionJobs: repairJobRows }),
    { minCreatedAt: 0 },
  );
  assert.equal(
    drainedRepairJobs.length,
    5_001,
    "maintenance repair queries must not inherit the 12-job rollback compatibility cap",
  );

  const createLegacyJob = (index, mode) => ({
    _id: `job-${mode ?? "legacy"}-${index}`,
    mode,
    source: "cron_active_venues",
    status: "completed",
    handles: [`job-handle-${mode ?? "legacy"}-${index}`],
    summaryJson: "{}",
    stateJson: "{}",
    createdAt: 1_000 + index,
  });
  const invokeLegacyAttemptMetadata = (rows) =>
    listRecentFullScrapeAttemptMetadata._handler(
      {
        auth: { getUserIdentity: async () => null },
        db: createPagedDb({ ingestionJobs: rows }),
      },
      { minCreatedAt: 0, serviceSecret: "qa-cooldown-secret" },
    );

  const validRollbackWindow = await invokeLegacyAttemptMetadata([
    ...Array.from({ length: 6 }, (_, index) => createLegacyJob(index, "full_scrape")),
    ...Array.from({ length: 6 }, (_, index) => createLegacyJob(100 + index, undefined)),
  ]);
  assert.equal(validRollbackWindow.length, 12);
  await assert.rejects(
    invokeLegacyAttemptMetadata(
      Array.from({ length: 13 }, (_, index) => createLegacyJob(index, "full_scrape")),
    ),
    /full-scrape history exceeded the fail-closed 12-document/i,
    "a 13th current-mode job must fail closed instead of dropping attempted handles",
  );
  await assert.rejects(
    invokeLegacyAttemptMetadata([
      ...Array.from({ length: 12 }, (_, index) => createLegacyJob(index, "full_scrape")),
      createLegacyJob(999, undefined),
    ]),
    /optional-mode history exceeded the fail-closed 12-document/i,
    "a newer optional-mode legacy job must fail closed when the shared cap is already full",
  );
} finally {
  if (previousCooldownSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCooldownSecret;
}

assert.match(
  cronRouteSource,
  /ingestionJobs:findLatestResumableFullScrapeJob/,
  "daily resume lookup must use the bounded indexed resumable query",
);
assert.doesNotMatch(
  cronRouteSource,
  /ingestionJobs:getJob/,
  "the resumable query must return the compatible full job and avoid a duplicate read",
);
assert.match(
  ingestionJobsSource,
  /by_source_status_createdAt[\s\S]{0,360}\.first\(\)/,
  "resume lookup must read at most the newest queued and running job for the source",
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
  assert.equal(
    calls,
    1,
    "A source revision must make exactly one paid OpenAI transport even for transient failures.",
  );

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
  /const cooldownMinCreatedAt =\s*Date\.now\(\) - cronConfig\.fullScrapeCooldownHours \* MS_PER_HOUR/,
  "cron route should honor the configured cooldown independently of recovery lookback",
);
assert.match(
  cronRouteSource,
  /DEFAULT_RESUMABLE_LOOKBACK_HOURS = 7 \* 24/,
  "the recovery window must outlive the daily provider cooldown",
);
assert.match(
  cronRouteSource,
  /minCreatedAt: resumableMinCreatedAt/,
  "interrupted daily jobs must use the recovery cutoff rather than the cooldown cutoff",
);
assert.match(
  cronRouteSource,
  /findResumableCronJob/,
  "cron route should resume recent cron jobs before applying cooldown skips",
);
assert.equal(
  [...cronRouteSource.matchAll(/await getRecentlyAttemptedFullScrapeHandles\(/g)].length,
  1,
  "each cron step must perform one compact cooldown lookup, not duplicate range reads",
);
assert.match(
  instagramSourcesSource,
  /lastFetchAttemptAt: source\.lastFetchAttemptAt/,
  "recent full-scrape cooldown metadata must remain a compact source projection",
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
  /resumeCapacity = normalizeHostRunRemaining\(request, MAX_INGESTION_JOB_HANDLES\)[\s\S]{0,360}maxHandles: resumeCapacity/,
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
  /activeVenueCount = activeVenueHandles\.length;[\s\S]{0,100}hostRunMaxHandles = activeVenueCount/,
  "scheduled ingestion must size a new host run from the complete active venue set",
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
assert.match(hostCronRunnerSource, /hostRunCompletedThrough/);
assert.match(hostCronRunnerSource, /missing_host_completion_accounting/);
assert.match(hostCronRunnerSource, /incomplete_host_accounting/);
assert.doesNotMatch(hostCronRunnerSource, /COUNTED_JOB_IDS/);
assert.match(hostCronRunnerSource, /trap cleanup_sensitive_temp_file EXIT/);
assert.match(
  ingestionJobsSource,
  /assertIngestionJobPayloadWithinBounds/,
  "the central Convex mutation boundary must reject oversized job documents",
);
assert.match(
  recentFullScrapeHandlesSource,
  /lastFetchAttemptAt/,
  "same host run must advance past every transport-attempted handle, including provider errors",
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
  selectCronIngestionHandles({
    activeVenueHandles: ["a", "b", "c", "d", "e"],
    recentlyAttemptedHandles: [],
    maxHandlesPerRun: 2,
    afterHandle: "b",
  }),
  {
    handles: ["c", "d"],
    skippedRecentlyAttempted: 0,
    skippedDueToRunLimit: 1,
  },
  "a maintenance-only first chunk must not be selected again merely because it created no cooldown receipt",
);

assert.deepEqual(
  selectCronIngestionHandles({
    activeVenueHandles: ["a", "b", "c", "d", "e"],
    recentlyAttemptedHandles: ["d"],
    maxHandlesPerRun: 2,
    afterHandle: "bb",
  }),
  {
    handles: ["c", "e"],
    skippedRecentlyAttempted: 1,
    skippedDueToRunLimit: 0,
  },
  "a deleted cursor handle must still advance lexically without repeating the first chunk",
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

const maintenanceOnlySummary = createEmptyIngestionSummary(["maintenance-only"]);
maintenanceOnlySummary.handles[0].insertedEvents = 1;
markFreshFetchNotAttempted(
  maintenanceOnlySummary,
  "maintenance-only",
  "saved_backlog_not_ready",
);
assert.equal(maintenanceOnlySummary.handles[0].freshFetchAttempted, 0);
assert.deepEqual(
  maintenanceOnlySummary.handles[0].errors,
  [],
  "normal backlog maintenance must not be misreported as an ingestion error",
);
assert.deepEqual(
  getFreshCompletedAttemptHandles(
    ["maintenance-only"],
    JSON.stringify(maintenanceOnlySummary),
  ),
  [],
  "saved-backlog-only maintenance must not manufacture a fresh-fetch cooldown",
);
maintenanceOnlySummary.handles[0].freshFetchAttempted = 1;
markFreshFetchNotAttempted(
  maintenanceOnlySummary,
  "maintenance-only",
  "resume_after_transport_ambiguity",
);
assert.equal(
  maintenanceOnlySummary.handles[0].freshFetchAttempted,
  1,
  "a later maintenance denial must not erase an already durable positive attempt receipt",
);

assert.deepEqual(
  getFreshCompletedAttemptHandles(
    ["provider-zero", "gate-denied", "provider-fetched"],
    JSON.stringify({
      handles: [
        { handle: "provider-zero", freshFetchAttempted: 1, errors: [] },
        {
          handle: "gate-denied",
          freshFetchAttempted: 0,
          insertedEvents: 1,
          errors: ["Fresh Apify fetch for @gate-denied was not attempted (saved_backlog_present)."],
        },
        { handle: "provider-fetched", freshFetchAttempted: 1, fetchedPosts: 1, errors: [] },
      ],
    }),
  ),
  ["provider-zero", "provider-fetched"],
  "a denied provider lease must not create a 24-hour fresh-attempt cooldown",
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
if (process.env.FAKE_CURL_MODE === "lost-terminal" && !state.failedOnce) {
  state.failedOnce = true;
  state.requests.push({ attempt: state.count, httpCode: 200, transportLost: true, selected: 200 });
  writeFileSync(process.env.FAKE_CURL_STATE, JSON.stringify(state));
  writeFileSync(outputPath, JSON.stringify({ done: true, hostRunCompletedThrough: 200 }));
  process.exit(28);
}
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
const incomingCursor = parsedUrl.searchParams.get("hostRunAfter");
const selected = Math.min(200, Math.max(0, remaining));
const repeat = process.env.FAKE_CURL_MODE === "repeat-resume";
const singleHandleProgress = process.env.FAKE_CURL_MODE === "single-handle-progress";
const zeroProgress = process.env.FAKE_CURL_MODE === "zero-progress";
const jobId = singleHandleProgress || zeroProgress
  ? process.env.FAKE_CURL_MODE + "-job"
  : repeat && requestIndex <= 2
    ? "resumed-job"
    : "job-" + requestIndex;
const hostRunCursor = "cursor_" + jobId.replace(/[^a-z0-9._]/g, "_");
const done = zeroProgress
  ? false
  : singleHandleProgress
    ? requestIndex >= selected
    : !(repeat && requestIndex === 1);
const hostRunCompletedThrough = process.env.FAKE_CURL_MODE === "lost-terminal"
  ? Math.min(activeCount, requestIndex * 200)
  : Math.min(activeCount, activeCount - remaining + (done ? selected : 0));
const payload = {
  jobId,
  resumedJob: requestIndex === 1 || (repeat && requestIndex === 2),
  status: done ? "completed" : "running",
  done,
  handles: Array.from({ length: selected }, (_, index) => "handle-" + requestIndex + "-" + index),
  skippedDueToRunLimit: remaining > selected ? 1 : 0,
  hostRunMaxHandles: activeCount,
  hostRunCursor,
  hostRunCompletedThrough,
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
  incomingCursor,
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
        IG_EVENT_CRON_LOCK_DIR: join(fixtureRoot, "locks"),
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.ok(existsSync(stateFile), `host runner never reached fake curl: ${result.stderr || result.stdout}`);
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
assert.deepEqual(
  resumedCapFixture.state.requests.slice(0, 3).map((request) => request.incomingCursor),
  [null, "cursor_job_1", "cursor_job_2"],
  "each completed job must advance the host-run source cursor",
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
  [2400, 2400, 2200],
  "an incomplete job must not consume the host budget before durable completion",
);
assert.deepEqual(
  repeatedResumeFixture.state.requests.slice(0, 3).map((request) => request.incomingCursor),
  [null, null, "cursor_resumed_job"],
  "resuming the same job must not advance its cursor until that job completes",
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
assert.deepEqual(
  [...new Set(singleHandleProgressFixture.state.requests.map((request) => request.incomingCursor))],
  [null],
  "an incomplete final job must not advance the source cursor before its terminal response",
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

const lostTerminalFixture = runCronRunnerCapFixture("lost-terminal", 630);
assert.equal(lostTerminalFixture.result.status, 0, lostTerminalFixture.result.stderr);
assert.match(
  lostTerminalFixture.result.stdout,
  /status=ok requests=3 selected=630 host_run_max=630/,
  "a lost terminal response must reconcile completed fleet coverage from the next durable cursor rank",
);
assert.deepEqual(
  lostTerminalFixture.state.requests.map((request) => request.selected),
  [200, 200, 200, 30],
  "the 630-handle fleet must remain covered as [200,200,200,30] across a lost response",
);

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
