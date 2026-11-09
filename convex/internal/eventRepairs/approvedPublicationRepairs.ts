import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { parseCanonicalEventPayload } from "../../../lib/domain/occurrences/canonical-event-payload";
import { parseStructuredFactsJson } from "../../../lib/domain/occurrences/facts";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { getEventTimeSortMinutes } from "../../../lib/events/event-time";
import { readPersistedSourceOccurrenceBinding, sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { getBelgradeDayKey } from "../../../lib/pipeline/belgrade-day-key";
import { normalizeHandle, normalizeVenueComparableText, toSearchableText } from "../../../lib/pipeline/venue-normalization";
import { canonicalizeEventType } from "../../../lib/taxonomy/venue-types";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { writeEventAuditLog } from "../../eventDomain/persistence";
import { assertApprovalCandidatePolicy, classifyApprovalCandidates } from "../../eventDomain/sourceApproval";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { evaluateEventPublication, isEventPubliclyVisible, toPublicationPatch } from "../../publicationPolicy";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { isSupportedExtractionModel } from "../extractionModel";
import { assertExistingSourceOccurrenceReceiptWithinBounds, assertSourceOccurrencePlanMatchesSourceDocument, recordSourceOccurrenceSatisfaction, type SourceOccurrencePlan } from "../sourceOccurrenceReceipts";
import { withNovember2026ReadCache } from "./reviewedNovember2026Repairs";

type ReadCtx = QueryCtx | MutationCtx;
type Expected = SourceOccurrencePlan["expectedOccurrences"][number];
type Target = { id: Id<"events">; sourceIdentity?: string; serviceSecret: string };
const MAX_ROWS = 32;
const MAX_MISSING = 6;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonObject(value: string | undefined) {
  try { return object(JSON.parse(value ?? "null")); } catch { return null; }
}

function words(value: string) {
  return toSearchableText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function text(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

function equalArtists(left: unknown, right: readonly string[]) {
  return Array.isArray(left) && left.every((item) => typeof item === "string") &&
    JSON.stringify(left.map(words).sort()) === JSON.stringify(right.map(words).sort());
}

function timeMatches(expected: string | undefined, actual: string | undefined) {
  const expectedMinutes = getEventTimeSortMinutes(expected);
  return expectedMinutes === null ? !expected || expected.toUpperCase() === "TBD" :
    expectedMinutes === getEventTimeSortMinutes(actual);
}

function hasExactVenueClaim(venue: Doc<"venues">, claim: string) {
  const normalized = normalizeVenueComparableText(claim);
  const handle = normalizeHandle(venue.instagramHandle);
  return Boolean(normalized && [venue.name, ...(venue.aliases ?? [])].some((name) =>
    normalizeVenueComparableText(name) === normalized)) ||
    (Boolean(handle) && /^@?[\w.]+$/u.test(claim) && normalizeHandle(claim) === handle);
}

/** Match the immutable selected schedule row and its stored date evidence. */
function verifiedSavedRow(expected: Expected, entries: Record<string, unknown>[], venue: Doc<"venues">) {
  const facts = parseStructuredFactsJson(expected.factsJson);
  const payload = parseCanonicalEventPayload(expected.canonicalEventJson);
  if (!facts?.sourceRowIdentity || !facts.policy.structuredEvidenceVerified || !payload ||
      facts.localDate !== expected.date || payload.dateEvidenceResolvedDate !== expected.date ||
      payload.dateEvidenceIsRelative === true || payload.sourceConflictFields.length > 0 ||
      words(facts.titleClaim) !== words(expected.title) || !equalArtists(facts.artistClaims, expected.artists) ||
      !hasExactVenueClaim(venue, expected.venue)) return null;
  const matches = entries.filter((row) => text(row.source_text) === text(facts.sourceRowIdentity));
  const row = matches.length === 1 ? matches[0] : null;
  const date = object(row?.date_evidence);
  if (!row || !date || date.resolved_date !== expected.date || date.is_relative === true ||
      !["poster", "caption", "alt_text"].includes(text(date.source)) || !text(date.exact_text) ||
      !text(row.source_text).includes(text(date.exact_text).split(";")[0]!.trim()) ||
      words(text(row.title)) !== words(expected.title) || !equalArtists(row.artists, expected.artists) ||
      !hasExactVenueClaim(venue, text(row.venue) || expected.venue) ||
      !timeMatches(expected.time, text(row.time))) return null;
  return facts;
}

/** A presentation-only title alias may retain both original source payloads. */
export function reviewedReceiptRepresentativeBinding(expected: Expected, event: Doc<"events">): Expected | null {
  if (sourceOccurrenceRepresentativeMatchesExpected(event, expected)) return expected;
  const binding = readPersistedSourceOccurrenceBinding(jsonObject(event.normalizedFieldsJson));
  if (!binding || binding.date !== expected.date ||
      !timeMatches(expected.time, binding.time) || !timeMatches(expected.time, event.time)) return null;
  const expectedTitle = words(expected.title);
  const existingTitle = words(binding.title);
  const expectedType = canonicalizeEventType(parseStructuredFactsJson(expected.factsJson)?.eventTypeClaim);
  const currentType = canonicalizeEventType(event.eventType);
  const film = expectedType === "arts & culture" && currentType === "arts & culture" &&
    /(?:^| )(?:film|triler|projekcija|screening|thriller)(?: |$)/u.test(words(`${event.description ?? ""} ${event.sourceCaption ?? ""}`));
  const selfTitleAsArtist = expectedType === "live music" && currentType === "live music" &&
    existingTitle === expectedTitle && expected.artists.length === 1 && words(expected.artists[0]!) === expectedTitle;
  // Repertory rows often omit the cast. Equal named play and stated start are
  // required before the separately grounded detailed listing can represent it.
  const omittedCast = expectedType === "arts & culture" && currentType === "arts & culture" &&
    existingTitle === expectedTitle && expected.artists.length === 0 && getEventTimeSortMinutes(expected.time) !== null;
  if (!equalArtists(binding.artists, expected.artists) && !selfTitleAsArtist && !omittedCast) return null;
  if (!existingTitle || (existingTitle !== expectedTitle &&
      !(film && (expectedTitle === `${existingTitle} film` || existingTitle === `${expectedTitle} film`)))) return null;
  return {
    ...expected,
    title: binding.title,
    venue: binding.venue,
    ...(expected.time && binding.time ? { time: binding.time } : {}),
    artists: binding.artists,
  };
}

async function requireService(ctx: ReadCtx, secret: string) {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") throw new Error("Approved publication repair requires service authentication.");
  return auth.actor;
}

async function loadRepair(ctx: ReadCtx, args: Target) {
  const day = getBelgradeDayKey();
  const event = await ctx.db.get(args.id);
  if (!event || event.status !== "approved" || event.date < day || !event.venueId ||
      event.publicationState === "publishable" || isCrossPostCampaignLineageEvent(event)) {
    throw new Error("Choose an upcoming hidden approved event with a canonical venue.");
  }
  const venue = await ctx.db.get(event.venueId);
  if (!venue || !isVenuePublic(venue) || event.venue !== venue.name ||
      !(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
    throw new Error("Approved event lacks current canonical venue or source proof.");
  }
  const decision = await evaluateEventPublication(ctx, event);
  if (decision.state === "publishable") return { event, venue, day, source: null, receipt: null, missing: [] } as const;
  if (decision.reason !== "occurrence_incomplete") throw new Error(`Repair requires occurrence evidence. Current blocker is ${decision.reason}.`);
  const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
  const incompleteReceipts = topology.receipts.filter((receipt) =>
    receipt.expectedKeys.some((key) => !receipt.satisfiedKeys.includes(key)));
  const receipt = args.sourceIdentity
    ? incompleteReceipts.find((row) => row.sourceIdentity === args.sourceIdentity)
    : incompleteReceipts.length === 1 ? incompleteReceipts[0] : undefined;
  if (!receipt) throw new Error("Choose one current incomplete receipt by its source identity.");
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const current = topology.currentOccurrences.filter((item) => item.sourceIdentity === receipt.sourceIdentity);
  const occurrence = current.length === 1 ? current[0] : undefined;
  const source = occurrence ? await ctx.db.get(occurrence.sourceDocumentId) : null;
  const raw = jsonObject(source?.analysisResultJson);
  if (!source || !occurrence || source.processingStatus === "processing" ||
      source.analysisRevision !== (source.sourceRevision ?? 1) || occurrence.sourceRevision !== (source.sourceRevision ?? 1) ||
      occurrence.sourceFingerprint !== receipt.sourceFingerprint || source.analysisContractVersion !== "event_evidence_v2" ||
      source.analysisIsEvent !== true || !isSupportedExtractionModel(source.analysisModel) ||
      !raw || raw.extraction_contract_version !== "event_evidence_v2" || raw.is_event !== true ||
      !Array.isArray(raw.schedule_entries) || raw.schedule_entries.length > 64 ||
      receipt.expectedKeys.length > MAX_ROWS || receipt.deferredChildCount !== 0 ||
      !receipt.expectedOccurrences || receipt.expectedOccurrences.length !== receipt.expectedKeys.length) {
    throw new Error("Receipt and its saved source must be current, complete in shape and bounded.");
  }
  // Expiring a missing row requires source/media proof from the very same post.
  if (source.analysisResultJson !== event.rawExtractionJson || source.postId !== event.instagramPostId) {
    throw new Error("Use the canonical representative of this source as the repair target.");
  }
  const unsatisfied = receipt.expectedOccurrences.filter((row) => !receipt.satisfiedKeys.includes(row.key));
  if (!unsatisfied.length || unsatisfied.length > MAX_MISSING) throw new Error("Missing receipt row count exceeds the reviewed repair bound.");
  const rows = raw.schedule_entries.map(object).filter((row): row is Record<string, unknown> => row !== null);
  const used = new Set(receipt.satisfiedOccurrences.map((row) => row.eventId));
  const missing = [];
  for (const expected of unsatisfied) {
    const proof = verifiedSavedRow(expected, rows, venue);
    const info = { key: expected.key, title: expected.title, date: expected.date };
    if (!proof) {
      missing.push({ ...info, outcome: "missing_source_row" as const, representative: null, nextExpected: null });
      continue;
    }
    if (expected.date < day) {
      missing.push({ ...info, outcome: "expired" as const, representative: null, nextExpected: null });
      continue;
    }
    const cohort = await ctx.db.query("events").withIndex("by_venueId_status_date", (q) =>
      q.eq("venueId", venue._id).eq("status", "approved").eq("date", expected.date)).take(17);
    const matches = cohort.flatMap((candidate) => {
      if (candidate.instagramPostId === source.postId || isCrossPostCampaignLineageEvent(candidate) ||
          (candidate.sourceConflictFields?.length ?? 0) > 0 || !hasExactVenueClaim(venue, candidate.venue)) return [];
      const binding = reviewedReceiptRepresentativeBinding(expected, candidate);
      return binding && hasExactVenueClaim(venue, binding.venue) ? [{ representative: candidate, nextExpected: binding }] : [];
    });
    const match = cohort.length <= 16 && matches.length === 1 && !used.has(matches[0]!.representative._id) ? matches[0] : null;
    if (!match || !(await isCanonicallyGroundedApprovedEvent(ctx, match.representative))) {
      missing.push({ ...info, outcome: "missing_unique_approved_representative" as const, representative: null, nextExpected: null });
      continue;
    }
    used.add(match.representative._id);
    missing.push({ ...info, outcome: "attach" as const, ...match });
  }
  return { event, venue, day, source, receipt, missing };
}

function describe(plan: Awaited<ReturnType<typeof loadRepair>>) {
  const missing = plan.missing.map(({ representative, nextExpected, ...row }) => ({
    ...row, representativeId: representative?._id ?? null,
    representativeTitle: nextExpected?.title ?? null,
  }));
  const ready = missing.every((row) => row.outcome === "attach" || row.outcome === "expired");
  const reviewDigest = sha256Hex(JSON.stringify({
    day: plan.day, id: plan.event._id, eventVersion: plan.event.updatedAt, venueVersion: plan.venue.updatedAt,
    source: plan.source?._id, sourceRevision: plan.source?.sourceRevision, sourceVersion: plan.source?.updatedAt, receipt: plan.receipt,
    representativeVersions: plan.missing.map((row) => row.representative?.updatedAt ?? null), missing,
  }));
  return { id: plan.event._id, title: plan.event.title, sourceIdentity: plan.receipt?.sourceIdentity ?? null,
    ready, reviewDigest, missing };
}

export async function previewApprovedPublicationRepair(ctx: QueryCtx, args: Target) {
  await requireService(ctx, args.serviceSecret);
  return describe(await loadRepair(withNovember2026ReadCache(ctx), args));
}

async function refreshRepairedRepresentatives(ctx: MutationCtx, affected: Set<Id<"events">>) {
  const readCtx = withNovember2026ReadCache(ctx);
  const decisions = new Map<Id<"events">, { event: Doc<"events">; patch: ReturnType<typeof toPublicationPatch> }>();
  for (const id of affected) {
    const event = await readCtx.db.get(id);
    if (!event) throw new Error("A receipt representative disappeared during repair.");
    const patch = toPublicationPatch(await evaluateEventPublication(readCtx, event));
    if (event.publicationState === "publishable" && patch.publicationState !== "publishable") {
      throw new Error("Receipt repair would hide an already published event.");
    }
    decisions.set(id, { event, patch });
  }
  for (const { event, patch } of decisions.values()) {
    if (event.publicationState === "publishable" || patch.publicationState !== "publishable" || !event.venueId) continue;
    const cohort = await readCtx.db.query("events").withIndex("by_venueId_status_date", (q) =>
      q.eq("venueId", event.venueId).eq("status", "approved").eq("date", event.date)).take(17);
    if (cohort.length > 16 || cohort.some((other) => other._id !== event._id &&
        (decisions.get(other._id)?.patch.publicationState ?? other.publicationState) === "publishable" &&
        classifyApprovalCandidates(event, other) === "proven_duplicate")) {
      throw new Error(`Receipt repair would expose another approved copy of ${event.title}.`);
    }
  }
  for (const { event, patch } of decisions.values()) {
    if (event.publicationPolicyVersion !== patch.publicationPolicyVersion ||
        event.publicationReason !== patch.publicationReason || event.publicationState !== patch.publicationState) {
      await ctx.db.patch(event._id, patch);
    }
  }
}

export async function applyApprovedPublicationRepair(ctx: MutationCtx, args: Target & { reviewDigest: string; moderationNote: string }) {
  const actor = await requireService(ctx, args.serviceSecret);
  const note = args.moderationNote.trim();
  if (note.length < 20 || note.length > 1_000) throw new Error("A substantive repair note is required.");
  const plan = await loadRepair(withNovember2026ReadCache(ctx), args);
  const review = describe(plan);
  if (!review.ready || review.reviewDigest !== args.reviewDigest) throw new Error("The reviewed repair changed or remains blocked. Preview it again.");
  await assertApprovalCandidatePolicy(ctx, plan.event, [plan.event._id]);
  const affected = new Set<Id<"events">>([plan.event._id]);
  if (plan.receipt && plan.source) {
    const expired = new Set(plan.missing.filter((row) => row.outcome === "expired").map((row) => row.key));
    const attachments = plan.missing.filter((row) => row.outcome === "attach");
    const changedByKey = new Map(attachments.map((row) => [row.key, row.nextExpected!]));
    const sourcePlan: SourceOccurrencePlan = {
      sourceIdentity: plan.receipt.sourceIdentity,
      sourceFingerprint: plan.receipt.sourceFingerprint,
      expectedKeys: plan.receipt.expectedKeys.filter((key) => !expired.has(key)),
      expectedOccurrences: plan.receipt.expectedOccurrences!.filter((row) => !expired.has(row.key))
        .map((row) => changedByKey.get(row.key) ?? row),
      confirmedPastKeys: [...expired], deferredChildCount: 0, deferredChildKeys: [],
      observedChildKeys: plan.receipt.expectedKeys,
    };
    assertSourceOccurrencePlanMatchesSourceDocument(sourcePlan, plan.source);
    const records = attachments.length > 0 ? attachments.map((row) => ({ key: row.key, id: row.representative!._id })) :
      [{ key: plan.receipt.satisfiedOccurrences.find((row) => row.eventId === plan.event._id)!.key, id: plan.event._id }];
    for (const { key, id } of records) {
      const result = await recordSourceOccurrenceSatisfaction(ctx, sourcePlan, key, id, plan.source);
      for (const affectedId of result.representativeEventIds) affected.add(affectedId);
    }
  }
  await refreshRepairedRepresentatives(ctx, affected);
  const event = await ctx.db.get(plan.event._id);
  if (!event || !(await isEventPubliclyVisible(ctx, event))) {
    throw new Error("Current public source proof still blocks the selected event. Repair was rolled back.");
  }
  await writeEventAuditLog(ctx, event._id, "approved_publication_receipt_repaired", {
    actor, note, patch: { receiptId: plan.receipt?._id ?? null, ...review, affectedIds: [...affected] },
  });
  return { id: event._id, affectedIds: [...affected], attachedCount: review.missing.filter((row) => row.outcome === "attach").length,
    expiredCount: review.missing.filter((row) => row.outcome === "expired").length };
}
