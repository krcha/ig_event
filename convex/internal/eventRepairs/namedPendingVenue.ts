import { ConvexError, type Infer } from "convex/values";
import type { Id, Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { hasSharedCaptionVenue, programmeWithdrawnOrMoved } from "../../../lib/domain/venues/shared-caption-venue";
import { normalizeHandle } from "../../../lib/domain/venues/normalization";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { getBelgradeDayKey } from "../../../lib/pipeline/belgrade-day-key";
import { prepareUpcomingVenueRepair, persistUpcomingVenueRepair, upcomingVenueRepairPlan } from "./upcomingVenueRepairs";
import { evaluateAutomaticUniqueApproval } from "../automaticUniqueApprovalPreflight";
import { persistAutomaticUniqueApproval } from "../automaticUniqueApproval";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(value: string | undefined) {
  try { return object(JSON.parse(value ?? "null")); } catch { return null; }
}
const eligibleReasons = new Set(["requires_human_approval", "missing_venue", "unresolved_venue_identity", "unscoped_canonical_venue_evidence"]);

/** A current named programme whose only outstanding source claim is its venue. */
export function hasNamedPendingVenueEvidence(event: Doc<"events">) {
  if (event.status !== "pending" || event.venueId || event.venue.trim() || event.date < getBelgradeDayKey() ||
      event.reviewedAt !== undefined || event.reviewedBy !== undefined || event.moderationNote?.trim() ||
      event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
      event.sourceConflictFields?.length) return false;
  const fields = parse(event.normalizedFieldsJson);
  const raw = parse(event.rawExtractionJson);
  if (!fields || !raw || raw.is_event !== true || raw.extraction_contract_version !== "event_evidence_v2" ||
      !Array.isArray(raw.source_conflicts) || raw.source_conflicts.length ||
      fields.humanReviewedLegacySourcePolicyVersion !== undefined || fields.humanReviewedStructuredSourcePolicyVersion !== undefined ||
      fields.title !== event.title || fields.normalizedDate !== event.date || fields.titleUsedFallback !== false ||
      fields.titleDerivedFromContext !== false || fields.approvalTitleSensible !== true || fields.sourceOccurrencePlanUnverified !== false ||
      fields.identityEvidenceVerified !== true || fields.dateEvidenceVerified !== true || fields.timeEvidenceVerified !== true ||
      fields.venueEvidenceVerified !== true || fields.materialSourceConflictCount !== 0 ||
      !Array.isArray(fields.moderationPendingReasons) || !fields.moderationPendingReasons.some(r => r === "missing_venue" || r === "unresolved_venue_identity") ||
      !fields.moderationPendingReasons.every(r => eligibleReasons.has(r)) ||
      !Array.isArray(raw.schedule_entries) || raw.schedule_entries.length > 64 ||
      typeof fields.rowSourceText !== "string" || !fields.rowSourceText.trim()) return false;
  const matches = raw.schedule_entries.map(object).filter(r => r?.source_text === fields.rowSourceText);
  // Withhold the entire proposal if the source withdraws or relocates a programme.
  const source = [event.sourceCaption, fields.rowSourceText, event.title].join("\n");
  if (programmeWithdrawnOrMoved(source)) return false;
  return matches.length === 1 && matches[0]?.title === event.title &&
    object(matches[0]?.date_evidence)?.resolved_date === event.date;
}

type Prepared = Awaited<ReturnType<typeof prepareUpcomingVenueRepair>>;
export type NamedVenuePlan = Infer<typeof upcomingVenueRepairPlan>;
async function hasExactVenueScope(ctx: MutationCtx, prepared: Prepared) {
  const { event, nextEvent, plan, venueHandle } = prepared;
  if (!plan.sourceAccountId) return false;
  const account = await ctx.db.get(plan.sourceAccountId);
  if (!account?.active) return false;
  const fields = parse(event.normalizedFieldsJson)!;
  const raw = parse(event.rawExtractionJson)!;
  const rows = (raw.schedule_entries as unknown[]).map(object);
  if (!rows.every(r => r?.venue === nextEvent.venue) ||
      normalizeHandle(String(fields.sourceGroundingInstagramHandle ?? "")) !== normalizeHandle(account.handle)) return false;
  if (account.role === "venue" && fields.sourceAccountRole === "venue") {
    return account.venueId === plan.venueId && normalizeHandle(account.handle) === venueHandle;
  }
  if (account.role !== "promoter" || fields.sourceAccountRole !== "promoter") return false;
  const shared = object(object(raw.shared_schedule_context)?.venue);
  return hasSharedCaptionVenue({ caption: event.sourceCaption ?? "", handle: venueHandle, venue: nextEvent.venue, shared, rows });
}

export type NamedVenueResult = { outcome: "approved" | "already_applied" | "stale" | "held"; reason: string };
const blocked = (reason: string): NamedVenueResult => ({ outcome: "held", reason });

/** Run as an isolated submutation: post-rebind uniqueness rejection rolls back every venue/receipt write. */
export async function approveNamedPendingVenue(ctx: MutationCtx, args: {
  id: Id<"events">; expectedUpdatedAt: number; plan?: NamedVenuePlan;
}): Promise<NamedVenueResult> {
  const event = await ctx.db.get(args.id);
  const previous = object(parse(event?.normalizedFieldsJson)?.automaticNamedVenueRepair);
  if (event?.status === "approved" && previous?.version === 1 && previous.expectedUpdatedAt === args.expectedUpdatedAt &&
      (!args.plan || (previous.sourceFingerprint === args.plan.sourceFingerprint && previous.sourceRevision === args.plan.sourceRevision))) {
    return { outcome: "already_applied", reason: "exact_version_previously_approved" };
  }
  if (!event || event.status !== "pending" || event.updatedAt !== args.expectedUpdatedAt) return { outcome: "stale", reason: "event_version_changed" };
  if (!hasNamedPendingVenueEvidence(event)) return blocked("named_programme_evidence_required");
  let prepared: Prepared;
  try { prepared = await prepareUpcomingVenueRepair(ctx, args); }
  catch (error) {
    if (error instanceof ConvexError) return blocked("source_or_venue_proof_incomplete");
    throw error;
  }
  if (args.plan && !exactJsonValue(args.plan, prepared.plan)) return { outcome: "stale", reason: "source_or_venue_version_changed" };
  if (!(await hasExactVenueScope(ctx, prepared))) return blocked("venue_scope_not_certified");
  const { plan, nextEvent } = prepared;
  nextEvent.normalizedFieldsJson = JSON.stringify({ ...parse(nextEvent.normalizedFieldsJson), automaticNamedVenueRepair: {
    version: 1, expectedUpdatedAt: event.updatedAt, sourceFingerprint: plan.sourceFingerprint, sourceRevision: plan.sourceRevision,
  } });
  const bound = await persistUpcomingVenueRepair(ctx, prepared, "service:auto-unique");
  const evaluation = await evaluateAutomaticUniqueApproval(ctx, bound);
  if (!evaluation.approval) throw new ConvexError({ namedVenueHold: evaluation.diagnostic.holdReason });
  const result = await persistAutomaticUniqueApproval(ctx, bound, evaluation.approval);
  if (result.publicationState !== "publishable") throw new ConvexError({ namedVenueHold: "final_publication_proof_failed" });
  return { outcome: "approved", reason: "named_occurrence_and_venue_verified" };
}
