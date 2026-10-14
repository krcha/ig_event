import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { hasHumanReviewableStructuredSourceAttestation, nextEventUpdatedAt } from "../../lib/events/event-update-precondition";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { loadPublicVenueSnapshot, resolveVenueFromSnapshot } from "../venueResolver";
import { hasCompleteAutomaticUniqueSourceProof } from "./automaticUniqueSourceProof";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import { rebindCanonicalVenueProvenance } from "../eventDomain/moderationVenue";
import { assertPersistedServiceSourcePolicy } from "../eventDomain/sourceApproval";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { markSourceOccurrenceTopologyMutation } from "./sourceOccurrenceTopologyEpoch";
import { refreshCanonicalEventDerivedStates, writeEventAuditLog } from "../eventDomain/persistence";

/** Resolve an already evidenced alias, never choose a different physical venue. */
export async function repairAutomaticVenueAlias(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<{ repaired: boolean; reason: string }> {
  if (event.status !== "pending" || event.reviewedAt !== undefined || event.reviewedBy !== undefined) {
    return { repaired: false, reason: "human_review_or_status_changed" };
  }
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(event.normalizedFieldsJson ?? "null"); }
  catch { return { repaired: false, reason: "invalid_normalized_evidence" }; }
  if (!fields || Array.isArray(fields) || typeof fields !== "object" ||
      fields.humanReviewedLegacySourcePolicyVersion !== undefined ||
      fields.humanReviewedStructuredSourcePolicyVersion !== undefined ||
      event.humanReviewedLegacySourcePolicyVersion !== undefined ||
      event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
      fields.normalizedVenue !== event.venue || (event.sourceConflictFields?.length ?? 0) > 0 ||
      !hasHumanReviewableStructuredSourceAttestation(event.normalizedFieldsJson, event)) {
    return { repaired: false, reason: "venue_evidence_not_certified" };
  }
  const snapshot = await loadPublicVenueSnapshot(ctx);
  const resolved = resolveVenueFromSnapshot(snapshot, event.venue);
  const venue = resolved.venueFields.venueId ? snapshot.venueById.get(resolved.venueFields.venueId) : null;
  const sourceHandle = normalizeHandle(typeof fields.sourceGroundingInstagramHandle === "string" ? fields.sourceGroundingInstagramHandle : "");
  if (!venue || resolved.resolution.status !== "resolved" || !sourceHandle ||
      normalizeHandle(venue.instagramHandle) !== sourceHandle ||
      (event.venueId !== undefined && event.venueId !== venue._id) ||
      (event.venueInstagramHandle !== undefined && normalizeHandle(event.venueInstagramHandle) !== sourceHandle)) {
    return { repaired: false, reason: "venue_alias_not_exact_source_mapping" };
  }
  const sources = await ctx.db.query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle)).take(2);
  if (sources.length !== 1 || !sources[0]!.active || sources[0]!.role !== "venue" || sources[0]!.venueId !== venue._id) {
    return { repaired: false, reason: "venue_source_mapping_not_current" };
  }
  if (!(await hasCompleteAutomaticUniqueSourceProof(ctx, event))) {
    return { repaired: false, reason: "venue_source_proof_incomplete" };
  }
  const nextFields = { ...fields, normalizedVenue: venue.name, automaticVenueAliasRepairPolicyVersion: 1 };
  const next = { ...event, ...resolved.venueFields, venue: venue.name, normalizedFieldsJson: JSON.stringify(nextFields) };
  if (["venue", "venueId", "normalizedVenueIdentity", "normalizedVenueInstagramHandle"].every((key) =>
      event[key as keyof typeof event] === next[key as keyof typeof next])) {
    return { repaired: false, reason: "venue_binding_already_current" };
  }
  // All failure-prone proofs run before any write. The final operation is a
  // single transaction, including compatibility receipts and canonical rows.
  try {
    if (!hasHumanReviewableStructuredSourceAttestation(next.normalizedFieldsJson, next)) {
      return { repaired: false, reason: "canonical_venue_field_binding_unverified" };
    }
    await assertPersistedServiceSourcePolicy(ctx, next, { allowHumanReviewedStructured: true });
    await sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(ctx, event, next, { dryRun: true, topologyEpochVerified: true });
  } catch {
    return { repaired: false, reason: "canonical_venue_provenance_not_rebindable" };
  }
  const rebound = await rebindCanonicalVenueProvenance(ctx, event, next);
  await ctx.db.patch(event._id, { ...resolved.venueFields, venue: venue.name,
    normalizedFieldsJson: next.normalizedFieldsJson, ...buildEventOccurrenceIndexPatch(next), updatedAt: nextEventUpdatedAt(event.updatedAt) });
  await refreshCanonicalEventDerivedStates(ctx, rebound.affectedRepresentativeIds);
  if (rebound.topologyMutated) await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await writeEventAuditLog(ctx, event._id, "automatic_venue_alias_repaired", {
    actor: "service:autonomous-moderation", note: "Exact active source mapping and complete current occurrence provenance verified.",
    patch: { previousVenue: event.venue, venue: venue.name, policyVersion: 1 },
  });
  return { repaired: true, reason: "venue_alias_certified" };
}
