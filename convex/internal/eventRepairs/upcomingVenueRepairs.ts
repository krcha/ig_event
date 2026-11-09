import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { ConvexError, v } from "convex/values";
import { normalizeHandle } from "../../../lib/domain/venues/normalization";
import {
  hasHumanReviewableStructuredSourceAttestation,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { getBelgradeDayKey } from "../../../lib/pipeline/belgrade-day-key";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { rebindCanonicalVenueProvenance } from "../../eventDomain/moderationVenue";
import { refreshCanonicalEventDerivedStates, writeEventAuditLog } from "../../eventDomain/persistence";
import { assertApprovalCandidatePolicy, assertPersistedServiceSourcePolicy, classifyApprovalCandidates } from "../../eventDomain/sourceApproval";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { resolveVenueClaimsForWrite } from "../../venueResolver";
import { diagnoseCompleteAutomaticUniqueSourceProof } from "../automaticUniqueSourceProof";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";

export const upcomingVenueRepairPlan = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedStatus: v.union(v.literal("pending"), v.literal("approved")),
  venueId: v.id("venues"),
  expectedVenueUpdatedAt: v.number(),
  sourceAccountId: v.union(v.id("instagramSources"), v.null()),
  expectedSourceAccountUpdatedAt: v.union(v.number(), v.null()),
  sourcePostId: v.id("scrapedPosts"),
  expectedSourcePostUpdatedAt: v.number(),
  sourceRevision: v.number(),
  sourceFingerprint: v.string(),
  sourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
  receiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
});

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(value: string | undefined) {
  try { return object(JSON.parse(value ?? "null")); }
  catch { return null; }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function readUpcomingVenueRepairClaims(
  fields: Record<string, unknown>,
  raw: Record<string, unknown>,
): string[] | null {
  if (raw.extraction_contract_version !== "event_evidence_v2" || raw.is_event !== true ||
      !Array.isArray(raw.source_conflicts) ||
      raw.source_conflicts.some((value) => object(value)?.field === "venue") ||
      !Array.isArray(raw.schedule_entries) || raw.schedule_entries.length > 64) return null;

  const entries = raw.schedule_entries.map(object);
  const sourceLine = text(fields.rowSourceText) || text(fields.splitSourceLine);
  const matches = sourceLine
    ? entries.filter((row) => text(row?.source_text) === sourceLine)
    : [];
  const selectedVenues = matches.map((row) => text(row?.venue));
  if (entries.length > 0 && (matches.length === 0 ||
      (matches.length > 1 && selectedVenues.some((venue) => !venue)))) return null;

  // A poster may repeat the same show text on different dates. Each row must
  // name a venue and all claims must resolve alike. The receipt binds the date.
  const shared = object(object(raw.shared_schedule_context)?.venue);
  const sharedVenue = shared?.applies_to_all === true ? text(shared.value) : "";
  // A roundup header can name its host without describing a specific row's room.
  const rawVenue = entries.length === 0 || (!selectedVenues.some(Boolean) && !sharedVenue) ? text(raw.venue) : "";
  return [...new Set([...selectedVenues, sharedVenue, rawVenue].filter(Boolean))];
}

async function assertNoApprovedAliasConflict(ctx: QueryCtx | MutationCtx, nextEvent: Doc<"events">) {
  if (nextEvent.status !== "approved") return;
  const rows = await ctx.db.query("events")
    .withIndex("by_status_date", (q) => q.eq("status", "approved").eq("date", nextEvent.date))
    .take(501);
  if (rows.length > 500) throw new ConvexError("Approved date cohort exceeds the safe venue review bound.");
  const unbound = rows.filter((row) => row._id !== nextEvent._id && !row.venueId && row.venue.trim());
  const claims = [...new Set(unbound.map((row) => row.venue.trim()))];
  if (claims.length > 64) throw new ConvexError("Unbound venue names exceed the safe venue review bound.");
  if (claims.length === 0) return;
  const resolutions = await resolveVenueClaimsForWrite(ctx, claims);
  for (const row of unbound) {
    const resolved = resolutions.get(row.venue.trim());
    if (resolved?.resolution.status !== "resolved" || resolved.venueFields.venueId !== nextEvent.venueId) continue;
    const relation = classifyApprovalCandidates(nextEvent, { ...row, ...resolved.venueFields, venue: nextEvent.venue });
    if (relation === "proven_duplicate" || relation === "ambiguous") {
      throw new ConvexError("Another approved record at an exact alias may represent the same occurrence.");
    }
  }
}

export async function prepareUpcomingVenueRepair(
  ctx: QueryCtx | MutationCtx,
  args: { id: Id<"events">; expectedUpdatedAt: number },
) {
  const event = await ctx.db.get(args.id);
  if (!event || !Number.isSafeInteger(args.expectedUpdatedAt) || event.updatedAt !== args.expectedUpdatedAt) {
    throw new ConvexError("The event version changed or no longer exists.");
  }
  if ((event.status !== "pending" && event.status !== "approved") ||
      event.date < getBelgradeDayKey() || event.venueId ||
      (event.status === "pending" && (event.reviewedAt !== undefined || event.reviewedBy !== undefined)) ||
      (event.sourceConflictFields?.length ?? 0) > 0 ||
      !hasHumanReviewableStructuredSourceAttestation(event.normalizedFieldsJson, event)) {
    throw new ConvexError("Venue repair requires an unbound upcoming event with current structured evidence.");
  }
  const fields = parseObject(event.normalizedFieldsJson);
  const raw = parseObject(event.rawExtractionJson);
  const claims = fields && raw ? readUpcomingVenueRepairClaims(fields, raw) : null;
  const sourceHandle = normalizeHandle(text(fields?.sourceGroundingInstagramHandle));
  if (!fields || !claims || !sourceHandle) throw new ConvexError("The saved occurrence has no exact venue evidence.");

  const proof = await diagnoseCompleteAutomaticUniqueSourceProof(ctx, event);
  if (!proof.complete || !proof.sourcePostId || proof.sourceRevision === null) {
    throw new ConvexError(`Current occurrence proof is incomplete (${proof.reason}).`);
  }
  const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
  const [link] = topology.links;
  const [receipt] = topology.receipts;
  const sourcePost = await ctx.db.get(proof.sourcePostId);
  if (!link || !receipt || topology.links.length !== 1 || topology.receipts.length !== 1 || !sourcePost) {
    throw new ConvexError("Venue repair needs one exact saved source and receipt.");
  }

  const accountRows = await ctx.db.query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle)).take(2);
  if (accountRows.length > 1) throw new ConvexError("The posting account identity is ambiguous.");
  const sourceAccount = accountRows[0];
  const accountClaim = `@${sourceHandle}`;
  const storedVenue = text(event.venue);
  const savedClaims = [...new Set([...claims, storedVenue, ...(!claims.length ? [text(fields.rawVenue)] : [])].filter(Boolean))];
  const resolutions = await resolveVenueClaimsForWrite(ctx, [...savedClaims, accountClaim]);
  const explicit = savedClaims.map((claim) => resolutions.get(claim));
  const accountResolution = resolutions.get(accountClaim);
  const mappedVenueAccount = fields.sourceAccountRole === "venue" &&
    sourceAccount?.active && sourceAccount.role === "venue" && sourceAccount.venueId &&
    accountResolution?.venueFields.venueId === sourceAccount.venueId &&
    normalizeHandle(accountResolution.venueFields.venueInstagramHandle ?? "") === sourceHandle;
  const resolved = explicit[0] ?? (mappedVenueAccount ? accountResolution : undefined);
  const venueId = resolved?.venueFields.venueId;
  if (!resolved || resolved.resolution.status !== "resolved" || !venueId ||
      (!claims.length && (!mappedVenueAccount || sourceAccount.venueId !== venueId)) ||
      explicit.some((candidate) => candidate?.resolution.status !== "resolved" || candidate.venueFields.venueId !== venueId)) {
    throw new ConvexError("The source venue or alias does not resolve to one exact venue.");
  }
  const venue = await ctx.db.get(venueId);
  const venueHandle = normalizeHandle(venue?.instagramHandle ?? "");
  if (!venue || !venueHandle || !isVenuePublic(venue) ||
      resolved.canonicalVenueName !== venue.name ||
      (event.venueInstagramHandle && normalizeHandle(event.venueInstagramHandle) !== venueHandle)) {
    throw new ConvexError("The source venue is unavailable or contradicts an existing handle.");
  }

  const nextEvent: Doc<"events"> = {
    ...event,
    ...resolved.venueFields,
    venue: venue.name,
    normalizedFieldsJson: JSON.stringify({ ...fields, normalizedVenue: venue.name }),
  };
  try {
    await assertPersistedServiceSourcePolicy(ctx, nextEvent, { allowHumanReviewedStructured: true });
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Saved source proof failed.");
  }
  await assertNoApprovedAliasConflict(ctx, nextEvent);
  const plan = {
    id: event._id,
    expectedUpdatedAt: event.updatedAt,
    expectedStatus: event.status,
    venueId,
    expectedVenueUpdatedAt: venue.updatedAt,
    sourceAccountId: sourceAccount?._id ?? null,
    expectedSourceAccountUpdatedAt: sourceAccount?.updatedAt ?? null,
    sourcePostId: sourcePost._id,
    expectedSourcePostUpdatedAt: sourcePost.updatedAt,
    sourceRevision: proof.sourceRevision,
    sourceFingerprint: link.sourceFingerprint,
    sourceLinkId: link._id,
    expectedSourceLinkUpdatedAt: link.updatedAt,
    receiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
  } as const;
  return { event, nextEvent, plan, venuePatch: resolved.venueFields, venueHandle };
}

export async function persistUpcomingVenueRepair(
  ctx: MutationCtx,
  prepared: Awaited<ReturnType<typeof prepareUpcomingVenueRepair>>,
  actor: string,
) {
  const { event, nextEvent, venuePatch, plan } = prepared;
  if (event.status === "approved") await assertApprovalCandidatePolicy(ctx, nextEvent, [event._id]);
  const { affectedRepresentativeIds, topologyMutated } =
    await rebindCanonicalVenueProvenance(ctx, event, nextEvent);
  await ctx.db.patch(event._id, {
    ...venuePatch,
    venue: nextEvent.venue,
    normalizedFieldsJson: nextEvent.normalizedFieldsJson,
    ...buildEventOccurrenceIndexPatch(nextEvent),
    updatedAt: nextEventUpdatedAt(event.updatedAt),
  });
  await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
  if (topologyMutated) await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  const repaired = await ctx.db.get(event._id);
  if (!repaired || (event.status === "approved" &&
      (repaired.publicationState !== "publishable" || !(await isCanonicallyGroundedApprovedEvent(ctx, repaired))))) {
    throw new ConvexError(`Repaired approved event does not pass current publication proof (${repaired?.publicationReason ?? "missing"}).`);
  }
  await writeEventAuditLog(ctx, event._id, "upcoming_source_venue_repaired", {
    actor,
    patch: { previousVenue: event.venue, venue: repaired.venue, venueId: plan.venueId, sourcePostId: plan.sourcePostId },
  });
  return repaired;
}
