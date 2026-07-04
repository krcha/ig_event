import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID,
  DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
  DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT,
  DEFAULT_FOLLOW_DISCOVERY_SOURCE_HANDLE,
  MAX_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
  MAX_FOLLOW_DISCOVERY_RESULTS_LIMIT,
  buildApifyFollowingScrapeRequest,
  getFollowDiscoveryConfig,
  normalizeInstagramHandle,
  planFollowDiscoveryVenues,
  runFollowDiscoveryWorkflow,
} from "../lib/pipeline/follow-discovery.ts";

const vercelConfig = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
assert.deepEqual(
  vercelConfig.crons,
  [],
  "Vercel Cron should stay disabled; the VPS host cron owns ingestion and follow-discovery scheduling.",
);

assert.equal(DEFAULT_FOLLOW_DISCOVERY_SOURCE_HANDLE, "going_places11");
assert.equal(DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID, "scraping_solutions/instagram-scraper-followers-following-no-cookies");
assert.equal(DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT, 700);
assert.equal(DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD, 0.5);

const defaultConfig = getFollowDiscoveryConfig({});
assert.equal(defaultConfig.sourceHandle, "going_places11");
assert.equal(defaultConfig.actorId, DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID);
assert.equal(defaultConfig.resultsLimit, DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT);
assert.equal(defaultConfig.maxTotalChargeUsd, DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD);
assert.equal(defaultConfig.ingestionResultsLimit, 1);
assert.equal(defaultConfig.ingestionDaysBack, 10);

const normalizedConfig = getFollowDiscoveryConfig({
  FOLLOW_DISCOVERY_SOURCE_HANDLE: " https://www.instagram.com/Going_Places11/ ",
  FOLLOW_DISCOVERY_RESULTS_LIMIT: "999999",
  FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD: "999",
  FOLLOW_DISCOVERY_TIMEOUT_SECONDS: "999",
});
assert.equal(normalizedConfig.sourceHandle, "going_places11");
assert.equal(normalizedConfig.resultsLimit, MAX_FOLLOW_DISCOVERY_RESULTS_LIMIT);
assert.equal(normalizedConfig.maxTotalChargeUsd, MAX_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD);
assert.ok(normalizedConfig.timeoutSeconds <= 300);

const blankOverrideConfig = getFollowDiscoveryConfig({
  FOLLOW_DISCOVERY_SOURCE_HANDLE: "   ",
  FOLLOW_DISCOVERY_RESULTS_LIMIT: "0",
  FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD: "free",
});
assert.equal(blankOverrideConfig.sourceHandle, "going_places11");
assert.equal(blankOverrideConfig.resultsLimit, DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT);
assert.equal(blankOverrideConfig.maxTotalChargeUsd, DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD);

const followingRequest = buildApifyFollowingScrapeRequest(defaultConfig);
assert.equal(followingRequest.actorId, DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID);
assert.deepEqual(followingRequest.input, {
  Account: ["going_places11"],
  resultsLimit: DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT,
  dataToScrape: "Followings",
});
assert.equal(followingRequest.runOptions.maxItems, DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT);
assert.ok(
  followingRequest.runOptions.maxTotalChargeUsd > 0 &&
    followingRequest.runOptions.maxTotalChargeUsd <= DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
  "following actor should be budget capped by default",
);
assert.ok(followingRequest.runOptions.timeout <= 300);

assert.equal(normalizeInstagramHandle(" @Drugstore_Beograd "), "drugstore_beograd");
assert.equal(normalizeInstagramHandle("https://www.instagram.com/KCGrad/"), "kcgrad");
assert.equal(normalizeInstagramHandle("https://instagram.com/New.Place/?hl=en"), "new.place");
assert.equal(normalizeInstagramHandle("20_44.nightclub"), "20_44.nightclub");
assert.equal(normalizeInstagramHandle(""), "");
assert.equal(normalizeInstagramHandle("https://www.instagram.com/p/not-a-user/"), "");
assert.equal(normalizeInstagramHandle("bad handle"), "");

const planned = planFollowDiscoveryVenues({
  existingVenues: [
    { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    { name: "KC Grad", instagramHandle: "@kcgrad" },
    { name: "Klub 20/44", instagramHandle: "20_44.nightclub" },
  ],
  following: [
    { username: "@Drugstore_Beograd", full_name: "Drugstore" },
    { username: "https://www.instagram.com/kcgrad/", full_name: "KC Grad" },
    { username: "20_44.nightclub", full_name: "Klub 20/44" },
    { username: "https://instagram.com/New.Place/", full_name: "New Place" },
    { username: "NEW.PLACE", full_name: "Duplicate New Place" },
    { username: " new.place ", full_name: "Duplicate New Place 2" },
    { username: "bad handle", full_name: "Invalid" },
    { username: "", full_name: "Blank" },
  ],
});
assert.deepEqual(planned.missingHandles, ["new.place"]);
assert.deepEqual(
  planned.newVenues.map((venue) => venue.instagramHandle),
  ["new.place"],
);
assert.equal(planned.newVenues[0].name, "New Place");
assert.equal(planned.newVenues[0].category, "venue");
assert.equal(planned.skippedExisting, 3);
assert.equal(planned.skippedDuplicate, 2);
assert.equal(planned.skippedInvalid, 2);

const createdVenues = [];
const ingestionCalls = [];
const workflowResult = await runFollowDiscoveryWorkflow({
  env: {},
  deps: {
    scrapeFollowing: async (request) => {
      assert.equal(request.input.dataToScrape, "Followings");
      return [
        { username: "drugstore_beograd", full_name: "Drugstore" },
        { username: "new.place", full_name: "New Place" },
      ];
    },
    listVenues: async () => [
      { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    ],
    createVenue: async (venue) => {
      createdVenues.push(venue);
      return `venue-${createdVenues.length}`;
    },
    runVenueIngestion: async (options) => {
      ingestionCalls.push(options);
      return {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        handles: [],
      };
    },
  },
});
assert.equal(workflowResult.sourceHandle, "going_places11");
assert.deepEqual(createdVenues, [
  {
    name: "New Place",
    instagramHandle: "new.place",
    category: "venue",
    isActive: true,
  },
]);
assert.deepEqual(ingestionCalls, [
  {
    handles: ["new.place"],
    mode: "full_scrape",
    resultsLimit: 1,
    daysBack: 10,
  },
]);
assert.deepEqual(workflowResult.createdHandles, ["new.place"]);
assert.equal(workflowResult.ingestionTriggered, true);

const noNewResult = await runFollowDiscoveryWorkflow({
  env: {},
  deps: {
    scrapeFollowing: async () => [{ username: "drugstore_beograd", full_name: "Drugstore" }],
    listVenues: async () => [
      { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    ],
    createVenue: async () => {
      throw new Error("createVenue should not be called when nothing is missing");
    },
    runVenueIngestion: async () => {
      throw new Error("runVenueIngestion should not be called when nothing is missing");
    },
  },
});
assert.deepEqual(noNewResult.createdHandles, []);
assert.equal(noNewResult.ingestionTriggered, false);

const routeSource = readFileSync(
  new URL("../app/api/cron/discover-following/route.ts", import.meta.url),
  "utf8",
);
assert.match(routeSource, /isAuthorizedCronRequestHeader/);
assert.match(routeSource, /runFollowDiscoveryWorkflow/);
assert.match(routeSource, /venues:createVenue/);
assert.match(routeSource, /runInstagramIngestion/);

console.log("Follow-discovery QA passed.");
