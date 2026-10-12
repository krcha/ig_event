import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { claimCarouselImage, deleteOrphanedPage, findCarouselImage, findBySourceIdentity, refreshAndAttach, replaceMissingAndAttach, removeMissingAsset } from "../convex/mediaAssets.ts";
import { persistInstagramCarouselImage } from "../convex/mediaActions.ts";
import { recordOpenAiAnalysis } from "../convex/scrapedPosts.ts";
import { carouselAssetSourceKey, hasCarouselAnalysisMarker, hasPersistedCarouselEventMediaProof } from "../convex/internal/carouselMediaProof.ts";
import { buildInstagramCarouselImageCoverage } from "../lib/pipeline/instagram-image-coverage.ts";
import { assertPersistedServiceSourcePolicy } from "../convex/eventDomain/sourceApproval.ts";
import { hasEventEvidenceV2AutoApproval } from "../lib/events/event-update-precondition.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { isExistingEventEligibleForDurableMediaRetry } from "../lib/pipeline/ingestion/media-durability.ts";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.CRON_SECRET;
const originalNow = Date.now;
Date.now = () => Date.parse("2026-10-12T12:00:00.000Z");
process.env.CRON_SECRET = "qa-carousel-media-secret";
const urls = ["https://images.apifyusercontent.com/carousel-cover.jpg", "https://images.apifyusercontent.com/carousel-detail.jpg"];
const post = {
  _id: "qa-carousel-source", _creationTime: 1, handle: "qa_venue", username: "qa_venue",
  postId: "qa-carousel-post", instagramPostUrl: "https://www.instagram.com/p/qa_carousel/",
  caption: "Sunday 18 October: Independent Workshop", postedAt: "2026-10-01T12:00:00.000Z",
  imageUrls: urls, imageSlides: urls.map((url, index) => ({ index, imageUrls: [url] })), imageSlideCount: 2,
  sourceRevision: 1, processingStatus: "processing", processingLeaseOwner: "qa-owner",
  processingLeaseExpiresAt: Date.now() + 60_000, analysisAttemptRevision: 1, analysisAttemptOwner: "qa-owner",
  createdAt: 1, updatedAt: 1,
};
const fence = { handle: post.handle, scrapedPostId: post._id, postId: post.postId,
  instagramPostUrl: post.instagramPostUrl, owner: "qa-owner", sourceRevision: 1 };
const legacyAsset = { _id: "qa-legacy-asset", sourceKey: `instagram-post:${post.postId}`, instagramPostId: post.postId,
  storageId: "qa-legacy-storage", url: "https://stored.test/legacy.jpg", checksumSha256: "c".repeat(64) };
const existingEvent = { _id: "qa-existing-approved-event", instagramPostId: post.postId, instagramPostUrl: post.instagramPostUrl,
  imageStorageId: legacyAsset.storageId, imageUrl: legacyAsset.url, status: "approved", savedBy: ["qa-user"], updatedAt: 1 };
const existingBefore = structuredClone(existingEvent);
const tables = { scrapedPosts: [post], events: [existingEvent], mediaAssets: [legacyAsset] };
const storage = new Map([[legacyAsset.storageId, legacyAsset.url]]);
const writes = [];
let nextId = 0;
const context = {
  auth: { getUserIdentity: async () => null },
  storage: {
    getUrl: async (id) => storage.get(id) ?? null,
    store: async (blob) => { assert.ok(blob.size > 0); const id = `qa-stored-${++nextId}`; storage.set(id, `https://stored.test/${id}`); return id; },
    delete: async (id) => { storage.delete(id); },
  },
  db: {
    get: async (id) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
    insert: async (table, fields) => {
      assert.equal(table, "mediaAssets", "Retaining a future input must never insert events or audit historical events.");
      const row = { ...fields, _id: `qa-asset-${++nextId}` }; (tables[table] ??= []).push(row); writes.push(["insert", table]); return row._id;
    },
    patch: async (id, patch) => {
      assert.equal(id, post._id, "Fresh analysis may only patch its fenced source, never an existing event.");
      Object.assign(post, patch); writes.push(["patch", id]);
    },
    delete: async () => { throw new Error("Active carousel proof QA must not delete persisted records."); },
    query: (table) => {
      const predicates = [];
      const rows = () => (tables[table] ?? []).filter((row) => predicates.every(([key, value]) => row[key] === value));
      const query = {
        withIndex: (_name, build) => {
          const cursor = { eq: (key, value) => { predicates.push([key, value]); return cursor; }, lt: () => cursor };
          build(cursor); return query;
        },
        take: async (limit) => rows().slice(0, limit),
        first: async () => rows()[0] ?? null,
        unique: async () => { const values = rows(); assert.ok(values.length <= 1); return values[0] ?? null; },
        paginate: async () => ({ page: rows().slice(-1), isDone: true, continueCursor: "" }),
      };
      return query;
    },
  },
};
context.runQuery = async (name, args) => {
  assert.equal(name, "mediaAssets:findCarouselImage"); return findCarouselImage._handler(context, args);
};
context.runMutation = async (name, args) => {
  assert.equal(name, "mediaAssets:claimCarouselImage"); return claimCarouselImage._handler(context, args);
};

try {
  let fetches = 0;
  const bytes = new TextEncoder().encode("retained exact model raster bytes");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  globalThis.fetch = async (url, options) => {
    fetches += 1; assert.ok(urls.includes(String(url))); assert.equal(options.method, "GET");
    return new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
  };
  const receipts = [];
  for (let slideIndex = 0; slideIndex < 2; slideIndex += 1) {
    const args = { postId: post.postId, instagramPostUrl: post.instagramPostUrl, processingFence: fence,
      slideIndex, upstreamUrl: urls[slideIndex], expectedChecksumSha256: checksum, serviceSecret: process.env.CRON_SECRET };
    const result = await persistInstagramCarouselImage._handler(context, args);
    assert.equal(result.reused, false);
    receipts.push({ ...result, sourceUrl: urls[slideIndex] });
  }
  assert.equal(fetches, 2, "Each distinct submitted slide has an independently retained asset.");
  assert.deepEqual(existingEvent, existingBefore, "Retaining sibling inputs must preserve every existing event field.");
  assert.equal(post.imageStorageId, undefined, "Carousel retention must not attach a legacy source-wide image.");
  assert.equal((await findBySourceIdentity._handler(context, { postId: post.postId, instagramPostUrl: post.instagramPostUrl }))._id,
    legacyAsset._id, "Legacy source identity must remain unambiguous after adding multiple carousel assets.");
  const images = receipts.map(({ slideIndex, sourceUrl, checksumSha256 }) => ({ slideIndex, sourceUrl, checksumSha256 }));
  const row = { source_slide_indexes: [1], source_text: "Sunday 18 October: Workshop", date_evidence: { source: "poster", slide_index: 1 },
    time_evidence: { source: "poster", slide_index: 1 }, poster_evidence: [{ slide_index: 1, text: "Sunday 18 October: Workshop" }], text_evidence: [] };
  const analysis = { extraction_contract_version: "event_evidence_v2", _extractionPolicyVersion: "event_quality_v1",
    _carouselContractVersion: "carousel_evidence_v1", _carouselMedia: { version: 1, knownSlideCount: 2, images },
    _imageCoverage: buildInstagramCarouselImageCoverage(post, images), is_event: true, non_event_reason: "", schedule_entries: [row] };
  const args = { ...fence, resultJson: JSON.stringify(analysis, null, 2), imageSourceUrl: urls[0], imageChecksumSha256: checksum,
    carouselImages: receipts.map(({ slideIndex, sourceUrl, checksumSha256, assetId, storageId, url }) =>
      ({ slideIndex, sourceUrl, checksumSha256, assetId, storageId, url })), model: "gpt-6-luna", serviceSecret: process.env.CRON_SECRET };
  await assert.rejects(recordOpenAiAnalysis._handler(context, { ...args, carouselImages: args.carouselImages.slice(0, 1) }), /retained input bundle/i);
  const missing = storage.get(receipts[0].storageId); storage.delete(receipts[0].storageId);
  await assert.rejects(recordOpenAiAnalysis._handler(context, args), /not independently retained/i, "Even an unreferenced cover input must exist before cache attestation.");
  storage.set(receipts[0].storageId, missing);
  assert.deepEqual(await recordOpenAiAnalysis._handler(context, args), { recorded: true, reason: "recorded" });
  assert.deepEqual(post.analysisCarouselImages, args.carouselImages);
  const savedBytes = post.analysisResultJson;
  assert.deepEqual(await recordOpenAiAnalysis._handler(context, args), { recorded: false, reason: "already_recorded" });
  assert.equal(post.analysisResultJson, savedBytes, "The same-revision cache remains immutable.");
  await assert.rejects(recordOpenAiAnalysis._handler(context, { ...args,
    resultJson: JSON.stringify({ ...analysis, _carouselContractVersion: "unknown_future_contract" }),
  }), /retained input bundle/i);
  post.imageSlides[0].mediaType = "video";
  await assert.rejects(recordOpenAiAnalysis._handler(context, args), /coverage does not match/i,
    "A retained video thumbnail must never self-certify full-video coverage.");
  delete post.imageSlides[0].mediaType;
  const fields = { extractionCarouselContractVersion: "carousel_evidence_v1", carouselSourceSlideIndexes: [1],
    carouselSourceRowIndexes: [0], carouselDisplaySlideIndex: 1 };
  const candidate = { rawExtractionJson: args.resultJson, normalizedFieldsJson: JSON.stringify(fields),
    imageStorageId: receipts[1].storageId, imageUrl: receipts[1].url };
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, candidate), true);
  const publicFields = {
    title: "Independent Workshop", date: "2026-10-18", venue: "KC Grad", artists: [], time: "TBD",
    timeSource: "poster", timeEvidenceText: "", timeConfidence: 0, timeStatus: "unknown", timeEvidenceKind: "not_stated",
    dateEvidenceText: "18 October", dateEvidenceSource: "poster", dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: "2026-10-18", sourceConflictFields: [], sourceCaption: post.caption, sourcePostedAt: post.postedAt,
    instagramPostId: post.postId, instagramPostUrl: post.instagramPostUrl,
  };
  const approvalFields = {
    ...fields, ...publicFields, normalizedDate: publicFields.date, normalizedVenue: publicFields.venue,
    extractionContractVersion: "event_evidence_v2", extractionIsEvent: true, extractionNonEventReason: "",
    extractionMode: "poster", sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
    dateEvidenceVerified: true, timeEvidenceVerified: true, identityEvidenceVerified: true, venueEvidenceVerified: true,
    structuredEvidenceVerified: true, extractionSourceConflicts: [], extractionSourceConflictCount: 0,
    approvalTitleSensible: true, normalizedIsValid: true, titleUsedFallback: false, dateSuspiciousYear: false,
    moderationAutoApproved: true, moderationAutoApproveRule: "event_evidence_v2", moderationPendingReasons: [],
    sourceGroundingInstagramHandle: post.handle, sourceGroundingInstagramPostId: post.postId,
    sourceGroundingInstagramPostUrl: post.instagramPostUrl, sourceGroundingSourceCaption: post.caption,
  };
  const approvedCandidate = { ...candidate, ...publicFields, _id: "qa-new-carousel-event", status: "approved", normalizedFieldsJson: JSON.stringify(approvalFields) };
  assert.equal(hasEventEvidenceV2AutoApproval(approvedCandidate.normalizedFieldsJson, approvedCandidate), true);
  await assertPersistedServiceSourcePolicy(context, approvedCandidate);
  assert.equal(await isCanonicallyGroundedApprovedEvent(context, approvedCandidate), true);
  storage.delete(receipts[0].storageId);
  await assert.rejects(assertPersistedServiceSourcePolicy(context, approvedCandidate), /current persisted/i,
    "The actual service approval entry point rejects a missing unselected input.");
  assert.equal(await isCanonicallyGroundedApprovedEvent(context, approvedCandidate), false,
    "The actual public grounding entry point repeats the all-input retained proof.");
  storage.set(receipts[0].storageId, missing);
  const recordedReceipts = post.analysisCarouselImages; delete post.analysisCarouselImages;
  assert.equal(hasCarouselAnalysisMarker(post, candidate), true);
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, candidate), false,
    "A missing immutable bundle must never fall through to legacy proof.");
  post.analysisCarouselImages = recordedReceipts;
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, { ...candidate, imageStorageId: receipts[0].storageId, imageUrl: receipts[0].url }), false,
    "An independently dated sibling must display its own retained poster.");
  for (const bad of [
    { carouselDisplaySlideIndex: 0 }, { carouselSourceSlideIndexes: [0] }, { carouselSourceRowIndexes: [1] },
  ]) assert.equal(await hasPersistedCarouselEventMediaProof(context, post, { ...candidate, normalizedFieldsJson: JSON.stringify({ ...fields, ...bad }) }), false);
  storage.delete(receipts[0].storageId);
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, candidate), false, "Approval verifies every model input, including the unselected cover.");
  storage.set(receipts[0].storageId, missing);
  const asset = tables.mediaAssets.find((item) => item._id === receipts[1].assetId);
  const oldChecksum = asset.checksumSha256; asset.checksumSha256 = "b".repeat(64);
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, candidate), false); asset.checksumSha256 = oldChecksum;
  const originalManifest = structuredClone(post.imageSlides);
  post.imageSlides = post.imageSlides.map((slide) => ({ ...slide, imageUrls: [`${urls[slide.index]}?rotated=1`] }));
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, candidate), true, "Immutable attested inputs survive harmless CDN rotation.");
  globalThis.fetch = async () => { throw new Error("Cached replay must never fetch expired CDN media or call paid providers."); };
  for (const receipt of receipts) {
    assert.equal((await persistInstagramCarouselImage._handler(context, {
      postId: post.postId, instagramPostUrl: post.instagramPostUrl, processingFence: fence, slideIndex: receipt.slideIndex,
      upstreamUrl: receipt.sourceUrl, expectedChecksumSha256: receipt.checksumSha256, serviceSecret: process.env.CRON_SECRET,
    })).reused, true);
  }
  assert.deepEqual(existingEvent, existingBefore);
  post.imageSlides = originalManifest;
  await assert.rejects(findCarouselImage._handler(context, {
    postId: post.postId, processingFence: { ...fence, sourceRevision: 2 }, slideIndex: 1, sourceUrl: urls[1], expectedChecksumSha256: checksum, checkedAt: Date.now(),
  }), /stale/i);
  await assert.rejects(persistInstagramCarouselImage._handler(context, {
    postId: post.postId, processingFence: { ...fence, owner: "another-owner" }, slideIndex: 1,
    upstreamUrl: urls[1], expectedChecksumSha256: checksum, serviceSecret: process.env.CRON_SECRET,
  }), /stale/i, "An old worker must not claim or fetch another owner's source inputs.");
  assert.equal(await hasPersistedCarouselEventMediaProof(context, post, { ...candidate, rawExtractionJson: `${candidate.rawExtractionJson}\n` }), false,
    "Raw cache bytes remain part of the proof.");
  const key0 = carouselAssetSourceKey(post._id, 1, 0, checksum, urls[0]), key1 = carouselAssetSourceKey(post._id, 1, 1, checksum, urls[1]);
  assert.notEqual(key0, key1, "Identical slide bytes retain distinct caller-attested indexes.");
  assert.notEqual(key0, carouselAssetSourceKey(post._id, 1, 0, checksum, `${urls[0]}?refreshed=1`),
    "A refreshed same-content URL cannot collide with an immutable input retained before an unsent analysis.");
  assert.ok(writes.every(([kind, id]) => kind === "insert" && id === "mediaAssets" || kind === "patch" && id === post._id));
  assert.equal(isExistingEventEligibleForDurableMediaRetry({ ...approvedCandidate, imageStorageId: undefined }), false,
    "A missing carousel display image must never enter the old source-wide repair path.");
  assert.equal(isExistingEventEligibleForDurableMediaRetry({ imageStorageId: undefined,
    normalizedFieldsJson: JSON.stringify({ ...approvalFields, extractionCarouselContractVersion: undefined }) }), true,
    "Existing single-image repair eligibility remains unchanged.");
  const inputAsset = tables.mediaAssets.find((item) => item._id === receipts[1].assetId);
  const protectedArgs = { postId: post.postId, instagramPostUrl: post.instagramPostUrl,
    assetId: inputAsset._id, storageId: inputAsset.storageId, expectedStorageId: inputAsset.storageId,
    url: inputAsset.url, actor: "qa", processingFence: fence };
  await assert.rejects(refreshAndAttach._handler(context, protectedArgs), /cannot be refreshed/i);
  await assert.rejects(replaceMissingAndAttach._handler(context, protectedArgs), /cannot be replaced/i);
  await assert.rejects(removeMissingAsset._handler(context, protectedArgs), /cannot be removed/i);
  const beforeRepairPost = structuredClone(post);
  const beforeRepairEvent = structuredClone(approvedCandidate);
  const priorPatch = context.db.patch;
  const priorRepairEvents = tables.events; tables.events = [approvedCandidate];
  context.db.patch = async (id) => assert.equal(id, legacyAsset._id,
    "Even a direct legacy repair may not patch a carousel event or its attested source.");
  await assert.rejects(refreshAndAttach._handler(context, { ...protectedArgs,
    assetId: legacyAsset._id, storageId: legacyAsset.storageId, url: legacyAsset.url }), /independently retained slide bindings/i);
  assert.deepEqual(post, beforeRepairPost);
  assert.deepEqual(approvedCandidate, beforeRepairEvent);
  const priorDelete = context.db.delete;
  const removedLegacyAssets = [];
  context.db.delete = async (id) => {
    assert.equal(id, legacyAsset._id, "Maintenance may only remove the missing legacy asset, never immutable carousel inputs.");
    removedLegacyAssets.push(id);
  };
  for (const companionPatch of [
    { normalizedFieldsJson: "{" },
    { rawExtractionJson: "{" },
  ]) {
    const damagedCompanionEvent = { ...approvedCandidate, ...companionPatch };
    const beforeDamagedEvent = structuredClone(damagedCompanionEvent);
    tables.events = [damagedCompanionEvent];
    assert.equal(hasCarouselAnalysisMarker({ analysisCarouselImages: undefined }, damagedCompanionEvent), true,
      "A damaged companion JSON must not suppress an independently valid carousel marker.");
    await assert.rejects(refreshAndAttach._handler(context, { ...protectedArgs,
      assetId: legacyAsset._id, storageId: legacyAsset.storageId, url: legacyAsset.url }), /independently retained slide bindings/i);
    assert.equal(await removeMissingAsset._handler(context, { ...protectedArgs,
      assetId: legacyAsset._id, expectedStorageId: legacyAsset.storageId }), true);
    assert.deepEqual(damagedCompanionEvent, beforeDamagedEvent,
      "Legacy refresh and missing-image maintenance must preserve carousel events with damaged companion JSON.");
    assert.deepEqual(post, beforeRepairPost);
  }
  assert.deepEqual(removedLegacyAssets, [legacyAsset._id, legacyAsset._id]);
  context.db.delete = priorDelete;
  tables.events = priorRepairEvents; context.db.patch = priorPatch;
  // No receipt or event need exist yet: a currently processing owner protects
  // its non-display sibling from the real retention handler.
  const priorEvents = tables.events; tables.events = [];
  const result = await deleteOrphanedPage._handler(context, { cutoffUpdatedAt: Date.now() + 1, paginationOpts: { numItems: 1, cursor: null } });
  assert.equal(result.retainedAssetCount, 1); assert.equal(result.deletedAssetCount, 0); tables.events = priorEvents;
  console.log("Carousel media proof QA passed: independent retained inputs, immutable source/slide checksums, correct poster selection, all-input approval, zero-fetch cached replay, legacy image/event preservation and retention.");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}
