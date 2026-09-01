import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type {
  ReconciliationOutcome,
  ReconciliationPlan,
} from "../../lib/domain/reconciliation/index";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import type { ReconciliationSourceDocument } from "../repositories/reconciliationSourceContext";
import {
  assertSourceOccurrenceFinalState,
  assertSourceOccurrencePlanFences,
} from "./reconciliationFullOutcome";
import type {
  FullOutcomeEvidence,
  FullOutcomeEvidenceStatus,
} from "./reconciliationRolloutVerification";
import { readCanonicalEventPayload } from "./reconciliationOccurrenceContext";

const MAX_LEGACY_SHADOW_AUDITS_PER_OCCURRENCE = 64;

type NormalizedOccurrenceObservation = {
  artists: readonly string[];
  date: string;
  eventType: string;
  time?: string;
  title: string;
};

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function loadLatestLegacyObservedAudit(
  ctx: Pick<MutationCtx, "db">,
  occurrence: Doc<"sourceOccurrences">,
): Promise<Doc<"reconciliationAudits"> | null> {
  const audits = await ctx.db
    .query("reconciliationAudits")
    .withIndex("by_source_occurrence_createdAt", (q) =>
      q.eq("sourceOccurrenceId", occurrence._id),
    )
    .order("desc")
    .take(MAX_LEGACY_SHADOW_AUDITS_PER_OCCURRENCE);
  return (
    audits.find(
      (audit) =>
        audit.mode === "shadow" &&
        audit.legacyOutcome !== undefined &&
        audit.shadowComparisonBasis === "post_write_counterfactual",
    ) ?? null
  );
}

export function legacyAuditIsBoundToCurrentOccurrence(
  audit: Doc<"reconciliationAudits">,
  occurrence: Doc<"sourceOccurrences">,
): boolean {
  const plan = parseObject(audit.planJson);
  const preconditions =
    plan?.preconditions &&
    typeof plan.preconditions === "object" &&
    !Array.isArray(plan.preconditions)
      ? (plan.preconditions as Record<string, unknown>)
      : null;
  return Boolean(
    audit.legacyOutcome &&
    audit.action === audit.legacyOutcome &&
    plan?.action === audit.legacyOutcome &&
    audit.createdAt >= occurrence.updatedAt &&
    preconditions?.sourceOccurrenceId === String(occurrence._id) &&
    preconditions.sourceOccurrenceUpdatedAt === occurrence.updatedAt &&
    preconditions.sourceOccurrenceKey === occurrence.sourceOccurrenceKey &&
    preconditions.sourceFingerprint === occurrence.sourceFingerprint &&
    preconditions.sourceRevision === occurrence.sourceRevision,
  );
}

function canonicalEventHasCurrentSignature(event: Doc<"events">): boolean {
  const expected = buildEventOccurrenceIndexPatch(event);
  return Object.entries(expected).every(
    ([field, value]) =>
      JSON.stringify((event as unknown as Record<string, unknown>)[field]) ===
      JSON.stringify(value),
  );
}

function canonicalEventMatchesCreateObservation(options: {
  canonicalVenueName: string;
  event: Doc<"events">;
  normalized: NormalizedOccurrenceObservation;
  occurrence: Doc<"sourceOccurrences">;
}): boolean {
  const { canonicalVenueName, event, normalized, occurrence } = options;
  const canonicalPayload = readCanonicalEventPayload(occurrence);
  const storedSignature = {
    occurrenceArtistFingerprint: occurrence.occurrenceArtistFingerprint,
    occurrenceDateKey: occurrence.occurrenceDateKey,
    occurrenceEventType: occurrence.occurrenceEventType,
    occurrenceSignatureHash: occurrence.occurrenceSignatureHash,
    occurrenceSignatureVersion: occurrence.occurrenceSignatureVersion,
    occurrenceTimeIdentity: occurrence.occurrenceTimeIdentity,
    occurrenceTitleFamily: occurrence.occurrenceTitleFamily,
    occurrenceVenueIdentity: occurrence.occurrenceVenueIdentity,
  };
  return (
    canonicalEventHasCurrentSignature(event) &&
    event.status === (canonicalPayload?.requestedStatus ?? "pending") &&
    event.canonicalSourceUrl === occurrence.canonicalSourceUrl &&
    event.sourceOccurrenceKey === occurrence.sourceOccurrenceKey &&
    event.title === normalized.title &&
    event.date === normalized.date &&
    event.time === normalized.time &&
    event.eventType === normalized.eventType &&
    event.venue === canonicalVenueName &&
    event.venueId === occurrence.venueId &&
    JSON.stringify(event.artists) === JSON.stringify(normalized.artists) &&
    Object.entries(storedSignature).every(
      ([field, value]) =>
        JSON.stringify((event as unknown as Record<string, unknown>)[field]) ===
        JSON.stringify(value),
    )
  );
}

function canonicalEventMatchesUpdatePlan(
  event: Doc<"events">,
  plan: ReconciliationPlan,
): boolean {
  return (
    Object.entries(plan.canonicalPatch ?? {}).every(
      ([field, value]) =>
        JSON.stringify((event as unknown as Record<string, unknown>)[field]) ===
        JSON.stringify(value),
    ) &&
    (plan.canonicalFieldsToUnset ?? []).every(
      (field) =>
        (event as unknown as Record<string, unknown>)[field] === undefined,
    )
  );
}

/**
 * Compares a current generic counterfactual with a separately observed legacy
 * action and its complete persisted final state. The audit writer is injected
 * so this module remains independent of the mutation entrypoint.
 */
export async function verifyPreparedLegacyObservedOutcome(options: {
  candidateEvents: readonly Doc<"events">[];
  candidateSetTruncated: boolean;
  canonicalVenueName: string;
  ctx: MutationCtx;
  legacyAudit: Doc<"reconciliationAudits">;
  normalized: NormalizedOccurrenceObservation;
  observedCanonicalEvent: Doc<"events">;
  occurrence: Doc<"sourceOccurrences">;
  outcome: ReconciliationOutcome;
  sourceDocument: ReconciliationSourceDocument;
  verificationRunId: string;
  writeAudit: (args: {
    canonicalEventId?: Id<"events">;
    status: FullOutcomeEvidenceStatus;
  }) => Promise<Id<"reconciliationAudits">>;
}): Promise<FullOutcomeEvidence> {
  const {
    candidateEvents,
    candidateSetTruncated,
    canonicalVenueName,
    ctx,
    legacyAudit,
    normalized,
    observedCanonicalEvent,
    occurrence,
    outcome,
    sourceDocument,
    writeAudit,
  } = options;
  const observedCanonicalEventId = observedCanonicalEvent._id;
  const legacyOutcome = legacyAudit.legacyOutcome!;
  let mismatchReason: string | null = null;
  try {
    await assertSourceOccurrencePlanFences({
      candidateEvents,
      candidateSetTruncated,
      ctx,
      observedCanonicalEventId,
      occurrence,
      outcome,
      resolvedVenueId: occurrence.venueId!,
      sourceDocument,
    });
    await assertSourceOccurrenceFinalState({
      ctx,
      eventId: observedCanonicalEventId,
      occurrenceId: occurrence._id,
    });
  } catch (error) {
    mismatchReason =
      error instanceof Error
        ? `${error.name}:${error.message}`.slice(0, 1_000)
        : "legacy_final_state_verification_failed";
  }
  if (outcome.plan.action !== legacyOutcome) {
    mismatchReason ??= "generic_action_differs_from_legacy_observed_action";
  }
  if (
    legacyOutcome !== "create" &&
    outcome.plan.canonicalEventId !== String(observedCanonicalEventId)
  ) {
    mismatchReason ??= "generic_target_differs_from_legacy_observed_target";
  }
  if (
    legacyOutcome === "create" &&
    !canonicalEventMatchesCreateObservation({
      canonicalVenueName,
      event: observedCanonicalEvent,
      normalized,
      occurrence,
    })
  ) {
    mismatchReason ??= "legacy_created_event_differs_from_normalized_outcome";
  }
  if (
    legacyOutcome === "update" &&
    !canonicalEventMatchesUpdatePlan(observedCanonicalEvent, outcome.plan)
  ) {
    mismatchReason ??= "legacy_updated_event_differs_from_generic_patch";
  }
  const status = mismatchReason ? ("mismatch" as const) : ("matched" as const);
  const plannedCanonicalEventId = outcome.plan.canonicalEventId as
    | Id<"events">
    | undefined;
  const auditId = await writeAudit({
    ...(plannedCanonicalEventId
      ? { canonicalEventId: plannedCanonicalEventId }
      : {}),
    status,
  });
  const digestMaterial = JSON.stringify({
    action: outcome.plan.action,
    auditId,
    candidateEventIds: candidateEvents.map((event) => String(event._id)).sort(),
    decision: outcome.decision,
    legacyAuditId: legacyAudit._id,
    legacyOutcome,
    mismatchReason,
    observedCanonicalEventId,
    plan: outcome.plan,
  });
  return status === "matched"
    ? { digestMaterial, operationKind: legacyOutcome, status }
    : { digestMaterial, status };
}
