import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  buildReconciliationPlan,
  reconcileOccurrence,
  type ReconciliationDecision,
  type ReconciliationOutcome,
} from "../../lib/domain/reconciliation/index";
import { loadOccurrenceCandidates } from "../repositories/occurrenceCandidates";
import {
  loadCandidateSourceAccountIdentity,
  type ReconciliationProvenanceLink,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import {
  eventAsOccurrence,
  sourceAsOccurrence,
  type NormalizedOccurrencePayload,
  type SourceOccurrenceIntent,
} from "./reconciliationOccurrenceContext";

export type GeneratedSourceOccurrenceOutcome = {
  candidateEvents: Doc<"events">[];
  candidateSetTruncated: boolean;
  outcome: ReconciliationOutcome;
};

export async function generateServerOutcome(
  ctx: MutationCtx,
  occurrence: Doc<"sourceOccurrences">,
  normalized: NormalizedOccurrencePayload,
  exactSourceLink: ReconciliationProvenanceLink | null,
  sourceDocument: ReconciliationSourceDocument,
  options: {
    canonicalFieldsToUnset?: readonly string[];
    canonicalPatch?: Readonly<Record<string, unknown>>;
    intent?: SourceOccurrenceIntent;
    topologyEpoch?: number;
    postWriteCounterfactualLegacyOutcome?: "attach" | "create" | "update";
    unresolvedVenuePendingCreate?: boolean;
  } = {},
): Promise<GeneratedSourceOccurrenceOutcome> {
  if (
    options.unresolvedVenuePendingCreate &&
    (occurrence.venueResolutionStatus !== "unresolved" ||
      occurrence.venueId ||
      !normalized.venue.trim())
  ) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "The unresolved-venue pending-create policy requires a nonempty unresolved venue claim without a canonical venue binding.",
    );
  }
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
  const candidateResult = await loadOccurrenceCandidates(ctx.db, occurrence, 12);
  const excludedPostWriteEventId =
    options.postWriteCounterfactualLegacyOutcome === "create"
      ? occurrence.canonicalEventId
      : undefined;
  const candidatesById = new Map(
    candidateResult.candidates
      .filter((event) => event._id !== excludedPostWriteEventId)
      .map((event) => [String(event._id), event]),
  );
  if (exactSourceLink && !options.postWriteCounterfactualLegacyOutcome) {
    const exactEvent = await ctx.db.get(exactSourceLink.eventId);
    if (!exactEvent) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Provenance link targets a missing canonical event.",
      );
    }
    candidatesById.set(String(exactEvent._id), exactEvent);
  }
  if (
    occurrence.canonicalEventId &&
    !options.postWriteCounterfactualLegacyOutcome
  ) {
    const linkedEvent = await ctx.db.get(occurrence.canonicalEventId);
    if (!linkedEvent) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Source occurrence targets a missing canonical event.",
      );
    }
    candidatesById.set(String(linkedEvent._id), linkedEvent);
  }
  const candidateEvents = [...candidatesById.values()];
  const incomingSourceAccountIdentity = sourceDocument.accountIdentity;
  const candidateOccurrences = await Promise.all(
    candidateEvents.map(async (event) =>
      eventAsOccurrence(
        event,
        !options.postWriteCounterfactualLegacyOutcome &&
          exactSourceLink?.eventId === event._id
          ? exactSourceLink
          : undefined,
        await loadCandidateSourceAccountIdentity(
          ctx,
          event._id,
          incomingSourceAccountIdentity,
        ),
      ),
    ),
  );
  const context = {
    candidates: candidateOccurrences,
    candidateSetTruncated: candidateResult.truncated,
    ...(options.canonicalPatch
      ? { canonicalPatch: options.canonicalPatch }
      : {}),
    ...(options.canonicalFieldsToUnset?.length
      ? { canonicalFieldsToUnset: options.canonicalFieldsToUnset }
      : {}),
    incoming: sourceAsOccurrence(occurrence, normalized, sourceDocument),
    intent: options.intent ?? "ingest_occurrence",
    ...(options.topologyEpoch !== undefined
      ? { occurrenceTopologyEpoch: options.topologyEpoch }
      : {}),
    sourceDocumentId: String(occurrence.sourceDocumentId),
    sourceFingerprint: occurrence.sourceFingerprint,
    sourceOccurrenceUpdatedAt: occurrence.updatedAt,
    sourceRevision: occurrence.sourceRevision,
    venueResolutionStatus: occurrence.venueResolutionStatus,
  } as const;
  const normalOutcome = reconcileOccurrence(context);
  let outcome = normalOutcome;
  if (
    options.unresolvedVenuePendingCreate &&
    normalOutcome.plan.action !== "manual_review" &&
    normalOutcome.decision.relation !== "exact_source_occurrence" &&
    normalOutcome.plan.action !== "create"
  ) {
    const decision: ReconciliationDecision = {
      confidence: "proven",
      evidence: normalOutcome.decision.evidence,
      reasons: [
        "unresolved_venue_requires_separate_pending_moderation",
        ...normalOutcome.decision.reasons,
      ],
      relation: "independent",
      strategy: "unresolved_venue_pending",
    };
    outcome = {
      decision,
      plan: buildReconciliationPlan(context, decision),
    };
  }
  return {
    candidateEvents,
    candidateSetTruncated: candidateResult.truncated,
    outcome,
  };
}
