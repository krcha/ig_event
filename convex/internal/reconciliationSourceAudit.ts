import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  buildManualReviewOutcome,
  type ReconciliationOutcome,
} from "../../lib/domain/reconciliation/index";
import {
  getReconciliationLineageQuarantineReason,
  loadExactReconciliationProvenanceLink,
  loadReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import {
  legacyAuditIsBoundToCurrentOccurrence,
  loadLatestLegacyObservedAudit,
  verifyPreparedLegacyObservedOutcome,
} from "./reconciliationObservedOutcomeVerifier";
import {
  canonicalPatchFromSourceOccurrence,
  loadVenueFields,
  readNormalizedOccurrence,
  assertStoredSignature,
  type LegacyOutcome,
} from "./reconciliationOccurrenceContext";
import type { FullOutcomeEvidenceStatus } from "./reconciliationRolloutVerification";
import { generateServerOutcome } from "./reconciliationSourceOutcome";
import { assertCurrentSourceFence } from "./reconciliationSourcePersistence";

export async function writeReconciliationAudit(options: {
  candidateEvents: readonly Doc<"events">[];
  canonicalEventId?: Id<"events">;
  ctx: MutationCtx;
  legacyOutcome?: LegacyOutcome;
  mode: "shadow" | "applied" | "rejected";
  occurrence: Doc<"sourceOccurrences">;
  outcome: ReconciliationOutcome;
  shadowComparisonBasis?: "post_write_counterfactual";
  fullOutcomeStatus?: FullOutcomeEvidenceStatus;
  verificationRunId?: string;
}): Promise<Id<"reconciliationAudits">> {
  return options.ctx.db.insert("reconciliationAudits", {
    action: options.outcome.plan.action,
    candidateEventIds: options.candidateEvents.map((event) => event._id),
    ...(options.canonicalEventId
      ? { canonicalEventId: options.canonicalEventId }
      : {}),
    createdAt: Date.now(),
    decisionJson: JSON.stringify(options.outcome.decision),
    ...(options.verificationRunId && options.fullOutcomeStatus
      ? {
          shadowMatches: options.fullOutcomeStatus === "matched",
          shadowComparisonReason: `server_full_outcome_v1:${options.verificationRunId}`,
          shadowComparisonStatus:
            options.fullOutcomeStatus === "matched"
              ? ("match" as const)
              : options.fullOutcomeStatus === "mismatch"
                ? ("mismatch" as const)
                : ("indeterminate" as const),
        }
      : options.legacyOutcome
        ? {
            legacyOutcome: options.legacyOutcome,
            shadowComparisonReason:
              "legacy_outcome_lacks_versioned_full_semantic_envelope",
            shadowComparisonStatus: "indeterminate" as const,
          }
        : {}),
    ...(options.shadowComparisonBasis
      ? { shadowComparisonBasis: options.shadowComparisonBasis }
      : {}),
    mode: options.mode,
    planJson: JSON.stringify(options.outcome.plan),
    policyVersion: options.outcome.plan.policyVersion,
    relation: options.outcome.decision.relation,
    sourceOccurrenceId: options.occurrence._id,
    strategy: options.outcome.decision.strategy,
  });
}

export async function verifySourceOccurrenceForRollout(
  ctx: MutationCtx,
  occurrence: Doc<"sourceOccurrences">,
  verificationRunId: string,
  topologyEpoch: number,
) {
  const sourceDocument = await loadReconciliationSourceDocument(
    ctx,
    occurrence,
  );
  if (!sourceDocument) {
    throw new DomainError("SOURCE_NOT_GROUNDED", "Source document not found.");
  }
  await assertCurrentSourceFence(sourceDocument, occurrence, {
    mode: "shadow",
  });
  const normalized = readNormalizedOccurrence(occurrence);
  assertStoredSignature(occurrence, normalized);
  const exactSourceLink = await loadExactReconciliationProvenanceLink(
    ctx,
    occurrence,
  );
  const legacyAudit = await loadLatestLegacyObservedAudit(ctx, occurrence);
  const quarantineReason = await getReconciliationLineageQuarantineReason(
    ctx,
    occurrence,
    exactSourceLink,
  );
  const venueFields = await loadVenueFields(ctx, occurrence, normalized.venue);
  const unavailableReason =
    occurrence.state === "deferred" || occurrence.state === "superseded"
      ? `inactive_source_occurrence_${occurrence.state}`
      : quarantineReason
        ? quarantineReason
        : !venueFields || !occurrence.venueId
          ? occurrence.venueResolutionStatus === "ambiguous"
            ? "venue_resolution_ambiguous"
            : "venue_resolution_unresolved"
          : !legacyAudit
            ? "legacy_observed_outcome_missing"
            : !legacyAuditIsBoundToCurrentOccurrence(legacyAudit, occurrence)
              ? "legacy_observed_outcome_stale_or_incomplete"
              : occurrence.state !== "satisfied" || !occurrence.canonicalEventId
                ? "legacy_final_state_missing"
                : null;
  if (unavailableReason) {
    const outcome = buildManualReviewOutcome(
      unavailableReason,
      String(occurrence._id),
    );
    const status =
      unavailableReason === "legacy_final_state_missing"
        ? ("mismatch" as const)
        : ("indeterminate" as const);
    const auditId = await writeReconciliationAudit({
      candidateEvents: [],
      ctx,
      fullOutcomeStatus: status,
      mode: "shadow",
      occurrence,
      outcome,
      verificationRunId,
    });
    return {
      digestMaterial: JSON.stringify({
        auditId,
        legacyAuditId: legacyAudit?._id,
        reason: unavailableReason,
      }),
      status,
    };
  }

  const observedCanonicalEventId = occurrence.canonicalEventId!;
  const observedCanonicalEvent = await ctx.db.get(observedCanonicalEventId);
  if (!observedCanonicalEvent) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Legacy-observed canonical event no longer exists.",
    );
  }
  const legacyOutcome = legacyAudit!.legacyOutcome!;
  const canonicalPatchEnvelope =
    legacyOutcome === "update"
      ? canonicalPatchFromSourceOccurrence(
          occurrence,
          normalized,
          venueFields!,
          sourceDocument,
        )
      : undefined;
  const generated = await generateServerOutcome(
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
      intent: legacyOutcome === "update" ? "moderate" : "ingest_occurrence",
      postWriteCounterfactualLegacyOutcome: legacyOutcome,
      topologyEpoch,
    },
  );
  return verifyPreparedLegacyObservedOutcome({
    candidateEvents: generated.candidateEvents,
    candidateSetTruncated: generated.candidateSetTruncated,
    canonicalVenueName: venueFields!.canonicalVenueName,
    ctx,
    legacyAudit: legacyAudit!,
    normalized,
    observedCanonicalEvent,
    occurrence,
    outcome: generated.outcome,
    sourceDocument,
    verificationRunId,
    writeAudit: ({ canonicalEventId, status }) =>
      writeReconciliationAudit({
        candidateEvents: generated.candidateEvents,
        ...(canonicalEventId ? { canonicalEventId } : {}),
        ctx,
        fullOutcomeStatus: status,
        mode: "shadow",
        occurrence,
        outcome: generated.outcome,
        verificationRunId,
      }),
  });
}
