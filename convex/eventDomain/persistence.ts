import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { savedEventRepository } from "../repositories/savedEvents";
import {
  sourceOccurrenceProvenanceRepository,
  type EventOccurrenceTopology,
} from "../repositories/sourceOccurrenceProvenance";
import { assertCompleteReceiptTopologyCoverage } from "../internal/receiptTopologyCoverage";
import {
  MAX_PUBLICATION_REFRESH_EVENTS,
  refreshEventPublicationStates,
} from "../publicationPolicy";

const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 100;

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
  return Math.max(1, Math.min(500, Math.trunc(value as number)));
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
