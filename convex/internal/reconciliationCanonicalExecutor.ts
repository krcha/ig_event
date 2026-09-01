import { v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  reconcileOccurrence,
  type ReconciliationOccurrence,
  type ReconciliationOutcome,
} from "../../lib/domain/reconciliation/index";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { loadOccurrenceCandidates } from "../repositories/occurrenceCandidates";
import {
  readReconciliationVenueAccountIdentity,
  readSourceAccountIdentityFromNormalizedFields,
} from "../repositories/reconciliationSourceContext";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { savedEventRepository } from "../repositories/savedEvents";
import {
  sourceOccurrenceProvenanceRepository,
  type PreparedReconciliationEventTopology,
} from "../repositories/sourceOccurrenceProvenance";
import { refreshEventPublicationStates } from "../publicationPolicy";
import { assertReconciliationApplyReady } from "./reconciliationApplyReadiness";
import { appendServerVerifiedConsolidationCapability } from "./reconciliationRollout";
import {
  assertConsolidationFinalState,
  assertConsolidationPreconditions,
  assertRegeneratedOutcomeStillMatches,
  assertVerifiedTopologyEpoch,
  captureSavedReferenceSnapshot,
} from "./reconciliationFullOutcome";

const MAX_GENERIC_CONSOLIDATION_EVENTS = 8;
const CANONICAL_CONTENT_PRESERVATION_FIELDS = [
  "dateEvidenceIsRelative",
  "dateEvidenceResolvedDate",
  "dateEvidenceSource",
  "dateEvidenceText",
  "description",
  "humanReviewedLegacySourcePolicyVersion",
  "humanReviewedStructuredSourcePolicyVersion",
  "imageStorageId",
  "imageUrl",
  "normalizedFieldsJson",
  "promotionEnd",
  "promotionPriority",
  "promotionStart",
  "promotionTier",
  "rawExtractionJson",
  "sourceCaption",
  "sourceConflictFields",
  "sourcePostedAt",
  "ticketPrice",
  "timeConfidence",
  "timeEvidenceKind",
  "timeEvidenceText",
  "timeSource",
  "timeStatus",
] as const satisfies readonly (keyof Doc<"events">)[];

const resultValidator = v.object({
  action: v.union(
    v.literal("merge"),
    v.literal("coalesce"),
    v.literal("keep_distinct"),
    v.literal("manual_review"),
  ),
  applied: v.boolean(),
  auditId: v.id("reconciliationAudits"),
  canonicalEventId: v.id("events"),
  removedEventCount: v.number(),
});

type ConsolidationIntent = "merge_events" | "coalesce_events";

type CanonicalConsolidationResult = {
  action: "merge" | "coalesce" | "keep_distinct" | "manual_review";
  applied: boolean;
  auditId: Id<"reconciliationAudits">;
  canonicalEventId: Id<"events">;
  removedEventCount: number;
};

type ConsolidationArgs = {
  eventVersions: readonly {
    eventId: Id<"events">;
    expectedUpdatedAt: number;
  }[];
  intent: ConsolidationIntent;
  mode: "shadow" | "apply";
  primaryEventId: Id<"events">;
};

function eventAsOccurrence(event: Doc<"events">): ReconciliationOccurrence {
  return {
    artists: event.artists,
    canonicalSourceUrl: event.canonicalSourceUrl,
    date: event.date,
    eventId: String(event._id),
    eventType: event.eventType,
    id: String(event._id),
    normalizedFieldsJson: event.normalizedFieldsJson,
    normalizedVenueIdentity: event.normalizedVenueIdentity,
    sourceAccountHandle: readSourceAccountIdentityFromNormalizedFields(
      event.normalizedFieldsJson,
    ),
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    status: event.status,
    time: event.time,
    title: event.title,
    updatedAt: event.updatedAt,
    venue: event.venue,
    venueAccountIdentity: readReconciliationVenueAccountIdentity(event),
    venueId: event.venueId ? String(event.venueId) : null,
  };
}

function planInvalid(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new DomainError(
    "RECONCILIATION_PLAN_INVALID",
    message,
    details ? { details } : undefined,
  );
}

function assertStoredEventSignature(event: Doc<"events">): void {
  const expected = buildEventOccurrenceIndexPatch(event);
  for (const [field, value] of Object.entries(expected)) {
    if (
      JSON.stringify((event as unknown as Record<string, unknown>)[field]) !==
      JSON.stringify(value)
    ) {
      planInvalid("Canonical event occurrence signature is stale.", {
        eventId: event._id,
        field,
      });
    }
  }
}

function assertVersionEnvelope(
  args: ConsolidationArgs,
  events: readonly Doc<"events">[],
): void {
  if (
    args.eventVersions.length !== events.length ||
    new Set(args.eventVersions.map((version) => String(version.eventId)))
      .size !== args.eventVersions.length
  ) {
    planInvalid("Canonical consolidation version envelope is incomplete.");
  }
  const expectedById = new Map(
    args.eventVersions.map((version) => [
      String(version.eventId),
      version.expectedUpdatedAt,
    ]),
  );
  for (const event of events) {
    if (expectedById.get(String(event._id)) !== event.updatedAt) {
      planInvalid("Canonical event changed before reconciliation planning.", {
        eventId: event._id,
      });
    }
  }
}

function classifyPair(
  left: Doc<"events">,
  right: Doc<"events">,
): ReconciliationOutcome {
  return reconcileOccurrence({
    candidates: [eventAsOccurrence(right)],
    incoming: eventAsOccurrence(left),
    intent: "merge_events",
  });
}

function assertEveryPairEquivalent(events: readonly Doc<"events">[]): void {
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < events.length;
      rightIndex += 1
    ) {
      const pair = classifyPair(events[leftIndex]!, events[rightIndex]!);
      if (pair.plan.action !== "merge") {
        planInvalid(
          "Canonical consolidation would collapse a proven-distinct or ambiguous event pair.",
          {
            leftEventId: events[leftIndex]!._id,
            relation: pair.decision.relation,
            rightEventId: events[rightIndex]!._id,
          },
        );
      }
    }
  }
}

/**
 * Generic consolidation is deliberately exact-equivalent-only for rich
 * canonical content. Source topology is moved losslessly, but choosing among
 * conflicting descriptions/media/evidence requires a dedicated reviewed
 * fold with an explicit patch and rollback envelope.
 */
function hasCanonicalContentLossRisk(
  primary: Doc<"events">,
  duplicates: readonly Doc<"events">[],
): boolean {
  return duplicates.some((duplicate) =>
    CANONICAL_CONTENT_PRESERVATION_FIELDS.some(
      (field) =>
        JSON.stringify(duplicate[field]) !== JSON.stringify(primary[field]),
    ),
  );
}

function toContentPreservationManualReview(
  outcome: ReconciliationOutcome,
): ReconciliationOutcome {
  const decision = {
    confidence: "ambiguous" as const,
    evidence: outcome.decision.evidence,
    reasons: ["canonical_content_differs_across_equivalent_events"],
    relation: "ambiguous" as const,
    strategy: "canonical_content_preservation",
  };
  const {
    canonicalEventId: _canonicalEventId,
    canonicalEventIdsToRemove: _canonicalEventIdsToRemove,
    canonicalFieldsToUnset: _canonicalFieldsToUnset,
    canonicalPatch: _canonicalPatch,
    ...nonMutatingPlan
  } = outcome.plan;
  return {
    decision,
    plan: {
      ...nonMutatingPlan,
      action: "manual_review",
      decision,
      provenanceChanges: [],
      receiptChanges: [],
      relation: "ambiguous",
      saveReassignments: [],
      sourceOccurrenceIds: [],
      strategy: decision.strategy,
    },
  };
}

async function generateConsolidationOutcome(
  ctx: MutationCtx,
  primary: Doc<"events">,
  duplicates: readonly Doc<"events">[],
  intent: ConsolidationIntent,
): Promise<{
  boundedCandidateEvents: Doc<"events">[];
  outcome: ReconciliationOutcome;
}> {
  if (
    primary.occurrenceSignatureVersion === undefined ||
    !primary.occurrenceSignatureHash ||
    !primary.occurrenceDateKey ||
    !primary.occurrenceVenueIdentity ||
    !primary.occurrenceTitleFamily
  ) {
    planInvalid(
      "Canonical consolidation requires migrated occurrence signatures.",
    );
  }
  const bounded = await loadOccurrenceCandidates(ctx.db, {
    occurrenceDateKey: primary.occurrenceDateKey,
    occurrenceSignatureHash: primary.occurrenceSignatureHash,
    occurrenceSignatureVersion: primary.occurrenceSignatureVersion,
    occurrenceTitleFamily: primary.occurrenceTitleFamily,
    occurrenceVenueIdentity: primary.occurrenceVenueIdentity,
  });
  if (bounded.truncated) {
    planInvalid("Canonical consolidation candidate set is truncated.");
  }
  const boundedCandidateEvents = bounded.candidates.filter(
    (event) => event._id !== primary._id,
  );
  const boundedIds = new Set(boundedCandidateEvents.map((event) => event._id));
  if (duplicates.some((duplicate) => !boundedIds.has(duplicate._id))) {
    planInvalid(
      "Selected canonical event is outside the bounded candidate set.",
    );
  }

  const selectedIds = new Set(duplicates.map((duplicate) => duplicate._id));
  for (const unselected of boundedCandidateEvents) {
    if (selectedIds.has(unselected._id)) continue;
    const relationship = classifyPair(primary, unselected);
    if (
      relationship.plan.action === "merge" ||
      relationship.decision.relation === "ambiguous"
    ) {
      planInvalid(
        "A new equivalent or ambiguous candidate appeared outside the generated consolidation plan.",
        { candidateEventId: unselected._id },
      );
    }
  }

  const topologyEpoch = await assertVerifiedTopologyEpoch(ctx);
  const base = reconcileOccurrence({
    candidates: duplicates.map(eventAsOccurrence),
    incoming: eventAsOccurrence(primary),
    intent,
    occurrenceTopologyEpoch: topologyEpoch,
  });
  const fullCandidateVersions = [primary, ...boundedCandidateEvents]
    .map((event) => ({
      eventId: String(event._id),
      updatedAt: event.updatedAt,
    }))
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const fullCandidateIds = boundedCandidateEvents
    .map((event) => String(event._id))
    .sort();
  const generatedOutcome: ReconciliationOutcome = {
    decision: base.decision,
    plan: {
      ...base.plan,
      preconditions: {
        ...base.plan.preconditions,
        candidateEventVersions: fullCandidateVersions,
        candidateSetEventIds: fullCandidateIds,
        candidateSetTruncated: false,
        canonicalEventUpdatedAt: primary.updatedAt,
        occurrenceTopologyEpoch: topologyEpoch,
      },
    },
  };
  const outcome = hasCanonicalContentLossRisk(primary, duplicates)
    ? toContentPreservationManualReview(generatedOutcome)
    : generatedOutcome;
  return { boundedCandidateEvents, outcome };
}

async function writeAudit(options: {
  candidateEvents: readonly Doc<"events">[];
  ctx: MutationCtx;
  mode: "shadow" | "applied" | "rejected";
  outcome: ReconciliationOutcome;
  primaryEventId: Id<"events">;
}): Promise<Id<"reconciliationAudits">> {
  return options.ctx.db.insert("reconciliationAudits", {
    action: options.outcome.plan.action,
    candidateEventIds: options.candidateEvents.map((event) => event._id),
    canonicalEventId: options.primaryEventId,
    createdAt: Date.now(),
    decisionJson: JSON.stringify(options.outcome.decision),
    mode: options.mode,
    planJson: JSON.stringify(options.outcome.plan),
    policyVersion: options.outcome.plan.policyVersion,
    relation: options.outcome.decision.relation,
    strategy: options.outcome.decision.strategy,
  });
}

async function assertConsolidationExecutionPreflight(options: {
  ctx: MutationCtx;
  duplicates: readonly Doc<"events">[];
  expectedEventVersions: readonly { eventId: string; updatedAt: number }[];
  primary: Doc<"events">;
}): Promise<void> {
  await assertConsolidationPreconditions({
    ctx: options.ctx,
    expectedEventVersions: options.expectedEventVersions,
  });
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(
    options.ctx,
    options.primary._id,
    options.primary,
  );
  for (const duplicate of options.duplicates) {
    await sourceOccurrenceProvenanceRepository.assertEventCanBeReassigned(
      options.ctx,
      duplicate._id,
      options.primary,
    );
  }
  await captureSavedReferenceSnapshot(options.ctx, [
    options.primary._id,
    ...options.duplicates.map((event) => event._id),
  ]);
}

export async function executeCanonicalConsolidationHandler(
  ctx: MutationCtx,
  args: ConsolidationArgs,
): Promise<CanonicalConsolidationResult> {
  if (
    args.eventVersions.length < 2 ||
    args.eventVersions.length > MAX_GENERIC_CONSOLIDATION_EVENTS ||
    !args.eventVersions.some(
      (version) => version.eventId === args.primaryEventId,
    )
  ) {
    planInvalid(
      "Canonical consolidation requires one bounded primary/duplicate set.",
    );
  }
  const events = await Promise.all(
    args.eventVersions.map((version) => ctx.db.get(version.eventId)),
  );
  if (events.some((event) => event === null)) {
    planInvalid("Canonical consolidation event disappeared before planning.");
  }
  const currentEvents = events as Doc<"events">[];
  assertVersionEnvelope(args, currentEvents);
  currentEvents.forEach(assertStoredEventSignature);
  const primary = currentEvents.find(
    (event) => event._id === args.primaryEventId,
  )!;
  const duplicates = currentEvents.filter((event) => event._id !== primary._id);
  if (
    currentEvents.some(
      (event) => event.status === "rejected" || event.status !== primary.status,
    )
  ) {
    planInvalid(
      "Canonical consolidation requires equal non-rejected moderation states.",
    );
  }
  if (currentEvents.some(isCrossPostCampaignLineageEvent)) {
    planInvalid(
      "Audited campaign lineage remains a dedicated re-attestation compatibility exception.",
    );
  }
  const generated = await generateConsolidationOutcome(
    ctx,
    primary,
    duplicates,
    args.intent,
  );
  const regenerated = await generateConsolidationOutcome(
    ctx,
    primary,
    duplicates,
    args.intent,
  );
  assertRegeneratedOutcomeStillMatches(generated.outcome, regenerated.outcome);
  const expectedAction = args.intent === "merge_events" ? "merge" : "coalesce";
  if (generated.outcome.plan.action !== expectedAction) {
    const nonMutatingAction =
      generated.outcome.plan.action === "keep_distinct" ||
      generated.outcome.plan.action === "manual_review"
        ? generated.outcome.plan.action
        : planInvalid(
            "Canonical consolidation generated an incompatible non-mutating action.",
          );
    const auditId = await writeAudit({
      candidateEvents: generated.boundedCandidateEvents,
      ctx,
      mode: args.mode === "shadow" ? "shadow" : "rejected",
      outcome: generated.outcome,
      primaryEventId: primary._id,
    });
    return {
      action: nonMutatingAction,
      applied: false,
      auditId,
      canonicalEventId: primary._id,
      removedEventCount: 0,
    };
  }
  assertEveryPairEquivalent(currentEvents);
  await assertConsolidationExecutionPreflight({
    ctx,
    duplicates,
    expectedEventVersions:
      generated.outcome.plan.preconditions.candidateEventVersions ?? [],
    primary,
  });
  if (args.mode === "shadow") {
    const auditId = await writeAudit({
      candidateEvents: generated.boundedCandidateEvents,
      ctx,
      mode: "shadow",
      outcome: generated.outcome,
      primaryEventId: primary._id,
    });
    return {
      action: expectedAction,
      applied: false,
      auditId,
      canonicalEventId: primary._id,
      removedEventCount: 0,
    };
  }

  await assertReconciliationApplyReady(ctx, expectedAction);
  await assertConsolidationPreconditions({
    ctx,
    expectedEventVersions:
      generated.outcome.plan.preconditions.candidateEventVersions ?? [],
  });
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(
    ctx,
    primary._id,
    primary,
  );
  const preparedTopologies = new Map<
    Id<"events">,
    PreparedReconciliationEventTopology
  >();
  for (const duplicate of duplicates) {
    preparedTopologies.set(
      duplicate._id,
      await sourceOccurrenceProvenanceRepository.prepareReconciliationEventTopology(
        ctx,
        duplicate._id,
        primary,
      ),
    );
  }
  const expectedSaves = await captureSavedReferenceSnapshot(ctx, [
    primary._id,
    ...duplicates.map((event) => event._id),
  ]);

  for (const duplicate of duplicates) {
    const topology = preparedTopologies.get(duplicate._id);
    if (!topology) {
      planInvalid(
        "Canonical consolidation lost its prepared provenance topology.",
      );
    }
    await savedEventRepository.reassignEventReferences(
      ctx,
      duplicate._id,
      primary._id,
    );
    await sourceOccurrenceProvenanceRepository.reassignPreparedReconciliationEventTopology(
      ctx,
      topology,
      primary._id,
      { topologyEpochVerified: true },
    );
    await ctx.db.delete(duplicate._id);
    await ctx.db.insert("eventAuditLog", {
      action: `${expectedAction}_deleted_duplicate`,
      createdAt: Date.now(),
      eventId: duplicate._id,
      patchJson: JSON.stringify({ primaryEventId: primary._id }),
    });
  }
  await refreshEventPublicationStates(ctx, [primary._id]);
  await assertConsolidationFinalState({
    ctx,
    expectedSaves,
    removedEventIds: duplicates.map((event) => event._id),
    targetEventId: primary._id,
  });
  const auditId = await writeAudit({
    candidateEvents: generated.boundedCandidateEvents,
    ctx,
    mode: "applied",
    outcome: generated.outcome,
    primaryEventId: primary._id,
  });
  await ctx.db.insert("eventAuditLog", {
    action: `${expectedAction}_completed_by_reconciliation_executor`,
    createdAt: Date.now(),
    eventId: primary._id,
    patchJson: JSON.stringify({
      removedEventIds: duplicates.map((event) => event._id),
    }),
  });
  return {
    action: expectedAction,
    applied: true,
    auditId,
    canonicalEventId: primary._id,
    removedEventCount: duplicates.length,
  };
}

/**
 * Internal-only generic consolidation boundary. It accepts IDs and optimistic
 * versions, never a client-generated decision/plan, then re-runs bounded
 * classification and full final-state verification in one transaction.
 * Apply remains blocked by the existing disabled-by-default rollout gate.
 */
export const executeCanonicalConsolidation = internalMutation({
  args: {
    eventVersions: v.array(
      v.object({
        eventId: v.id("events"),
        expectedUpdatedAt: v.number(),
      }),
    ),
    intent: v.union(v.literal("merge_events"), v.literal("coalesce_events")),
    mode: v.union(v.literal("shadow"), v.literal("apply")),
    primaryEventId: v.id("events"),
  },
  returns: resultValidator,
  handler: executeCanonicalConsolidationHandler,
});

const consolidationCapabilityVerificationResultValidator = v.object({
  auditId: v.id("reconciliationAudits"),
  evidenceDigestSha256: v.string(),
  operation: v.union(v.literal("merge"), v.literal("coalesce")),
  operatorEnabled: v.literal(false),
  updatedAt: v.number(),
  verifiedConsolidationEvidenceCount: v.number(),
  verifiedOperationKinds: v.array(
    v.union(
      v.literal("create"),
      v.literal("attach"),
      v.literal("update"),
      v.literal("merge"),
      v.literal("coalesce"),
    ),
  ),
  verificationRunId: v.string(),
});

/**
 * Bounded server proof for one real current consolidation envelope. It accepts
 * only IDs/versions, regenerates the plan, validates topology and save
 * preconditions, writes a shadow audit, and can append capability evidence
 * only while the rollout remains disabled and awaiting human review.
 */
export const verifyCanonicalConsolidationCapability = internalMutation({
  args: {
    eventVersions: v.array(
      v.object({
        eventId: v.id("events"),
        expectedUpdatedAt: v.number(),
      }),
    ),
    expectedRolloutUpdatedAt: v.number(),
    intent: v.union(v.literal("merge_events"), v.literal("coalesce_events")),
    primaryEventId: v.id("events"),
  },
  returns: consolidationCapabilityVerificationResultValidator,
  handler: async (ctx, args) => {
    const verification = await executeCanonicalConsolidationHandler(ctx, {
      eventVersions: args.eventVersions,
      intent: args.intent,
      mode: "shadow",
      primaryEventId: args.primaryEventId,
    });
    const operation =
      args.intent === "merge_events"
        ? ("merge" as const)
        : ("coalesce" as const);
    if (verification.applied || verification.action !== operation) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Consolidation capability proof did not produce the requested non-mutating generic action.",
      );
    }
    const audit = await ctx.db.get(verification.auditId);
    if (!audit || audit.mode !== "shadow" || audit.action !== operation) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Consolidation capability proof did not persist its server audit.",
      );
    }
    const appended = await appendServerVerifiedConsolidationCapability(ctx, {
      evidenceMaterial: JSON.stringify({
        auditId: audit._id,
        candidateEventIds: audit.candidateEventIds.map(String).sort(),
        decisionJson: audit.decisionJson,
        operation,
        planJson: audit.planJson,
        policyVersion: audit.policyVersion,
        primaryEventId: args.primaryEventId,
      }),
      expectedUpdatedAt: args.expectedRolloutUpdatedAt,
      operation,
    });
    return {
      auditId: audit._id,
      evidenceDigestSha256: appended.evidenceDigestSha256,
      operation,
      operatorEnabled: false as const,
      updatedAt: appended.updatedAt,
      verifiedConsolidationEvidenceCount:
        appended.verifiedConsolidationEvidenceCount,
      verifiedOperationKinds: appended.verifiedOperationKinds,
      verificationRunId: appended.verificationRunId,
    };
  },
});
