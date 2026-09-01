import type { ReconciliationOutcome, ReconciliationPlan } from "./types";

export type ReconciliationFullOutcomeCheck =
  | "candidate_relationship_current"
  | "candidate_set_current"
  | "canonical_target_current"
  | "distinct_occurrences_preserved"
  | "occurrence_topology_current"
  | "provenance_complete"
  | "publication_current"
  | "receipt_satisfiable"
  | "saved_reassignment_lossless"
  | "source_document_current"
  | "source_occurrence_current"
  | "topology_has_no_orphans"
  | "venue_resolution_current";

export type ReconciliationFullOutcomeVerification = {
  checks: readonly ReconciliationFullOutcomeCheck[];
  safe: true;
};

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function normalizedEventVersions(
  plan: ReconciliationPlan,
): Array<{ eventId: string; updatedAt: number }> {
  return [...(plan.preconditions.candidateEventVersions ?? [])].sort(
    (left, right) => left.eventId.localeCompare(right.eventId),
  );
}

/**
 * Compares every decision-shaping and mutation-shaping field. Descriptive
 * reasons/evidence may grow without invalidating a plan, but a changed action,
 * relation, target, source fence, venue fence, topology epoch, candidate set,
 * candidate version, patch, or reassignment makes the earlier plan stale.
 */
export function reconciliationPlansHaveSameOutcome(
  expected: ReconciliationPlan,
  current: ReconciliationPlan,
): boolean {
  return (
    expected.policyVersion === current.policyVersion &&
    expected.action === current.action &&
    expected.relation === current.relation &&
    expected.strategy === current.strategy &&
    expected.canonicalEventId === current.canonicalEventId &&
    JSON.stringify(sorted(expected.canonicalEventIdsToRemove)) ===
      JSON.stringify(sorted(current.canonicalEventIdsToRemove)) &&
    JSON.stringify(expected.canonicalPatch ?? null) ===
      JSON.stringify(current.canonicalPatch ?? null) &&
    JSON.stringify(sorted(expected.canonicalFieldsToUnset)) ===
      JSON.stringify(sorted(current.canonicalFieldsToUnset)) &&
    JSON.stringify(normalizedEventVersions(expected)) ===
      JSON.stringify(normalizedEventVersions(current)) &&
    JSON.stringify(sorted(expected.preconditions.candidateSetEventIds)) ===
      JSON.stringify(sorted(current.preconditions.candidateSetEventIds)) &&
    expected.preconditions.candidateSetTruncated ===
      current.preconditions.candidateSetTruncated &&
    expected.preconditions.canonicalEventUpdatedAt ===
      current.preconditions.canonicalEventUpdatedAt &&
    expected.preconditions.candidateEventUpdatedAt ===
      current.preconditions.candidateEventUpdatedAt &&
    expected.preconditions.occurrenceTopologyEpoch ===
      current.preconditions.occurrenceTopologyEpoch &&
    expected.preconditions.sourceDocumentId ===
      current.preconditions.sourceDocumentId &&
    expected.preconditions.sourceFingerprint ===
      current.preconditions.sourceFingerprint &&
    expected.preconditions.sourceOccurrenceId ===
      current.preconditions.sourceOccurrenceId &&
    expected.preconditions.sourceOccurrenceKey ===
      current.preconditions.sourceOccurrenceKey &&
    expected.preconditions.sourceOccurrenceUpdatedAt ===
      current.preconditions.sourceOccurrenceUpdatedAt &&
    expected.preconditions.sourceRevision ===
      current.preconditions.sourceRevision &&
    expected.preconditions.venueId === current.preconditions.venueId &&
    expected.preconditions.venueResolutionStatus ===
      current.preconditions.venueResolutionStatus &&
    JSON.stringify(expected.provenanceChanges) ===
      JSON.stringify(current.provenanceChanges) &&
    JSON.stringify(expected.receiptChanges) ===
      JSON.stringify(current.receiptChanges) &&
    JSON.stringify(expected.saveReassignments) ===
      JSON.stringify(current.saveReassignments) &&
    JSON.stringify(sorted(expected.sourceOccurrenceIds)) ===
      JSON.stringify(sorted(current.sourceOccurrenceIds))
  );
}

export function reconciliationOutcomesHaveSameFinalState(
  expected: ReconciliationOutcome,
  current: ReconciliationOutcome,
): boolean {
  return (
    expected.decision.relation === current.decision.relation &&
    expected.decision.confidence === current.decision.confidence &&
    expected.decision.candidateEventId === current.decision.candidateEventId &&
    reconciliationPlansHaveSameOutcome(expected.plan, current.plan)
  );
}

export function verifiedFullOutcome(
  checks: readonly ReconciliationFullOutcomeCheck[],
): ReconciliationFullOutcomeVerification {
  return { checks: [...new Set(checks)], safe: true };
}
