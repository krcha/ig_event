export type AutomaticApprovalHoldView = {
  eventId: string;
  expectedUpdatedAt: number;
  holdReason: string;
  repairReason: string | null;
  repairCategory: string;
  status: string;
  repairAttemptCount: number;
  observedAt: number;
};

export function getAutomaticApprovalExplanation(
  event: { id: string; updatedAt: number; automaticApproval?: AutomaticApprovalHoldView | null },
): string | null {
  const hold = event.automaticApproval;
  if (!hold || hold.eventId !== event.id || hold.expectedUpdatedAt !== event.updatedAt) return null;
  if (hold.status === "processing") return "Source evidence is being checked automatically.";
  if (hold.status === "queued") return "Automatic source recovery is queued.";
  if (hold.status === "resolved") return "Source evidence was repaired; automatic approval will check it again.";
  const reasons: Record<string, string> = {
    ineligible_source_conflict: "Poster and caption details still need resolution.",
    ineligible_title: "The extracted title needs correction from the source.",
    duplicate_same_occurrence: "Another listing already represents this occurrence.",
    ambiguous_same_date_occurrence: "Similar listings need a duplicate decision.",
    venue_identity_requires_rebind: "The venue alias needs a verified source binding.",
    source_analysis_stale: "The source changed; current extraction evidence is required.",
    source_receipt_deferred_children: "Other events from the same post still need source processing.",
    source_receipt_missing_occurrences: "Some events from the same post have incomplete source evidence.",
    source_occurrence_plan_unverified: "The source schedule has not been fully verified.",
    persisted_source_policy_failed: "The saved source evidence could not be verified.",
    evaluation_error: "Automatic verification could not complete; the event remains available for review.",
  };
  if (hold.repairReason === "repair_attempt_limit") return "Automatic recovery reached its retry limit; source review is needed.";
  return reasons[hold.holdReason] ?? "Automatic source verification remains incomplete.";
}
