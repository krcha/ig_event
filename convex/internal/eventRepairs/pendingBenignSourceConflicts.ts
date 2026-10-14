import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { loadCompleteReceipt, loadPendingSourceConflictCandidateProof } from "./pendingSourceConflictReclassification";
import { preparePendingSourceConflictReclassification } from "../../../lib/events/pending-source-conflict-reclassification";
import { eventRepresentsExpectedOccurrence } from "../sourceOccurrenceReceipts";
import { nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { writeEventAuditLog } from "../../eventDomain/persistence";
import { hasCompleteAutomaticUniqueSourceProof } from "../automaticUniqueSourceProof";
import { hasPersistedFocusedConflictReviewProof } from "../focusedConflictReviewProof";

type ReadCtx = MutationCtx | QueryCtx;
export async function loadPendingConflictRepairProof(ctx: ReadCtx, id: Id<"events">) {
  const links = await ctx.db.query("instagramEventSources").withIndex("by_event", (q) => q.eq("eventId", id)).take(2);
  if (links.length !== 1) throw new Error("Conflict repair requires one exact source link.");
  const receipt = await loadCompleteReceipt(ctx, links[0]!.sourceIdentity);
  if (new Set(receipt.satisfiedKeys).size !== receipt.satisfiedKeys.length) throw new Error("Conflict repair receipt satisfaction is ambiguous.");
  const proof = await loadPendingSourceConflictCandidateProof(ctx, receipt, id);
  if (proof.source.processingStatus !== undefined && proof.source.processingStatus !== "completed") throw new Error("Conflict repair source processing is not complete.");
  if (!(await hasCompleteAutomaticUniqueSourceProof(ctx, proof.event))) throw new Error("Conflict repair source topology or receipt proof failed.");
  return { ...proof, receipt };
}
export async function repairPendingBenignSourceConflictHandler(
  ctx: MutationCtx, args: { id: Id<"events">; expectedUpdatedAt: number; actor: string; reviewMarker?: Record<string, unknown> },
) {
  const event = await ctx.db.get(args.id);
  if (!event || event.status !== "pending" || event.updatedAt !== args.expectedUpdatedAt)
    return { outcome: "stale" as const, reason: "event_version_changed", updatedAt: event?.updatedAt ?? args.expectedUpdatedAt, reclassifiedCount: 0 };
  if (event.reviewedAt !== undefined || event.reviewedBy !== undefined || event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined) {
    return { outcome: "held" as const, reason: "human_review_preserved", updatedAt: event.updatedAt, reclassifiedCount: 0 };
  }
  try {
    const fields: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("invalid_normalized_evidence");
    const markers = fields as Record<string, unknown>;
    if (markers.humanReviewedLegacySourcePolicyVersion !== undefined || markers.humanReviewedStructuredSourcePolicyVersion !== undefined)
      return { outcome: "held" as const, reason: "human_review_preserved", updatedAt: event.updatedAt, reclassifiedCount: 0 };
  } catch {
    return { outcome: "held" as const, reason: "invalid_normalized_evidence", updatedAt: event.updatedAt, reclassifiedCount: 0 };
  }
  let proof: Awaited<ReturnType<typeof loadPendingConflictRepairProof>>;
  let prepared: ReturnType<typeof preparePendingSourceConflictReclassification>;
  try {
    proof = await loadPendingConflictRepairProof(ctx, args.id);
    const candidate = args.reviewMarker ? { ...proof.event, normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(proof.event.normalizedFieldsJson ?? "{}"), focusedSourceConflictReview: args.reviewMarker,
    }) } : proof.event;
    if (!(await hasPersistedFocusedConflictReviewProof(ctx, candidate))) throw new Error("Focused conflict review is not bound to the current source.");
    prepared = preparePendingSourceConflictReclassification(candidate);
    if (!eventRepresentsExpectedOccurrence({ ...proof.event, normalizedFieldsJson: prepared.normalizedFieldsJson }, proof.expected))
      throw new Error("Conflict repair would change occurrence facts.");
  } catch (error) {
    return { outcome: "held" as const, reason: error instanceof Error ? error.message : "conflict_proof_unavailable", updatedAt: event.updatedAt, reclassifiedCount: 0 };
  }
  const updatedAt = nextEventUpdatedAt(event.updatedAt);
  await ctx.db.patch(event._id, { normalizedFieldsJson: prepared.normalizedFieldsJson, sourceConflictFields: prepared.sourceConflictFields, updatedAt });
  const before = JSON.parse(event.normalizedFieldsJson ?? "{}") as Record<string, unknown>;
  const after = JSON.parse(prepared.normalizedFieldsJson) as Record<string, unknown>;
  await writeEventAuditLog(ctx, event._id, "pending_benign_source_conflicts_reclassified", { actor: args.actor, patch: {
    policyVersion: 1, sourceIdentity: proof.receipt.sourceIdentity, sourceFingerprint: proof.receipt.sourceFingerprint,
    sourceOccurrenceKey: proof.link.sourceOccurrenceKey, sourceDocumentId: proof.source._id,
    sourceRevision: proof.source.sourceRevision ?? 1, analysisRevision: proof.source.analysisRevision,
    expectedUpdatedAt: event.updatedAt, updatedAt, receiptId: proof.receipt._id, receiptUpdatedAt: proof.receipt.updatedAt,
    sourceLinkId: proof.link._id, sourceLinkUpdatedAt: proof.link.updatedAt,
    previousMaterialConflicts: before.materialSourceConflicts, nextBenignConflicts: after.benignSourceConflicts,
    previousMaterialCount: prepared.previousMaterialCount, nextBenignCount: prepared.nextBenignCount,
  } });
  return { outcome: "repaired" as const, reason: "verified_benign_source_conflicts", updatedAt, reclassifiedCount: prepared.previousMaterialCount };
}
