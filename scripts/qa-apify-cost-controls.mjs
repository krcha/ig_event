import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildApifyInstagramScrapeRequest,
} from "../lib/scraper/instagram-scraper.ts";
import {
  getCronIngestionConfig,
  isAuthorizedCronRequestHeader,
  selectCronIngestionHandles,
} from "../lib/pipeline/cron-ingestion-config.ts";
import { getAttemptedHandlesFromRecentJob } from "../lib/pipeline/recent-full-scrape-handles.ts";

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
  request.runOptions.maxTotalChargeUsd > 0 && request.runOptions.maxTotalChargeUsd <= 0.02,
  "default Apify per-run charge cap should stay low",
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
  maxHandlesPerRun: 600,
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
    activeVenueHandles: Array.from({ length: 600 }, (_, index) => `venue-${index + 1}`),
    recentlyAttemptedHandles: [],
    maxHandlesPerRun: cronConfig.maxHandlesPerRun,
  }),
  {
    handles: Array.from({ length: 600 }, (_, index) => `venue-${index + 1}`),
    skippedRecentlyAttempted: 0,
    skippedDueToRunLimit: 0,
  },
  "default cron selection should cover every active handle up to the configured cap",
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
