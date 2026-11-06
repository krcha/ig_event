import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  hasHumanReviewedStructuredSourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { requireAdminOrServiceSecret } from "../../authz";
import { isSupportedExtractionModel } from "../extractionModel";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { evaluateEventPublication, isEventPubliclyVisible } from "../../publicationPolicy";
import { savedEventRepository } from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { resolveVenueDenormalizedFieldsFromPublicVenues } from "../../eventDomain/moderationVenue";
import {
  prepareInstagramOccurrenceTopologyForDedicatedReattestation,
  reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { assertApprovalCandidatePolicy, assertPersistedServiceSourcePolicy } from "../../eventDomain/sourceApproval";
import { withNovember2026ReadCache } from "./reviewedNovember2026Repairs";

// Frozen operator review, not an extraction rule or generic same-day merge.
export const DRUGSTORE_NOVEMBER_2026_REVIEW = {
  groupKey: "drugstore-antibo-nov7",
  operationId: "reviewed-drugstore-november-2026:antibo-nov7:v1",
  date: "2026-11-07",
  sourceHandle: "antiboemska.veselja",
  venueId: "k17e6bhe8pb9kbs1wm2a6jy0y5897n7j",
  venueName: "Drugstore Belgrade",
  venueHandle: "clubdrugstore",
  rows: [
    { id: "j57945w9y08afq653hhxxca0nx8hng80", code: "DfWhINjCG-U", postId: "4023549016939196308", title: "ANTIBO", time: "22:00", venue: "Klub Drugstore", status: "approved", key: "instagram-occurrence-v2:a5efc511ac9267ada8622533d677d97ee0240da6d48d6f3febe7c2289014a0fe" },
    { id: "j575v7xd0a6e63tev57xqxan8d8gth2y", code: "DezLV3zI7X4", postId: "4013601574451656184", title: "ANTIBO BEOGRAD", time: "TBD", venue: "Dragstor", status: "approved", key: "instagram-occurrence-v2:e6ffa7764c86496efa4e85754c43e1ef27c7782f22d96405423810dd413cc04f" },
    { id: "j572q7zr5bhx6bhy318pvxm3fd8h8728", code: "DfFr66ziIlT", postId: "4018811407369275731", title: "ANTIBO", time: "TBD", venue: "Drugstore", status: "approved", key: "instagram-occurrence-v2:e14efad906abe1119bf8ebbc1612f1d868a86014ae3f056c63d3636a50fdbf81" },
    { id: "j57cwekj5w07c7yj1543jy671h8hjbpr", code: "DfSlyDXiCR8", postId: "4022443584506045564", title: "ACID FOV", time: "TBD", venue: "Drugstore", status: "pending", key: "instagram-occurrence-v2:38d1aab4e44351b3315a70a51d815be35fc2347a8e72254c2ccc5a0b25ef2abe" },
  ],
} as const;

type ReadCtx = QueryCtx | MutationCtx;
const MAX_ROWS = 32;
const MAX_SAVES = 100;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const fail = (message: string): never => { throw new Error(`Reviewed Drugstore repair: ${message}`); };
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sorted = <T extends { _id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a._id.localeCompare(b._id));
function parseFields(event: Doc<"events">): Record<string, unknown> {
  const fields: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fail("invalid normalized evidence.");
  return fields as Record<string, unknown>;
}
function contextDigest(context: unknown): string {
  const serialized = stableJson(context);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONTEXT_BYTES) return fail("incident context exceeds its bounded proof size.");
  return sha256Hex(serialized);
}
async function requireService(ctx: ReadCtx, secret: string): Promise<string> {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") return fail("service authentication is required.");
  return auth.actor;
}

async function loadContext(ctx: ReadCtx) {
  const review = DRUGSTORE_NOVEMBER_2026_REVIEW;
  const events: Doc<"events">[] = [];
  for (const pin of review.rows) {
    const event = await ctx.db.get(pin.id as Id<"events">);
    if (!event) return fail("a pinned event disappeared.");
    events.push(event);
  }
  const primary = events[0]!;
  const venue = await ctx.db.get(review.venueId as Id<"venues">);
  if (!venue || !isVenuePublic(venue) || venue.name !== review.venueName || venue.instagramHandle !== review.venueHandle) {
    return fail("the exact public target venue changed.");
  }
  const marker = parseFields(primary).reviewedNovember2026Repair as Record<string, unknown> | undefined;
  const complete = marker?.groupKey === review.groupKey && marker.role === "primary";
  if (complete && (marker.operationId !== review.operationId || marker.primaryId !== primary._id ||
    !exactJsonValue(marker.componentIds, events.slice(1).map((event) => event._id)) ||
    primary.venueId !== venue._id || primary.venue !== venue.name)) return fail("applied incident marker or venue binding changed.");
  const links: Doc<"instagramEventSources">[] = [];
  const occurrences: Doc<"sourceOccurrences">[] = [];
  const receiptsById = new Map<string, Doc<"instagramSourceOccurrenceReceipts">>();
  const sourcesById = new Map<string, Doc<"scrapedPosts">>();
  const selectedIds = new Set(events.map((event) => event._id));
  for (const [index, event] of events.entries()) {
    const pin = review.rows[index]!;
    const fields = parseFields(event);
    const eventMarker = fields.reviewedNovember2026Repair as Record<string, unknown> | undefined;
    if (event.date !== review.date || event.title !== pin.title || (event.time ?? "TBD") !== pin.time ||
      event.instagramPostId !== pin.postId || event.instagramPostUrl !== `https://www.instagram.com/p/${pin.code}/` ||
      event.sourceOccurrenceKey !== pin.key || fields.sourceOccurrenceKey !== pin.key ||
      !exactJsonValue(event.artists, []) || fields.sourceGroundingInstagramHandle !== review.sourceHandle ||
      event.venue !== (complete && index === 0 ? venue.name : pin.venue) ||
      event.venueId !== (complete && index === 0 ? venue._id : undefined) ||
      event.status !== (complete ? index === 0 ? "approved" : "rejected" : pin.status) ||
      (!complete && isCrossPostCampaignLineageEvent(event)) ||
      (complete && (eventMarker?.groupKey !== review.groupKey || eventMarker.operationId !== review.operationId ||
        eventMarker.role !== (index === 0 ? "primary" : "component") || eventMarker.primaryId !== primary._id ||
        !exactJsonValue(eventMarker.componentIds, events.slice(1).map((item) => item._id)))) ||
      fields.extractionContractVersion !== "event_evidence_v2" || fields.extractionIsEvent !== true ||
      fields.sourceGroundingVersion !== 5 || fields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2") {
      return fail("a pinned original venue, title, status, time, date, or source changed.");
    }
    const eventLinks = complete
      ? await ctx.db.query("instagramEventSources").withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", `instagram-source-identity-v1:${pin.code}`).eq("sourceOccurrenceKey", pin.key)).take(2)
      : await ctx.db.query("instagramEventSources").withIndex("by_event", (q) => q.eq("eventId", event._id)).take(2);
    if (eventLinks.length !== 1) return fail("original source-link cohort changed.");
    const link = eventLinks[0]!;
    if (link.eventId !== (complete ? primary._id : event._id) || link.sourceIdentity !== `instagram-source-identity-v1:${pin.code}` ||
      link.instagramPostId !== pin.postId || link.instagramPostUrl !== event.instagramPostUrl || link.sourceOccurrenceKey !== pin.key ||
      link.sourceFingerprint !== fields.sourceOccurrenceSourceFingerprint) return fail("selected source link is inconsistent.");
    const occurrenceRows = link.sourceOccurrenceId ? [await ctx.db.get(link.sourceOccurrenceId)]
      : await ctx.db.query("sourceOccurrences").withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", link.sourceIdentity).eq("sourceOccurrenceKey", pin.key)).take(2);
    const occurrence = occurrenceRows.length === 1 ? occurrenceRows[0] : null;
    if (!occurrence || occurrence.state !== "satisfied" || occurrence.canonicalEventId !== (complete ? primary._id : event._id) ||
      occurrence.sourceIdentity !== link.sourceIdentity || occurrence.sourceOccurrenceKey !== pin.key ||
      occurrence.sourceFingerprint !== link.sourceFingerprint) return fail("first-class occurrence changed or is incomplete.");
    const receiptRows = await ctx.db.query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", link.sourceIdentity)).take(2);
    if (receiptRows.length !== 1) return fail("source receipt is not unique.");
    const receipt = receiptRows[0]!;
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    const expected = receipt.expectedOccurrences?.filter((row) => row.key === pin.key) ?? [];
    const satisfied = receipt.satisfiedOccurrences.filter((row) => row.key === pin.key);
    if (receipt.sourceFingerprint !== link.sourceFingerprint || expected.length !== 1 || satisfied.length !== 1 ||
      satisfied[0]!.eventId !== (complete ? primary._id : event._id) ||
      !sourceOccurrenceRepresentativeMatchesExpected(complete ? primary : event, expected[0]) ||
      receipt.deferredChildCount !== 0 || receipt.deferredChildKeys.length !== 0 ||
      receipt.expectedKeys.length !== receipt.satisfiedKeys.length || receipt.expectedKeys.length > MAX_ROWS) {
      return fail("selected receipt row is incomplete or inconsistent.");
    }
    const source = await ctx.db.get(occurrence.sourceDocumentId);
    if (!source || source.handle !== review.sourceHandle || source.postId !== pin.postId ||
      source.instagramPostUrl !== event.instagramPostUrl || source.caption !== event.sourceCaption || source.postedAt !== event.sourcePostedAt ||
      source.analysisRevision !== (source.sourceRevision ?? 1) || occurrence.sourceRevision !== (source.sourceRevision ?? 1) ||
      source.analysisContractVersion !== "event_evidence_v2" || source.analysisIsEvent !== true ||
      !isSupportedExtractionModel(source.analysisModel) || source.analysisResultJson !== event.rawExtractionJson) {
      return fail("persisted source author, analysis, or revision changed.");
    }
    if (index === 3 && !source.caption?.includes("ANTIBO BEOGRAD ACID FOV")) return fail("ACID FOV is no longer bound to the reviewed ANTIBO announcement.");
    // Independently prove every original source, including the pending guest
    // variant. This transient review never publishes or edits a component.
    const sourceCandidate: Doc<"events"> = { ...event, status: "approved",
      normalizedFieldsJson: JSON.stringify({ ...fields, humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION }),
      humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
      reviewedAt: event.updatedAt, reviewedBy: "service:reviewed-drugstore-source-proof",
      moderationNote: "Exact original Drugstore ANTIBO source independently reviewed before the frozen incident fold." };
    if (!hasHumanReviewedStructuredSourceAttestation(sourceCandidate.normalizedFieldsJson, sourceCandidate) ||
      !(await isCanonicallyGroundedApprovedEvent(ctx, sourceCandidate))) return fail("an original source does not independently retain its current persisted analysis proof.");
    links.push(link); occurrences.push(occurrence);
    receiptsById.set(receipt._id, receipt); sourcesById.set(source._id, source);
  }
  const siblingsById = new Map<string, Doc<"events">>();
  for (const receipt of receiptsById.values()) for (const satisfaction of receipt.satisfiedOccurrences) {
    if (selectedIds.has(satisfaction.eventId)) continue;
    const sibling = await ctx.db.get(satisfaction.eventId);
    const expected = receipt.expectedOccurrences?.filter((row) => row.key === satisfaction.key) ?? [];
    if (!sibling || expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(sibling, expected[0])) return fail("an unrelated receipt sibling is incomplete.");
    siblingsById.set(sibling._id, sibling);
    if (siblingsById.size > MAX_ROWS) return fail("receipt sibling bound exceeded.");
  }
  const saves = [];
  for (const event of events) {
    const refs = await savedEventRepository.loadEventReferences(ctx, event._id, { limit: MAX_SAVES });
    if (complete && event._id !== primary._id && (refs.canonical.length || refs.legacy.length)) return fail("applied component retains saved references.");
    saves.push({ eventId: event._id, canonical: sorted(refs.canonical), legacy: sorted(refs.legacy) });
  }
  if (complete) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
    if (topology.links.length !== review.rows.length || topology.currentOccurrences.length !== review.rows.length ||
      !(await isEventPubliclyVisible(ctx, primary))) return fail("applied primary publication or provenance is incomplete.");
    for (const component of events.slice(1)) {
      const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, component._id);
      if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("applied component retained provenance.");
    }
  }
  return { groupKey: review.groupKey, complete, primaryId: primary._id, events, links, occurrences,
    receipts: sorted([...receiptsById.values()]), sources: sorted([...sourcesById.values()]), venue,
    siblings: sorted([...siblingsById.values()]), saves };
}

export async function getReviewedDrugstoreNovember2026ContextHandler(ctx: QueryCtx, args: { serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  await requireService(ctx, args.serviceSecret);
  const context = await loadContext(ctx);
  return { ...context, contextSha256: contextDigest(context) };
}

export async function consolidateReviewedDrugstoreNovember2026Handler(ctx: MutationCtx,
  args: { expectedContextSha256: string; moderationNote: string; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  const actor = await requireService(ctx, args.serviceSecret);
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (note.length < 30 || note.length > 1000 || !/^[a-f0-9]{64}$/u.test(args.expectedContextSha256)) return fail("a bounded reviewed context and substantive note are required.");
  const context = await loadContext(ctx);
  if (context.complete) return fail("incident is already applied; inspect the final context.");
  if (contextDigest(context) !== args.expectedContextSha256) return fail("reviewed context changed; preview again.");
  const review = DRUGSTORE_NOVEMBER_2026_REVIEW;
  const primary = context.events[0]!;
  const components = context.events.slice(1);
  const selectedIds = new Set(context.events.map((event) => event._id));
  const now = Date.now();
  const marker = { policyVersion: 1, operationId: review.operationId, groupKey: review.groupKey,
    primaryId: primary._id, componentIds: components.map((event) => event._id), reviewedAt: now, reviewedBy: actor };
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues([context.venue], review.venueName);
  if (venueFields.venueId !== context.venue._id) return fail("the canonical venue did not resolve exactly.");
  const nextFields = { ...parseFields(primary), normalizedVenue: review.venueName,
    moderationAutoApproved: false, moderationAutoApproveRule: null,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedVenueCorrection: { policyVersion: 1, reviewedAt: now, reviewedBy: actor,
      previousVenue: primary.venue, venue: review.venueName, evidence: "KLUB DRUGSTORE" },
    reviewedNovember2026Repair: { ...marker, role: "primary" } };
  const effectivePrimary: Doc<"events"> = { ...primary, ...venueFields, venue: review.venueName,
    normalizedFieldsJson: JSON.stringify(nextFields),
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note };
  if (!hasHumanReviewedStructuredSourceAttestation(effectivePrimary.normalizedFieldsJson, effectivePrimary)) return fail("review did not bind the complete final public payload.");
  if (hasHumanReviewableStructuredSourceAttestation(effectivePrimary.normalizedFieldsJson, effectivePrimary)) {
    await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, { allowHumanReviewedStructured: true });
  }
  // Only the exact four reviewed source variants are excluded from collisions.
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, context.events.map((event) => event._id));
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) return fail("final public source proof failed.");
  const topologies = [];
  for (const component of components) topologies.push(await prepareInstagramOccurrenceTopologyForDedicatedReattestation(ctx, component._id));
  await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  const siblingsBefore = [];
  for (const sibling of context.siblings) siblingsBefore.push({ event: sibling,
    decision: await evaluateEventPublication(ctx, sibling),
    visible: await isEventPubliclyVisible(ctx, sibling, { allowNeverMigratedApproved: true }) });
  const receiptPlans = context.receipts.map((receipt) => {
    const selectedKeys = new Set(context.links.filter((link) => link.sourceIdentity === receipt.sourceIdentity).map((link) => link.sourceOccurrenceKey));
    return { receipt,
      expectedOccurrences: receipt.expectedOccurrences!.map((row) => selectedKeys.has(row.key)
        ? { ...row, title: primary.title, date: primary.date, time: primary.time, venue: review.venueName, artists: primary.artists } : row),
      satisfiedOccurrences: receipt.satisfiedOccurrences.map((row) => selectedIds.has(row.eventId) ? { ...row, eventId: primary._id } : row) };
  });
  for (const plan of receiptPlans) for (const satisfaction of plan.satisfiedOccurrences) {
    const expected = plan.expectedOccurrences.filter((row) => row.key === satisfaction.key);
    const representative = satisfaction.eventId === primary._id ? effectivePrimary : await ctx.db.get(satisfaction.eventId);
    if (expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(representative, expected[0])) return fail("review would invalidate an existing receipt satisfaction.");
  }
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, now);
  await ctx.db.patch(primary._id, { ...venueFields, ...buildEventOccurrenceIndexPatch(effectivePrimary), venue: review.venueName,
    normalizedFieldsJson: effectivePrimary.normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note, updatedAt: primaryUpdatedAt });
  for (const plan of receiptPlans) await ctx.db.patch(plan.receipt._id, {
    expectedOccurrences: plan.expectedOccurrences, satisfiedOccurrences: plan.satisfiedOccurrences,
    updatedAt: nextEventUpdatedAt(plan.receipt.updatedAt, now) });
  let movedSaveCount = 0; let dedupedSaveCount = 0;
  for (const [index, component] of components.entries()) {
    await ctx.db.patch(component._id, { status: "rejected", reviewedAt: now, reviewedBy: actor,
      moderationNote: `[reviewed_november_component:v1] ${review.operationId} - ${note}`,
      normalizedFieldsJson: JSON.stringify({ ...parseFields(component), reviewedNovember2026Repair: { ...marker, role: "component" } }),
      updatedAt: nextEventUpdatedAt(component.updatedAt, now) });
    await reassignInstagramOccurrenceReferences(ctx, component._id, primary._id, topologies[index]!);
    const saves = await reassignSavedEventReferences(ctx, component._id, primary._id);
    movedSaveCount += saves.movedCount; dedupedSaveCount += saves.dedupedCount;
  }
  for (const link of context.links) {
    const plan = receiptPlans.find((item) => item.receipt.sourceIdentity === link.sourceIdentity)!;
    const expected = plan.expectedOccurrences.find((row) => row.key === link.sourceOccurrenceKey)!;
    await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, {
      expected, representative: effectivePrimary, sourceFingerprint: link.sourceFingerprint, sourceLink: link, topologyEpochVerified: true });
  }
  const finalTopology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  if (finalTopology.links.length !== context.links.length || finalTopology.currentOccurrences.length !== context.occurrences.length) return fail("final primary source topology is incomplete.");
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(ctx, primary._id, effectivePrimary);
  for (const component of components) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, component._id);
    if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("a rejected component retained source references.");
  }
  for (const before of context.occurrences) {
    const after = await ctx.db.get(before._id);
    if (!after || after.factsJson !== before.factsJson || after.canonicalEventJson !== before.canonicalEventJson ||
      after.sourceDocumentId !== before.sourceDocumentId || after.sourceRevision !== before.sourceRevision) return fail("immutable observed source evidence changed.");
  }
  for (const source of context.sources) if (!exactJsonValue(await ctx.db.get(source._id), source)) return fail("a persisted source document changed.");
  for (const event of context.events) await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  const published = await ctx.db.get(primary._id);
  if (!published || (await evaluateEventPublication(ctx, published)).state !== "publishable" || !(await isEventPubliclyVisible(ctx, published))) return fail("retained primary is not publicly visible.");
  for (const before of siblingsBefore) {
    const after = await ctx.db.get(before.event._id);
    if (!after || !exactJsonValue(after, before.event) || !exactJsonValue(await evaluateEventPublication(ctx, after), before.decision) ||
      (before.visible && !(await isEventPubliclyVisible(ctx, after)))) return fail("an unrelated sibling changed or lost publication.");
  }
  for (const before of context.events) {
    const after = await ctx.db.get(before._id);
    if (!after || after.rawExtractionJson !== before.rawExtractionJson || after.sourceCaption !== before.sourceCaption ||
      after.instagramPostId !== before.instagramPostId || after.instagramPostUrl !== before.instagramPostUrl ||
      after.sourcePostedAt !== before.sourcePostedAt || after.imageStorageId !== before.imageStorageId) return fail("original event evidence changed.");
    await writeEventAuditLog(ctx, before._id, before._id === primary._id ? "reviewed_drugstore_november_consolidated" : "reviewed_drugstore_november_component_rejected", {
      actor, note, patch: { ...marker, before, sourceLinksBefore: context.links.filter((link) => link.eventId === before._id), movedSaveCount, dedupedSaveCount } });
  }
  return { primaryId: primary._id, rejectedIds: components.map((event) => event._id), primaryUpdatedAt, movedSaveCount, dedupedSaveCount };
}

export const stableDrugstoreNovember2026ContextJson = stableJson;
