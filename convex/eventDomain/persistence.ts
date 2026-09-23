import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { savedEventRepository } from "../repositories/savedEvents";
import {
  sourceOccurrenceProvenanceRepository,
  MAX_RETENTION_RETAINED_PUBLICATION_CHECKS,
  type EventOccurrenceTopology,
} from "../repositories/sourceOccurrenceProvenance";
import { assertCompleteReceiptTopologyCoverage } from "../internal/receiptTopologyCoverage";
import { isCrossPostCampaignAttestationEvent, isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { isEventExpiredAtCutoff, type EventExpiryCutoff } from "../../lib/events/event-retention";
import { loadVerifiedReviewedFoldEventGroup } from "../internal/migrations/eventVenueBindings";
import {
  advanceRetentionReceiptCoverage,
  assertCompleteRetentionReceiptCoverage,
  loadCompleteRetentionReceiptReferences,
} from "../internal/retentionReceiptCoverage";
import {
  MAX_PUBLICATION_REFRESH_EVENTS,
  evaluateEventPublication,
  refreshEventPublicationStates,
} from "../publicationPolicy";

// One candidate can expand to a whole (at most eight-event) campaign, and each
// member can own 250 saved references. Keep the transactional fan-out bounded
// even when an operator asks for an oversized catch-up batch.
const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 1;

export async function writeEventAuditLog(
  ctx: MutationCtx,
  eventId: Id<"events">,
  action: string,
  options: {
    actor?: string;
    note?: string;
    patch?: unknown;
  } = {},
) {
  await ctx.db.insert("eventAuditLog", {
    eventId,
    action,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.patch !== undefined
      ? { patchJson: JSON.stringify(options.patch) }
      : {}),
    createdAt: Date.now(),
  });
}

export async function refreshCanonicalEventDerivedStates(
  ctx: MutationCtx,
  eventIds: readonly Id<"events">[],
): Promise<void> {
  const uniqueIds = [...new Set(eventIds)];
  if (uniqueIds.length > MAX_PUBLICATION_REFRESH_EVENTS) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Canonical event derived-state refresh exceeds the safe bounded limit.",
    );
  }
  const events = await Promise.all(
    uniqueIds.map((eventId) => ctx.db.get(eventId)),
  );
  for (const event of events) {
    if (!event) continue;
    const signaturePatch = buildEventOccurrenceIndexPatch(event);
    if (
      Object.entries(signaturePatch).some(
        ([key, value]) =>
          JSON.stringify((event as unknown as Record<string, unknown>)[key]) !==
          JSON.stringify(value),
      )
    ) {
      await ctx.db.patch(event._id, signaturePatch);
    }
  }
  await refreshEventPublicationStates(ctx, uniqueIds);
}

export function normalizeExpiredEventDeleteBatchSize(
  value: number | undefined,
): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE;
  return Math.max(1, Math.min(1, Math.trunc(value as number)));
}

export async function deleteEventWithSavedReferences(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<{ deletedReferenceCount: number; topologyMutated: boolean }> {
  await assertCompleteReceiptTopologyCoverage(ctx);
  const sourceTopology =
    await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
      ctx,
      eventId,
    );
  const topologyMutated =
    sourceTopology.links.length > 0 ||
    sourceTopology.occurrences.length > 0 ||
    sourceTopology.receipts.some((receipt) =>
      receipt.satisfiedOccurrences.some(
        (occurrence) => occurrence.eventId === eventId,
      ),
    );
  const deletedReferenceCount =
    await savedEventRepository.deleteEventReferences(ctx, eventId);
  const retiredProvenance =
    await sourceOccurrenceProvenanceRepository.removeLegacyBindingsForDeletedEvent(
      ctx,
      eventId,
      { preparedTopology: sourceTopology, topologyEpochVerified: true },
    );
  await sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(
    ctx,
    eventId,
    {
      preparedTopology: sourceTopology,
      topologyEpochVerified: true,
    },
  );
  await refreshCanonicalEventDerivedStates(
    ctx,
    retiredProvenance.remainingRepresentativeEventIds,
  );
  await writeEventAuditLog(
    ctx,
    eventId,
    "source_occurrence_retired_for_event_deletion",
    {
      patch: {
        legacySourceLinkCount: retiredProvenance.linkCount,
        retiredOccurrenceKeys: retiredProvenance.retiredOccurrenceKeys,
      },
    },
  );
  await ctx.db.delete(eventId);
  return { deletedReferenceCount, topologyMutated };
}

/** Separate retention policy: expiry may retire a complete audited campaign,
 * but never broadens the generic admin deletion/reconciliation permission. */
export async function deleteExpiredEventWithSavedReferences(
  ctx: MutationCtx,
  event: Doc<"events">,
  cutoff: EventExpiryCutoff,
): Promise<{
  deletedEventIds: Id<"events">[];
  deletedReferenceCount: number;
  retainedEventCount: number;
  topologyMutated: boolean;
}> {
  if (!isEventExpiredAtCutoff(event, cutoff)) {
    throw new Error("Event retention cannot delete an unexpired event.");
  }
  const retained = {
    deletedEventIds: [],
    deletedReferenceCount: 0,
    retainedEventCount: 1,
    topologyMutated: false,
  };
  let events = [event];
  if (isCrossPostCampaignAttestationEvent(event)) {
    const campaign = await sourceOccurrenceProvenanceRepository.prepareExpiredCampaignRetirement(
      ctx, event, cutoff,
    );
    if (!campaign) return retained;
    events = campaign.events;
  } else if (isCrossPostCampaignLineageEvent(event)) {
    const group = await loadVerifiedReviewedFoldEventGroup(ctx, event);
    if (!group || group.some((member) => !isEventExpiredAtCutoff(member, cutoff))) return retained;
    events = group;
  }
  const proof = await assertCompleteRetentionReceiptCoverage(ctx);
  const reverseReferences = await Promise.all(events.map((member) =>
    loadCompleteRetentionReceiptReferences(ctx, member._id, proof),
  ));
  const topology = await sourceOccurrenceProvenanceRepository.prepareExpiredEventGroupTopology(
    ctx, events, reverseReferences.flatMap((item) => item.receipts), cutoff,
  );
  if (!topology) return retained;
  // Completeness is invariant for ordinary siblings: every retired current
  // occurrence is satisfied and points at an existing retired event. Removing
  // only these true conjuncts preserves the source-wide every() decision;
  // superseding (not deleting) also preserves indexed counts/read budgets.
  // Remaining event/post/media/venue fields and per-child receipt projections
  // stay exact. Full-receipt campaign/fold proofs need explicit reevaluation.
  const remainingIds = topology.remainingRepresentativeEventIds;
  const retainedDecisions = new Map<Id<"events">, { event: Doc<"events">; decision: string }>();
  const specialRepresentatives: Doc<"events">[] = [];
  for (const id of remainingIds) {
    const remaining = await ctx.db.get(id);
    if (remaining && (isCrossPostCampaignLineageEvent(remaining) || remaining.legacySourceOccurrenceAdmissionPolicyVersion === 1)) specialRepresentatives.push(remaining);
  }
  // One full publication evaluation can itself expand to 96 source rows and
  // representatives. Never multiply that fan-out by an entire monthly schedule.
  if (specialRepresentatives.length > MAX_RETENTION_RETAINED_PUBLICATION_CHECKS) return retained;
  for (const remaining of specialRepresentatives) {
    retainedDecisions.set(remaining._id, {
      event: remaining,
      decision: JSON.stringify(await evaluateEventPublication(ctx, remaining)),
    });
  }
  let deletedReferenceCount = 0;
  for (const member of events) {
    deletedReferenceCount += await savedEventRepository.deleteEventReferences(ctx, member._id);
    await writeEventAuditLog(ctx, member._id, events.length > 1 ? "expired_campaign_event_deleted" : "expired_event_deleted", {
      patch: { cutoff, eventBefore: member, campaignEventIds: events.map((row) => row._id) },
    });
  }
  const deletion = await sourceOccurrenceProvenanceRepository.retirePreparedExpiredEventGroup(ctx, topology);
  for (const references of reverseReferences) {
    for (const row of references.referenceRows) await ctx.db.delete(row._id);
  }
  for (const member of events) await ctx.db.delete(member._id);
  // Removing an expired sibling must not rewrite or deapprove a current row.
  // An unexpected visibility change aborts the whole Convex transaction.
  for (const { event: remaining, decision } of retainedDecisions.values()) {
    if (JSON.stringify(await evaluateEventPublication(ctx, remaining)) !== decision) {
      throw new DomainError("RECONCILIATION_CONFLICT", "Expiry would change a retained event's publication decision.");
    }
  }
  if (deletion.topologyMutated) await advanceRetentionReceiptCoverage(ctx, proof);
  return {
    deletedEventIds: events.map((member) => member._id),
    deletedReferenceCount,
    retainedEventCount: 0,
    topologyMutated: deletion.topologyMutated,
  };
}

export async function reassignSavedEventReferences(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
): Promise<{ movedCount: number; dedupedCount: number }> {
  return savedEventRepository.reassignEventReferences(
    ctx,
    fromEventId,
    toEventId,
  );
}

export async function reassignInstagramOccurrenceReferences(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
  preparedTopology: EventOccurrenceTopology,
  options: { preserveLegacyLinks?: boolean } = {},
): Promise<boolean> {
  if (fromEventId === toEventId) return false;
  const topologyMutated =
    preparedTopology.links.length > 0 ||
    preparedTopology.occurrences.length > 0 ||
    preparedTopology.receipts.some((receipt) =>
      receipt.satisfiedOccurrences.some(
        (occurrence) => occurrence.eventId === fromEventId,
      ),
    );
  await sourceOccurrenceProvenanceRepository.reassignPreparedEventTopology(
    ctx,
    preparedTopology,
    toEventId,
    {
      ...options,
      topologyEpochVerified: options.preserveLegacyLinks !== true,
    },
  );
  return topologyMutated;
}

export async function assertInstagramOccurrenceReferencesCanBeReassigned(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEvent: Doc<"events">,
): Promise<EventOccurrenceTopology> {
  return sourceOccurrenceProvenanceRepository.assertCanReassignEvent(
    ctx,
    fromEventId,
    toEvent,
  );
}

export async function prepareInstagramOccurrenceTopologyForDedicatedReattestation(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<EventOccurrenceTopology> {
  return sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
    ctx,
    eventId,
  );
}
