import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import {
  backfillCanonicalEventFieldsBatchHandler,
  backfillMediaCanonicalUrlsBatchHandler,
  backfillSourceDocumentCanonicalUrlsBatchHandler,
} from "./canonicalFields";
import { backfillEventVenueBindingsBatchHandler } from "./eventVenueBindings";
import {
  consolidateReviewedKolaracVenueHandler,
} from "./reviewedKolaracVenueConsolidation";
import {
  addReviewedOfficialVenueDirectoryEntriesHandler,
} from "./reviewedOfficialVenueDirectoryAdditions";
import {
  correctReviewedMrakSourceOccurrenceHandler,
} from "./reviewedMrakOccurrenceCorrection";
import {
  rewireReviewedMadlenianumDuplicateHandler,
} from "./reviewedMadlenianumDuplicateRewire";
import {
  eventDomainMigrationBatchArgs,
  eventDomainMigrationBatchResult,
} from "./eventDomainShared";
import { backfillSourceOccurrencesBatchHandler } from "./sourceOccurrenceBackfill";
import { backfillSourceOccurrenceCanonicalPayloadsBatchHandler } from "./sourceOccurrenceCanonicalPayload";
import { auditSourceOccurrenceReceiptTopologyBatchHandler } from "./sourceOccurrenceTopologyAudit";
import { admitLegacySourceOccurrencesBatchHandler, canonicalizeLegacySourceIdentitiesBatchHandler } from "./legacySourceOccurrenceAdmission";
import {
  auditVenueCompatibilitySeedsHandler,
  backfillVenueIdentitiesBatchHandler,
} from "./venueIdentity";

// Stable registrations only; all migration implementations stay in cohesive modules.
export const backfillSourceDocumentCanonicalUrlsBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillSourceDocumentCanonicalUrlsBatchHandler,
});
export const backfillMediaCanonicalUrlsBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillMediaCanonicalUrlsBatchHandler,
});
export const backfillCanonicalEventFieldsBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillCanonicalEventFieldsBatchHandler,
});
export const consolidateReviewedKolaracVenue = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: consolidateReviewedKolaracVenueHandler,
});
export const addReviewedOfficialVenueDirectoryEntries = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: addReviewedOfficialVenueDirectoryEntriesHandler,
});
export const correctReviewedMrakSourceOccurrence = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: correctReviewedMrakSourceOccurrenceHandler,
});
export const rewireReviewedMadlenianumDuplicate = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: rewireReviewedMadlenianumDuplicateHandler,
});
export const auditVenueCompatibilitySeeds = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    restart: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    issueCount: v.number(),
    issuesJson: v.string(),
    scannedCount: v.number(),
  }),
  handler: auditVenueCompatibilitySeedsHandler,
});
export const backfillVenueIdentitiesBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillVenueIdentitiesBatchHandler,
});
export const backfillEventVenueBindingsBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillEventVenueBindingsBatchHandler,
});
export const backfillSourceOccurrencesBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillSourceOccurrencesBatchHandler,
});
export const admitLegacySourceOccurrencesBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: admitLegacySourceOccurrencesBatchHandler,
});
export const canonicalizeLegacySourceIdentitiesBatch = internalMutation({ args: eventDomainMigrationBatchArgs, returns: eventDomainMigrationBatchResult, handler: canonicalizeLegacySourceIdentitiesBatchHandler });
export const backfillSourceOccurrenceCanonicalPayloadsBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: backfillSourceOccurrenceCanonicalPayloadsBatchHandler,
});
export const auditSourceOccurrenceReceiptTopologyBatch = internalMutation({
  args: eventDomainMigrationBatchArgs,
  returns: eventDomainMigrationBatchResult,
  handler: auditSourceOccurrenceReceiptTopologyBatchHandler,
});

export { REVIEWED_KOLARAC_VENUE_CONSOLIDATION_KEY } from "./reviewedKolaracVenueConsolidation";
export { REVIEWED_MADLENIANUM_DUPLICATE_REWIRE_KEY } from "./reviewedMadlenianumDuplicateRewire";
export { REVIEWED_MRAK_OCCURRENCE_CORRECTION_KEY } from "./reviewedMrakOccurrenceCorrection";
export { REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY } from "./reviewedOfficialVenueDirectoryAdditions";
export { VENUE_COMPATIBILITY_SEED_AUDIT_KEY } from "./venueIdentity";
