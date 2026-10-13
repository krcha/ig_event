import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION, AUTOMATIC_UNIQUE_APPROVAL_RULE, hasAutomaticUniqueStructuredSourceAttestation, hasHumanReviewableStructuredSourceAttestation } from "../../lib/events/event-update-precondition";
import { buildPendingModerationUniquenessReview, type PendingModerationUniquenessBuild } from "../eventDomain/moderationUniqueness";
import { assertPersistedServiceSourcePolicy } from "../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../eventDomain/sourceUrlPolicy";
import { AUTOMATIC_UNIQUE_SOURCE_PROOF_REASONS, diagnoseCompleteAutomaticUniqueSourceProof, type AutomaticUniqueSourceProofDiagnostic } from "./automaticUniqueSourceProof";

const CLASSIFICATION_NOTE = "Automatic source and uniqueness verification; no human moderation is claimed.";
const VENUE_TOPOLOGY_FIELDS = ["venue", "venueId", "normalizedVenueIdentity", "normalizedVenueInstagramHandle"] as const;
export const AUTOMATIC_UNIQUE_APPROVAL_HOLD_REASONS = ["eligible", "human_reviewed", "normalized_fields_invalid", "venue_identity_requires_rebind", "structured_source_attestation_invalid", "source_occurrence_plan_unverified", "automatic_source_attestation_invalid", "source_proof_incomplete", "source_url_invalid", "persisted_source_policy_failed", "evaluation_error", "duplicate_same_occurrence", "ambiguous_same_date_occurrence", "ineligible_title", "ineligible_invalid_date", "ineligible_expired_event", "ineligible_source_policy", "ineligible_source_conflict", "indeterminate_venue_limit", "indeterminate_pending_cohort_limit", "indeterminate_approved_cohort_limit", "indeterminate_batch_incomplete"] as const;
export type AutomaticUniqueApprovalHoldReason = typeof AUTOMATIC_UNIQUE_APPROVAL_HOLD_REASONS[number];
export const AUTOMATIC_UNIQUE_REPAIR_CATEGORIES = ["none", "certified_venue_rebind", "saved_source_reprocess", "source_binding_repair", "occurrence_completion", "source_conflict_review"] as const;
export type AutomaticUniqueRepairCategory = typeof AUTOMATIC_UNIQUE_REPAIR_CATEGORIES[number];
export type AutomaticUniqueApprovalDiagnostic = {
  id: Id<"events">; expectedUpdatedAt: number; eligible: boolean; holdReason: AutomaticUniqueApprovalHoldReason;
  repairCategory: AutomaticUniqueRepairCategory; sourcePostId: Id<"scrapedPosts"> | null; sourceRevision: number | null;
  sourceOccurrenceKey: string | null; sourceProofReason: AutomaticUniqueSourceProofDiagnostic["reason"] | null;
  missingOccurrenceKeys: string[]; conflictIds: Id<"events">[];
};
export const automaticUniqueApprovalDiagnosticValidator = v.object({
  id: v.id("events"), expectedUpdatedAt: v.number(), eligible: v.boolean(),
  holdReason: v.union(...AUTOMATIC_UNIQUE_APPROVAL_HOLD_REASONS.map((reason) => v.literal(reason))),
  repairCategory: v.union(...AUTOMATIC_UNIQUE_REPAIR_CATEGORIES.map((category) => v.literal(category))),
  sourcePostId: v.union(v.id("scrapedPosts"), v.null()), sourceRevision: v.union(v.number(), v.null()),
  sourceOccurrenceKey: v.union(v.string(), v.null()),
  sourceProofReason: v.union(v.union(...AUTOMATIC_UNIQUE_SOURCE_PROOF_REASONS.map((reason) => v.literal(reason))), v.null()),
  missingOccurrenceKeys: v.array(v.string()), conflictIds: v.array(v.id("events")),
});
type ApprovedCandidate = NonNullable<ReturnType<PendingModerationUniquenessBuild["approvals"]["get"]>>;
export type AutomaticUniqueApprovalPreflight = {
  diagnostic: AutomaticUniqueApprovalDiagnostic; approval: { approved: ApprovedCandidate; nextCandidate: Doc<"events"> } | null;
};
function parseFields(value: string | undefined): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(value ?? "null"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}
function buildAutomaticFields(fields: Record<string, unknown>, canonicalVenue: string): string {
  return JSON.stringify({ ...fields, normalizedVenue: canonicalVenue, automaticUniqueApprovalPolicyVersion: AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION,
    ...(fields.sourceOccurrenceAmbiguousProvenance === true ? { automaticUniqueCollisionProofVersion: 1 } : {}),
    moderationAutoApproved: true, moderationAutoApproveRule: AUTOMATIC_UNIQUE_APPROVAL_RULE, moderationPendingReasons: [],
    moderationSignals: Array.isArray(fields.moderationSignals) ? fields.moderationSignals.filter((signal) => signal !== "requires_human_approval") : [] });
}
function repairCategoryForProof(proof: AutomaticUniqueSourceProofDiagnostic | null): AutomaticUniqueRepairCategory {
  if (!proof?.sourcePostId) return "none";
  switch (proof.reason) {
    case "source_analysis_stale": case "source_analysis_contract_invalid": return "saved_source_reprocess";
    case "source_binding_missing": case "source_binding_mismatch": case "source_analysis_binding_mismatch": case "source_fingerprint_stale": return "source_binding_repair";
    case "source_receipt_deferred_children": case "source_receipt_missing_occurrences": case "source_receipt_past_occurrence_unverified": return "occurrence_completion";
    default: return "none";
  }
}
/** Read-only preflight shared by the queue and exact-version diagnostics. */
export async function evaluateAutomaticUniqueApproval(
  ctx: QueryCtx | MutationCtx, event: Doc<"events">,
  options: { asOfMs?: number; prebuiltReview?: PendingModerationUniquenessBuild } = {},
): Promise<AutomaticUniqueApprovalPreflight> {
  let proof: AutomaticUniqueSourceProofDiagnostic | null = null;
  let conflictIds: Id<"events">[] = [];
  const hold = (holdReason: AutomaticUniqueApprovalHoldReason, repairCategory: AutomaticUniqueRepairCategory = "none"): AutomaticUniqueApprovalPreflight =>
    ({ diagnostic: { id: event._id, expectedUpdatedAt: event.updatedAt, eligible: false, holdReason, repairCategory,
      sourcePostId: proof?.sourcePostId ?? null, sourceRevision: proof?.sourceRevision ?? null,
      sourceOccurrenceKey: event.sourceOccurrenceKey ?? null, sourceProofReason: proof?.reason ?? null,
      missingOccurrenceKeys: proof?.missingOccurrenceKeys ?? [], conflictIds }, approval: null });
  try {
    if (event.reviewedAt !== undefined || event.reviewedBy !== undefined || event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined)
      return hold("human_reviewed");
    const fields = parseFields(event.normalizedFieldsJson);
    if (fields?.humanReviewedLegacySourcePolicyVersion !== undefined || fields?.humanReviewedStructuredSourcePolicyVersion !== undefined) return hold("human_reviewed");
    const asOfMs = options.asOfMs ?? Date.now();
    const review = options.prebuiltReview ?? await buildPendingModerationUniquenessReview(ctx, {
      items: [{ id: event._id, expectedUpdatedAt: event.updatedAt }], asOfMs, moderationNote: CLASSIFICATION_NOTE });
    const item = review.result.items.find((row) => row.id === event._id);
    if (!item || item.expectedUpdatedAt !== event.updatedAt) return hold("evaluation_error");
    conflictIds = item.conflictIds;
    proof = await diagnoseCompleteAutomaticUniqueSourceProof(ctx, event, asOfMs);
    const approved = item.disposition === "unique" ? review.approvals.get(event._id) : null;
    if (item.disposition === "unique" && !approved) return hold("evaluation_error");
    if (!approved) {
      const reason = item.reason as AutomaticUniqueApprovalHoldReason;
      return hold(reason, reason === "ineligible_source_conflict" ? "source_conflict_review" : reason === "ineligible_source_policy" ? repairCategoryForProof(proof) : "none");
    }
    if (!fields) return hold("normalized_fields_invalid");
    const normalizedFieldsJson = buildAutomaticFields(fields, approved.prepared.candidate.venue);
    const nextCandidate: Doc<"events"> = { ...approved.prepared.candidate, automaticUniqueApprovalPolicyVersion: AUTOMATIC_UNIQUE_APPROVAL_POLICY_VERSION, normalizedFieldsJson };
    if (VENUE_TOPOLOGY_FIELDS.some((field) => event[field] !== nextCandidate[field])) return hold("venue_identity_requires_rebind", "certified_venue_rebind");
    if (!hasHumanReviewableStructuredSourceAttestation(normalizedFieldsJson, nextCandidate)) return hold("structured_source_attestation_invalid", repairCategoryForProof(proof));
    if (fields.sourceOccurrencePlanUnverified === true) return hold("source_occurrence_plan_unverified", proof.sourcePostId ? "occurrence_completion" : "none");
    if (!hasAutomaticUniqueStructuredSourceAttestation(normalizedFieldsJson, nextCandidate)) return hold("automatic_source_attestation_invalid", repairCategoryForProof(proof));
    if (!proof.complete) return hold("source_proof_incomplete", repairCategoryForProof(proof));
    try { requireCanonicalInstagramPostUrl(nextCandidate.instagramPostUrl, `Automatic unique approval ${event._id}`); } catch { return hold("source_url_invalid"); }
    try { await assertPersistedServiceSourcePolicy(ctx, nextCandidate, { allowHumanReviewedStructured: true }); } catch { return hold("persisted_source_policy_failed"); }
    return { diagnostic: { ...hold("eligible").diagnostic, eligible: true }, approval: { approved, nextCandidate } };
  } catch { return hold("evaluation_error"); }
}
