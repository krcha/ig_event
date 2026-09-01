import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { buildManualReviewOutcome } from "../../lib/domain/reconciliation/index";
import { refreshEventPublicationStates } from "../publicationPolicy";
import {
  getReconciliationLineageQuarantineReason,
  loadExactReconciliationProvenanceLink,
  loadReconciliationSourceDocument,
  sourceOccurrenceHasFinalProvenance,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import { assertReconciliationApplyReady } from "./reconciliationApplyReadiness";
import {
  applySourceOccurrenceCanonicalAction,
  createPendingEventForUnresolvedVenue,
} from "./reconciliationCanonicalEventWriter";
import {
  assertRegeneratedOutcomeStillMatches,
  assertSourceOccurrenceFinalState,
  assertSourceOccurrencePlanFences,
  assertUnresolvedVenueExactRetryFences,
  assertUnresolvedVenuePendingCreateFences,
  assertVerifiedTopologyEpoch,
} from "./reconciliationFullOutcome";
import {
  canonicalPatchFromSourceOccurrence,
  loadVenueFields,
  readCanonicalEventPayload,
  readNormalizedOccurrence,
  assertStoredSignature,
  type LegacyOutcome,
  type SourceOccurrenceIntent,
} from "./reconciliationOccurrenceContext";
import { writeReconciliationAudit } from "./reconciliationSourceAudit";
import {
  generateServerOutcome,
  type GeneratedSourceOccurrenceOutcome,
} from "./reconciliationSourceOutcome";
import {
  assertCurrentSourceFence,
  upsertProvenanceAndReceipt,
} from "./reconciliationSourcePersistence";
import {
  markSourceOccurrenceTopologyMutation,
  readSourceOccurrenceTopologyEpoch,
} from "./sourceOccurrenceTopologyEpoch";

export type ExecuteSourceOccurrenceArgs = {
  expectedSourceOccurrenceUpdatedAt: number;
  expectedSourceRevision: number;
  legacyOutcome?: LegacyOutcome;
  intent?: SourceOccurrenceIntent;
  mode: "shadow" | "apply";
  processingOwner?: string;
  shadowComparisonBasis?: "post_write_counterfactual";
  sourceOccurrenceId: Id<"sourceOccurrences">;
};

async function finalizeAppliedSourceOccurrence(options: {
  ctx: MutationCtx;
  generated: GeneratedSourceOccurrenceOutcome;
  legacyOutcome?: LegacyOutcome;
  canonicalEventId: Id<"events">;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
}) {
  const {
    canonicalEventId,
    ctx,
    generated,
    legacyOutcome,
    occurrence,
    sourceDocument,
  } = options;
  const affectedRepresentativeEventIds = await upsertProvenanceAndReceipt({
    ctx,
    eventId: canonicalEventId,
    occurrence,
    sourceDocument,
  });
  await ctx.db.patch(occurrence._id, {
    canonicalEventId,
    state: "satisfied",
    updatedAt: Date.now(),
  });
  await refreshEventPublicationStates(ctx, affectedRepresentativeEventIds);
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await assertSourceOccurrenceFinalState({
    ctx,
    eventId: canonicalEventId,
    occurrenceId: occurrence._id,
  });
  const auditId = await writeReconciliationAudit({
    candidateEvents: generated.candidateEvents,
    canonicalEventId,
    ctx,
    legacyOutcome,
    mode: "applied",
    occurrence,
    outcome: generated.outcome,
  });
  return {
    applied: true,
    auditId,
    canonicalEventId,
    decision: generated.outcome.decision,
    plan: generated.outcome.plan,
  };
}

export async function executeSourceOccurrenceHandler(
  ctx: MutationCtx,
  args: ExecuteSourceOccurrenceArgs,
) {
  const occurrence = await ctx.db.get(args.sourceOccurrenceId);
  if (!occurrence) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Source occurrence not found.",
    );
  }
  if (occurrence.state === "deferred" || occurrence.state === "superseded") {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Deferred or superseded source occurrences cannot be reconciled.",
      {
        details: {
          sourceOccurrenceId: occurrence._id,
          state: occurrence.state,
        },
      },
    );
  }
  if (
    occurrence.updatedAt !== args.expectedSourceOccurrenceUpdatedAt ||
    occurrence.sourceRevision !== args.expectedSourceRevision
  ) {
    throw new DomainError(
      "SOURCE_REVISION_CHANGED",
      "Source occurrence changed before reconciliation.",
    );
  }
  const sourceDocument = await loadReconciliationSourceDocument(
    ctx,
    occurrence,
  );
  if (!sourceDocument) {
    throw new DomainError("SOURCE_NOT_GROUNDED", "Source document not found.");
  }
  await assertCurrentSourceFence(sourceDocument, occurrence, args);
  const normalized = readNormalizedOccurrence(occurrence);
  assertStoredSignature(occurrence, normalized);
  const exactSourceLink = await loadExactReconciliationProvenanceLink(
    ctx,
    occurrence,
  );
  if (
    exactSourceLink &&
    occurrence.canonicalEventId &&
    exactSourceLink.eventId !== occurrence.canonicalEventId
  ) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "First-class occurrence and legacy provenance link target different canonical events.",
      {
        details: {
          legacyCanonicalEventId: exactSourceLink.eventId,
          occurrenceCanonicalEventId: occurrence.canonicalEventId,
          sourceOccurrenceId: occurrence._id,
        },
      },
    );
  }
  const quarantineReason = await getReconciliationLineageQuarantineReason(
    ctx,
    occurrence,
    exactSourceLink,
  );
  let topologyEpoch: number | undefined;
  if (args.mode === "apply") {
    if (quarantineReason) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Audited aggregate lineage requires a dedicated atomic re-attestation before automatic reconciliation.",
        { details: { quarantineReason, sourceOccurrenceId: occurrence._id } },
      );
    }
    topologyEpoch = await assertVerifiedTopologyEpoch(ctx);
  } else {
    const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
    if (epoch && epoch.currentEpoch === epoch.verifiedEpoch) {
      topologyEpoch = epoch.currentEpoch;
    }
  }
  const venueFields = await loadVenueFields(ctx, occurrence, normalized.venue);
  const canonicalEventPayload = readCanonicalEventPayload(occurrence);
  const canonicalPatchEnvelope =
    venueFields && (args.intent === "moderate" || canonicalEventPayload)
      ? canonicalPatchFromSourceOccurrence(
          occurrence,
          normalized,
          venueFields,
          sourceDocument,
        )
      : undefined;
  const unresolvedVenueClaimEligible =
    occurrence.venueResolutionStatus === "unresolved" &&
    !occurrence.venueId &&
    Boolean(normalized.venue.trim());
  const exactUnresolvedRetry = Boolean(
    args.mode === "apply" &&
      unresolvedVenueClaimEligible &&
      exactSourceLink &&
      occurrence.canonicalEventId &&
      exactSourceLink.eventId === occurrence.canonicalEventId &&
      (await sourceOccurrenceHasFinalProvenance({
        ctx,
        eventId: occurrence.canonicalEventId,
        occurrence,
      })),
  );
  const unresolvedBindingIsUnsafe = Boolean(
    args.mode === "apply" &&
      unresolvedVenueClaimEligible &&
      (exactSourceLink || occurrence.canonicalEventId) &&
      !exactUnresolvedRetry,
  );
  const generated = quarantineReason
    ? {
        candidateEvents: [] as Doc<"events">[],
        candidateSetTruncated: false,
        outcome: buildManualReviewOutcome(
          quarantineReason,
          String(occurrence._id),
        ),
      }
    : venueFields
      ? await generateServerOutcome(
          ctx,
          occurrence,
          normalized,
          exactSourceLink,
          sourceDocument,
          {
            ...(canonicalPatchEnvelope
              ? {
                  canonicalFieldsToUnset: canonicalPatchEnvelope.fieldsToUnset,
                  canonicalPatch: canonicalPatchEnvelope.patch,
                }
              : {}),
            intent: args.intent ?? "ingest_occurrence",
            ...(topologyEpoch !== undefined ? { topologyEpoch } : {}),
            ...(args.shadowComparisonBasis && args.legacyOutcome
              ? {
                  postWriteCounterfactualLegacyOutcome: args.legacyOutcome,
                }
              : {}),
          },
        )
      : args.mode === "apply" &&
          unresolvedVenueClaimEligible &&
          !unresolvedBindingIsUnsafe
        ? await generateServerOutcome(
            ctx,
            occurrence,
            normalized,
            exactSourceLink,
            sourceDocument,
            {
              intent: "ingest_occurrence",
              ...(topologyEpoch !== undefined ? { topologyEpoch } : {}),
              unresolvedVenuePendingCreate: true,
            },
          )
      : {
          candidateEvents: [] as Doc<"events">[],
          candidateSetTruncated: false,
          outcome: buildManualReviewOutcome(
            unresolvedBindingIsUnsafe
              ? "unresolved_venue_exact_identity_incomplete"
              : occurrence.venueResolutionStatus === "ambiguous"
              ? "venue_resolution_ambiguous"
              : "venue_resolution_unresolved",
            String(occurrence._id),
          ),
        };

  if (
    args.mode === "shadow" ||
    generated.outcome.plan.action === "manual_review"
  ) {
    const auditId = await writeReconciliationAudit({
      candidateEvents: generated.candidateEvents,
      ctx,
      legacyOutcome: args.legacyOutcome,
      mode: args.mode === "shadow" ? "shadow" : "rejected",
      occurrence,
      outcome: generated.outcome,
      shadowComparisonBasis: args.shadowComparisonBasis,
    });
    return {
      applied: false,
      auditId,
      canonicalEventId: undefined,
      decision: generated.outcome.decision,
      plan: generated.outcome.plan,
    };
  }
  if (
    generated.outcome.plan.action !== "create" &&
    generated.outcome.plan.action !== "attach" &&
    generated.outcome.plan.action !== "update"
  ) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Generated source-occurrence action is not an enabled generic operation.",
    );
  }
  await assertReconciliationApplyReady(ctx, generated.outcome.plan.action);
  if (!venueFields) {
    const regenerated = await generateServerOutcome(
      ctx,
      occurrence,
      normalized,
      exactSourceLink,
      sourceDocument,
      {
        intent: "ingest_occurrence",
        ...(topologyEpoch !== undefined ? { topologyEpoch } : {}),
        unresolvedVenuePendingCreate: true,
      },
    );
    assertRegeneratedOutcomeStillMatches(generated.outcome, regenerated.outcome);

    if (regenerated.outcome.plan.action === "create") {
      if (exactSourceLink || occurrence.canonicalEventId) {
        throw new DomainError(
          "RECONCILIATION_PLAN_INVALID",
          "An unresolved venue occurrence with existing provenance cannot create a second canonical event.",
        );
      }
      await assertUnresolvedVenuePendingCreateFences({
        candidateEvents: regenerated.candidateEvents,
        candidateSetTruncated: regenerated.candidateSetTruncated,
        ctx,
        occurrence,
        outcome: regenerated.outcome,
        sourceDocument,
      });
      const canonicalEventId = await createPendingEventForUnresolvedVenue({
        ctx,
        normalized,
        occurrence,
        sourceDocument,
      });
      return await finalizeAppliedSourceOccurrence({
        canonicalEventId,
        ctx,
        generated: regenerated,
        legacyOutcome: args.legacyOutcome,
        occurrence,
        sourceDocument,
      });
    }

    if (
      regenerated.outcome.plan.action === "attach" &&
      exactUnresolvedRetry &&
      occurrence.canonicalEventId
    ) {
      await assertUnresolvedVenueExactRetryFences({
        candidateEvents: regenerated.candidateEvents,
        candidateSetTruncated: regenerated.candidateSetTruncated,
        ctx,
        eventId: occurrence.canonicalEventId,
        occurrence,
        outcome: regenerated.outcome,
        sourceDocument,
      });
      return await finalizeAppliedSourceOccurrence({
        canonicalEventId: occurrence.canonicalEventId,
        ctx,
        generated: regenerated,
        legacyOutcome: args.legacyOutcome,
        occurrence,
        sourceDocument,
      });
    }

    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "An unresolved venue occurrence may only create a hidden pending event or retry its exact proven source identity.",
    );
  }

  const regenerated = await generateServerOutcome(
    ctx,
    occurrence,
    normalized,
    exactSourceLink,
    sourceDocument,
    {
      ...(canonicalPatchEnvelope
        ? {
            canonicalFieldsToUnset: canonicalPatchEnvelope.fieldsToUnset,
            canonicalPatch: canonicalPatchEnvelope.patch,
          }
        : {}),
      intent: args.intent ?? "ingest_occurrence",
      ...(topologyEpoch !== undefined ? { topologyEpoch } : {}),
    },
  );
  assertRegeneratedOutcomeStillMatches(generated.outcome, regenerated.outcome);
  await assertSourceOccurrencePlanFences({
    candidateEvents: regenerated.candidateEvents,
    candidateSetTruncated: regenerated.candidateSetTruncated,
    ctx,
    occurrence,
    outcome: regenerated.outcome,
    resolvedVenueId: occurrence.venueId!,
    sourceDocument,
  });

  const canonicalEventId = await applySourceOccurrenceCanonicalAction({
    ctx,
    generated: regenerated,
    normalized,
    occurrence,
    sourceDocument,
    venueFields,
  });
  return await finalizeAppliedSourceOccurrence({
    canonicalEventId,
    ctx,
    legacyOutcome: args.legacyOutcome,
    generated: regenerated,
    occurrence,
    sourceDocument,
  });
}
