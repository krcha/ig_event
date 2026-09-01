import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  reconciliationOutcomesHaveSameFinalState,
  verifiedFullOutcome,
  type ReconciliationFullOutcomeCheck,
  type ReconciliationFullOutcomeVerification,
  type ReconciliationOutcome,
} from "../../lib/domain/reconciliation/index";
import { PUBLICATION_POLICY_VERSION } from "../../lib/domain/publication/policy";
import {
  evaluateEventPublication,
  toPublicationPatch,
} from "../publicationPolicy";
import { savedEventRepository } from "../repositories/savedEvents";
import {
  assertReconciliationReceiptSatisfiable,
  hasReconciliationProvenanceForEvent,
  sourceOccurrenceHasFinalProvenance,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import { assertCompleteReceiptTopologyCoverage } from "./receiptTopologyCoverage";
import { readSourceOccurrenceTopologyEpoch } from "./sourceOccurrenceTopologyEpoch";

type SavedReferenceSnapshot = {
  canonicalSavedAtBySubject: ReadonlyMap<string, number>;
  legacySavedAtByUser: ReadonlyMap<string, number>;
};

function sameNumberMap(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}

function planConflict(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new DomainError(
    "RECONCILIATION_PLAN_INVALID",
    message,
    details ? { details } : undefined,
  );
}

export async function assertVerifiedTopologyEpoch(
  ctx: MutationCtx,
  expectedEpoch?: number,
): Promise<number> {
  const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
  if (!epoch) {
    planConflict("Source-occurrence topology epoch is missing.", {
      expectedEpoch,
    });
  }
  if (
    epoch.currentEpoch !== epoch.verifiedEpoch ||
    (expectedEpoch !== undefined && epoch.currentEpoch !== expectedEpoch)
  ) {
    planConflict(
      "Source-occurrence topology epoch is missing, dirty, or stale.",
      {
        expectedEpoch,
        liveEpoch: epoch,
      },
    );
  }
  return epoch.currentEpoch;
}

export function assertRegeneratedOutcomeStillMatches(
  expected: ReconciliationOutcome,
  regenerated: ReconciliationOutcome,
): void {
  if (!reconciliationOutcomesHaveSameFinalState(expected, regenerated)) {
    planConflict("Reconciliation plan became stale before application.", {
      currentAction: regenerated.plan.action,
      currentRelation: regenerated.decision.relation,
      expectedAction: expected.plan.action,
      expectedRelation: expected.decision.relation,
    });
  }
}

export async function assertSourceOccurrencePlanFences(options: {
  candidateEvents: readonly Doc<"events">[];
  candidateSetTruncated: boolean;
  ctx: MutationCtx;
  occurrence: Doc<"sourceOccurrences">;
  observedCanonicalEventId?: Id<"events">;
  outcome: ReconciliationOutcome;
  resolvedVenueId: Id<"venues">;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<ReconciliationFullOutcomeVerification> {
  const {
    candidateEvents,
    candidateSetTruncated,
    ctx,
    occurrence,
    outcome,
    observedCanonicalEventId,
    resolvedVenueId,
    sourceDocument,
  } = options;
  await assertCompleteReceiptTopologyCoverage(ctx);
  const { plan } = outcome;
  const preconditions = plan.preconditions;
  if (
    preconditions.sourceOccurrenceId !== String(occurrence._id) ||
    preconditions.sourceOccurrenceUpdatedAt !== occurrence.updatedAt ||
    preconditions.sourceOccurrenceKey !== occurrence.sourceOccurrenceKey ||
    preconditions.sourceFingerprint !== occurrence.sourceFingerprint ||
    preconditions.sourceRevision !== occurrence.sourceRevision ||
    preconditions.sourceDocumentId !== sourceDocument.id ||
    sourceDocument.sourceRevision !== occurrence.sourceRevision
  ) {
    planConflict(
      "Source document or SourceOccurrence preconditions are stale.",
    );
  }
  if (
    preconditions.venueResolutionStatus !== "resolved" ||
    occurrence.venueResolutionStatus !== "resolved" ||
    !occurrence.venueId ||
    occurrence.venueId !== resolvedVenueId ||
    preconditions.venueId !== String(resolvedVenueId)
  ) {
    planConflict("Venue resolution changed before reconciliation.");
  }
  await assertVerifiedTopologyEpoch(ctx, preconditions.occurrenceTopologyEpoch);
  const expectedVersions = [
    ...(preconditions.candidateEventVersions ?? []),
  ].sort((left, right) => left.eventId.localeCompare(right.eventId));
  const currentVersions = candidateEvents
    .map((event) => ({
      eventId: String(event._id),
      updatedAt: event.updatedAt,
    }))
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const currentCandidateIds = currentVersions.map((row) => row.eventId).sort();
  if (
    JSON.stringify(expectedVersions) !== JSON.stringify(currentVersions) ||
    JSON.stringify([...(preconditions.candidateSetEventIds ?? [])].sort()) !==
      JSON.stringify(currentCandidateIds) ||
    preconditions.candidateSetTruncated !== candidateSetTruncated ||
    candidateSetTruncated
  ) {
    planConflict(
      "Bounded reconciliation candidate set is stale or incomplete.",
    );
  }
  if (plan.action !== "create") {
    const target = candidateEvents.find(
      (event) => String(event._id) === plan.canonicalEventId,
    );
    if (!target || target.updatedAt !== preconditions.candidateEventUpdatedAt) {
      planConflict("Canonical reconciliation target is missing or stale.");
    }
  }

  const targetId =
    (plan.canonicalEventId as Id<"events"> | undefined) ??
    observedCanonicalEventId;
  await assertReconciliationReceiptSatisfiable({
    ctx,
    occurrence,
    ...(targetId ? { targetEventId: targetId } : {}),
  });

  return verifiedFullOutcome([
    "source_document_current",
    "source_occurrence_current",
    "occurrence_topology_current",
    "venue_resolution_current",
    "candidate_set_current",
    "candidate_relationship_current",
    "canonical_target_current",
    "receipt_satisfiable",
  ] satisfies ReconciliationFullOutcomeCheck[]);
}

function assertUnresolvedSourcePreconditions(options: {
  occurrence: Doc<"sourceOccurrences">;
  outcome: ReconciliationOutcome;
  sourceDocument: ReconciliationSourceDocument;
}): void {
  const { occurrence, outcome, sourceDocument } = options;
  const preconditions = outcome.plan.preconditions;
  if (
    preconditions.sourceOccurrenceId !== String(occurrence._id) ||
    preconditions.sourceOccurrenceUpdatedAt !== occurrence.updatedAt ||
    preconditions.sourceOccurrenceKey !== occurrence.sourceOccurrenceKey ||
    preconditions.sourceFingerprint !== occurrence.sourceFingerprint ||
    preconditions.sourceRevision !== occurrence.sourceRevision ||
    preconditions.sourceDocumentId !== sourceDocument.id ||
    sourceDocument.sourceRevision !== occurrence.sourceRevision ||
    preconditions.venueResolutionStatus !== "unresolved" ||
    occurrence.venueResolutionStatus !== "unresolved" ||
    occurrence.venueId !== undefined ||
    preconditions.venueId !== null
  ) {
    planConflict(
      "Unresolved source document, occurrence, or venue preconditions are stale.",
    );
  }
}

function assertCurrentCandidatePreconditions(options: {
  candidateEvents: readonly Doc<"events">[];
  candidateSetTruncated: boolean;
  outcome: ReconciliationOutcome;
  rejectTruncation: boolean;
}): void {
  const { candidateEvents, candidateSetTruncated, outcome, rejectTruncation } =
    options;
  const preconditions = outcome.plan.preconditions;
  const expectedVersions = [
    ...(preconditions.candidateEventVersions ?? []),
  ].sort((left, right) => left.eventId.localeCompare(right.eventId));
  const currentVersions = candidateEvents
    .map((event) => ({
      eventId: String(event._id),
      updatedAt: event.updatedAt,
    }))
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const currentCandidateIds = currentVersions.map((row) => row.eventId).sort();
  if (
    JSON.stringify(expectedVersions) !== JSON.stringify(currentVersions) ||
    JSON.stringify([...(preconditions.candidateSetEventIds ?? [])].sort()) !==
      JSON.stringify(currentCandidateIds) ||
    preconditions.candidateSetTruncated !== candidateSetTruncated ||
    (rejectTruncation && candidateSetTruncated)
  ) {
    planConflict(
      "Unresolved-venue candidate set is stale, incomplete, or unsafe.",
    );
  }
}

export async function assertUnresolvedVenuePendingCreateFences(options: {
  candidateEvents: readonly Doc<"events">[];
  candidateSetTruncated: boolean;
  ctx: MutationCtx;
  occurrence: Doc<"sourceOccurrences">;
  outcome: ReconciliationOutcome;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<ReconciliationFullOutcomeVerification> {
  const {
    candidateEvents,
    candidateSetTruncated,
    ctx,
    occurrence,
    outcome,
    sourceDocument,
  } = options;
  await assertCompleteReceiptTopologyCoverage(ctx);
  assertUnresolvedSourcePreconditions({ occurrence, outcome, sourceDocument });
  if (
    outcome.plan.action !== "create" ||
    outcome.decision.relation !== "independent"
  ) {
    planConflict(
      "Unresolved venue moderation may only create an independent pending event.",
    );
  }
  await assertVerifiedTopologyEpoch(
    ctx,
    outcome.plan.preconditions.occurrenceTopologyEpoch,
  );
  assertCurrentCandidatePreconditions({
    candidateEvents,
    candidateSetTruncated,
    outcome,
    rejectTruncation: true,
  });
  await assertReconciliationReceiptSatisfiable({ ctx, occurrence });
  return verifiedFullOutcome([
    "source_document_current",
    "source_occurrence_current",
    "occurrence_topology_current",
    "venue_resolution_current",
    "candidate_set_current",
    "candidate_relationship_current",
    "receipt_satisfiable",
  ] satisfies ReconciliationFullOutcomeCheck[]);
}

export async function assertUnresolvedVenueExactRetryFences(options: {
  candidateEvents: readonly Doc<"events">[];
  candidateSetTruncated: boolean;
  ctx: MutationCtx;
  eventId: Id<"events">;
  occurrence: Doc<"sourceOccurrences">;
  outcome: ReconciliationOutcome;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<ReconciliationFullOutcomeVerification> {
  const {
    candidateEvents,
    candidateSetTruncated,
    ctx,
    eventId,
    occurrence,
    outcome,
    sourceDocument,
  } = options;
  await assertCompleteReceiptTopologyCoverage(ctx);
  assertUnresolvedSourcePreconditions({ occurrence, outcome, sourceDocument });
  if (
    outcome.plan.action !== "attach" ||
    outcome.decision.relation !== "exact_source_occurrence" ||
    outcome.plan.canonicalEventId !== String(eventId)
  ) {
    planConflict(
      "An unresolved-venue retry may only retain its exact source-bound event.",
    );
  }
  await assertVerifiedTopologyEpoch(
    ctx,
    outcome.plan.preconditions.occurrenceTopologyEpoch,
  );
  assertCurrentCandidatePreconditions({
    candidateEvents,
    candidateSetTruncated,
    outcome,
    rejectTruncation: false,
  });
  const target = candidateEvents.find((event) => event._id === eventId);
  if (
    !target ||
    target.updatedAt !== outcome.plan.preconditions.candidateEventUpdatedAt
  ) {
    planConflict("Exact unresolved-venue retry target is missing or stale.");
  }
  await assertReconciliationReceiptSatisfiable({
    ctx,
    occurrence,
    targetEventId: eventId,
  });
  return verifiedFullOutcome([
    "source_document_current",
    "source_occurrence_current",
    "occurrence_topology_current",
    "venue_resolution_current",
    "candidate_set_current",
    "candidate_relationship_current",
    "canonical_target_current",
    "receipt_satisfiable",
  ] satisfies ReconciliationFullOutcomeCheck[]);
}

export async function captureSavedReferenceSnapshot(
  ctx: MutationCtx,
  eventIds: readonly Id<"events">[],
): Promise<SavedReferenceSnapshot> {
  const canonicalSavedAtBySubject = new Map<string, number>();
  const legacySavedAtByUser = new Map<string, number>();
  for (const eventId of [...new Set(eventIds)]) {
    const { canonical, legacy } =
      await savedEventRepository.loadEventReferences(ctx, eventId);
    for (const row of canonical) {
      canonicalSavedAtBySubject.set(
        row.userId,
        Math.max(canonicalSavedAtBySubject.get(row.userId) ?? 0, row.createdAt),
      );
    }
    for (const row of legacy) {
      const userId = String(row.userId);
      legacySavedAtByUser.set(
        userId,
        Math.max(legacySavedAtByUser.get(userId) ?? 0, row.savedAt),
      );
    }
  }
  return { canonicalSavedAtBySubject, legacySavedAtByUser };
}

export async function assertConsolidationFinalState(options: {
  ctx: MutationCtx;
  expectedSaves: SavedReferenceSnapshot;
  removedEventIds: readonly Id<"events">[];
  targetEventId: Id<"events">;
}): Promise<ReconciliationFullOutcomeVerification> {
  const { ctx, expectedSaves, removedEventIds, targetEventId } = options;
  const target = await ctx.db.get(targetEventId);
  if (
    !target ||
    (await Promise.all(removedEventIds.map((id) => ctx.db.get(id)))).some(
      Boolean,
    )
  ) {
    planConflict(
      "Canonical consolidation did not produce exactly one target event.",
    );
  }
  for (const removedEventId of removedEventIds) {
    const [hasProvenance, occurrences, savedReferences] = await Promise.all([
      hasReconciliationProvenanceForEvent(ctx, removedEventId),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_canonical_event", (q) =>
          q.eq("canonicalEventId", removedEventId),
        )
        .take(1),
      savedEventRepository.loadEventReferences(ctx, removedEventId),
    ]);
    if (
      hasProvenance ||
      occurrences.length ||
      savedReferences.canonical.length ||
      savedReferences.legacy.length
    ) {
      planConflict("Consolidation orphaned provenance or saved references.", {
        removedEventId,
      });
    }
  }
  await sourceOccurrenceProvenanceRepository.assertReconciliationEventTopology(
    ctx,
    targetEventId,
  );
  const currentSaves = await captureSavedReferenceSnapshot(ctx, [
    targetEventId,
  ]);
  if (
    !sameNumberMap(
      expectedSaves.canonicalSavedAtBySubject,
      currentSaves.canonicalSavedAtBySubject,
    ) ||
    !sameNumberMap(
      expectedSaves.legacySavedAtByUser,
      currentSaves.legacySavedAtByUser,
    )
  ) {
    planConflict("Canonical consolidation lost a saved-event reference.");
  }
  const decision = await evaluateEventPublication(ctx, target);
  const publicationPatch = toPublicationPatch(
    decision,
    target.publicationEvaluatedAt,
  );
  if (
    target.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION ||
    target.publicationPolicyVersion !==
      publicationPatch.publicationPolicyVersion ||
    target.publicationState !== publicationPatch.publicationState ||
    target.publicationReason !== publicationPatch.publicationReason
  ) {
    planConflict("Canonical consolidation left stale publication state.");
  }
  await assertVerifiedTopologyEpoch(ctx);
  return verifiedFullOutcome([
    "canonical_target_current",
    "provenance_complete",
    "saved_reassignment_lossless",
    "publication_current",
    "topology_has_no_orphans",
    "distinct_occurrences_preserved",
    "occurrence_topology_current",
  ]);
}

export async function assertSourceOccurrenceFinalState(options: {
  ctx: MutationCtx;
  eventId: Id<"events">;
  occurrenceId: Id<"sourceOccurrences">;
}): Promise<ReconciliationFullOutcomeVerification> {
  const { ctx, eventId, occurrenceId } = options;
  const occurrence = await ctx.db.get(occurrenceId);
  const event = await ctx.db.get(eventId);
  if (
    !occurrence ||
    !event ||
    occurrence.state !== "satisfied" ||
    occurrence.canonicalEventId !== eventId
  ) {
    planConflict(
      "Applied reconciliation did not satisfy its SourceOccurrence.",
    );
  }
  if (!(await sourceOccurrenceHasFinalProvenance({ ctx, eventId, occurrence }))) {
    planConflict(
      "Applied reconciliation left incomplete provenance or receipt state.",
    );
  }
  await sourceOccurrenceProvenanceRepository.assertReconciliationEventTopology(
    ctx,
    eventId,
  );
  const publicationDecision = await evaluateEventPublication(ctx, event);
  const publicationPatch = toPublicationPatch(
    publicationDecision,
    event.publicationEvaluatedAt,
  );
  const publicationRefreshIsSafelyDeferred =
    event.publicationPolicyVersion === PUBLICATION_POLICY_VERSION &&
    event.publicationState === "pending_verification" &&
    event.publicationReason === "derived_state_refresh_deferred";
  if (
    !publicationRefreshIsSafelyDeferred &&
    (event.publicationPolicyVersion !==
      publicationPatch.publicationPolicyVersion ||
      event.publicationState !== publicationPatch.publicationState ||
      event.publicationReason !== publicationPatch.publicationReason)
  ) {
    planConflict("Applied reconciliation left stale publication state.");
  }
  await assertVerifiedTopologyEpoch(ctx);
  return verifiedFullOutcome([
    "source_occurrence_current",
    "provenance_complete",
    "receipt_satisfiable",
    "publication_current",
    "topology_has_no_orphans",
    "occurrence_topology_current",
  ]);
}

export async function assertConsolidationPreconditions(options: {
  ctx: MutationCtx;
  expectedEventVersions: readonly { eventId: string; updatedAt: number }[];
}): Promise<void> {
  await assertCompleteReceiptTopologyCoverage(options.ctx);
  await assertVerifiedTopologyEpoch(options.ctx);
  for (const expected of options.expectedEventVersions) {
    const current = await options.ctx.db.get(expected.eventId as Id<"events">);
    if (!current || current.updatedAt !== expected.updatedAt) {
      planConflict("Canonical event changed before consolidation.", {
        eventId: expected.eventId,
      });
    }
  }
}
