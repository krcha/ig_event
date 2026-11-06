import assert from "node:assert/strict";
import { drugstoreHarness } from "./qa-reviewed-drugstore-november-operator.mjs";
import { getContext, admitCachedRetry, LIKA_CACHED_RECEIPT_REVIEW as review } from "../convex/reviewedLikaCachedReceiptRecovery.ts";
import { claimProcessing, recordProcessingResult } from "../convex/scrapedPosts.ts";
import { recordInstagramSourceOccurrenceSatisfaction } from "../convex/events.ts";
import { sha256Hex } from "../lib/domain/reconciliation/evidence-digest.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { buildEventOccurrenceIndexPatch } from "../convex/sourceOccurrences.ts";
import { carouselAssetSourceKey } from "../convex/internal/carouselMediaProof.ts";

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const secret = "qa-lika-cached-retry-secret";
const originalSecret = process.env.CRON_SECRET;
const originalNow = Date.now;
const pinned = structuredClone(review);
process.env.CRON_SECRET = secret;
Date.now = () => Date.parse("2026-11-06T14:00:00.000Z");

// Real production payloads stay private. Only evidence digests are replaced in
// this local test process; the production module has no caller-supplied pins.
function fixture(partial = false) {
  const seed = { events: [], venues: [], scrapedPosts: [], sourceOccurrences: [], instagramEventSources: [],
    instagramSourceOccurrenceReceipts: [], mediaAssets: [], savedEvents: [], userSavedEvents: [], eventAuditLog: [] };
  const venue = { _id: review.venueId, _creationTime: 1, name: "KC Elektropionir", instagramHandle: review.venueHandle,
    publicStatus: "published", isActive: true, createdAt: 1, updatedAt: 1 };
  seed.venues.push(venue);
  const caption = "Synthetic seven-row cached venue schedule.";
  const images = [0, 1].map(slideIndex => ({ slideIndex, sourceUrl: `https://example.com/slide-${slideIndex}.jpg`, checksumSha256: String(slideIndex + 1).repeat(64),
    assetId: `qa-lika-asset-${slideIndex}`, storageId: `qa-lika-storage-${slideIndex}`, url: `https://example.com/stored-${slideIndex}.jpg` }));
  const source = { _id: review.sourceId, _creationTime: 1, handle: review.handle, username: review.handle, postId: review.postId,
    instagramPostUrl: review.url, caption, sourceRevision: 1, analysisRevision: 1, analysisAttemptRevision: 1,
    analysisAttemptStartedAt: 1, analysisCompletedAt: 2, analysisContractVersion: "event_evidence_v2", analysisModel: "gpt-6-luna",
    analysisIsEvent: true, imageSlideCount: partial ? 3 : 2,
    imageSlides: [0, 1, ...(partial ? [2] : [])].map(index => ({ index, imageUrls: [`https://example.com/slide-${index}.jpg`] })),
    analysisCarouselImages: images, imageUrls: [], processingStatus: "retryable_failure", processingOutcome: "incomplete_occurrence_receipt",
    processingRetryAt: Date.now() + 3600000, processingAttempts: 6, blocksPaidFetch: false, createdAt: 1, updatedAt: 1 };
  source.analysisResultJson = JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true,
    _extractionPolicyVersion: "event_quality_v1", _carouselContractVersion: "carousel_evidence_v1",
    _carouselMedia: { version: 1, knownSlideCount: source.imageSlideCount, images: images.map(({ slideIndex, sourceUrl, checksumSha256 }) => ({ slideIndex, sourceUrl, checksumSha256 })) },
    _imageCoverage: { version: 1, knownSlideCount: source.imageSlideCount, analyzedSlideIndexes: [0, 1], unanalyzedSlideIndexes: partial ? [2] : [], complete: !partial, manifestKnown: true } });
  seed.scrapedPosts.push(source);
  for (const image of images) seed.mediaAssets.push({ _id: image.assetId, _creationTime: 1, sourceKind: "instagram_post",
    sourceKey: carouselAssetSourceKey(source._id, 1, image.slideIndex, image.checksumSha256, image.sourceUrl),
    carouselSourceDocumentId: source._id, carouselSourceRevision: 1, carouselSlideIndex: image.slideIndex,
    carouselSourceUrl: image.sourceUrl, checksumSha256: image.checksumSha256, storageId: image.storageId, url: image.url });
  const original = { _id: "qa-lika-original-source", _creationTime: 1, handle: review.venueHandle, username: review.venueHandle, postId: "4008677139967700697",
    instagramPostUrl: "https://www.instagram.com/p/Dehrp6zAO7Z/", caption: "Lika Kolorado 5 December 2026 21:00 KC Elektropionir.",
    postedAt: "2026-10-15T12:00:00.000Z",
    sourceRevision: 1, analysisRevision: 1, analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna",
    imageUrls: [], createdAt: 1, updatedAt: 1 };
  original.analysisResultJson = JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true,
    source_url: original.instagramPostUrl, source_caption: original.caption });
  seed.scrapedPosts.push(original);
  const originalKey = "qa-lika-original-key";
  const fingerprint = buildInstagramSourceOccurrenceFingerprint({ caption: original.caption });
  const fields = { title: "Lika Kolorado", time: "21:00", artists: ["Lika Kolorado"], normalizedDate: "2026-12-05", normalizedVenue: venue.name,
    extractionMode: "caption", extractionContractVersion: "event_evidence_v2", extractionIsEvent: true, sourceGroundingVersion: 5,
    sourceGroundingEvidence: "persisted_openai_event_evidence_v2", normalizedIsValid: true, dateSuspiciousYear: false,
    dateEvidenceVerified: true, dateEvidenceResolvedDate: "2026-12-05", sourceGroundingSourceCaption: original.caption,
    sourceGroundingInstagramPostId: original.postId, sourceGroundingInstagramPostUrl: original.instagramPostUrl,
    sourceGroundingInstagramHandle: original.handle, sourceOccurrenceKey: originalKey, sourceOccurrenceSourceFingerprint: fingerprint,
    humanReviewedStructuredSourcePolicyVersion: 1 };
  const lika = { _id: review.likaId, _creationTime: 1, title: "Lika Kolorado", date: "2026-12-05", time: "21:00", venue: venue.name, venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle, artists: ["Lika Kolorado"], eventType: "live music", status: "approved", description: "Retained description.",
    sourceCaption: original.caption, sourcePostedAt: original.postedAt, instagramPostId: original.postId, instagramPostUrl: original.instagramPostUrl,
    sourceOccurrenceKey: originalKey, rawExtractionJson: original.analysisResultJson, normalizedFieldsJson: JSON.stringify(fields),
    humanReviewedStructuredSourcePolicyVersion: 1, reviewedAt: 1, reviewedBy: "qa-reviewer", moderationNote: "Exact source-reviewed event correction.", createdAt: 1, updatedAt: 1 };
  Object.assign(lika, buildEventOccurrenceIndexPatch(lika)); seed.events.push(lika);
  seed.instagramEventSources.push({ _id: review.originalLinkId, _creationTime: 1, eventId: lika._id, sourceIdentity: "qa-original-source-identity",
    sourceFingerprint: fingerprint, sourceOccurrenceKey: originalKey, sourceOccurrenceId: "qa-original-occurrence", sourceHandle: original.handle,
    instagramPostId: original.postId, instagramPostUrl: original.instagramPostUrl, createdAt: 1, updatedAt: 1 });
  seed.instagramSourceOccurrenceReceipts.push({ _id: "qa-original-receipt", sourceIdentity: "qa-original-source-identity", sourceFingerprint: fingerprint,
    expectedKeys: [originalKey], satisfiedKeys: [originalKey], expectedOccurrences: [{ key: originalKey, title: lika.title, date: lika.date, time: lika.time, venue: lika.venue, artists: lika.artists }],
    satisfiedOccurrences: [{ key: originalKey, eventId: lika._id }], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 });
  seed.sourceOccurrences.push({ _id: "qa-original-occurrence", sourceIdentity: "qa-original-source-identity", sourceFingerprint: fingerprint,
    sourceOccurrenceKey: originalKey, canonicalEventId: lika._id, state: "satisfied", sourceDocumentId: original._id, sourceRevision: 1,
    provider: "instagram", canonicalSourceUrl: original.instagramPostUrl, venueId: venue._id, venueResolutionStatus: "resolved",
    factsJson: "{}", canonicalEventJson: "{}", normalizedOccurrenceJson: "{}", createdAt: 1, updatedAt: 1 });
  const receipt = { _id: review.receiptId, sourceIdentity: review.sourceIdentity, sourceFingerprint: review.fingerprint,
    expectedKeys: [], expectedOccurrences: [], satisfiedKeys: [], satisfiedOccurrences: [], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 };
  for (const [index, pin] of review.occurrences.entries()) {
    const [id, suffix, eventId] = pin; const key = `instagram-occurrence-v2:${suffix}`;
    const expected = { key, title: eventId ? `Independent programme ${index}` : lika.title, date: eventId ? "2026-12-04" : lika.date,
      time: "21:00", venue: venue.name, artists: eventId ? [] : [...lika.artists], factsJson: JSON.stringify({ localDate: eventId ? "2026-12-04" : lika.date, titleClaim: eventId ? `Independent programme ${index}` : lika.title, artistClaims: eventId ? [] : lika.artists }), canonicalEventJson: JSON.stringify({ retainedCanonicalRow: index }) };
    expected.factsJson = JSON.stringify({ ...JSON.parse(expected.factsJson), venueClaim: expected.venue, startTime: expected.time,
      eventTypeClaim: "live music", timeRelation: "exact", evidence: [], policy: { approvalDisposition: "pending", pendingReasons: [], signals: [], structuredEvidenceVerified: true } });
    expected.canonicalEventJson = JSON.stringify({ normalizedFieldsJson: JSON.stringify({ title: expected.title,
      normalizedDate: expected.date, normalizedVenue: expected.venue, time: expected.time, artists: expected.artists }),
      requestedStatus: "pending", sourceConflictFields: [], time: expected.time, timeConfidence: .95, timeSource: "poster", timeStatus: "confirmed" });
    pin[3] = sha256Hex(expected.factsJson); pin[4] = sha256Hex(expected.canonicalEventJson);
    receipt.expectedKeys.push(key); receipt.expectedOccurrences.push(expected);
    seed.sourceOccurrences.push({ _id: id, provider: "instagram", sourceDocumentId: source._id, sourceIdentity: review.sourceIdentity,
      canonicalSourceUrl: review.url, sourceFingerprint: review.fingerprint, sourceRevision: 1, sourceOccurrenceKey: key,
      occurrenceOrdinal: index, factsJson: expected.factsJson, canonicalEventJson: expected.canonicalEventJson, normalizedOccurrenceJson: "{}",
      venueId: venue._id, venueResolutionStatus: "resolved", ...(eventId ? { canonicalEventId: eventId } : {}),
      state: eventId ? "satisfied" : "expected", createdAt: 1, updatedAt: 1 });
    if (eventId) {
      const event = { _id: eventId, _creationTime: 1, title: expected.title, date: expected.date, time: expected.time, venue: expected.venue,
        artists: [], status: "pending", eventType: "live music", createdAt: 1, updatedAt: 1 };
      seed.events.push(event); receipt.satisfiedKeys.push(key); receipt.satisfiedOccurrences.push({ key, eventId });
      seed.instagramEventSources.push({ _id: `qa-retained-link-${index}`, eventId, sourceIdentity: review.sourceIdentity, sourceFingerprint: review.fingerprint,
        sourceOccurrenceKey: key, sourceOccurrenceId: id, instagramPostId: source.postId, instagramPostUrl: source.instagramPostUrl, sourceHandle: source.handle, createdAt: 1, updatedAt: 1 });
    }
  }
  seed.instagramSourceOccurrenceReceipts.push(receipt);
  review.analysisSha256 = sha256Hex(source.analysisResultJson); review.captionSha256 = sha256Hex(caption); review.expectedBindingsSha256 = sha256Hex(stable(receipt.expectedOccurrences));
  const h = drugstoreHarness(seed); h.ctx.storage = { getUrl: async () => "https://example.com/retained" };
  return { seed, h, source, receipt, lika };
}

try {
  for (const damage of [
    h => { h.tables.get("scrapedPosts").get(review.sourceId).handle = "unreviewed"; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).analysisResultJson += " "; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).analysisModel = "unreviewed-model"; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).analysisIsEvent = false; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).sourceRevision = 2; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).processingLeaseOwner = "another-worker"; },
    h => { h.tables.get("scrapedPosts").get(review.sourceId).analysisCompletedAt = 0; },
    h => { h.tables.get("events").get(review.likaId).time = "22:00"; },
    h => { h.tables.get("instagramSourceOccurrenceReceipts").get(review.receiptId).satisfiedKeys.pop(); },
    h => { h.tables.get("sourceOccurrences").get(review.occurrences[0][0]).factsJson = "changed"; },
    h => { h.tables.get("events").get(review.occurrences[0][2]).artists = ["Different act"]; },
  ]) {
    const { h } = fixture(); const valid = await getContext._handler(h.ctx, { serviceSecret: secret });
    const before = h.snapshot(); damage(h); const damaged = h.snapshot();
    const changedContext = structuredClone(valid.context);
    for (const field of ["source", "lika", "receipt", "venue"]) changedContext[field] = await h.db.get(changedContext[field]._id);
    for (const field of ["occurrences", "siblings", "links", "likaLinks", "admissions"]) changedContext[field] = await Promise.all(changedContext[field].map(row => h.db.get(row._id)));
    // A fresh digest must not mask a missing semantic/model/lease guard.
    const freshDigest = sha256Hex(stable(changedContext));
    await assert.rejects(() => h.transaction(admitCachedRetry._handler, { serviceSecret: secret, expectedContextSha256: freshDigest, moderationNote: "Exact reviewed cached-only source admission." }));
    assert.deepEqual(h.snapshot(), damaged, "Rejected admission performs zero writes."); assert.notDeepEqual(damaged, before);
  }
  for (const partial of [false, true]) {
    const { seed, h, source, receipt, lika } = fixture(partial);
    const context = await getContext._handler(h.ctx, { serviceSecret: secret });
    const unchanged = h.snapshot();
    await assert.rejects(() => h.transaction(admitCachedRetry._handler, { serviceSecret: "wrong", expectedContextSha256: context.contextSha256, moderationNote: "Exact reviewed cached-only source admission." }));
    await assert.rejects(() => h.transaction(admitCachedRetry._handler, { serviceSecret: secret, expectedContextSha256: "0".repeat(64), moderationNote: "Exact reviewed cached-only source admission." }), /context changed/u);
    assert.deepEqual(h.snapshot(), unchanged);
    const eventVersion = lika.updatedAt;
    await h.transaction(admitCachedRetry._handler, { serviceSecret: secret, expectedContextSha256: context.contextSha256, moderationNote: "Exact reviewed cached-only source admission." });
    const admittedSource = await h.db.get(source._id); const expectedSource = { ...source }; delete expectedSource.processingRetryAt;
    assert.deepEqual(admittedSource, expectedSource); assert.equal((await h.db.get(lika._id)).updatedAt, eventVersion);
    await assert.rejects(() => h.transaction(admitCachedRetry._handler, { serviceSecret: secret, expectedContextSha256: context.contextSha256, moderationNote: "Exact reviewed cached-only source admission." }), /already admitted/u);
    const owner = "qa-manual-cached-retry";
    const claim = await h.transaction(claimProcessing._handler, { handle: source.handle, scrapedPostId: source._id, expectedSourceRevision: 1, owner, serviceSecret: secret });
    assert.equal(claim.claimed, true); assert.equal(claim.analysisResultJson, source.analysisResultJson);
    const plan = { sourceIdentity: receipt.sourceIdentity, sourceFingerprint: receipt.sourceFingerprint, previousSourceFingerprint: receipt.sourceFingerprint,
      expectedKeys: receipt.expectedKeys, expectedOccurrences: receipt.expectedOccurrences, deferredChildCount: 0, deferredChildKeys: [], observedChildKeys: receipt.expectedKeys };
    await h.transaction(recordInstagramSourceOccurrenceSatisfaction._handler, { plan, satisfiedKey: review.orphanKey, representativeEventId: lika._id,
      processingFence: { handle: source.handle, scrapedPostId: source._id, owner, sourceRevision: 1 }, serviceSecret: secret });
    const finished = await h.db.get(receipt._id);
    assert.equal(finished.satisfiedKeys.length, 7); assert.equal(finished.satisfiedOccurrences.find(s => s.key === review.orphanKey).eventId, lika._id);
    for (const retained of receipt.satisfiedOccurrences) assert.deepEqual(finished.satisfiedOccurrences.find(s => s.key === retained.key), retained);
    const coreEvent = event => Object.fromEntries(Object.entries(event).filter(([key]) => !key.startsWith("publication")));
    for (const event of seed.events) assert.deepEqual(coreEvent(await h.db.get(event._id)), coreEvent(event));
    for (const occurrence of seed.sourceOccurrences) {
      const after = await h.db.get(occurrence._id);
      assert.equal(after.factsJson, occurrence.factsJson); assert.equal(after.canonicalEventJson, occurrence.canonicalEventJson);
    }
    await h.transaction(recordProcessingResult._handler, { handle: source.handle, scrapedPostId: source._id, owner, sourceRevision: 1,
      status: "completed", outcome: "receipt_complete", serviceSecret: secret });
    const completed = await h.db.get(source._id);
    assert.equal(completed.processingStatus, partial ? "retryable_failure" : "completed");
    assert.equal(completed.processingOutcome, partial ? "source_media_partial" : "receipt_complete");
    assert.equal(completed.analysisResultJson, source.analysisResultJson); assert.equal(completed.sourceRevision, 1);
    assert.deepEqual(completed.analysisCarouselImages, source.analysisCarouselImages);
  }
  console.log("Reviewed Lika cached receipt recovery passed: frozen source/analysis/receipt guards, stale and leased zero-write rejection, admission-only metadata change, ordinary fenced cached attachment, six sibling preservation, immutable observations and truthful partial completion.");
} finally {
  Object.assign(review, pinned); Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
}
