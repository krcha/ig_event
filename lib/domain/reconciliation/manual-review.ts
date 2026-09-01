import {
  RECONCILIATION_POLICY_VERSION,
  type ReconciliationDecision,
  type ReconciliationOutcome,
  type ReconciliationPlan,
} from "./types";

/** Builds the canonical non-mutating fallback used by every adapter. */
export function buildManualReviewOutcome(
  reason: string,
  sourceOccurrenceId: string,
): ReconciliationOutcome {
  const decision: ReconciliationDecision = {
    confidence: "ambiguous",
    evidence: [],
    reasons: [reason],
    relation: "ambiguous",
    strategy: "server_policy",
  };
  const plan: ReconciliationPlan = {
    action: "manual_review",
    decision,
    evidence: [],
    policyVersion: RECONCILIATION_POLICY_VERSION,
    preconditions: {},
    provenanceChanges: [],
    receiptChanges: [],
    relation: "ambiguous",
    saveReassignments: [],
    sourceOccurrenceIds: [sourceOccurrenceId],
    strategy: "server_policy",
  };
  return { decision, plan };
}
