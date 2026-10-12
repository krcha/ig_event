import assert from "node:assert/strict";
import "../convex/events.ts";
import {
  claimProcessing,
  recordOpenAiAnalysis,
  recordProcessingResult,
  upsertManyByHandle,
} from "../convex/scrapedPosts.ts";
import { mapApifyItemToInstagramPost } from "../lib/scraper/instagram-scraper.ts";
import {
  buildInstagramImageCoverage,
  hasKnownUnanalyzedInstagramSlides,
  parseCachedInstagramImageCoveragePartial,
} from "../lib/pipeline/instagram-image-coverage.ts";
import { processLoadedPostsForHandle } from "../lib/pipeline/ingestion/handle-processing.ts";
import { createEmptyHandleSummary } from "../lib/pipeline/ingestion/reporting.ts";
import {
  buildSourceOccurrenceFingerprint,
  buildSourceOccurrenceIdentity,
} from "../lib/pipeline/source-occurrence-planning.ts";
import { normalizeScrapedPost, persistScrapedPostsForHandle } from "../lib/pipeline/ingestion/source-documents.ts";
import {
  fetchInstagramSourceDocuments,
  projectInstagramSourceDocumentForCompatibilityParser,
} from "../lib/pipeline/ingestion/source-provider.ts";

const COVER = "https://images.apifyusercontent.com/qa-cover.jpg";
const DETAIL = "https://images.apifyusercontent.com/qa-sunday.jpg";
const sourceItem = {
  id: "qa-two-slide-source",
  shortCode: "qa_two_slide",
  type: "Sidecar",
  timestamp: "2026-09-30T12:00:00.000Z",
  ownerUsername: "qa_venue",
  caption: "Saturday 17 October: Cover Party. Sunday 18 October: Independent Workshop.",
  images: [
    { displayUrl: COVER, displayUrlHD: `${COVER}?hd=1`, thumbnailUrl: `${COVER}?thumb=1` },
    { displayUrl: DETAIL, displayUrlHD: `${DETAIL}?hd=1` },
  ],
};
const post = mapApifyItemToInstagramPost(sourceItem, "qa_venue");
assert.equal(post.imageSlides.length, 2);
assert.equal(post.imageSlideCount, 2);
assert.equal(post.imageSlides[0].imageUrls.length, 3, "Cover/HD/thumbnail must remain one slide.");
assert.ok(post.imageSlides[1].imageUrls.includes(`${DETAIL}?hd=1`));
assert.deepEqual(post.imageUrls, [COVER, DETAIL], "Adding diagnostic alternate resolutions must not change legacy source candidates.");
const partialCoverage = buildInstagramImageCoverage(post, [COVER]);
assert.deepEqual(partialCoverage, {
  version: 1, knownSlideCount: 2, analyzedSlideIndexes: [0],
  unanalyzedSlideIndexes: [1], complete: false, manifestKnown: true,
});
assert.equal(buildInstagramImageCoverage(post, [COVER, `${COVER}?hd=1`]).complete, false);
assert.equal(buildInstagramImageCoverage(post, [COVER, DETAIL]).complete, true);
assert.deepEqual(buildInstagramImageCoverage(post, [DETAIL]).analyzedSlideIndexes, [1]);
const alternateImage = mapApifyItemToInstagramPost({
  ...sourceItem,
  type: "Image",
  images: undefined,
  displayUrl: COVER,
  displayUrlHD: `${COVER}?hd=1`,
  thumbnailUrl: `${COVER}?thumb=1`,
  image_versions2: { candidates: [{ url: `${COVER}?width=1080` }] },
}, "qa_venue");
assert.equal(alternateImage.imageSlides, undefined);
assert.equal(buildInstagramImageCoverage(alternateImage, [COVER]).manifestKnown, false);
const legacyFlat = mapApifyItemToInstagramPost({ ...sourceItem, images: undefined, imageUrls: [COVER, DETAIL] }, "qa_venue");
assert.equal(legacyFlat.imageSlides, undefined, "An old flat list must never be guessed to contain actual slides.");
const childPosts = mapApifyItemToInstagramPost({
  ...sourceItem,
  images: undefined,
  childPosts: [{ url: "https://www.instagram.com/p/child_source/", displayUrl: COVER }, { displayUrl: DETAIL }],
}, "qa_venue");
assert.equal(childPosts.imageSlides.length, 2);
assert.equal(childPosts.imageUrl, COVER, "A child's Instagram post URL must not be treated as its image.");
const longSourceUrl = `${COVER}?signed=${"a".repeat(2_100)}`;
const longUrlSource = mapApifyItemToInstagramPost({ ...sourceItem, images: [longSourceUrl, DETAIL] }, "qa_venue");
assert.equal(longUrlSource.imageUrl, longSourceUrl, "Diagnostic URL bounds must not change legacy image candidate selection.");
assert.deepEqual(longUrlSource.imageSlides[0].imageUrls, []);
assert.equal(buildInstagramImageCoverage(longUrlSource, [longSourceUrl]).complete, false);
const manySlides = mapApifyItemToInstagramPost({
  ...sourceItem,
  images: Array.from({ length: 25 }, (_, index) => `https://images.apifyusercontent.com/slide-${index}.jpg`),
}, "qa_venue");
assert.equal(manySlides.imageSlides.length, 20);
assert.equal(manySlides.imageSlideCount, 25, "A bounded manifest must retain the provider's full declared count.");
const clippedCoverage = buildInstagramImageCoverage(manySlides, manySlides.imageSlides.map((slide) => slide.imageUrls[0]));
assert.equal(clippedCoverage.complete, false);
assert.equal(buildInstagramImageCoverage({ imageSlides: [{ index: 0, imageUrls: [COVER] }, { index: 1, imageUrls: [COVER] }] }, [COVER]).complete, false, "One ambiguous shared URL cannot attest two different slides.");

const fetchBatch = await fetchInstagramSourceDocuments({ handle: "qa_venue" }, {
  fetchProviderRows: async () => [post], now: () => 1,
});
const projected = normalizeScrapedPost(projectInstagramSourceDocumentForCompatibilityParser(fetchBatch.documents[0]));
assert.deepEqual(projected.imageSlides, post.imageSlides, "Provider/domain/normalization boundaries must preserve ordered slides.");
assert.equal(projected.imageSlideCount, 2);
let persistedManifest;
await persistScrapedPostsForHandle({
  mutation: async (name, args) => {
    assert.equal(name, "scrapedPosts:upsertManyByHandle");
    persistedManifest = args.posts[0];
    return [{ scrapedPostId: "saved-qa-two-slide-source", postId: post.postId, sourceRevision: 1 }];
  },
}, post.username, [projected], "qa-persist-secret");
assert.deepEqual(persistedManifest.imageSlides, post.imageSlides, "Actual persistence request must retain alternate URLs grouped by slide.");
assert.equal(persistedManifest.imageSlideCount, 2);
assert.deepEqual(persistedManifest.imageUrls, post.imageUrls);

const newAnalysis = {
  extraction_contract_version: "event_evidence_v2",
  _extractionPolicyVersion: "event_quality_v1",
  _imageCoverage: partialCoverage,
  is_event: true,
  non_event_reason: "",
  title: "Cover Party",
  date: "2026-10-17",
};
const onceCompleteAnalysis = {
  ...newAnalysis,
  _imageCoverage: buildInstagramImageCoverage({ imageSlides: [post.imageSlides[0]], imageSlideCount: 1 }, [COVER]),
};
assert.equal(hasKnownUnanalyzedInstagramSlides(newAnalysis), true);
assert.equal(parseCachedInstagramImageCoveragePartial(JSON.stringify(onceCompleteAnalysis)), false);
assert.equal(parseCachedInstagramImageCoveragePartial(JSON.stringify(onceCompleteAnalysis), post, COVER), true, "Current observations outrank stale whole-source coverage without rewriting the cache.");
assert.equal(hasKnownUnanalyzedInstagramSlides({ ...newAnalysis, _imageCoverage: clippedCoverage }), true, "Unread slides beyond the bounded manifest also prevent source completion.");
assert.equal(hasKnownUnanalyzedInstagramSlides({ ...newAnalysis, _extractionPolicyVersion: undefined }), false);
assert.equal(hasKnownUnanalyzedInstagramSlides({ ...newAnalysis, _imageCoverage: buildInstagramImageCoverage(legacyFlat, [COVER]) }), false);

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_FETCH = globalThis.fetch;
process.env.CRON_SECRET = "qa-image-coverage-secret";
globalThis.fetch = async () => { throw new Error("Image-coverage QA must never call a provider or production backend."); };

function makeSource(analysis) {
  return {
    ...post,
    _id: "saved-qa-two-slide-source",
    handle: post.username,
    sourceRevision: 1,
    analysisRevision: 1,
    analysisContractVersion: "event_evidence_v2",
    // Keep intentional whitespace: receipt-bound cache bytes must be unchanged.
    analysisResultJson: JSON.stringify(analysis, null, 2),
    analysisImageSourceUrl: COVER,
    analysisImageChecksumSha256: "a".repeat(64),
    processingStatus: "retryable_failure",
    processingAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
function makeContext(source) {
  return {
    auth: { getUserIdentity: async () => null },
    db: {
      get: async (id) => id === source._id ? source : null,
      patch: async (id, patch) => {
        assert.equal(id, source._id);
        Object.assign(source, patch);
      },
      query: () => { throw new Error("Exact saved-post fence must not perform a global source scan."); },
    },
  };
}

function makeUpsertContext(source) {
  const context = makeContext(source);
  context.db.query = (table) => {
    let predicates = [];
    const query = {
      withIndex: (_name, build) => {
        const cursor = { eq: (field, value) => { predicates.push([field, value]); return cursor; } };
        build(cursor);
        return query;
      },
      unique: async () => {
        assert.equal(table, "instagramPaidFetchControl");
        return null;
      },
      take: async () => {
        assert.equal(table, "scrapedPosts", "A metadata-only update must never invalidate existing events or receipts.");
        return predicates.every(([field, value]) => source[field] === value) ? [source] : [];
      },
    };
    return query;
  };
  return context;
}

async function runCachedSourceCompletion(analysis, expectedStatus, currentPost = post) {
  const source = makeSource(analysis);
  Object.assign(source, currentPost);
  const originalJson = source.analysisResultJson;
  const context = makeContext(source);
  const receipt = {
    sourceIdentity: buildSourceOccurrenceIdentity(post),
    sourceFingerprint: buildSourceOccurrenceFingerprint(post),
    expectedKeys: ["cover-party-saturday"],
    satisfiedKeys: ["cover-party-saturday"],
    satisfiedOccurrences: [{ key: "cover-party-saturday", eventId: "existing-approved-cover-party" }],
    deferredChildCount: 0,
    deferredChildKeys: [],
  };
  const canonicalEvent = { _id: "existing-approved-cover-party", title: "Cover Party", date: "2026-10-17", status: "approved", savedBy: ["qa-user"] };
  const canonicalBefore = structuredClone(canonicalEvent);
  const receiptBefore = structuredClone(receipt);
  const summary = createEmptyHandleSummary(post.username);
  let recordedResults = 0;
  await processLoadedPostsForHandle({
    client: {
      query: async (name) => name === "events:getInstagramSourceOccurrenceReceipt" ? receipt : [],
      mutation: async (name, args) => {
        if (name === "scrapedPosts:claimProcessing") return claimProcessing._handler(context, args);
        if (name === "scrapedPosts:recordProcessingResult") {
          recordedResults += 1;
          return recordProcessingResult._handler(context, args);
        }
        throw new Error(`Cached source must never start new provider transport or mutate events: ${name}`);
      },
      action: async () => { throw new Error("Cached verified events must not replace their media."); },
    },
    handle: post.username,
    posts: [currentPost],
    summary,
    seenSourceKeys: [],
    canonicalVenueNamesByHandle: { qa_venue: "QA Venue" },
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: { qa_venue: "QA Venue" },
    sourceRolesByHandle: { qa_venue: "venue" },
    serviceSecret: process.env.CRON_SECRET,
    workOwner: "qa-coverage-owner",
    scrapedPostId: source._id,
    expectedSourceRevision: 1,
  });
  assert.equal(recordedResults, 1);
  assert.equal(source.processingStatus, expectedStatus);
  assert.equal(source.processingOutcome, expectedStatus === "completed" ? "receipt_complete" : "source_media_partial");
  assert.equal(source.analysisResultJson, originalJson, "Never rewrite already-attested raw analysis bytes.");
  assert.deepEqual(receipt, receiptBefore, "Known occurrence receipt proof remains valid.");
  assert.deepEqual(canonicalEvent, canonicalBefore, "Existing approved events and saved references remain untouched.");
  if (expectedStatus !== "completed") {
    assert.ok(source.processingRetryAt > Date.now(), "Partial source retries must be backoff-delayed.");
    assert.equal(source.blocksPaidFetch, false, "A partial source must not block unrelated fresh source fetches.");
  }
  return source;
}

try {
  const legacySaved = makeSource({ is_event: true, title: "Cover Party", date: "2026-10-17" });
  Object.assign(legacySaved, persistedManifest);
  delete legacySaved.imageSlides;
  delete legacySaved.imageSlideCount;
  const legacyRaw = legacySaved.analysisResultJson;
  const legacyContext = makeUpsertContext(legacySaved);
  const upsertArgs = {
    handle: post.username,
    posts: [persistedManifest],
    serviceSecret: process.env.CRON_SECRET,
  };
  assert.deepEqual(await upsertManyByHandle._handler(legacyContext, upsertArgs), [{
    scrapedPostId: legacySaved._id, postId: post.postId, sourceRevision: 1,
  }]);
  assert.deepEqual(legacySaved.imageSlides, post.imageSlides);
  assert.equal(legacySaved.imageSlideCount, 2);
  assert.equal(legacySaved.analysisRevision, 1);
  assert.equal(legacySaved.analysisResultJson, legacyRaw, "Manifest-only discovery must not rewrite a legacy cache or pay for another revision.");
  assert.equal(legacySaved.processingStatus, "retryable_failure");
  await assert.rejects(upsertManyByHandle._handler(legacyContext, {
    ...upsertArgs,
    posts: [{ ...persistedManifest, imageSlides: [{ index: 2, imageUrls: [COVER] }] }],
  }), /ordered slides/i);
  await assert.rejects(upsertManyByHandle._handler(legacyContext, {
    ...upsertArgs,
    posts: [{ ...persistedManifest, imageSlideCount: 1 }],
  }), /slide count is invalid/i);

  const completeSaved = makeSource(onceCompleteAnalysis);
  Object.assign(completeSaved, persistedManifest, {
    imageSlides: [post.imageSlides[0]], imageSlideCount: 1, imageUrls: [COVER],
    imageStorageId: "qa-retained-primary-storage", imageUrl: "https://storage.qa.local/cover-proof.jpg",
    processingStatus: "completed", processingOutcome: "receipt_complete",
  });
  const completeRaw = completeSaved.analysisResultJson;
  const completeContext = makeUpsertContext(completeSaved);
  await upsertManyByHandle._handler(completeContext, upsertArgs);
  assert.equal(completeSaved.processingStatus, "retryable_failure");
  assert.equal(completeSaved.processingOutcome, "source_media_partial");
  assert.equal(completeSaved.sourceRevision, 1);
  assert.equal(completeSaved.analysisResultJson, completeRaw);
  assert.equal(completeSaved.imageStorageId, "qa-retained-primary-storage");
  assert.equal(completeSaved.imageUrl, "https://storage.qa.local/cover-proof.jpg");
  const rotatingPost = {
    ...persistedManifest,
    imageUrl: `${COVER}?fresh=2`, imageUrls: [`${COVER}?fresh=2`, `${DETAIL}?fresh=2`],
    imageSlides: [{ index: 0, imageUrls: [`${COVER}?fresh=2`] }, { index: 1, imageUrls: [`${DETAIL}?fresh=2`] }],
  };
  await upsertManyByHandle._handler(completeContext, { ...upsertArgs, posts: [rotatingPost] });
  assert.equal(completeSaved.sourceRevision, 1, "Rotating signed URLs must not create another paid source revision for a valid future cache.");
  assert.equal(completeSaved.analysisRevision, 1);
  assert.equal(completeSaved.analysisResultJson, completeRaw);
  assert.ok(completeSaved.imageSlides[0].imageUrls.includes(COVER), "Keep the already-attested URL in conservative source observations.");
  const unknownPost = { ...rotatingPost };
  delete unknownPost.imageSlides;
  delete unknownPost.imageSlideCount;
  await upsertManyByHandle._handler(completeContext, { ...upsertArgs, posts: [unknownPost] });
  assert.equal(completeSaved.imageSlideCount, 2, "Unknown later provider metadata cannot erase observed siblings.");
  await upsertManyByHandle._handler(completeContext, { ...upsertArgs, posts: [{
    ...rotatingPost, imageSlides: [{ index: 0, imageUrls: [`${COVER}?fresh=2`] }], imageSlideCount: 1,
  }] });
  assert.equal(completeSaved.imageSlideCount, 2, "A truncated later manifest cannot certify fewer slides.");
  assert.equal(completeSaved.processingOutcome, "source_media_partial");
  Object.assign(completeSaved, { processingStatus: "completed", processingOutcome: "receipt_complete" });
  const reopened = await claimProcessing._handler(completeContext, {
    handle: completeSaved.handle, scrapedPostId: completeSaved._id, owner: "qa-reopen-owner",
    expectedSourceRevision: 1, serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(reopened.claimed, false);
  assert.equal(reopened.reason, "deferred");
  assert.equal(completeSaved.processingOutcome, "source_media_partial", "The terminal claim fence must detect a now-stale complete cache.");
  assert.equal(completeSaved.analysisResultJson, completeRaw);
  const completedLegacy = makeSource({ is_event: true, title: "Cover Party", date: "2026-10-17" });
  Object.assign(completedLegacy, persistedManifest, { processingStatus: "completed", processingOutcome: "receipt_complete" });
  delete completedLegacy.imageSlides;
  delete completedLegacy.imageSlideCount;
  await upsertManyByHandle._handler(makeUpsertContext(completedLegacy), upsertArgs);
  assert.equal(completedLegacy.processingStatus, "completed", "New manifests must not change legacy cached completion policy.");
  assert.equal((await claimProcessing._handler(makeContext(completedLegacy), {
    handle: completedLegacy.handle, scrapedPostId: completedLegacy._id, owner: "qa-legacy-owner",
    serviceSecret: process.env.CRON_SECRET,
  })).reason, "terminal");
  const staleCompletion = makeSource(onceCompleteAnalysis);
  Object.assign(staleCompletion, {
    processingStatus: "processing", processingLeaseOwner: "qa-current-manifest-owner",
    processingLeaseExpiresAt: Date.now() + 60_000,
  });
  await recordProcessingResult._handler(makeContext(staleCompletion), {
    handle: staleCompletion.handle, scrapedPostId: staleCompletion._id, owner: "qa-current-manifest-owner",
    sourceRevision: 1, status: "completed", outcome: "receipt_complete", serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(staleCompletion.processingOutcome, "source_media_partial", "Completion must independently recompute a cached one-slide result against the current two-slide manifest.");
  assert.equal(staleCompletion.analysisResultJson, JSON.stringify(onceCompleteAnalysis, null, 2));

  const originalInfo = console.info;
  console.info = () => {};
  try {
    await runCachedSourceCompletion(newAnalysis, "retryable_failure");
    await runCachedSourceCompletion(onceCompleteAnalysis, "retryable_failure");
    await runCachedSourceCompletion(onceCompleteAnalysis, "retryable_failure", {
      ...post, imageUrl: rotatingPost.imageUrl, imageUrls: rotatingPost.imageUrls,
      imageSlides: completeSaved.imageSlides, imageSlideCount: completeSaved.imageSlideCount,
    });
    const legacyAnalysis = { ...newAnalysis };
    delete legacyAnalysis._extractionPolicyVersion;
    delete legacyAnalysis._imageCoverage;
    await runCachedSourceCompletion(legacyAnalysis, "completed");
  } finally { console.info = originalInfo; }

  const pending = makeSource(newAnalysis);
  Object.assign(pending, {
    analysisRevision: undefined,
    analysisResultJson: undefined,
    processingStatus: "processing",
    processingLeaseOwner: "qa-analysis-owner",
    processingLeaseExpiresAt: Date.now() + 60_000,
    analysisAttemptRevision: 1,
    analysisAttemptOwner: "qa-analysis-owner",
  });
  const context = makeContext(pending);
  const args = {
    handle: pending.handle, scrapedPostId: pending._id, postId: pending.postId,
    instagramPostUrl: pending.instagramPostUrl,
    owner: "qa-analysis-owner", sourceRevision: 1,
    resultJson: JSON.stringify(newAnalysis), imageSourceUrl: COVER,
    imageChecksumSha256: "a".repeat(64), model: "gpt-6-luna", serviceSecret: process.env.CRON_SECRET,
  };
  assert.deepEqual(await recordOpenAiAnalysis._handler(context, args), { recorded: true, reason: "recorded" });
  const persisted = pending.analysisResultJson;
  await assert.rejects(recordOpenAiAnalysis._handler(context, {
    ...args,
    resultJson: JSON.stringify({ ...newAnalysis, _imageCoverage: { ...partialCoverage, complete: true } }),
  }), /coverage does not match/i, "A model/client claim cannot certify unread independent Sunday content.");
  assert.equal(pending.analysisResultJson, persisted);
  const withoutCoverage = { ...newAnalysis };
  delete withoutCoverage._imageCoverage;
  await assert.rejects(recordOpenAiAnalysis._handler(context, {
    ...args, resultJson: JSON.stringify(withoutCoverage),
  }), /requires source image coverage/i);
  await recordProcessingResult._handler(context, {
    handle: pending.handle, scrapedPostId: pending._id, postId: pending.postId,
    instagramPostUrl: pending.instagramPostUrl,
    owner: "qa-analysis-owner", sourceRevision: 1,
    status: "completed", outcome: "receipt_complete", serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(pending.processingOutcome, "source_media_partial", "The backend must independently refuse false whole-source completion.");
  Object.assign(pending, {
    processingStatus: "processing", processingLeaseOwner: "qa-analysis-owner",
    processingLeaseExpiresAt: Date.now() + 60_000,
  });
  await recordProcessingResult._handler(context, {
    handle: pending.handle, scrapedPostId: pending._id, owner: "qa-analysis-owner",
    sourceRevision: 1, status: "retryable_failure", outcome: "event_write_retry",
    error: "A separately reported event write needs retry.", serviceSecret: process.env.CRON_SECRET,
  });
  assert.equal(pending.processingOutcome, "event_write_retry", "Coverage diagnostics must not hide another persistence failure.");
  assert.match(pending.processingError, /event write needs retry/);
  console.log("Instagram image coverage QA passed: ordered slides vs alternatives, domain/persistence boundary, future-only partial source completion, cached zero-transport retries, receipt/event preservation and backend attestation guard.");
} finally {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
}
