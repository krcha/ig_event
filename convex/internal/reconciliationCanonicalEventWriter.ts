import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { PUBLICATION_POLICY_VERSION } from "../../lib/domain/publication/policy";
import { normalizeEventTimeWritePatch } from "../../lib/events/event-time-write";
import {
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
} from "../../lib/events/event-update-precondition";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { assertPublicEventImageWrite } from "../../lib/images/public-event-image";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "../eventDomain/sourceApproval";
import {
  projectUnresolvedVenueIdentityFields,
  projectNormalizedFieldsForSource,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import {
  assertCanonicalEventSignature,
  materializeCanonicalPatch,
  readCanonicalEventPayload,
  storedOccurrenceIndexFields,
  type NormalizedOccurrencePayload,
  type ResolvedVenueFields,
} from "./reconciliationOccurrenceContext";
import type { GeneratedSourceOccurrenceOutcome } from "./reconciliationSourceOutcome";

async function createSourceOccurrenceCanonicalEvent(options: {
  ctx: MutationCtx;
  forcePending: boolean;
  normalized: NormalizedOccurrencePayload;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
  venueFields?: ResolvedVenueFields;
}): Promise<Id<"events">> {
  const {
    ctx,
    forcePending,
    normalized,
    occurrence,
    sourceDocument,
    venueFields,
  } = options;
  const now = Date.now();
  const canonicalPayload = readCanonicalEventPayload(occurrence);
  const normalizedFieldsJson = projectNormalizedFieldsForSource(
    sourceDocument,
    canonicalPayload?.normalizedFieldsJson ??
      occurrence.normalizedOccurrenceJson,
  );
  const canonicalTimeFields = normalizeEventTimeWritePatch(
    canonicalPayload
      ? {
          time: canonicalPayload.time,
          timeConfidence: canonicalPayload.timeConfidence,
          timeEvidenceKind: canonicalPayload.timeEvidenceKind,
          timeEvidenceText: canonicalPayload.timeEvidenceText,
          timeSource: canonicalPayload.timeSource,
          timeStatus: canonicalPayload.timeStatus,
        }
      : normalized.time
        ? { time: normalized.time }
        : {},
  );
  const status = forcePending
    ? ("pending" as const)
    : canonicalPayload?.requestedStatus ?? ("pending" as const);
  const eventFields = {
    artists: normalized.artists,
    canonicalSourceUrl: occurrence.canonicalSourceUrl,
    date: normalized.date,
    ...((canonicalPayload?.description ?? normalized.description)
      ? {
          description:
            canonicalPayload?.description ?? normalized.description,
        }
      : {}),
    eventType: normalized.eventType,
    ...sourceDocument.canonicalEventFields,
    normalizedFieldsJson,
    ...(venueFields
      ? venueFields.fields
      : projectUnresolvedVenueIdentityFields(
          occurrence.occurrenceVenueIdentity,
        )),
    ...storedOccurrenceIndexFields(occurrence),
    sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
    status,
    ...(canonicalPayload
      ? {
          ...(canonicalPayload.dateEvidenceIsRelative !== undefined
            ? {
                dateEvidenceIsRelative:
                  canonicalPayload.dateEvidenceIsRelative,
              }
            : {}),
          ...(canonicalPayload.dateEvidenceResolvedDate
            ? {
                dateEvidenceResolvedDate:
                  canonicalPayload.dateEvidenceResolvedDate,
              }
            : {}),
          ...(canonicalPayload.dateEvidenceSource
            ? { dateEvidenceSource: canonicalPayload.dateEvidenceSource }
            : {}),
          ...(canonicalPayload.dateEvidenceText
            ? { dateEvidenceText: canonicalPayload.dateEvidenceText }
            : {}),
          sourceConflictFields: [...canonicalPayload.sourceConflictFields],
          ...(canonicalPayload.ticketPrice
            ? { ticketPrice: canonicalPayload.ticketPrice }
            : {}),
        }
      : {}),
    ...canonicalTimeFields,
    title: normalized.title,
    venue: venueFields?.canonicalVenueName ?? normalized.venue,
  };
  assertPublicEventImageWrite(
    eventFields.imageUrl,
    eventFields.imageStorageId,
  );
  assertServiceCreateEventPolicy(
    eventFields.status,
    eventFields.normalizedFieldsJson,
    eventFields,
  );
  if (eventFields.status === "approved") {
    await assertPersistedServiceSourcePolicy(ctx, eventFields);
    await assertApprovalCandidatePolicy(ctx, eventFields);
  }
  const canonicalEventId = await ctx.db.insert("events", {
    ...eventFields,
    createdAt: now,
    publicationEvaluatedAt: now,
    publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
    publicationReason:
      eventFields.status === "approved"
        ? "canonical_source_grounding_missing"
        : "moderation_not_approved",
    publicationState:
      eventFields.status === "approved"
        ? "pending_verification"
        : "hidden",
    updatedAt: now,
  });
  await ctx.db.insert("eventAuditLog", {
    action: "created_by_reconciliation_executor",
    createdAt: now,
    eventId: canonicalEventId,
    patchJson: JSON.stringify({
      ...(forcePending ? { unresolvedVenuePending: true } : {}),
      sourceOccurrenceId: occurrence._id,
    }),
  });
  const createdEvent = await ctx.db.get(canonicalEventId);
  if (!createdEvent) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Created canonical event disappeared before verification.",
    );
  }
  assertCanonicalEventSignature(createdEvent);
  return canonicalEventId;
}

export async function createPendingEventForUnresolvedVenue(options: {
  ctx: MutationCtx;
  normalized: NormalizedOccurrencePayload;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<Id<"events">> {
  if (
    options.occurrence.venueResolutionStatus !== "unresolved" ||
    options.occurrence.venueId ||
    !options.normalized.venue.trim()
  ) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Unresolved-venue moderation creation requires one nonempty unresolved venue claim.",
    );
  }
  return createSourceOccurrenceCanonicalEvent({
    ...options,
    forcePending: true,
  });
}

/**
 * Applies only the canonical-event portion of an already regenerated and
 * fenced source-occurrence plan. Provenance, receipt, publication, and topology
 * finalization remain the executor's separate atomic responsibility.
 */
export async function applySourceOccurrenceCanonicalAction(options: {
  ctx: MutationCtx;
  generated: GeneratedSourceOccurrenceOutcome;
  normalized: NormalizedOccurrencePayload;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
  venueFields: ResolvedVenueFields;
}): Promise<Id<"events">> {
  const {
    ctx,
    generated,
    normalized,
    occurrence,
    sourceDocument,
    venueFields,
  } = options;
  const { plan } = generated.outcome;

  if (plan.action === "attach") {
    const target = generated.candidateEvents.find(
      (event) => String(event._id) === plan.canonicalEventId,
    );
    if (
      !target ||
      target.updatedAt !== plan.preconditions.candidateEventUpdatedAt
    ) {
      throw new DomainError(
        "STALE_EVENT_VERSION",
        "Canonical candidate changed before reconciliation was applied.",
      );
    }
    if (isCrossPostCampaignLineageEvent(target)) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Audited campaign lineage requires a dedicated atomic re-attestation before attachment.",
        {
          details: {
            canonicalEventId: target._id,
            sourceOccurrenceId: occurrence._id,
          },
        },
      );
    }
    return target._id;
  }

  if (plan.action === "update") {
    const target = generated.candidateEvents.find(
      (event) => String(event._id) === plan.canonicalEventId,
    );
    if (
      !target ||
      target.status !== "pending" ||
      target.updatedAt !== plan.preconditions.candidateEventUpdatedAt ||
      !plan.canonicalPatch
    ) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Generic occurrence update requires one current pending target and a server-generated patch.",
      );
    }
    if (isCrossPostCampaignLineageEvent(target)) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Audited campaign lineage requires dedicated re-attestation before update.",
      );
    }
    const canonicalMutationPatch = materializeCanonicalPatch(plan);
    const effectiveTarget = {
      ...target,
      ...canonicalMutationPatch,
    } as Doc<"events">;
    assertPublicEventImageWrite(
      effectiveTarget.imageUrl,
      effectiveTarget.imageStorageId,
    );
    assertServiceUpdateEventPolicy(
      target.status,
      canonicalMutationPatch as Parameters<
        typeof assertServiceUpdateEventPolicy
      >[1],
      target,
    );
    if (effectiveTarget.status === "approved") {
      await assertPersistedServiceSourcePolicy(ctx, effectiveTarget);
      await assertApprovalCandidatePolicy(ctx, effectiveTarget, [target._id]);
    }
    assertCanonicalEventSignature(effectiveTarget);
    await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(
      ctx,
      target._id,
      effectiveTarget,
    );
    const updatedAt = Math.max(Date.now(), target.updatedAt + 1);
    await ctx.db.patch(target._id, {
      ...canonicalMutationPatch,
      updatedAt,
    });
    await ctx.db.insert("eventAuditLog", {
      action: "updated_by_reconciliation_executor",
      createdAt: Date.now(),
      eventId: target._id,
      patchJson: JSON.stringify({
        fieldsToUnset: plan.canonicalFieldsToUnset ?? [],
        patch: plan.canonicalPatch,
      }),
    });
    return target._id;
  }

  if (plan.action === "create") {
    return createSourceOccurrenceCanonicalEvent({
      ctx,
      forcePending: false,
      normalized,
      occurrence,
      sourceDocument,
      venueFields,
    });
  }

  throw new DomainError(
    "RECONCILIATION_PLAN_INVALID",
    "Generated reconciliation action is not enabled for this rollout phase.",
  );
}
