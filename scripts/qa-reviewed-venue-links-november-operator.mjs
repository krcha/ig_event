import assert from "node:assert/strict";
import "../convex/events.ts";
import { drugstoreHarness } from "./qa-reviewed-drugstore-november-operator.mjs";
import { getContext, consolidate } from "../convex/reviewedVenueLinksNovember2026Repairs.ts";
import { VENUE_LINKS_NOVEMBER_2026_REVIEWS as reviews } from "../convex/internal/eventRepairs/reviewedVenueLinksNovember2026Repairs.ts";
import { buildEventOccurrenceIndexPatch } from "../convex/sourceOccurrences.ts";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation.ts";
import { updateEvent } from "../convex/events.ts";

const secret = "qa-frozen-venue-links-secret";
const originalSecret = process.env.CRON_SECRET;
const originalAdmin = process.env.ADMIN_CLERK_USER_IDS;
const originalNow = Date.now;
process.env.CRON_SECRET = secret;
process.env.ADMIN_CLERK_USER_IDS = "qa-drugstore-admin";
Date.now = () => Date.parse("2026-11-06T12:00:00.000Z");

// Public joint-program caption, retained solely to exercise the frozen
// source SHA fence. Every other test input below is synthetic.
const JOINT_CAPTION = "JO\u0160 MESEC DANA DO DECEMBARSKOG XAOC HANGARA! \n\nVELIKI HAOS NA KOME PO PRVI PUT U SRBIJU DOLAZE @optimuss.official , @per.pleks i @siasios !\n\nDoma\u0107u scenu nismo zanemarili ni ovaj put. Predstavnik groova @gruber.wav nam sprema 2 sata extended set koji \u0107e nas uvesti u ve\u010de.\n\nHeadliner ve\u010deri @fatimahajji ponovo dolazi u Srbiju na velika vrata! \n\nKarte su dostupne na haosmusic.com ili u svim knji\u017earama vulkan\ud83c\udf9f\ufe0f";
const controls = [
  ["j57davczg3efawp0xnw6hmg86d8eyq6j", "JURA & FILM", "2026-12-05", "TBD"],
  ["j57bcps5x8s9zs8ma39qbwwdr98he2y5", "STABLO MASLINE", "2026-11-06", "18:30"],
  ["j576qhgday1np01bdr8rffg5an8he0ze", "PUKOTINA U LEDU", "2026-11-06", "20:30"],
  ["j5787fm1q2dhhrq6pxv1xrd6xn8gsw36", "The Nutcracker", "2026-12-20", "15:00"],
  ["j5739mef9qz6e1hpc252t9d92d8gsxn9", "The Nutcracker", "2026-12-20", "20:00"],
  ["j57212bsaaskcc4hy9sqqb9p158hecc2", "RIKVERC", "2026-11-07", "22:00"],
  ["j579dvsa7dyarqhfj4nxk6qv0d8h43g9", "Buzzcocks", "2026-12-12", "20:00"],
];

export function venueLinksFixture(groupKey) {
  const review = reviews[groupKey];
  const allRows = [...review.rows, ...(review.distinctControls ?? [])];
  const seed = { events: [], venues: [], scrapedPosts: [], sourceOccurrences: [], instagramEventSources: [], instagramSourceOccurrenceReceipts: [], savedEvents: [], userSavedEvents: [] };
  seed.venues.push({ _id: review.venueId, _creationTime: 1, name: review.venueName, instagramHandle: review.venueHandle,
    publicStatus: "published", isActive: true, latitude: 44.82, longitude: 20.49, createdAt: 1, updatedAt: 1 });
  const sourceById = new Map();
  for (const pin of allRows) for (const binding of pin.sources) {
    if (sourceById.has(binding.documentId)) continue;
    const caption = groupKey === "zappa-galactic-nov13" && binding.postId === review.rows[1].postId ? ""
      : `Synthetic original source ${binding.postId}: dated independent occurrence evidence.`;
    const source = { _id: binding.documentId, _creationTime: 1, handle: binding.handle, username: binding.handle, postId: binding.postId,
      instagramPostUrl: binding.url, caption, postedAt: "2026-10-20T12:00:00.000Z", sourceRevision: 1, analysisRevision: 1,
      analysisContractVersion: "event_evidence_v2", analysisIsEvent: true, analysisModel: "gpt-6-luna",
      analysisResultJson: JSON.stringify({ extraction_contract_version: "event_evidence_v2", is_event: true, source_url: binding.url, source_caption: caption }),
      imageUrls: [], createdAt: 1, updatedAt: 1 };
    sourceById.set(source._id, source); seed.scrapedPosts.push(source);
  }
  for (const [index, pin] of allRows.entries()) {
    const mainBinding = pin.sources.find((binding) => binding.key === pin.fieldsKey);
    assert.ok(mainBinding, "A frozen event must retain its exact main normalized source key.");
    const source = sourceById.get(mainBinding.documentId);
    const fields = (binding, originalSource) => ({ title: pin.title, time: pin.time, artists: [...pin.artists], normalizedDate: pin.date,
      normalizedVenue: pin.venue, extractionMode: "caption", extractionContractVersion: "event_evidence_v2", extractionIsEvent: true,
      sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2", normalizedIsValid: true, dateSuspiciousYear: false,
      dateEvidenceVerified: true, dateEvidenceResolvedDate: pin.date, sourceGroundingSourceCaption: originalSource.caption,
      sourceGroundingInstagramPostId: originalSource.postId, sourceGroundingInstagramPostUrl: originalSource.instagramPostUrl,
      sourceGroundingInstagramHandle: originalSource.handle, sourceOccurrenceKey: binding.key, sourceOccurrenceSourceFingerprint: binding.fingerprint });
    const event = { _id: pin.id, _creationTime: 1, title: pin.title, date: pin.date, time: pin.time, venue: pin.venue,
      ...(pin.venueId ? { venueId: pin.venueId } : {}), artists: [...pin.artists], status: pin.status, eventType: pin.eventType,
      description: `Original ${pin.title}`, instagramPostId: pin.postId, instagramPostUrl: pin.url, sourceCaption: source.caption || undefined,
      sourcePostedAt: source.postedAt, rawExtractionJson: source.analysisResultJson, normalizedFieldsJson: JSON.stringify(fields(mainBinding, source)),
      sourceOccurrenceKey: pin.key, createdAt: 1, updatedAt: 1,
      timeSource: pin.time === "TBD" ? "unknown" : "poster", timeEvidenceText: pin.time === "TBD" ? undefined : pin.time,
      timeConfidence: pin.time === "TBD" ? 0 : 0.95, timeStatus: pin.time === "TBD" ? "unknown" : "confirmed",
      timeEvidenceKind: pin.time === "TBD" ? "not_stated" : "start_time_stated" };
    Object.assign(event, buildEventOccurrenceIndexPatch(event)); seed.events.push(event);
    for (const [sourceIndex, binding] of pin.sources.entries()) {
      const originalSource = sourceById.get(binding.documentId);
      const canonicalEventJson = JSON.stringify({ normalizedFieldsJson: JSON.stringify(fields(binding, originalSource)), requestedStatus: pin.status,
        sourceConflictFields: [], time: pin.time, timeConfidence: 0.95, timeSource: "poster", timeStatus: "confirmed" });
      const occurrenceId = `qa-venue-links-occurrence-${index}-${sourceIndex}`;
      seed.sourceOccurrences.push({ _id: occurrenceId, _creationTime: 1, provider: "instagram", sourceDocumentId: binding.documentId,
        sourceIdentity: binding.identity, sourceFingerprint: binding.fingerprint, sourceOccurrenceKey: binding.key,
        canonicalSourceUrl: binding.url, sourceRevision: 1, occurrenceOrdinal: sourceIndex + 1, canonicalEventId: pin.id,
        state: "satisfied", ...(pin.venueId ? { venueId: pin.venueId } : {}), venueResolutionStatus: pin.venueId ? "resolved" : "unresolved",
        normalizedOccurrenceJson: JSON.stringify({ title: pin.title, date: pin.date, time: pin.time, venue: pin.venue, venueId: pin.venueId, artists: [...pin.artists], eventType: pin.eventType }),
        factsJson: JSON.stringify({ originalSource: binding.key }), canonicalEventJson, ...buildEventOccurrenceIndexPatch(event), createdAt: 1, updatedAt: 1 });
      seed.instagramEventSources.push({ _id: binding.linkId, _creationTime: 1, eventId: pin.id, sourceOccurrenceId: occurrenceId,
        sourceIdentity: binding.identity, sourceFingerprint: binding.fingerprint, sourceOccurrenceKey: binding.key,
        instagramPostId: binding.postId, instagramPostUrl: binding.url, updatedAt: 1 });
      let receipt = seed.instagramSourceOccurrenceReceipts.find((row) => row.sourceIdentity === binding.identity);
      if (!receipt) { receipt = { _id: `qa-venue-links-receipt-${index}-${sourceIndex}`, _creationTime: 1, sourceIdentity: binding.identity,
        sourceFingerprint: binding.fingerprint, expectedKeys: [], expectedOccurrences: [], satisfiedKeys: [], satisfiedOccurrences: [],
        deferredChildCount: 0, deferredChildKeys: [], createdAt: 1, updatedAt: 1 }; seed.instagramSourceOccurrenceReceipts.push(receipt); }
      receipt.expectedKeys.push(binding.key); receipt.satisfiedKeys.push(binding.key);
      receipt.expectedOccurrences.push({ key: binding.key, title: pin.title, date: pin.date, time: pin.time, venue: pin.venue, artists: [...pin.artists] });
      receipt.satisfiedOccurrences.push({ key: binding.key, eventId: pin.id });
    }
  }
  for (const pin of review.evidenceSources ?? []) seed.scrapedPosts.push({ _id: pin.id, _creationTime: 1, handle: pin.handle, postId: pin.postId,
    instagramPostUrl: pin.url, caption: JOINT_CAPTION, createdAt: 1, updatedAt: 1 });
  for (const [id, title, date, time] of controls) if (!seed.events.some((event) => event._id === id)) seed.events.push({ _id: id, _creationTime: 1, title, date, time, venue: "Independent venue",
    artists: [], eventType: "arts & culture", status: "approved", createdAt: 1, updatedAt: 1 });
  seed.savedEvents.push({ _id: "qa-venue-links-save-primary", userId: "same-user", eventId: review.rows[0].id, createdAt: 1 },
    { _id: "qa-venue-links-save-duplicate", userId: "same-user", eventId: review.rows[1].id, createdAt: 2 },
    { _id: "qa-venue-links-save-new", userId: "new-user", eventId: review.rows[1].id, createdAt: 2 });
  seed.userSavedEvents.push({ _id: "qa-venue-links-legacy-primary", userId: "legacy-same", eventId: review.rows[0].id, savedAt: 1 },
    { _id: "qa-venue-links-legacy-duplicate", userId: "legacy-same", eventId: review.rows[1].id, savedAt: 2 },
    { _id: "qa-venue-links-legacy-new", userId: "legacy-new", eventId: review.rows[1].id, savedAt: 2 });
  return seed;
}

try {
  assert.equal(Object.keys(reviews).length, 10);
  assert.equal(Object.values(reviews).reduce((count, review) => count + review.rows.length, 0), 24);
  // Public URLs and guest saves contain the original event ID; rejected
  // components do not redirect. Keep these existing public cards as primary.
  for (const [groupKey, publicId] of [
    ["karmakoma-cormac-nov13", "j579smrb26dar5sbebg1waydhx8eya54"],
    ["para-climax-nov8", "j5768p8hsjf0s47cm4zgdy22mx8gsgv1"],
    ["para-preweekender-nov22", "j577r0fs42z9sz08he81298ypn8grn6n"],
  ]) {
    assert.equal(reviews[groupKey].rows[0].id, publicId);
    assert.equal(reviews[groupKey].rows[0].venueId, reviews[groupKey].venueId);
    assert.ok(reviews[groupKey].nextTitle && reviews[groupKey].nextArtists.length);
  }
  for (const [groupKey, review] of Object.entries(reviews)) {
    const seed = venueLinksFixture(groupKey); const h = drugstoreHarness(seed);
    const before = await getContext._handler(h.ctx, { groupKey, serviceSecret: secret });
    assert.equal(before.complete, false);
    const args = { groupKey, expectedContextSha256: before.contextSha256,
      moderationNote: "Source-reviewed exact venue/campaign correction; retain original occurrence evidence and all unrelated independent performances.", serviceSecret: secret };
    const result = await h.transaction(consolidate._handler, args);
    assert.equal(result.movedSaveCount, 2); assert.equal(result.dedupedSaveCount, 2);
    const after = await getContext._handler(h.ctx, { groupKey, serviceSecret: secret });
    assert.equal(after.complete, true); assert.equal(after.events[0].publicationState, "publishable");
    assert.equal(after.events[0].venueId, review.venueId); assert.equal(after.events[0].time, review.nextTime ?? review.rows[0].time);
    assert.deepEqual(after.events[0].artists, [...(review.nextArtists ?? review.rows[0].artists)]);
    assert.equal(after.links.length, review.rows.reduce((count, row) => count + row.sources.length, 0));
    for (const source of before.sources) assert.deepEqual(await h.db.get(source._id), source);
    for (const original of before.occurrences) {
      const final = await h.db.get(original._id); assert.equal(final.factsJson, original.factsJson); assert.equal(final.canonicalEventJson, original.canonicalEventJson);
      assert.equal(final.canonicalEventId, review.rows[0].id); assert.equal(final.venueId, review.venueId);
    }
    for (const event of after.events) assert.equal(isCrossPostCampaignLineageEvent(event), true);
    for (const event of before.protectedEvents) assert.deepEqual(await h.db.get(event._id), event);
    assert.ok(after.saves.slice(1).every((refs) => !refs.canonical.length && !refs.legacy.length));
    if (review.nextTime) { assert.equal(after.events[0].timeSource, "poster"); assert.equal(after.events[0].timeEvidenceText, review.nextTime); assert.equal(after.events[0].timeStatus, "confirmed"); }
    const applied = h.snapshot();
    await assert.rejects(() => h.transaction(consolidate._handler, args), /already applied/u);
    await assert.rejects(() => h.transaction(updateEvent._handler, { id: review.rows[0].id, expectedUpdatedAt: after.events[0].updatedAt, patch: { description: "Unsafe generic edit" } }, h.adminCtx), /[Cc]ampaign|[Ll]ineage|re-attestation/u);
    assert.deepEqual(h.snapshot(), applied);
    for (const corrupt of [
      (state) => { state.tables.get("events").get(review.rows[1].id).updatedAt += 1; },
      (state) => { state.tables.get("events").get(review.rows[1].id).date = "2027-02-01"; },
      (state) => { state.tables.get("scrapedPosts").get(review.rows[0].sources[0].documentId).analysisRevision += 1; },
      (state) => { state.tables.get("events").get(controls[0][0]).title = "Changed protected show"; },
      (state) => { state.tables.get("savedEvents").set("new-save", { _id: "new-save", userId: "new-owner", eventId: review.rows[1].id, createdAt: 3 }); },
    ]) {
      const fresh = drugstoreHarness(seed); corrupt(fresh); const corrupted = fresh.snapshot();
      await assert.rejects(() => fresh.transaction(consolidate._handler, args), /Reviewed venue-links repair/u);
      assert.deepEqual(fresh.snapshot(), corrupted);
    }
    const interrupted = drugstoreHarness(seed); const patch = interrupted.db.patch;
    interrupted.db.patch = async (id, value) => { if (id === review.rows[1].id) throw new Error("Forced venue-links receipt rollback."); return patch(id, value); };
    const interruptedBefore = interrupted.snapshot();
    await assert.rejects(() => interrupted.transaction(consolidate._handler, args), /Forced venue-links/u);
    assert.deepEqual(interrupted.snapshot(), interruptedBefore);
    await assert.rejects(() => getContext._handler(h.ctx, { groupKey, serviceSecret: "wrong" }), /Authentication|Admin/u);
  }
  const seed = venueLinksFixture("hangar-haos-dec5"); const h = drugstoreHarness(seed);
  h.tables.get("scrapedPosts").get(reviews["hangar-haos-dec5"].evidenceSources[0].id).caption += " changed";
  await assert.rejects(() => getContext._handler(h.ctx, { groupKey: "hangar-haos-dec5", serviceSecret: secret }), /joint-program source/u);
  await assert.rejects(() => getContext._handler(h.ctx, { groupKey: "arbitrary-date-or-venue", serviceSecret: secret }), /unknown frozen cohort/u);
  for (const extraTitle of ["HAOS", "An unreviewed separate performance"]) {
    const collision = drugstoreHarness(venueLinksFixture("hangar-haos-dec5"));
    const before = await getContext._handler(collision.ctx, { groupKey: "hangar-haos-dec5", serviceSecret: secret });
    const extra = { ...before.events[0], _id: "qa-unreviewed-hangar-collision", title: extraTitle, time: "TBD",
      venue: "Hangar", venueId: reviews["hangar-haos-dec5"].venueId, artists: ["PER PLEKS"],
      instagramPostId: "unreviewed-post", instagramPostUrl: "https://www.instagram.com/p/UnreviewedHangar/" };
    collision.tables.get("events").set(extra._id, extra);
    await assert.rejects(() => collision.transaction(consolidate._handler, { groupKey: "hangar-haos-dec5", expectedContextSha256: before.contextSha256,
      moderationNote: "Only the frozen independently proved Jura performance can resolve its exact venue ambiguity.", serviceSecret: secret }), /[Dd]uplicate|[Aa]mbiguous|already exists/u,
    "The source-proved Jura exception must never override a proven duplicate or another unreviewed same-date conflict.");
  }
  console.log("Reviewed venue-links November operator passed:10 fixed cohorts/24 rows, retained multi-source history/pending components, exact time-donor provenance, immutable sources/facts, saved references, independent controls, auth/stale-plan/replay fences and transactional rollback.");
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  if (originalAdmin === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = originalAdmin;
}
