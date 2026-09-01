import type { EvidenceReference } from "../occurrences/types";

export const RECONCILIATION_POLICY_VERSION = 1 as const;

export type OccurrenceRelation =
  | "exact_source_occurrence"
  | "same_occurrence"
  | "duplicate"
  | "cross_post"
  | "campaign_variant"
  | "continuation"
  | "shared_schedule"
  | "recurring_occurrence"
  | "independent"
  | "ambiguous"
  | "unrelated";

export type ReconciliationConfidence = "proven" | "strong" | "ambiguous";

export type ReconciliationAction =
  | "create"
  | "attach"
  | "update"
  | "merge"
  | "coalesce"
  | "keep_distinct"
  | "manual_review";

export type ReconciliationOccurrence = {
  artists: readonly string[];
  canonicalSourceUrl?: string | null;
  date: string;
  eventId?: string;
  eventType?: string;
  id: string;
  normalizedFieldsJson?: string | null;
  normalizedVenueIdentity?: string | null;
  sourceAccountHandle?: string | null;
  sourceIdentity?: string | null;
  sourceOccurrenceKey?: string | null;
  sourceRevision?: number;
  status?: "pending" | "approved" | "rejected";
  time?: string | null;
  title: string;
  updatedAt?: number;
  venue?: string | null;
  venueAccountIdentity?: string | null;
  venueId?: string | null;
};

export type ReconciliationContext = {
  candidates: readonly ReconciliationOccurrence[];
  candidateSetTruncated?: boolean;
  canonicalFieldsToUnset?: readonly string[];
  canonicalPatch?: CanonicalEventPatch;
  incoming: ReconciliationOccurrence;
  intent: "ingest_occurrence" | "moderate" | "merge_events" | "coalesce_events";
  occurrenceTopologyEpoch?: number;
  sourceDocumentId?: string;
  sourceFingerprint?: string;
  sourceOccurrenceUpdatedAt?: number;
  sourceRevision?: number;
  venueResolutionStatus?: "resolved" | "ambiguous" | "unresolved";
};

export type ReconciliationDecision = {
  candidateEventId?: string;
  candidateOccurrenceId?: string;
  confidence: ReconciliationConfidence;
  evidence: readonly EvidenceReference[];
  reasons: readonly string[];
  relation: OccurrenceRelation;
  strategy: string;
};

export type ReconciliationPreconditions = {
  candidateEventVersions?: readonly {
    eventId: string;
    updatedAt: number;
  }[];
  candidateSetEventIds?: readonly string[];
  candidateSetTruncated?: boolean;
  canonicalEventUpdatedAt?: number;
  candidateEventUpdatedAt?: number;
  occurrenceTopologyEpoch?: number;
  sourceDocumentId?: string;
  sourceFingerprint?: string;
  sourceOccurrenceId?: string;
  sourceOccurrenceKey?: string;
  sourceOccurrenceUpdatedAt?: number;
  sourceRevision?: number;
  venueId?: string | null;
  venueResolutionStatus?: "resolved" | "ambiguous" | "unresolved";
};

export type CanonicalEventPatch = Readonly<Record<string, unknown>>;

export type ProvenanceChange =
  | {
      operation: "attach" | "retain";
      sourceOccurrenceId: string;
      toEventId?: string;
    }
  | {
      fromEventId: string;
      operation: "move_event_topology";
      toEventId: string;
    };

export type SaveReassignment = {
  fromEventId: string;
  toEventId: string;
};

export type ReceiptChange =
  | {
      operation: "satisfy" | "defer";
      sourceOccurrenceKey: string;
    }
  | {
      fromEventId: string;
      operation: "reassign_event_topology";
      toEventId: string;
    }
  | {
      fromEventId: string;
      operation: "reassign";
      sourceOccurrenceKey: string;
      toEventId: string;
    };

export type ReconciliationPlan = {
  action: ReconciliationAction;
  canonicalEventId?: string;
  canonicalEventIdsToRemove?: readonly string[];
  canonicalFieldsToUnset?: readonly string[];
  canonicalPatch?: CanonicalEventPatch;
  decision: ReconciliationDecision;
  evidence: readonly EvidenceReference[];
  policyVersion: typeof RECONCILIATION_POLICY_VERSION;
  preconditions: ReconciliationPreconditions;
  provenanceChanges: readonly ProvenanceChange[];
  receiptChanges: readonly ReceiptChange[];
  relation: OccurrenceRelation;
  saveReassignments: readonly SaveReassignment[];
  sourceOccurrenceIds: readonly string[];
  strategy: string;
};

export type ReconciliationOutcome = {
  decision: ReconciliationDecision;
  plan: ReconciliationPlan;
};

export interface ReconciliationStrategy {
  readonly name: string;
  evaluate(
    context: ReconciliationContext,
    candidate: ReconciliationOccurrence,
  ): ReconciliationDecision | null;
}
