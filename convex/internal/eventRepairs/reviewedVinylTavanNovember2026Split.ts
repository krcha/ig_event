import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { hasHumanReviewedStructuredSourceAttestation, HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION, nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { parseCanonicalEventPayload, serializeCanonicalEventPayload } from "../../../lib/domain/occurrences/canonical-event-payload";
import { parseStructuredFactsJson, serializeStructuredFacts, structuredFactsMatchOccurrenceBinding } from "../../../lib/domain/occurrences/facts";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isSupportedExtractionModel } from "../extractionModel";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { evaluateEventPublication, isEventPubliclyVisible } from "../../publicationPolicy";
import { savedEventRepository } from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch, syncSourceOccurrencePlan, type SourceOccurrencePlanRecord } from "../../sourceOccurrences";
import { resolveVenueDenormalizedFieldsFromPublicVenues } from "../../eventDomain/moderationVenue";
import { assertApprovalCandidatePolicy, assertPersistedServiceSourcePolicy } from "../../eventDomain/sourceApproval";
import { refreshCanonicalEventDerivedStates, writeEventAuditLog } from "../../eventDomain/persistence";
import { withNovember2026ReadCache } from "./reviewedNovember2026Repairs";

export const VINYL_TAVAN_SPLIT_REVIEW = {
  operationId: "reviewed-vinyl-tavan-nye-2026:poster-split:v1",
  primaryId: "j57d71z6zx937fmcn7vg4jx4xx8hnp06",
  sourceDocumentId: "jn7cwr89xb0q6nqn7dj2drh3398hnmr5",
  sourceIdentity: "instagram-source-identity-v1:DfUz1jQMPmP",
  sourceFingerprint: "instagram-source-v2:264aafb6ac8063d60d7a1b8cdbaac2d27558901d9a99dd3f20c679c3c6b0ccb1",
  postId: "4023068347505637775",
  postUrl: "https://www.instagram.com/p/DfUz1jQMPmP/",
  handle: "vinyl.belgrade",
  oldKey: "instagram-occurrence-v2:f94035db64c1a9b798cee8493d40cf1ee3c6435e43f05f1f34658bf5bebae05e",
  oldOccurrenceId: "pd70ccxggg1f7qj4rb4jxzk4e18hmyt3",
  linkId: "kx75tp721k0w4jq103y2wywzjn8hn0ph",
  receiptId: "mh75denz0x9pa1y3ge7rz5789s8hm85a",
  storageId: "kg21m9w359eh3jggaz4vakr0c98hnhyy",
  posterChecksumSha256: "cd45f43daf2d201da70cd2fb9e7e46beec7059d35c0bcf01fa07c8cade552b8e",
  title: "NEW YEAR 2027", date: "2026-12-31", time: "21:00-05:00", originalVenue: "Vinyl & Tavan",
  programs: [
    { role: "vinyl", venueId: "k17bp4t9435fgrfxkbpjb7ax3h897rjd", venue: "Vinyl", handle: "vinyl.belgrade", artists: ["TILE/SI", "\u010cITAKOVI\u0106"],
      artistQuote: "TILE/SI X \u010cITAKOVI\u0106", description: "Novogodisnji program u klubu Vinyl: TILE/SI x Citakovic, 31. decembra od 21:00 do 05:00. Zajednicka najava Vinyl x Tavan na adresi Brace Krsmanovic 8; program Tavan bine objavljen je zasebno. Poster navodi kartu od 30 EUR." },
    { role: "tavan", venueId: "k170krfz17ehnj6dfrrs7hwes5899a76", venue: "Tavan Nightclub Belgrade", handle: "tavan.belgrade", artists: ["PEPPE", "\u010cEHRANOV"],
      artistQuote: "PEPPE X \u010cEHRANOV", description: "Novogodisnji program u klubu Tavan: Peppe x Cehranov, 31. decembra od 21:00 do 05:00. Zajednicka najava Vinyl x Tavan na adresi Brace Krsmanovic 8; program Vinyl bine objavljen je zasebno. Poster navodi kartu od 30 EUR." },
  ],
  protectedIds: ["j57davczg3efawp0xnw6hmg86d8eyq6j", "j57bcps5x8s9zs8ma39qbwwdr98he2y5", "j576qhgday1np01bdr8rffg5an8he0ze", "j5787fm1q2dhhrq6pxv1xrd6xn8gsw36", "j5739mef9qz6e1hpc252t9d92d8gsxn9"],
} as const;

type ReadCtx = QueryCtx | MutationCtx;
type Program = typeof VINYL_TAVAN_SPLIT_REVIEW.programs[number];
const fail = (message: string): never => { throw new Error(`Reviewed Vinyl/Tavan split: ${message}`); };
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function digest(value: unknown): string {
  const json = stableJson(value);
  if (new TextEncoder().encode(json).byteLength > 2 * 1024 * 1024) return fail("review context exceeds its proof bound.");
  return sha256Hex(json);
}
function fields(event: Doc<"events">): Record<string, unknown> {
  const value: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("normalized evidence is invalid.");
  return value as Record<string, unknown>;
}
export function reviewedVinylTavanChildKey(program: Program): string {
  return `instagram-occurrence-v2:${sha256Hex(stableJson({ operationId: VINYL_TAVAN_SPLIT_REVIEW.operationId,
    sourceIdentity: VINYL_TAVAN_SPLIT_REVIEW.sourceIdentity, originalKey: VINYL_TAVAN_SPLIT_REVIEW.oldKey,
    venueId: program.venueId, artists: program.artists, date: VINYL_TAVAN_SPLIT_REVIEW.date, time: VINYL_TAVAN_SPLIT_REVIEW.time }))}`;
}
async function service(ctx: ReadCtx, secret: string): Promise<string> {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") return fail("service authentication is required.");
  return auth.actor;
}
function insertFields(event: Doc<"events">) {
  const { _id: ignoredId, _creationTime: ignoredCreationTime, ...data } = event;
  void ignoredId; void ignoredCreationTime;
  return data;
}

async function loadContext(ctx: ReadCtx) {
  const review = VINYL_TAVAN_SPLIT_REVIEW;
  const primary = await ctx.db.get(review.primaryId as Id<"events">);
  if (!primary) return fail("the pinned original event disappeared.");
  const primaryFields = fields(primary);
  const splitMarker = primaryFields.reviewedVinylTavanSplit as Record<string, unknown> | undefined;
  const complete = splitMarker !== undefined;
  if (complete && (splitMarker?.operationId !== review.operationId || splitMarker.role !== "vinyl" ||
    typeof splitMarker.secondaryEventId !== "string" || splitMarker.originalOccurrenceId !== review.oldOccurrenceId)) return fail("split marker changed.");
  const secondaryId = complete ? ctx.db.normalizeId("events", String(splitMarker?.secondaryEventId)) : null;
  const secondary = secondaryId ? await ctx.db.get(secondaryId) : null;
  if (complete && !secondary) return fail("the split secondary disappeared.");
  const events = secondary ? [primary, secondary] : [primary];
  const venues: Doc<"venues">[] = [];
  for (const program of review.programs) {
    const venue = await ctx.db.get(program.venueId as Id<"venues">);
    if (!venue || !isVenuePublic(venue) || venue.name !== program.venue || venue.instagramHandle !== program.handle) return fail("an exact public destination venue changed.");
    venues.push(venue);
  }
  const source = await ctx.db.get(review.sourceDocumentId as Id<"scrapedPosts">);
  if (!source || source.handle !== review.handle || source.username !== review.handle || source.postId !== review.postId ||
    source.instagramPostUrl !== review.postUrl || (source.sourceRevision ?? 1) !== 1 || source.analysisRevision !== 1 ||
    source.analysisContractVersion !== "event_evidence_v2" || source.analysisIsEvent !== true || !isSupportedExtractionModel(source.analysisModel) ||
    source.imageStorageId !== review.storageId || source.analysisImageChecksumSha256 !== review.posterChecksumSha256 || !source.analysisImageSourceUrl ||
    buildInstagramSourceOccurrenceFingerprint(source) !== review.sourceFingerprint) return fail("the checksum-bound source or analysis changed.");
  const assets = await ctx.db.query("mediaAssets").withIndex("by_sourceKey", (q) => q.eq("sourceKey", `instagram-post:${review.postId}`)).take(2);
  const asset = assets.length === 1 ? assets[0] : null;
  if (!asset || asset.storageId !== review.storageId || asset.checksumSha256 !== review.posterChecksumSha256 ||
    await ctx.storage.getUrl(asset.storageId) === null) return fail("the reviewed poster is no longer independently retained.");
  const raw = JSON.parse(source.analysisResultJson ?? "null") as Record<string, unknown> | null;
  const rows = Array.isArray(raw?.schedule_entries) ? raw.schedule_entries as Array<Record<string, unknown>> : [];
  const originalArtists = review.programs.flatMap((program) => [...program.artists]);
  if (raw?.extraction_contract_version !== "event_evidence_v2" || raw.is_event !== true || rows.length !== 1 ||
    rows[0]?.title !== review.title || rows[0]?.date !== review.date || rows[0]?.time !== review.time || rows[0]?.venue !== review.originalVenue ||
    !exactJsonValue(rows[0]?.artists, originalArtists)) return fail("the exact original combined extraction row changed.");
  for (const [index, event] of events.entries()) {
    const program = review.programs[index]!;
    const f = fields(event);
    const marker = f.reviewedVinylTavanSplit as Record<string, unknown> | undefined;
    if (event.status !== "approved" || event.eventType !== "nightlife" || event.title !== review.title || event.date !== review.date || event.time !== review.time ||
      event.instagramPostId !== review.postId || event.instagramPostUrl !== review.postUrl || event.sourceCaption !== source.caption ||
      event.sourcePostedAt !== source.postedAt || event.rawExtractionJson !== source.analysisResultJson || event.imageStorageId !== review.storageId || event.imageUrl !== asset.url ||
      f.sourceGroundingInstagramHandle !== review.handle || f.sourceOccurrenceSourceFingerprint !== review.sourceFingerprint ||
      (!complete && (event.venue !== review.originalVenue || event.venueId !== undefined || !exactJsonValue(event.artists, originalArtists) || isCrossPostCampaignLineageEvent(event))) ||
      (complete && (event.venue !== program.venue || event.venueId !== program.venueId || !exactJsonValue(event.artists, program.artists) ||
        event.sourceOccurrenceKey !== reviewedVinylTavanChildKey(program) || f.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        marker?.operationId !== review.operationId || marker.role !== program.role || marker.secondaryEventId !== secondaryId || !isCrossPostCampaignLineageEvent(event)))) return fail("a pinned event or its final source binding changed.");
  }
  const receiptRows = await ctx.db.query("instagramSourceOccurrenceReceipts").withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", review.sourceIdentity)).take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (!receipt || receipt._id !== review.receiptId || receipt.sourceFingerprint !== review.sourceFingerprint ||
    receipt.deferredChildCount !== 0 || receipt.deferredChildKeys.length !== 0) return fail("the exact source receipt changed or has an unreviewed deferred child.");
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const oldOccurrence = await ctx.db.get(review.oldOccurrenceId as Id<"sourceOccurrences">);
  if (!oldOccurrence || oldOccurrence.sourceIdentity !== review.sourceIdentity || oldOccurrence.sourceFingerprint !== review.sourceFingerprint ||
    oldOccurrence.sourceOccurrenceKey !== review.oldKey || oldOccurrence.sourceDocumentId !== source._id || oldOccurrence.sourceRevision !== 1) return fail("the original observed occurrence changed.");
  const originalFacts = parseStructuredFactsJson(oldOccurrence.factsJson);
  const oldPayload = parseCanonicalEventPayload(oldOccurrence.canonicalEventJson);
  const originalExpected = { key: review.oldKey, title: review.title, date: review.date, time: review.time, venue: review.originalVenue, artists: originalArtists };
  if (!originalFacts || !structuredFactsMatchOccurrenceBinding(originalFacts, originalExpected) || !oldPayload ||
    !sourceOccurrenceRepresentativeMatchesExpected({ ...primary, venue: review.originalVenue, artists: originalArtists, normalizedFieldsJson: oldPayload.normalizedFieldsJson }, originalExpected)) return fail("immutable combined observation no longer proves the reviewed poster row.");
  const links = await ctx.db.query("instagramEventSources").withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", review.sourceIdentity)).take(4);
  const occurrences = await ctx.db.query("sourceOccurrences").withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", review.sourceIdentity)).take(4);
  if (links.some((link) => link.instagramPostId !== review.postId || link.instagramPostUrl !== review.postUrl || link.sourceFingerprint !== review.sourceFingerprint) ||
    occurrences.some((occurrence) => occurrence.sourceDocumentId !== source._id || occurrence.sourceRevision !== 1 || occurrence.sourceFingerprint !== review.sourceFingerprint)) return fail("source-wide provenance contains an incompatible binding.");
  if (!complete) {
    if (primary.sourceOccurrenceKey !== review.oldKey || primaryFields.sourceOccurrenceKey !== review.oldKey ||
      links.length !== 1 || links[0]?._id !== review.linkId || links[0]?.eventId !== primary._id || links[0]?.sourceOccurrenceId !== oldOccurrence._id ||
      links[0]?.sourceIdentity !== review.sourceIdentity || links[0]?.sourceFingerprint !== review.sourceFingerprint || links[0]?.sourceOccurrenceKey !== review.oldKey || links[0]?.instagramPostUrl !== review.postUrl ||
      occurrences.length !== 1 || oldOccurrence.state !== "satisfied" || oldOccurrence.canonicalEventId !== primary._id ||
      !exactJsonValue(receipt.expectedKeys, [review.oldKey]) || !exactJsonValue(receipt.satisfiedKeys, [review.oldKey]) ||
      receipt.expectedOccurrences?.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(primary, receipt.expectedOccurrences[0]) ||
      !exactJsonValue(receipt.satisfiedOccurrences, [{ key: review.oldKey, eventId: primary._id }])) return fail("the original one-row topology changed.");
    await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  } else {
    if (oldOccurrence.state !== "superseded" || oldOccurrence.canonicalEventId !== undefined || links.length !== 2 || occurrences.length !== 3 ||
      splitMarker?.originalFactsSha256 !== sha256Hex(oldOccurrence.factsJson) || splitMarker.originalCanonicalSha256 !== sha256Hex(oldOccurrence.canonicalEventJson!)) return fail("archived evidence or final topology changed.");
    for (const event of events) {
      const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
      if (topology.links.length !== 1 || topology.currentOccurrences.length !== 1 ||
        topology.links[0]?.sourceIdentity !== review.sourceIdentity || topology.links[0]?.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        topology.currentOccurrences[0]?.sourceOccurrenceKey !== event.sourceOccurrenceKey || !(await isEventPubliclyVisible(ctx, event))) return fail("a split programme lost complete public provenance.");
      await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(ctx, event._id, event);
    }
    const expectedKeys = review.programs.map(reviewedVinylTavanChildKey);
    if (!exactJsonValue(receipt.expectedKeys, expectedKeys) || !exactJsonValue(receipt.satisfiedKeys, expectedKeys) || receipt.deferredChildCount !== 0 ||
      !exactJsonValue(receipt.satisfiedOccurrences, events.map((event) => ({ key: event.sourceOccurrenceKey, eventId: event._id })))) return fail("split receipt is incomplete.");
  }
  const saves = await savedEventRepository.loadEventReferences(ctx, primary._id, { limit: 100 });
  const secondarySaves = secondary ? await savedEventRepository.loadEventReferences(ctx, secondary._id, { limit: 100 }) : null;
  const controls = [];
  for (const id of review.protectedIds) {
    const control = await ctx.db.get(id as Id<"events">);
    if (!control) return fail("an independent protected performance disappeared.");
    controls.push(control);
  }
  const sourceCandidate: Doc<"events"> = { ...primary, normalizedFieldsJson: JSON.stringify({ ...primaryFields, humanReviewedStructuredSourcePolicyVersion: 1 }),
    humanReviewedStructuredSourcePolicyVersion: 1, reviewedAt: primary.updatedAt, reviewedBy: "service:reviewed-vinyl-tavan-poster-proof", moderationNote: "Checksum-bound original poster and current persisted source independently reviewed for the exact New Year programme." };
  if (!hasHumanReviewedStructuredSourceAttestation(sourceCandidate.normalizedFieldsJson, sourceCandidate) || !(await isCanonicallyGroundedApprovedEvent(ctx, sourceCandidate))) return fail("current source proof failed.");
  return { complete, primaryId: primary._id, secondaryId, events, venues, source, asset, receipt, oldOccurrence, occurrences, links, saves, secondarySaves, controls };
}

export async function getReviewedVinylTavanSplitContextHandler(ctx: QueryCtx, args: { serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  await service(ctx, args.serviceSecret);
  const context = await loadContext(ctx);
  return { ...context, contextSha256: digest(context) };
}

export async function splitReviewedVinylTavanHandler(ctx: MutationCtx, args: { expectedContextSha256: string; moderationNote: string; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  const actor = await service(ctx, args.serviceSecret);
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (note.length < 30 || note.length > 1000 || !/^[a-f0-9]{64}$/u.test(args.expectedContextSha256)) return fail("a substantive review note and exact context digest are required.");
  const before = await loadContext(ctx);
  if (before.complete) return fail("the split is already applied; inspect the complete context.");
  if (digest(before) !== args.expectedContextSha256) return fail("reviewed context changed; preview again.");
  const review = VINYL_TAVAN_SPLIT_REVIEW;
  const primary = before.events[0]!;
  const now = Date.now();
  const baseMarker = { policyVersion: 1, operationId: review.operationId, originalOccurrenceId: review.oldOccurrenceId,
    originalKey: review.oldKey, posterChecksumSha256: review.posterChecksumSha256,
    originalFactsSha256: sha256Hex(before.oldOccurrence.factsJson), originalCanonicalSha256: sha256Hex(before.oldOccurrence.canonicalEventJson!), reviewedAt: now, reviewedBy: actor };
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, now);
  function candidate(program: Program, index: number, secondaryId: Id<"events"> | null): Doc<"events"> {
    const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues([before.venues[index]!], program.venue);
    if (venueFields.venueId !== program.venueId) return fail("the exact programme venue did not resolve.");
    const key = reviewedVinylTavanChildKey(program);
    const nextFields = { ...fields(primary), title: review.title, normalizedVenue: program.venue, artists: [...program.artists], description: program.description,
      sourceOccurrenceKey: key, sourceOccurrencePlanUnverified: false, moderationAutoApproved: false, moderationAutoApproveRule: null,
      humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
      reviewedVinylTavanSplit: { ...baseMarker, role: program.role, secondaryEventId: secondaryId },
      // Existing generic update/merge/replay guards recognize this reviewed-only lineage.
      reviewedNovember2026Repair: { policyVersion: 1, groupKey: "vinyl-tavan-nye-split", operationId: review.operationId, role: program.role, primaryId: primary._id, componentIds: secondaryId ? [secondaryId] : [] } };
    const result: Doc<"events"> = { ...primary, ...venueFields, venue: program.venue, artists: [...program.artists], description: program.description,
      sourceOccurrenceKey: key, normalizedFieldsJson: JSON.stringify(nextFields), humanReviewedStructuredSourcePolicyVersion: 1,
      reviewedAt: now, reviewedBy: actor, moderationNote: note, updatedAt: primaryUpdatedAt };
    return { ...result, ...buildEventOccurrenceIndexPatch(result) };
  }
  let vinyl = candidate(review.programs[0], 0, null);
  let tavan = candidate(review.programs[1], 1, null);
  for (const event of [vinyl, tavan]) {
    if (!hasHumanReviewedStructuredSourceAttestation(event.normalizedFieldsJson, event)) return fail("review does not bind the complete programme payload.");
    await assertPersistedServiceSourcePolicy(ctx, event, { allowHumanReviewedStructured: true });
    await assertApprovalCandidatePolicy(ctx, event, [primary._id]);
    if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) return fail("a proposed programme lacks current source proof.");
  }
  for (const program of review.programs) {
    const existing = await ctx.db.query("sourceOccurrences").withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", review.sourceIdentity).eq("sourceOccurrenceKey", reviewedVinylTavanChildKey(program))).take(1);
    if (existing.length) return fail("a reviewed child key was already materialized.");
  }
  const originalTopology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  const secondaryId = await ctx.db.insert("events", { ...insertFields(tavan), createdAt: now });
  vinyl = candidate(review.programs[0], 0, secondaryId);
  tavan = { ...candidate(review.programs[1], 1, secondaryId), _id: secondaryId };
  await ctx.db.patch(primary._id, insertFields(vinyl));
  await ctx.db.patch(secondaryId, insertFields(tavan));
  await sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(ctx, primary._id, { preparedTopology: originalTopology, topologyEpochVerified: true });
  const expectedOccurrences = [vinyl, tavan].map((event, index) => {
    const program = review.programs[index]!;
    const factsJson = serializeStructuredFacts({ artistClaims: [...program.artists], localDate: review.date, titleClaim: review.title,
      startTime: review.time, timeRelation: "exact", eventTypeClaim: "nightlife", venueClaim: program.venue, venueHandleClaim: program.handle,
      sourceRowIdentity: `Human-reviewed checksum-bound poster programme: ${program.role}; ${program.artistQuote}`,
      evidence: [{ field: "date", source: "poster", exactText: "31.12. | THURSDAY" }, { field: "start_time", source: "caption", exactText: "21-05h" },
        { field: "venue", source: "poster", exactText: program.role === "vinyl" ? "Vinyl" : "Tavan" }, { field: "artists", source: "poster", exactText: program.artistQuote }],
      policy: { approvalDisposition: "approved", pendingReasons: [], signals: ["human_reviewed_poster_program_segmentation"], structuredEvidenceVerified: true } });
    const originalPayload = parseCanonicalEventPayload(before.oldOccurrence.canonicalEventJson)!;
    const canonicalEventJson = serializeCanonicalEventPayload({ ...originalPayload, normalizedFieldsJson: event.normalizedFieldsJson!, description: event.description, requestedStatus: "approved" });
    return { key: event.sourceOccurrenceKey!, title: event.title, date: event.date, time: event.time, venue: event.venue, artists: event.artists, factsJson, canonicalEventJson };
  });
  const plan: SourceOccurrencePlanRecord = { sourceIdentity: review.sourceIdentity, sourceFingerprint: review.sourceFingerprint,
    deferredChildKeys: [], expectedKeys: expectedOccurrences.map((row) => row.key), expectedOccurrences };
  const newBindings = [];
  for (const event of [vinyl, tavan]) {
    const synced = await syncSourceOccurrencePlan({ ctx, plan, representativeEvent: event, satisfiedKey: event.sourceOccurrenceKey!, sourceDocument: before.source, topologyEpochVerified: true });
    if (!synced) return fail("a reviewed child could not be materialized.");
    newBindings.push(synced);
  }
  await ctx.db.patch(before.links[0]!._id, { sourceOccurrenceKey: vinyl.sourceOccurrenceKey!, sourceOccurrenceId: newBindings[0]!.sourceOccurrenceId, updatedAt: nextEventUpdatedAt(before.links[0]!.updatedAt, now) });
  const { _id: ignoredLinkId, _creationTime: ignoredLinkCreation, ...linkFields } = before.links[0]!;
  void ignoredLinkId; void ignoredLinkCreation;
  await ctx.db.insert("instagramEventSources", { ...linkFields, eventId: secondaryId, sourceOccurrenceKey: tavan.sourceOccurrenceKey!, sourceOccurrenceId: newBindings[1]!.sourceOccurrenceId, linkedAt: now, updatedAt: now });
  await ctx.db.patch(before.receipt._id, { expectedKeys: plan.expectedKeys, expectedOccurrences, satisfiedKeys: plan.expectedKeys,
    satisfiedOccurrences: [vinyl, tavan].map((event) => ({ key: event.sourceOccurrenceKey!, eventId: event._id })), deferredChildCount: 0, deferredChildKeys: [], updatedAt: nextEventUpdatedAt(before.receipt.updatedAt, now) });
  await refreshCanonicalEventDerivedStates(ctx, [primary._id, secondaryId]);
  for (const eventId of [primary._id, secondaryId]) {
    const event = await ctx.db.get(eventId);
    if (!event || (await evaluateEventPublication(ctx, event)).state !== "publishable" || !(await isEventPubliclyVisible(ctx, event))) return fail("both split programmes must be publicly visible.");
  }
  const after = await loadContext(ctx);
  if (!after.complete || !exactJsonValue(after.saves, before.saves) || after.secondarySaves?.canonical.length || after.secondarySaves?.legacy.length ||
    !exactJsonValue(after.source, before.source) || !exactJsonValue(after.asset, before.asset) || !exactJsonValue(after.controls, before.controls) ||
    after.oldOccurrence.factsJson !== before.oldOccurrence.factsJson || after.oldOccurrence.canonicalEventJson !== before.oldOccurrence.canonicalEventJson) return fail("split changed immutable evidence, original saves, or an independent performance.");
  for (const eventId of [primary._id, secondaryId]) await writeEventAuditLog(ctx, eventId, "reviewed_vinyl_tavan_poster_split", { actor, note,
    patch: { ...baseMarker, vinylEventId: primary._id, tavanEventId: secondaryId, originalEvent: primary, originalSourceLink: before.links[0], originalReceipt: before.receipt,
      originalOccurrenceId: before.oldOccurrence._id, savedReferencesRemainOnOriginalEvent: true } });
  return { vinylEventId: primary._id, tavanEventId: secondaryId, vinylUpdatedAt: primaryUpdatedAt };
}
