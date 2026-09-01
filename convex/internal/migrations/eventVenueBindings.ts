import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { refreshEventPublicationStates } from "../../publicationPolicy";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { resolveVenueForWrite } from "../../venueResolver";
import { DomainError } from "../../../lib/domain/errors";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { loadVerifiedCampaignLineageForSourceEvent } from "../campaignLineageReattestationProof";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import {
  assertCleanCompletedEventDomainMigration,
  eventDomainMigrationPatchDiffers,
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

/**
 * Binds legacy event venue text to canonical venue IDs after identity claims
 * are complete. Existing source provenance is re-attested through the same
 * receipt-fenced adapter used by moderation; campaign lineage stays in its
 * dedicated quarantine.
 */
export async function backfillEventVenueBindingsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  await assertCleanCompletedEventDomainMigration(ctx, "venue-identities-v1");
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("events")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: 0,
    quarantinedLineageMarkerCount: 0,
    scannedCount: page.page.length,
    skippedCount: 0,
    unchangedCount: 0,
    updatedCount: 0,
  };
  for (const event of page.page) {
    if (isCrossPostCampaignLineageEvent(event)) {
      const campaignProof = await loadVerifiedCampaignLineageForSourceEvent(
        ctx,
        event,
      );
      if (
        campaignProof &&
        event.venueId === campaignProof.currentAttestation.targetVenueId
      ) {
        const resolution = await resolveVenueForWrite(
          ctx,
          event.venueInstagramHandle ?? event.venue,
        );
        const effectiveEvent: Doc<"events"> = {
          ...event,
          ...resolution.venueFields,
        };
        if (
          resolution.resolution.status === "resolved" &&
          resolution.venueFields.venueId === event.venueId &&
          !eventDomainMigrationPatchDiffers(event, {
            ...resolution.venueFields,
            ...buildEventOccurrenceIndexPatch(effectiveEvent),
          })
        ) {
          counts.unchangedCount! += 1;
          continue;
        }
      }
      counts.skippedCount! += 1;
      counts.quarantinedLineageMarkerCount! += 1;
      continue;
    }
    const resolution = await resolveVenueForWrite(
      ctx,
      event.venueInstagramHandle ?? event.venue,
    );
    if (
      resolution.resolution.status !== "resolved" ||
      !resolution.venueFields.venueId
    ) {
      counts.mismatchCount += 1;
      continue;
    }
    const effectiveEvent: Doc<"events"> = {
      ...event,
      ...resolution.venueFields,
    };
    const patch = {
      ...resolution.venueFields,
      ...buildEventOccurrenceIndexPatch(effectiveEvent),
    };
    if (!eventDomainMigrationPatchDiffers(event, patch)) {
      counts.unchangedCount! += 1;
      continue;
    }
    let affectedRepresentativeIds: Doc<"events">["_id"][];
    try {
      affectedRepresentativeIds =
        await sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(
          ctx,
          event,
          effectiveEvent,
          { dryRun, topologyEpochVerified: true },
        );
    } catch (error) {
      if (error instanceof DomainError) {
        counts.mismatchCount += 1;
        continue;
      }
      throw error;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      await ctx.db.patch(event._id, patch);
      await refreshEventPublicationStates(ctx, affectedRepresentativeIds);
    }
  }
  if (!dryRun && counts.updatedCount > 0) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "event-venue-bindings-v1",
    phase: "event_venue_bindings",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
