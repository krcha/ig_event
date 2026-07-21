import assert from "node:assert/strict";
import {
  buildOperationsTriageSummary,
} from "../lib/pipeline/ingestion-run-triage.ts";

function makeHandle(handle, overrides = {}) {
  return {
    handle,
    fetchedPosts: 0,
    fetched_posts: 0,
    insertedEvents: 0,
    inserted_events: 0,
    insertedApprovedEvents: 0,
    insertedPendingEvents: 0,
    skippedDuplicates: 0,
    skipped_duplicates: 0,
    skipped_duplicates_clean: 0,
    skippedNoImage: 0,
    skipped_missing_date: 0,
    skipped_missing_venue: 0,
    skipped_video: 0,
    skipped_invalid_event: 0,
    skipped_past_event: 0,
    skipped_far_future_event: 0,
    updated_duplicates_bad_data: 0,
    duplicate_update_failed: 0,
    failedDownloads: 0,
    failed_downloads: 0,
    failedConversions: 0,
    failed_conversions: 0,
    failedExtractions: 0,
    failed_extractions: 0,
    failed_extraction: 0,
    failedImagePersistence: 0,
    persistedImages: 0,
    errors: [],
    ...overrides,
  };
}

function makeSummary(handles, runContext = {}) {
  return {
    startedAt: "2099-06-20T10:00:00.000Z",
    finishedAt: "2099-06-20T10:05:00.000Z",
    handles,
    runContext,
  };
}

const openAiQuota = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("club", {
      fetchedPosts: 3,
      failedExtractions: 3,
      errors: ["OpenAI extraction failed: 429 insufficient_quota"],
    }),
  ]),
});
assert.equal(openAiQuota.tone, "danger");
assert.equal(openAiQuota.providerStatus.openai, "blocked");
assert.equal(openAiQuota.title, "Posts saved, OpenAI quota blocked extraction.");

const apifyQuota = buildOperationsTriageSummary({
  status: "failed",
  summary: makeSummary([
    makeHandle("club", {
      errors: ["Apify actor failed with 402 monthly usage limit"],
    }),
  ]),
});
assert.equal(apifyQuota.tone, "danger");
assert.equal(apifyQuota.providerStatus.apify, "blocked");
assert.equal(apifyQuota.title, "Apify blocked Instagram scraping.");

const skippedHandles = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([], {
    activeVenueCount: 10,
    selectedHandleCount: 7,
    skippedRecentlyAttempted: 2,
    skippedDueToRunLimit: 1,
    fullScrapeCooldownHours: 23,
  }),
});
assert.equal(skippedHandles.handleSelection.activeVenueCount, 10);
assert.equal(skippedHandles.handleSelection.selectedHandleCount, 7);
assert.equal(skippedHandles.handleSelection.skippedRecentlyAttempted, 2);
assert.equal(skippedHandles.handleSelection.skippedDueToRunLimit, 1);

const completedWithWarnings = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("club", {
      fetchedPosts: 2,
      insertedEvents: 1,
      insertedApprovedEvents: 1,
      failedExtractions: 1,
      errors: ["OpenAI extraction failed: transient model error"],
    }),
  ]),
});
assert.equal(completedWithWarnings.tone, "warning");
assert.match(completedWithWarnings.title, /Completed with warnings/);

const completedWithImagePersistenceWarning = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("club", {
      fetchedPosts: 1,
      insertedEvents: 1,
      insertedApprovedEvents: 1,
      failedImagePersistence: 1,
    }),
  ]),
});
assert.equal(completedWithImagePersistenceWarning.tone, "warning");
assert.equal(completedWithImagePersistenceWarning.totals.failedImagePersistence, 1);
assert.ok(
  completedWithImagePersistenceWarning.issueGroups.some(
    (issue) => issue.category === "image_persistence" && issue.handle === "club",
  ),
);

const fetchedNoInserts = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("club", {
      fetchedPosts: 5,
      skipped_missing_date: 2,
      skipped_missing_venue: 1,
      skipped_invalid_event: 1,
      skipped_past_event: 1,
      skipped_far_future_event: 1,
    }),
  ]),
});
assert.equal(fetchedNoInserts.tone, "warning");
assert.equal(
  fetchedNoInserts.title,
  "Instagram scraping finished, but no events were created.",
);
assert.ok(fetchedNoInserts.issueGroups.some((issue) => issue.category === "missing_date"));
assert.ok(fetchedNoInserts.issueGroups.some((issue) => issue.category === "missing_venue"));
assert.ok(fetchedNoInserts.issueGroups.some((issue) => issue.category === "invalid_event"));

const recurring = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("club", {
      fetchedPosts: 1,
      skipped_missing_date: 1,
    }),
  ]),
  recentSummaries: [
    makeSummary([makeHandle("club", { skipped_missing_date: 1 })]),
    makeSummary([makeHandle("club", { skipped_missing_date: 2 })]),
  ],
});
assert.ok(
  recurring.issueGroups.some(
    (issue) => issue.category === "recurring_issue" && issue.handle === "club",
  ),
);

const legacy = buildOperationsTriageSummary({
  status: "completed",
  summary: {
    startedAt: "2099-06-20T10:00:00.000Z",
    finishedAt: "2099-06-20T10:05:00.000Z",
    handles: [makeHandle("legacy")],
  },
});
assert.equal(legacy.handleSelection.activeVenueCount, null);
assert.equal(legacy.providerStatus.openai, "ok");

const legacySnakeOnly = buildOperationsTriageSummary({
  status: "completed",
  summary: makeSummary([
    makeHandle("legacy-snake", {
      fetchedPosts: 0,
      fetched_posts: 4,
      insertedEvents: 0,
      inserted_events: 2,
      insertedApprovedEvents: 1,
      insertedPendingEvents: 1,
      skippedDuplicates: 0,
      skipped_duplicates: 1,
      failedDownloads: 0,
      failed_downloads: 1,
      failedConversions: 0,
      failed_conversions: 1,
      failedExtractions: 0,
      failed_extractions: 2,
    }),
  ]),
});
assert.equal(legacySnakeOnly.totals.fetchedPosts, 4);
assert.equal(legacySnakeOnly.totals.insertedEvents, 2);
assert.equal(legacySnakeOnly.totals.insertedApprovedEvents, 1);
assert.equal(legacySnakeOnly.totals.insertedPendingEvents, 1);
assert.equal(legacySnakeOnly.totals.skippedDuplicates, 1);
assert.equal(legacySnakeOnly.totals.failedDownloads, 1);
assert.equal(legacySnakeOnly.totals.failedConversions, 1);
assert.equal(legacySnakeOnly.totals.failedExtractions, 2);

console.log("QA passed: ingestion run triage classifies provider and summary outcomes.");
