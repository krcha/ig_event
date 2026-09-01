import { DEFAULT_RECONCILIATION_STRATEGIES } from "./strategies";
import {
  RECONCILIATION_POLICY_VERSION,
  type ReconciliationContext,
  type ReconciliationDecision,
  type ReconciliationOutcome,
  type ReconciliationPlan,
  type ReconciliationStrategy,
} from "./types";

const ATTACHABLE_RELATIONS = new Set([
  "exact_source_occurrence",
  "same_occurrence",
  "duplicate",
  "cross_post",
  "campaign_variant",
  "continuation",
  "shared_schedule",
]);

function actionForDecision(
  context: ReconciliationContext,
  decision: ReconciliationDecision,
): ReconciliationPlan["action"] {
  if (decision.relation === "ambiguous") return "manual_review";
  const attachable = ATTACHABLE_RELATIONS.has(decision.relation);
  if (context.intent === "merge_events") {
    return attachable ? "merge" : "keep_distinct";
  }
  if (context.intent === "coalesce_events") {
    return attachable ? "coalesce" : "keep_distinct";
  }
  if (context.intent === "moderate") {
    return attachable && decision.candidateEventId ? "update" : "manual_review";
  }
  if (attachable && decision.candidateEventId) {
    const target = context.candidates.find(
      (candidate) => candidate.eventId === decision.candidateEventId,
    );
    return target?.status === "pending" && context.canonicalPatch
      ? "update"
      : "attach";
  }
  return "create";
}

export function buildReconciliationPlan(
  context: ReconciliationContext,
  decision: ReconciliationDecision,
): ReconciliationPlan {
  const action = actionForDecision(context, decision);
  const isEventConsolidation = action === "merge" || action === "coalesce";
  const targetEventId = isEventConsolidation
    ? context.incoming.eventId
    : decision.candidateEventId;
  const eventIdsToRemove = isEventConsolidation
    ? context.candidates
        .map((candidate) => candidate.eventId)
        .filter((eventId): eventId is string =>
          Boolean(eventId && eventId !== targetEventId),
        )
    : [];
  const candidateEventVersions = context.candidates
    .filter(
      (
        candidate,
      ): candidate is ReconciliationContext["candidates"][number] & {
        eventId: string;
        updatedAt: number;
      } => Boolean(candidate.eventId && candidate.updatedAt !== undefined),
    )
    .map((candidate) => ({
      eventId: candidate.eventId,
      updatedAt: candidate.updatedAt,
    }))
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  if (
    isEventConsolidation &&
    context.incoming.eventId &&
    context.incoming.updatedAt !== undefined
  ) {
    candidateEventVersions.push({
      eventId: context.incoming.eventId,
      updatedAt: context.incoming.updatedAt,
    });
    candidateEventVersions.sort((left, right) =>
      left.eventId.localeCompare(right.eventId),
    );
  }
  const candidateSetEventIds = context.candidates
    .map((candidate) => candidate.eventId)
    .filter((eventId): eventId is string => Boolean(eventId))
    .sort();
  return {
    action,
    ...(targetEventId ? { canonicalEventId: targetEventId } : {}),
    ...(eventIdsToRemove.length > 0
      ? { canonicalEventIdsToRemove: eventIdsToRemove }
      : {}),
    ...(context.canonicalPatch
      ? { canonicalPatch: context.canonicalPatch }
      : {}),
    ...(context.canonicalFieldsToUnset?.length
      ? {
          canonicalFieldsToUnset: [
            ...new Set(context.canonicalFieldsToUnset),
          ].sort(),
        }
      : {}),
    decision,
    evidence: decision.evidence,
    policyVersion: RECONCILIATION_POLICY_VERSION,
    preconditions: {
      ...(candidateEventVersions.length > 0 ? { candidateEventVersions } : {}),
      ...(candidateSetEventIds.length > 0 ? { candidateSetEventIds } : {}),
      ...(context.candidateSetTruncated !== undefined
        ? { candidateSetTruncated: context.candidateSetTruncated }
        : {}),
      ...(isEventConsolidation && context.incoming.updatedAt !== undefined
        ? { canonicalEventUpdatedAt: context.incoming.updatedAt }
        : {}),
      ...(decision.candidateEventId &&
      context.candidates.find(
        (candidate) => candidate.eventId === decision.candidateEventId,
      )?.updatedAt !== undefined
        ? {
            candidateEventUpdatedAt: context.candidates.find(
              (candidate) => candidate.eventId === decision.candidateEventId,
            )?.updatedAt,
          }
        : {}),
      ...(context.incoming.sourceOccurrenceKey
        ? { sourceOccurrenceKey: context.incoming.sourceOccurrenceKey }
        : {}),
      ...(context.occurrenceTopologyEpoch !== undefined
        ? { occurrenceTopologyEpoch: context.occurrenceTopologyEpoch }
        : {}),
      ...(context.sourceDocumentId
        ? { sourceDocumentId: context.sourceDocumentId }
        : {}),
      ...(context.sourceFingerprint
        ? { sourceFingerprint: context.sourceFingerprint }
        : {}),
      ...(context.incoming.id
        ? { sourceOccurrenceId: context.incoming.id }
        : {}),
      ...(context.sourceOccurrenceUpdatedAt !== undefined
        ? { sourceOccurrenceUpdatedAt: context.sourceOccurrenceUpdatedAt }
        : {}),
      ...((context.sourceRevision ?? context.incoming.sourceRevision) !==
      undefined
        ? {
            sourceRevision:
              context.sourceRevision ?? context.incoming.sourceRevision,
          }
        : {}),
      ...(context.incoming.venueId !== undefined
        ? { venueId: context.incoming.venueId }
        : {}),
      ...(context.venueResolutionStatus
        ? { venueResolutionStatus: context.venueResolutionStatus }
        : {}),
    },
    provenanceChanges:
      action === "create"
        ? [
            {
              operation: "attach" as const,
              sourceOccurrenceId: context.incoming.id,
            },
          ]
        : (action === "attach" || action === "update") && targetEventId
          ? [
              {
                operation: "attach",
                sourceOccurrenceId: context.incoming.id,
                toEventId: targetEventId,
              },
            ]
          : isEventConsolidation && targetEventId
            ? eventIdsToRemove.map((fromEventId) => ({
                fromEventId,
                operation: "move_event_topology" as const,
                toEventId: targetEventId,
              }))
            : [],
    receiptChanges:
      isEventConsolidation && targetEventId
        ? eventIdsToRemove.map((fromEventId) => ({
            fromEventId,
            operation: "reassign_event_topology" as const,
            toEventId: targetEventId,
          }))
        : context.incoming.sourceOccurrenceKey
          ? [
              {
                operation:
                  action === "manual_review"
                    ? ("defer" as const)
                    : ("satisfy" as const),
                sourceOccurrenceKey: context.incoming.sourceOccurrenceKey,
              },
            ]
          : [],
    relation: decision.relation,
    saveReassignments:
      isEventConsolidation && targetEventId
        ? eventIdsToRemove.map((fromEventId) => ({
            fromEventId,
            toEventId: targetEventId,
          }))
        : [],
    sourceOccurrenceIds: isEventConsolidation ? [] : [context.incoming.id],
    strategy: decision.strategy,
  };
}

function aggregateDecisions(
  context: ReconciliationContext,
  decisions: readonly ReconciliationDecision[],
): ReconciliationDecision {
  const exact = decisions.filter(
    (decision) => decision.relation === "exact_source_occurrence",
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return {
      confidence: "ambiguous",
      evidence: exact.flatMap((decision) => decision.evidence),
      reasons: ["multiple_exact_source_occurrence_candidates"],
      relation: "ambiguous",
      strategy: "decision_aggregation",
    };
  }

  // An exact source-occurrence binding is independently unique and is checked
  // above. Semantic reconciliation must fail closed when its bounded candidate
  // search was truncated because an omitted candidate could change the result.
  if (context.candidateSetTruncated) {
    return {
      confidence: "ambiguous",
      evidence: decisions.flatMap((decision) => decision.evidence),
      reasons: ["indexed_candidate_set_truncated"],
      relation: "ambiguous",
      strategy: "decision_aggregation",
    };
  }

  const attachable = decisions.filter((decision) =>
    ATTACHABLE_RELATIONS.has(decision.relation),
  );
  const ambiguous = decisions.filter(
    (decision) => decision.relation === "ambiguous",
  );
  if (
    (context.intent === "merge_events" ||
      context.intent === "coalesce_events") &&
    context.candidates.length > 0
  ) {
    if (
      decisions.length === context.candidates.length &&
      attachable.length === decisions.length &&
      ambiguous.length === 0
    ) {
      const relations = new Set(
        attachable.map((decision) => decision.relation),
      );
      return {
        ...(context.incoming.eventId
          ? { candidateEventId: context.incoming.eventId }
          : {}),
        confidence: attachable.every(
          (decision) => decision.confidence === "proven",
        )
          ? "proven"
          : "strong",
        evidence: attachable.flatMap((decision) => decision.evidence),
        reasons: [
          context.intent === "merge_events"
            ? "all_selected_events_proven_equivalent"
            : "all_selected_occurrences_proven_coalescible",
        ],
        relation: relations.size === 1 ? attachable[0]!.relation : "duplicate",
        strategy: "decision_aggregation",
      };
    }
    return {
      confidence: ambiguous.length > 0 ? "ambiguous" : "proven",
      evidence: decisions.flatMap((decision) => decision.evidence),
      reasons: [
        ambiguous.length > 0
          ? "selected_event_relationship_is_ambiguous"
          : "selected_events_are_not_all_equivalent",
      ],
      relation: ambiguous.length > 0 ? "ambiguous" : "independent",
      strategy: "decision_aggregation",
    };
  }
  if (attachable.length === 1 && ambiguous.length === 0) return attachable[0];
  if (attachable.length === 1 && ambiguous.length > 0) {
    return {
      confidence: "ambiguous",
      evidence: [
        ...attachable.flatMap((decision) => decision.evidence),
        ...ambiguous.flatMap((decision) => decision.evidence),
      ],
      reasons: ["supported_candidate_conflicts_with_ambiguous_candidate"],
      relation: "ambiguous",
      strategy: "decision_aggregation",
    };
  }
  if (attachable.length > 1) {
    return {
      confidence: "ambiguous",
      evidence: attachable.flatMap((decision) => decision.evidence),
      reasons: ["multiple_equally_supported_canonical_candidates"],
      relation: "ambiguous",
      strategy: "decision_aggregation",
    };
  }

  if (ambiguous.length > 0) {
    return {
      confidence: "ambiguous",
      evidence: ambiguous.flatMap((decision) => decision.evidence),
      reasons: [...new Set(ambiguous.flatMap((decision) => decision.reasons))],
      relation: "ambiguous",
      strategy: "decision_aggregation",
    };
  }

  return {
    confidence: "proven",
    evidence: [],
    reasons: [
      context.candidates.length === 0
        ? "no_indexed_candidates"
        : "all_candidates_are_independent_or_unrelated",
    ],
    relation: "independent",
    strategy: "decision_aggregation",
  };
}

export function reconcileOccurrence(
  context: ReconciliationContext,
  strategies: readonly ReconciliationStrategy[] = DEFAULT_RECONCILIATION_STRATEGIES,
): ReconciliationOutcome {
  const decisions: ReconciliationDecision[] = [];
  for (const candidate of context.candidates) {
    for (const strategy of strategies) {
      const decision = strategy.evaluate(context, candidate);
      if (decision) {
        decisions.push(decision);
        break;
      }
    }
  }
  const decision = aggregateDecisions(context, decisions);
  return { decision, plan: buildReconciliationPlan(context, decision) };
}

export type ReconciliationShadowComparison = {
  legacyAction: string;
  matches: boolean;
  nextAction: ReconciliationPlan["action"];
  nextRelation: ReconciliationDecision["relation"];
};

export function compareReconciliationShadowOutcome(
  legacyAction: string,
  outcome: ReconciliationOutcome,
): ReconciliationShadowComparison {
  return {
    legacyAction,
    matches: legacyAction === outcome.plan.action,
    nextAction: outcome.plan.action,
    nextRelation: outcome.decision.relation,
  };
}
