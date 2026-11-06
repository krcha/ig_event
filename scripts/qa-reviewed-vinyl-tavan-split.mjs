import assert from "node:assert/strict";
import { harness } from "./qa-reviewed-november-2026-repairs.mjs";
import { getContext, split } from "../convex/reviewedVinylTavanNovember2026Split.ts";
import { VINYL_TAVAN_SPLIT_REVIEW as review, reviewedVinylTavanChildKey } from "../convex/internal/eventRepairs/reviewedVinylTavanNovember2026Split.ts";
import { buildEventOccurrenceIndexPatch, syncSourceOccurrencePlan } from "../convex/sourceOccurrences.ts";
import { serializeStructuredFacts } from "../lib/domain/occurrences/facts.ts";
import { serializeCanonicalEventPayload } from "../lib/domain/occurrences/canonical-event-payload.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { updateEvent, mergeApprovedEvents, deleteApprovedEvent, recordInstagramSourceOccurrenceSatisfaction, reconcileInstagramSourceOccurrenceReceipt } from "../convex/events.ts";
import { isEventPubliclyVisible } from "../convex/publicationPolicy.ts";
import { prepareSourceOccurrencePlanForReconciliation } from "../convex/internal/sourceOccurrenceReceipts.ts";

const originalSecret = process.env.CRON_SECRET;
const originalAdmins = process.env.ADMIN_CLERK_USER_IDS;
const originalNow = Date.now;
const secret = "qa-vinyl-tavan-human-reviewed-split";
const clone = structuredClone;
process.env.CRON_SECRET = secret;
process.env.ADMIN_CLERK_USER_IDS = "qa-admin";
Date.now = () => Date.parse("2026-11-06T20:00:00.000Z");

export function vinylTavanFixture() {
  // Public caption is a regression fixture; no live export or credentials.
  const caption = "CLUB VINYL & TAVAN BELGRADE \u2014 NEW YEAR 2027\ud83c\udf85\n\n\u260e\ufe0f Info&reservation: +381 69 8300 770\n\ud83d\udcc6 Thursday | 31.12. | 21-05h\n\ud83d\udccd Club Vinyl&Tavan | Bra\u0107e Krsmanovi\u0107 8, Savamala\n\nVidimo se na podijumu!\ud83c\udf8a";
  assert.equal(buildInstagramSourceOccurrenceFingerprint({ caption, altText: "", locationName: "" }), review.sourceFingerprint);
  const artists = review.programs.flatMap((program) => [...program.artists]);
  const raw = { extraction_contract_version: "event_evidence_v2", is_event: true, schedule_entries: [
    { title: review.title, date: review.date, time: review.time, venue: review.originalVenue, artists,
      source_text: "NEW YEAR 2027; 31.12. THURSDAY 21H; TILE/SI X CITAKOVIC; PEPPE X CEHRANOV" },
  ] };
  const source = { _id: review.sourceDocumentId, _creationTime: 1, handle: review.handle, username: review.handle, postId: review.postId,
    instagramPostUrl: review.postUrl, caption, altText: "", locationName: "", postedAt: "2026-11-04T15:55:53.000Z", sourceRevision: 1, analysisRevision: 1,
    analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna", analysisResultJson: JSON.stringify(raw),
    imageStorageId: review.storageId, analysisImageChecksumSha256: review.posterChecksumSha256, analysisImageSourceUrl: "https://example.test/reviewed-poster.jpg",
    imageUrls: [], processingStatus: "processing", processingLeaseOwner: "qa-owner", processingLeaseExpiresAt: Date.now() + 100000, createdAt: 1, updatedAt: 1 };
  const asset = { _id: "qa-vinyl-tavan-poster", _creationTime: 1, sourceKey: `instagram-post:${review.postId}`, sourceKind: "instagram_post",
    storageId: review.storageId, checksumSha256: review.posterChecksumSha256, url: "https://example.test/storage/retained-poster.jpg", createdAt: 1, updatedAt: 1 };
  const fields = { title: review.title, normalizedDate: review.date, time: review.time, normalizedVenue: review.originalVenue, artists,
    extractionContractVersion: "event_evidence_v2", extractionIsEvent: true, extractionMode: "poster", normalizedIsValid: true, dateSuspiciousYear: false,
    sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2", sourceGroundingInstagramHandle: review.handle,
    sourceGroundingInstagramPostId: review.postId, sourceGroundingInstagramPostUrl: review.postUrl, sourceGroundingSourceCaption: caption,
    sourceOccurrenceKey: review.oldKey, sourceOccurrenceSourceFingerprint: review.sourceFingerprint, humanReviewedStructuredSourcePolicyVersion: 1 };
  const event = { _id: review.primaryId, _creationTime: 1, title: review.title, date: review.date, time: review.time, venue: review.originalVenue, artists,
    eventType: "nightlife", description: "Combined original New Year poster observation.", status: "approved", ticketPrice: "30 EUR",
    instagramPostId: review.postId, instagramPostUrl: review.postUrl, sourceCaption: caption, sourcePostedAt: source.postedAt, rawExtractionJson: source.analysisResultJson,
    normalizedFieldsJson: JSON.stringify(fields), sourceOccurrenceKey: review.oldKey, imageUrl: asset.url, imageStorageId: review.storageId,
    humanReviewedStructuredSourcePolicyVersion: 1, reviewedAt: 1, reviewedBy: "qa-original-review", moderationNote: "Original source programme has complete independently retained poster evidence.", createdAt: 1, updatedAt: 1 };
  Object.assign(event, buildEventOccurrenceIndexPatch(event));
  const factsJson = serializeStructuredFacts({ titleClaim: event.title, localDate: event.date, startTime: event.time, timeRelation: "exact", venueClaim: event.venue,
    artistClaims: artists, eventTypeClaim: "nightlife", sourceRowIdentity: "Original combined poster row", evidence: [{ field: "venue", source: "poster", exactText: "Vinyl x Tavan" }],
    policy: { approvalDisposition: "approved", pendingReasons: [], signals: [], structuredEvidenceVerified: true } });
  const canonicalEventJson = serializeCanonicalEventPayload({ normalizedFieldsJson: event.normalizedFieldsJson, requestedStatus: "approved", sourceConflictFields: [],
    time: event.time, timeConfidence: 1, timeSource: "poster", timeStatus: "confirmed", description: event.description, ticketPrice: event.ticketPrice });
  const expected = { key: review.oldKey, title: event.title, date: event.date, time: event.time, venue: event.venue, artists, factsJson, canonicalEventJson };
  const occurrence = { _id: review.oldOccurrenceId, _creationTime: 1, provider: "instagram", sourceDocumentId: source._id, sourceIdentity: review.sourceIdentity,
    sourceFingerprint: review.sourceFingerprint, canonicalSourceUrl: review.postUrl, sourceRevision: 1, sourceOccurrenceKey: review.oldKey, occurrenceOrdinal: 0,
    factsJson, canonicalEventJson, normalizedOccurrenceJson: JSON.stringify({ title: event.title, date: event.date, time: event.time, artists, venue: event.venue, venueId: null, eventType: "nightlife" }),
    canonicalEventId: event._id, state: "satisfied", venueResolutionStatus: "unresolved", ...buildEventOccurrenceIndexPatch(event), createdAt: 1, updatedAt: 1 };
  return { events: [event, ...review.protectedIds.map((id, index) => ({ ...clone(event), _id: id, title: `Independent protected programme ${index}`, date: index < 3 ? "2026-11-06" : "2026-12-20" }))],
    venues: review.programs.map((program) => ({ _id: program.venueId, _creationTime: 1, name: program.venue, instagramHandle: program.handle, publicStatus: "published", isActive: true, createdAt: 1, updatedAt: 1 })),
    scrapedPosts: [source], mediaAssets: [asset], sourceOccurrences: [occurrence],
    instagramEventSources: [{ _id: review.linkId, _creationTime: 1, eventId: event._id, sourceIdentity: review.sourceIdentity, sourceFingerprint: review.sourceFingerprint,
      sourceOccurrenceKey: review.oldKey, sourceOccurrenceId: occurrence._id, instagramPostId: review.postId, instagramPostUrl: review.postUrl, canonicalSourceUrl: review.postUrl, linkedAt: 1, updatedAt: 1 }],
    instagramSourceOccurrenceReceipts: [{ _id: review.receiptId, _creationTime: 1, sourceIdentity: review.sourceIdentity, sourceFingerprint: review.sourceFingerprint,
      expectedKeys: [review.oldKey], expectedOccurrences: [expected], satisfiedKeys: [review.oldKey], satisfiedOccurrences: [{ key: review.oldKey, eventId: event._id }], deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 }],
    savedEvents: [{ _id: "qa-vinyl-existing-save", eventId: event._id, userId: "existing-owner", createdAt: 1 }],
    userSavedEvents: [{ _id: "qa-vinyl-existing-legacy-save", eventId: event._id, userId: "existing-legacy-owner", savedAt: 1 }],
  };
}

export function vinylTavanHarness(seed) {
  const h = harness(seed);
  h.ctx.storage = { getUrl: async (id) => id === review.storageId ? "https://example.test/storage/retained-poster.jpg" : null };
  h.adminCtx.storage = h.ctx.storage;
  return h;
}

try {
  const seed = vinylTavanFixture();
  const h = vinylTavanHarness(seed);
  const before = await getContext._handler(h.ctx, { serviceSecret: secret });
  assert.equal(before.complete, false);
  const args = { serviceSecret: secret, expectedContextSha256: before.contextSha256,
    moderationNote: "User reviewed the exact checksum-bound New Year poster: two venue-assigned artist pairs, one Vinyl programme and one Tavan programme; preserve the original evidence and saves." };
  const result = await h.transaction(split._handler, args);
  const after = await getContext._handler(h.ctx, { serviceSecret: secret });
  assert.equal(after.complete, true);
  assert.equal(result.vinylEventId, review.primaryId);
  assert.notEqual(result.tavanEventId, review.primaryId);
  assert.equal(after.events.length, 2);
  assert.equal(after.occurrences.length, 3);
  assert.equal(after.links.length, 2);
  assert.equal(after.oldOccurrence.state, "superseded");
  assert.equal(after.oldOccurrence.canonicalEventId, undefined);
  assert.equal(after.oldOccurrence.factsJson, before.oldOccurrence.factsJson);
  assert.equal(after.oldOccurrence.canonicalEventJson, before.oldOccurrence.canonicalEventJson);
  assert.deepEqual(after.source, before.source);
  assert.deepEqual(after.asset, before.asset);
  assert.deepEqual(after.saves, before.saves);
  assert.deepEqual(after.controls, before.controls);
  assert.ok(after.secondarySaves.canonical.length === 0 && after.secondarySaves.legacy.length === 0);
  for (const [index, event] of after.events.entries()) {
    assert.equal(event.time, review.time);
    assert.equal(event.date, review.date);
    assert.equal(event.venueId, review.programs[index].venueId);
    assert.deepEqual(event.artists, [...review.programs[index].artists]);
    assert.equal(event.sourceOccurrenceKey, reviewedVinylTavanChildKey(review.programs[index]));
    assert.equal(event.rawExtractionJson, before.events[0].rawExtractionJson);
    assert.equal(event.sourceCaption, before.events[0].sourceCaption);
    assert.equal(await isEventPubliclyVisible(h.ctx, event), true);
    assert.equal(isCrossPostCampaignLineageEvent(event), true);
  }
  const finalSnapshot = h.snapshot();
  await assert.rejects(() => h.transaction(split._handler, args), /already applied/u);
  for (const event of after.events) {
    await assert.rejects(() => h.transaction(updateEvent._handler, { id: event._id, expectedUpdatedAt: event.updatedAt, patch: { description: "Unsafe generic edit" } }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
    await assert.rejects(() => h.transaction(mergeApprovedEvents._handler, { primaryId: event._id, duplicateIds: [], patch: {} }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
    await assert.rejects(() => h.transaction(deleteApprovedEvent._handler, { id: event._id, expectedUpdatedAt: event.updatedAt }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|[Rr]etire|[Dd]edicated/u);
  }
  const originalPlan = { sourceIdentity: review.sourceIdentity, sourceFingerprint: review.sourceFingerprint,
    expectedKeys: [review.oldKey], expectedOccurrences: before.receipt.expectedOccurrences, observedChildKeys: [review.oldKey], deferredChildKeys: [], deferredChildCount: 0 };
  const fence = { handle: review.handle, scrapedPostId: review.sourceDocumentId, owner: "qa-owner", sourceRevision: 1 };
  await assert.rejects(() => h.transaction(async (ctx) => prepareSourceOccurrencePlanForReconciliation(ctx, originalPlan, before.source), {}), /[Cc]ampaign|[Ll]ineage|[Ff]olded|re-attestation/u);
  const deferredReplay = { ...originalPlan, expectedKeys: [], expectedOccurrences: [], deferredChildKeys: [review.oldKey], deferredChildCount: 1 };
  await assert.rejects(() => h.transaction(reconcileInstagramSourceOccurrenceReceipt._handler, { plan: deferredReplay, processingFence: fence, serviceSecret: secret }), /[Cc]ampaign|[Ll]ineage|[Ff]olded|re-attestation/u);
  await assert.rejects(() => h.transaction(recordInstagramSourceOccurrenceSatisfaction._handler, { plan: originalPlan, satisfiedKey: review.oldKey, representativeEventId: review.primaryId, processingFence: fence, serviceSecret: secret }), /[Cc]ampaign|[Ll]ineage|[Ff]olded|re-attestation/u);
  await assert.rejects(() => h.transaction(async (ctx) => syncSourceOccurrencePlan({ ctx, plan: originalPlan, representativeEvent: before.events[0], satisfiedKey: review.oldKey,
    sourceDocument: before.source, topologyEpochVerified: true }), {}), /superseded/u);
  assert.deepEqual(h.snapshot(), finalSnapshot, "Cached original combined analysis cannot resurrect an observation, add a third event, or rewrite either programme.");
  for (const corrupt of [
    (state) => { state.tables.get("events").get(review.primaryId).updatedAt += 1; },
    (state) => { state.tables.get("events").get(review.primaryId).date = "2026-12-30"; },
    (state) => { state.tables.get("events").get(review.primaryId).artists.reverse(); },
    (state) => { state.tables.get("scrapedPosts").get(review.sourceDocumentId).analysisImageChecksumSha256 = "0".repeat(64); },
    (state) => { state.tables.get("scrapedPosts").get(review.sourceDocumentId).sourceRevision += 1; },
    (state) => { state.tables.get("sourceOccurrences").get(review.oldOccurrenceId).factsJson = "{}"; },
    (state) => { state.tables.get("instagramSourceOccurrenceReceipts").get(review.receiptId).updatedAt += 1; },
    (state) => { const receipt = state.tables.get("instagramSourceOccurrenceReceipts").get(review.receiptId); receipt.deferredChildCount = 1; receipt.deferredChildKeys = ["qa-unreviewed-deferred-programme"]; },
    (state) => { state.tables.get("venues").get(review.programs[1].venueId).updatedAt += 1; },
    (state) => { state.tables.get("savedEvents").get("qa-vinyl-existing-save").createdAt += 1; },
  ]) {
    const state = vinylTavanHarness(seed); corrupt(state); const snapshot = state.snapshot();
    await assert.rejects(() => state.transaction(split._handler, args), /Reviewed Vinyl\/Tavan split/u);
    assert.deepEqual(state.snapshot(), snapshot, "A stale or invalid full preimage must not write any partial segmentation.");
  }
  const missingMedia = vinylTavanHarness(seed); missingMedia.ctx.storage.getUrl = async () => null;
  await assert.rejects(() => getContext._handler(missingMedia.ctx, { serviceSecret: secret }), /poster/u);
  const collision = vinylTavanHarness(seed);
  const competing = { ...clone(seed.events[0]), _id: "qa-existing-tavan-programme", venue: review.programs[1].venue, venueId: review.programs[1].venueId,
    artists: [...review.programs[1].artists], instagramPostId: "unreviewed-other-post", instagramPostUrl: "https://www.instagram.com/p/UnreviewedTavan/" };
  competing.normalizedFieldsJson = JSON.stringify({ ...JSON.parse(competing.normalizedFieldsJson), normalizedVenue: competing.venue, artists: competing.artists });
  collision.tables.get("events").set(competing._id, competing);
  await assert.rejects(() => collision.transaction(split._handler, args), /[Dd]uplicate|[Aa]mbiguous|already exists/u);
  const interrupted = vinylTavanHarness(seed); const originalPatch = interrupted.db.patch;
  interrupted.db.patch = async (id, patch) => { if (id === review.receiptId) throw new Error("Forced failure after new event and child materialization."); return originalPatch(id, patch); };
  const interruptedSnapshot = interrupted.snapshot();
  await assert.rejects(() => interrupted.transaction(split._handler, args), /Forced failure/u);
  assert.deepEqual(interrupted.snapshot(), interruptedSnapshot, "Failure rolls back the second event, supersession, child rows, links and receipt together.");
  await assert.rejects(() => getContext._handler(h.ctx, { serviceSecret: "wrong" }), /Authentication|Admin/u);
  await assert.rejects(() => getContext._handler(h.adminCtx, { serviceSecret: "wrong" }), /service authentication/u);
  console.log("Reviewed Vinyl/Tavan split passed: exact checksum-bound two-programme review, original event/saves retained, immutable superseded observation, two current receipts/public events, stale/auth/collision/rollback fences and cached/generic mutation protection.");
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  if (originalAdmins === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = originalAdmins;
}
