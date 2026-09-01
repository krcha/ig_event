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
 * Attests legacy event venue text after identity claims are complete. Exact
 * claims bind to canonical venue IDs; unknown claims retain an explicit,
 * normalized unresolved identity; ambiguous claims fail closed. Existing
 * source provenance is re-attested through the same receipt-fenced adapter
 * used by moderation, while campaign lineage stays in its dedicated
 * quarantine.
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
    const rawVenueClaim = (event.venueInstagramHandle ?? event.venue).trim();
    const resolution = await resolveVenueForWrite(ctx, rawVenueClaim);
    // A nonempty legacy venue claim does not become invalid merely because the
    // canonical directory has not learned it yet. Unresolved venue identity is
    // a first-class state throughout occurrence construction and
    // reconciliation; this migration must normalize and attest that state
    // instead of requiring every historical event to acquire a guessed venue
    // record. Ambiguity remains a hard mismatch, as does the impossible shape
    // of a "resolved" result without its canonical venue ID. A missing claim
    // or an already-bound event that no longer resolves also stays a mismatch:
    // this migration must never erase a canonical venue binding by inference.
    const explicitUnresolvedClaim =
      resolution.resolution.status === "unresolved" &&
      rawVenueClaim.length > 0 &&
      Boolean(resolution.venueFields.normalizedVenueIdentity) &&
      event.venueId === undefined;
    if (
      resolution.resolution.status === "ambiguous" ||
      (resolution.resolution.status === "resolved" &&
        !resolution.venueFields.venueId) ||
      (resolution.resolution.status === "unresolved" &&
        !explicitUnresolvedClaim)
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
