import { internalMutation, mutation, query } from "./_generated/server";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";
import { markSourceOccurrenceTopologyMutation } from "./internal/sourceOccurrenceTopologyEpoch";
import {
  approvedLegacyVenueRepairArgs,
  approvedLegacyVenueRepairResult,
  repairApprovedLegacyEventVenueAndOccurrenceHandler,
} from "./internal/eventRepairs/approvedLegacyVenue";
import {
  eventRepresentsExpectedOccurrenceForTesting,
  sourceOccurrencePlan,
  sourceProcessingFence,
} from "./internal/sourceOccurrenceReceipts";
import { sourceOccurrenceProvenanceRepository } from "./repositories/sourceOccurrenceProvenance";
import {
  getDiscoverFeedHandler,
  getPublicApprovedEventHandler,
  getPublicDuplicateEventIds,
  listApprovedUpcomingByDatePaginatedHandler,
  listPublicCalendarEventsWindowPaginatedHandler,
  listPublicEventsWindowHandler,
} from "./eventDomain/publicReads";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./eventDomain/persistence";
import { assertApprovalCandidatePolicy } from "./eventDomain/sourceApproval";
import {
  getByInstagramPostIdHandler,
  getByInstagramPostUrlHandler,
  getEventHandler,
  getManyByIdsHandler,
  listByDateHandler,
  listByInstagramPostIdHandler,
  listByInstagramPostUrlHandler,
  listByStatusDateWindowHandler,
  listByStatusDateWindowPaginatedHandler,
  listByStatusHandler,
  listByStatusPaginatedHandler,
  listEventsHandler,
} from "./eventDomain/compatibilityReads";
import {
  classifyPendingModerationUniquenessHandler,
  listModerationDuplicateContextByDatesHandler,
} from "./eventDomain/moderationReads";
import {
  getInstagramSourceOccurrenceReceiptHandler,
  reconcileInstagramSourceOccurrenceReceiptHandler,
  recordInstagramSourceOccurrenceSatisfactionHandler,
  updateSourceOccurrenceExpectedCountHandler,
} from "./eventDomain/sourceOccurrenceCompatibility";
import {
  approveUniquePendingEventsResult,
  crossPostPromotionCandidateVersion,
  crossPostPromotionCoalescingContextResult,
  crossPostPromotionCoalescingResult,
  eventDateEvidenceSource,
  eventDocument,
  eventEvidencePolicyReprocessItem,
  eventStatus,
  eventTimeEvidenceKind,
  eventTimeSource,
  eventTimeStatus,
  eventUpdatePatch,
  moderationDuplicateContextResult,
  moderationStatus,
  nightlifeLineupCandidateVersion,
  nightlifeLineupCoalescingPatch,
  nightlifeLineupCoalescingResult,
  pendingModerationUniquenessResult,
  pendingModerationUniquenessReviewItem,
  promotionTier,
  sourceGroundingReprocessItem,
  trustedV2VenueRepairResult,
} from "./eventDomain/contracts";
import {
  updateEventAndRecordInstagramSourceOccurrenceSatisfactionHandler,
  updateEventHandler,
} from "./eventDomain/eventUpdates";
import {
  assertEventEvidencePolicyDateEvidenceTransitionForTesting,
  assertEventEvidencePolicyTitleTransitionForTesting,
  reprocessPendingEventEvidencePolicyBatchHandler,
  rollbackEventEvidencePolicyBatchHandler,
} from "./eventDomain/evidencePolicy";
import {
  approveUniquePendingEventsHandler,
  setEventStatusHandler,
  setEventStatusesHandler,
} from "./eventDomain/moderationCommands";
import { reprocessPendingSourceGroundingBatchHandler } from "./eventDomain/sourceGroundingReprocess";
import {
  coalesceApprovedCrossPostPromotionOccurrencesHandler,
  getCrossPostPromotionCoalescingContextHandler,
} from "./eventDomain/crossPostPromotion";
import {
  coalesceApprovedNightlifeLineupOccurrencesHandler,
  getNightlifeLineupCoalescingContextHandler,
} from "./eventDomain/nightlifeLineup";
import {
  deleteApprovedEventHandler,
  deleteExpiredEventsHandler,
  mergeApprovedEventsHandler,
} from "./eventDomain/lifecycleCommands";
import { repairTrustedV2EventVenueHandler } from "./eventDomain/trustedV2VenueRepair";
import {
  getReviewedStructuredEvidenceCorrectionContextHandler,
  repairReviewedStructuredEventEvidenceHandler,
  repairReviewedStructuredEventVenueHandler,
} from "./eventDomain/reviewedStructuredCorrections";
import {
  foldReviewedCrossPostScheduleDuplicateHandler,
  getReviewedCrossPostScheduleFoldContextHandler,
} from "./eventDomain/reviewedScheduleFold";
import { foldReviewedStructuredPromotionVariantHandler } from "./eventDomain/reviewedPromotionFold";
import { foldReviewedStructuredSameSourceContinuationHandler } from "./eventDomain/reviewedContinuationFold";
import { createEventHandler } from "./eventDomain/eventCreation";

export {
  assertEventEvidencePolicyDateEvidenceTransitionForTesting,
  assertEventEvidencePolicyTitleTransitionForTesting,
  eventRepresentsExpectedOccurrenceForTesting,
  getPublicDuplicateEventIds,
};

export const getEvent = query({
  args: { id: v.id("events") },
  handler: getEventHandler,
});

export const listEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: listEventsHandler,
});

export const listModerationDuplicateContextByDates = query({
  args: {
    dates: v.array(v.string()),
  },
  returns: moderationDuplicateContextResult,
  handler: listModerationDuplicateContextByDatesHandler,
});

export const classifyPendingModerationUniqueness = query({
  args: {
    items: v.array(pendingModerationUniquenessReviewItem),
    asOfMs: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  returns: pendingModerationUniquenessResult,
  handler: classifyPendingModerationUniquenessHandler,
});

export const getPublicApprovedEvent = query({
  args: { id: v.string() },
  handler: getPublicApprovedEventHandler,
});

export const getByInstagramPostId = query({
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: getByInstagramPostIdHandler,
});

export const getByInstagramPostUrl = query({
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: getByInstagramPostUrlHandler,
});

export const listByInstagramPostId = query({
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: listByInstagramPostIdHandler,
});

export const listByInstagramPostUrl = query({
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: listByInstagramPostUrlHandler,
});

export const listByStatus = query({
  args: {
    status: eventStatus,
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: listByStatusHandler,
});

export const listByStatusPaginated = query({
  args: {
    status: eventStatus,
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: listByStatusPaginatedHandler,
});

export const getManyByIds = query({
  args: {
    ids: v.array(v.id("events")),
    serviceSecret: v.optional(v.string()),
  },
  handler: getManyByIdsHandler,
});

export const getNightlifeLineupCoalescingContext = query({
  args: {
    ids: v.array(v.id("events")),
    sourceIdentity: v.string(),
    serviceSecret: v.string(),
  },
  returns: v.any(),
  handler: getNightlifeLineupCoalescingContextHandler,
});
export const backfillEventVenueIdentityBatch = mutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    void args.cursor;
    void args.limit;
    throw new Error(
      "This unsafe compatibility backfill is retired. Use the tracked internal event-venue-bindings-v1 migration, which atomically rebinds occurrence provenance and refreshes publication state.",
    );
  },
});

export const listByStatusDateWindow = query({
  args: {
    status: eventStatus,
    fromDate: v.string(),
    beforeDate: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: listByStatusDateWindowHandler,
});

export const listByStatusDateWindowPaginated = query({
  args: {
    status: eventStatus,
    fromDate: v.string(),
    beforeDate: v.string(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  returns: paginationResultValidator(eventDocument),
  handler: listByStatusDateWindowPaginatedHandler,
});

export const listPublicEventsWindow = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: listPublicEventsWindowHandler,
});

export const listPublicCalendarEventsWindowPaginated = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: listPublicCalendarEventsWindowPaginatedHandler,
});

export const listApprovedUpcomingByDatePaginated = query({
  args: {
    fromDate: v.string(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: listApprovedUpcomingByDatePaginatedHandler,
});

export const getDiscoverFeed = query({
  args: {
    today: v.string(),
  },
  handler: getDiscoverFeedHandler,
});

export const listByDate = query({
  args: {
    date: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: listByDateHandler,
});

export const reconcileInstagramSourceOccurrenceReceipt = mutation({
  args: {
    plan: sourceOccurrencePlan,
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: reconcileInstagramSourceOccurrenceReceiptHandler,
});

export const getInstagramSourceOccurrenceReceipt = query({
  args: {
    sourceIdentity: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: getInstagramSourceOccurrenceReceiptHandler,
});

export const recordInstagramSourceOccurrenceSatisfaction = mutation({
  args: {
    plan: sourceOccurrencePlan,
    satisfiedKey: v.string(),
    representativeEventId: v.id("events"),
    supersededKey: v.optional(v.string()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: recordInstagramSourceOccurrenceSatisfactionHandler,
});

export const createEvent = mutation({
  args: {
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    timeSource: v.optional(eventTimeSource),
    timeEvidenceText: v.optional(v.union(v.string(), v.null())),
    timeConfidence: v.optional(v.number()),
    timeStatus: v.optional(eventTimeStatus),
    timeEvidenceKind: v.optional(eventTimeEvidenceKind),
    dateEvidenceText: v.optional(v.string()),
    dateEvidenceSource: v.optional(eventDateEvidenceSource),
    dateEvidenceIsRelative: v.optional(v.boolean()),
    dateEvidenceResolvedDate: v.optional(v.string()),
    sourceConflictFields: v.optional(v.array(v.string())),
    venue: v.string(),
    artists: v.array(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    instagramPostUrl: v.optional(v.string()),
    instagramPostId: v.optional(v.string()),
    ticketPrice: v.optional(v.string()),
    eventType: v.string(),
    sourceCaption: v.optional(v.string()),
    sourcePostedAt: v.optional(v.string()),
    rawExtractionJson: v.optional(v.string()),
    normalizedFieldsJson: v.optional(v.string()),
    sourceOccurrenceKey: v.optional(v.string()),
    sourceOccurrencePlan: v.optional(sourceOccurrencePlan),
    processingFence: v.optional(sourceProcessingFence),
    promotionTier: v.optional(promotionTier),
    promotionStart: v.optional(v.string()),
    promotionEnd: v.optional(v.string()),
    promotionPriority: v.optional(v.number()),
    status: v.optional(eventStatus),
    returnCreateDisposition: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  handler: createEventHandler,
});
export const updateSourceOccurrenceExpectedCount = mutation({
  args: {
    id: v.id("events"),
    sourceOccurrenceKey: v.string(),
    expectedCurrentCount: v.number(),
    expectedCurrentKeys: v.array(v.string()),
    expectedCurrentDeferredChildCount: v.number(),
    expectedCurrentSourceFingerprint: v.optional(v.string()),
    nextExpectedCount: v.number(),
    nextExpectedKeys: v.array(v.string()),
    nextDeferredChildCount: v.number(),
    nextSourceFingerprint: v.string(),
    confirmedPastKeys: v.array(v.string()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: updateSourceOccurrenceExpectedCountHandler,
});

/**
 * Repairs the narrowly scoped event-evidence-v2 venue-loss bug without
 * reopening a paid fetch or weakening the generic service update policy.
 *
 * The mutation only accepts an empty current venue, an exact optimistic
 * version/JSON snapshot, and a next JSON value whose sole change is the
 * canonical venue already bound to the persisted source handle. Approved
 * rows must still pass the complete v2 source and duplicate policies.
 */
export const repairTrustedV2EventVenue = mutation({
  args: {
    id: v.id("events"),
    expectedStatus: eventStatus,
    expectedUpdatedAt: v.number(),
    expectedNormalizedFieldsJson: v.string(),
    nextVenue: v.string(),
    nextNormalizedFieldsJson: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: trustedV2VenueRepairResult,
  handler: repairTrustedV2EventVenueHandler,
});
const reviewedStructuredEvidenceCorrectionResult = v.object({
  updated: v.boolean(),
  updatedAt: v.number(),
  receiptUpdatedAt: v.number(),
  status: eventStatus,
});

export const getReviewedStructuredEvidenceCorrectionContext = query({
  args: {
    id: v.id("events"),
    serviceSecret: v.string(),
  },
  returns: v.any(),
  handler: getReviewedStructuredEvidenceCorrectionContextHandler,
});

export const repairReviewedStructuredEventEvidence = mutation({
  args: {
    id: v.id("events"),
    expectedUpdatedAt: v.number(),
    expectedNormalizedFieldsJson: v.string(),
    expectedSourceLinkId: v.id("instagramEventSources"),
    expectedSourceLinkUpdatedAt: v.number(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    nextTitle: v.string(),
    nextTime: v.string(),
    nextVenue: v.string(),
    targetVenueId: v.optional(v.id("venues")),
    expectedTargetVenueUpdatedAt: v.optional(v.number()),
    expectedTargetVenueHandle: v.optional(v.string()),
    nextArtists: v.array(v.string()),
    nextDescription: v.string(),
    posterVenueEvidence: v.string(),
    posterTimeEvidence: v.string(),
    posterArtistEvidence: v.array(v.string()),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: reviewedStructuredEvidenceCorrectionResult,
  handler: repairReviewedStructuredEventEvidenceHandler,
});

export const repairReviewedStructuredEventVenue = mutation({
  args: {
    id: v.id("events"),
    expectedUpdatedAt: v.number(),
    expectedNormalizedFieldsJson: v.string(),
    expectedSourceLinkId: v.id("instagramEventSources"),
    expectedSourceLinkUpdatedAt: v.number(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    nextVenue: v.string(),
    targetVenueId: v.optional(v.id("venues")),
    expectedTargetVenueUpdatedAt: v.optional(v.number()),
    expectedTargetVenueHandle: v.optional(v.string()),
    venueEvidence: v.string(),
    moderationNote: v.string(),
    expectedAmbiguousApprovedEventVersions: v.optional(
      v.array(
        v.object({
          id: v.id("events"),
          updatedAt: v.number(),
        }),
      ),
    ),
    serviceSecret: v.string(),
  },
  returns: reviewedStructuredEvidenceCorrectionResult,
  handler: repairReviewedStructuredEventVenueHandler,
});
const reviewedCrossPostSourceVersion = v.object({
  id: v.id("instagramEventSources"),
  updatedAt: v.number(),
});

const reviewedCrossPostScheduleFoldResult = v.object({
  operationId: v.string(),
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  primaryReceiptUpdatedAt: v.number(),
  duplicateId: v.id("events"),
  duplicateUpdatedAt: v.number(),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});

export const getReviewedCrossPostScheduleFoldContext = query({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    duplicateId: v.id("events"),
    serviceSecret: v.string(),
  },
  returns: v.any(),
  handler: getReviewedCrossPostScheduleFoldContextHandler,
});

export const foldReviewedCrossPostScheduleDuplicate = mutation({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    expectedPrimaryUpdatedAt: v.number(),
    expectedPrimaryNormalizedFieldsJson: v.string(),
    expectedPrimarySourceLinkId: v.id("instagramEventSources"),
    expectedPrimarySourceLinkUpdatedAt: v.number(),
    expectedPrimaryReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedPrimaryReceiptUpdatedAt: v.number(),
    duplicateId: v.id("events"),
    expectedDuplicateUpdatedAt: v.number(),
    expectedDuplicateNormalizedFieldsJson: v.string(),
    expectedDuplicateSourceVersions: v.array(reviewedCrossPostSourceVersion),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    expectedTargetVenueHandle: v.string(),
    occurrenceAnchors: v.array(v.string()),
    primaryVenueEvidence: v.string(),
    duplicateVenueEvidence: v.string(),
    nextTitle: v.string(),
    nextTime: v.string(),
    nextVenue: v.string(),
    nextArtists: v.array(v.string()),
    nextDescription: v.string(),
    timeEvidenceText: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: reviewedCrossPostScheduleFoldResult,
  handler: foldReviewedCrossPostScheduleDuplicateHandler,
});
const reviewedPromotionVariantFoldResult = v.object({
  operationId: v.string(),
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  primaryReceiptUpdatedAt: v.number(),
  variantId: v.id("events"),
  variantUpdatedAt: v.number(),
  variantReceiptUpdatedAt: v.number(),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});

export const foldReviewedStructuredPromotionVariant = mutation({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    expectedPrimaryUpdatedAt: v.number(),
    expectedPrimaryNormalizedFieldsJson: v.string(),
    expectedPrimarySourceLinkId: v.id("instagramEventSources"),
    expectedPrimarySourceLinkUpdatedAt: v.number(),
    expectedPrimaryReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedPrimaryReceiptUpdatedAt: v.number(),
    variantId: v.id("events"),
    expectedVariantUpdatedAt: v.number(),
    expectedVariantNormalizedFieldsJson: v.string(),
    expectedVariantSourceLinkId: v.id("instagramEventSources"),
    expectedVariantSourceLinkUpdatedAt: v.number(),
    expectedVariantReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedVariantReceiptUpdatedAt: v.number(),
    expectedSourceHandle: v.string(),
    campaignAnchors: v.array(v.string()),
    primaryDuplicateEvidence: v.array(v.string()),
    variantDuplicateEvidence: v.array(v.string()),
    nextTitle: v.string(),
    nextTime: v.string(),
    nextVenue: v.string(),
    targetVenueId: v.optional(v.id("venues")),
    expectedTargetVenueUpdatedAt: v.optional(v.number()),
    expectedTargetVenueHandle: v.optional(v.string()),
    nextArtists: v.array(v.string()),
    nextDescription: v.string(),
    posterVenueEvidence: v.string(),
    posterTimeEvidence: v.string(),
    posterArtistEvidence: v.array(v.string()),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: reviewedPromotionVariantFoldResult,
  handler: foldReviewedStructuredPromotionVariantHandler,
});
const reviewedSameSourceContinuationFoldResult = v.object({
  operationId: v.string(),
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  continuationId: v.id("events"),
  continuationUpdatedAt: v.number(),
  independentId: v.id("events"),
  independentUpdatedAt: v.number(),
  receiptUpdatedAt: v.number(),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});

export const foldReviewedStructuredSameSourceContinuation = mutation({
  args: {
    operationId: v.string(),
    primaryId: v.id("events"),
    expectedPrimaryUpdatedAt: v.number(),
    expectedPrimaryNormalizedFieldsJson: v.string(),
    expectedPrimarySourceLinkId: v.id("instagramEventSources"),
    expectedPrimarySourceLinkUpdatedAt: v.number(),
    continuationId: v.id("events"),
    expectedContinuationUpdatedAt: v.number(),
    expectedContinuationNormalizedFieldsJson: v.string(),
    expectedContinuationSourceLinkId: v.id("instagramEventSources"),
    expectedContinuationSourceLinkUpdatedAt: v.number(),
    independentId: v.id("events"),
    expectedIndependentUpdatedAt: v.number(),
    expectedIndependentNormalizedFieldsJson: v.string(),
    expectedIndependentSourceLinkId: v.id("instagramEventSources"),
    expectedIndependentSourceLinkUpdatedAt: v.number(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceHandle: v.string(),
    expectedSourceIdentity: v.string(),
    expectedSourceFingerprint: v.string(),
    primaryScheduleSourceText: v.string(),
    continuationScheduleSourceText: v.string(),
    nextIndependentTime: v.string(),
    independentPosterVenueEvidence: v.string(),
    independentPosterTimeEvidence: v.string(),
    independentPosterArtistEvidence: v.array(v.string()),
    nextVenue: v.string(),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    expectedTargetVenueHandle: v.string(),
    nextArtists: v.array(v.string()),
    nextDescription: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: reviewedSameSourceContinuationFoldResult,
  handler: foldReviewedStructuredSameSourceContinuationHandler,
});
export const repairApprovedLegacyEventVenueAndOccurrence = mutation({
  args: approvedLegacyVenueRepairArgs,
  returns: approvedLegacyVenueRepairResult,
  handler: async (ctx, args) => {
    const result = await repairApprovedLegacyEventVenueAndOccurrenceHandler(
      ctx,
      args,
      {
        assertApprovalCandidatePolicy,
        rebindCanonicalVenue: (repairCtx, currentEvent, nextEvent) =>
          sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(
            repairCtx,
            currentEvent,
            nextEvent,
            { topologyEpochVerified: true },
          ),
        refreshCanonicalEventDerivedStates,
        writeEventAuditLog,
      },
    );
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
    return result;
  },
});

export const updateEvent = mutation({
  args: {
    id: v.id("events"),
    patch: eventUpdatePatch,
    expectedStatus: v.optional(eventStatus),
    expectedUpdatedAt: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: updateEventHandler,
});

export const updateEventAndRecordInstagramSourceOccurrenceSatisfaction =
  mutation({
    args: {
      id: v.id("events"),
      patch: eventUpdatePatch,
      expectedStatus: v.optional(eventStatus),
      expectedUpdatedAt: v.optional(v.number()),
      plan: sourceOccurrencePlan,
      satisfiedKey: v.string(),
      supersededKey: v.optional(v.string()),
      processingFence: sourceProcessingFence,
      serviceSecret: v.optional(v.string()),
    },
    handler: updateEventAndRecordInstagramSourceOccurrenceSatisfactionHandler,
  });

export const reprocessPendingSourceGroundingBatch = mutation({
  args: {
    serviceSecret: v.string(),
    items: v.array(sourceGroundingReprocessItem),
  },
  handler: reprocessPendingSourceGroundingBatchHandler,
});
const eventEvidencePolicyTransitionArgs = {
  sourceIdentity: v.string(),
  expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
  expectedSourceFingerprint: v.string(),
  items: v.array(eventEvidencePolicyReprocessItem),
  serviceSecret: v.string(),
};

const eventEvidencePolicyTransitionResult = v.object({
  updatedCount: v.number(),
  eventIds: v.array(v.id("events")),
  eventUpdatedAts: v.array(
    v.object({ id: v.id("events"), updatedAt: v.number() }),
  ),
  receiptUpdatedAt: v.number(),
});

export const reprocessPendingEventEvidencePolicyBatch = mutation({
  args: eventEvidencePolicyTransitionArgs,
  returns: eventEvidencePolicyTransitionResult,
  handler: reprocessPendingEventEvidencePolicyBatchHandler,
});

export const rollbackEventEvidencePolicyBatch = mutation({
  args: eventEvidencePolicyTransitionArgs,
  returns: eventEvidencePolicyTransitionResult,
  handler: rollbackEventEvidencePolicyBatchHandler,
});

export const approveUniquePendingEvents = mutation({
  args: {
    items: v.array(pendingModerationUniquenessReviewItem),
    moderationNote: v.string(),
    reviewedBy: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  returns: approveUniquePendingEventsResult,
  handler: approveUniquePendingEventsHandler,
});

export const setEventStatus = mutation({
  args: {
    id: v.id("events"),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    expectedUpdatedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: setEventStatusHandler,
});

export const setEventStatuses = mutation({
  args: {
    ids: v.array(v.id("events")),
    expectedVersions: v.optional(
      v.array(
        v.object({
          id: v.id("events"),
          expectedUpdatedAt: v.number(),
        }),
      ),
    ),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    approveAsDistinctSameVenueDateBatch: v.optional(v.boolean()),
  },
  returns: v.object({
    updatedCount: v.number(),
    skippedCount: v.number(),
  }),
  handler: setEventStatusesHandler,
});
export const getCrossPostPromotionCoalescingContext = query({
  args: {
    operationId: v.string(),
    legacyMigrationOperationId: v.optional(v.string()),
    eventIds: v.array(v.id("events")),
    targetVenueId: v.id("venues"),
    serviceSecret: v.string(),
  },
  returns: crossPostPromotionCoalescingContextResult,
  handler: getCrossPostPromotionCoalescingContextHandler,
});

export const coalesceApprovedCrossPostPromotionOccurrences = mutation({
  args: {
    operationId: v.string(),
    legacyMigrationOperationId: v.optional(v.string()),
    primary: crossPostPromotionCandidateVersion,
    duplicates: v.array(crossPostPromotionCandidateVersion),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    sharedEvidenceAnchors: v.array(v.string()),
    automaticCampaignIdentity: v.optional(v.string()),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: crossPostPromotionCoalescingResult,
  handler: coalesceApprovedCrossPostPromotionOccurrencesHandler,
});
export const coalesceApprovedNightlifeLineupOccurrences = mutation({
  args: {
    primary: nightlifeLineupCandidateVersion,
    duplicates: v.array(nightlifeLineupCandidateVersion),
    expectedSourceIdentity: v.string(),
    expectedSourceFingerprint: v.string(),
    expectedOccurrenceKeys: v.array(v.string()),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    patch: nightlifeLineupCoalescingPatch,
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: nightlifeLineupCoalescingResult,
  handler: coalesceApprovedNightlifeLineupOccurrencesHandler,
});
export const deleteApprovedEvent = mutation({
  args: {
    id: v.id("events"),
    expectedUpdatedAt: v.optional(v.number()),
  },
  handler: deleteApprovedEventHandler,
});

export const mergeApprovedEvents = mutation({
  args: {
    primaryId: v.id("events"),
    duplicateIds: v.array(v.id("events")),
    expectedPrimaryUpdatedAt: v.optional(v.number()),
    expectedDuplicateVersions: v.optional(
      v.array(
        v.object({
          id: v.id("events"),
          expectedUpdatedAt: v.number(),
        }),
      ),
    ),
    patch: v.object({
      title: v.optional(v.string()),
      date: v.optional(v.string()),
      time: v.optional(v.string()),
      timeSource: v.optional(eventTimeSource),
      timeEvidenceText: v.optional(v.union(v.string(), v.null())),
      timeConfidence: v.optional(v.number()),
      timeStatus: v.optional(eventTimeStatus),
      timeEvidenceKind: v.optional(eventTimeEvidenceKind),
      dateEvidenceText: v.optional(v.union(v.string(), v.null())),
      dateEvidenceSource: v.optional(eventDateEvidenceSource),
      dateEvidenceIsRelative: v.optional(v.boolean()),
      dateEvidenceResolvedDate: v.optional(v.union(v.string(), v.null())),
      sourceConflictFields: v.optional(v.array(v.string())),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      imageStorageId: v.optional(v.id("_storage")),
      ticketPrice: v.optional(v.string()),
      eventType: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: mergeApprovedEventsHandler,
});

export const deleteExpiredEvents = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
    beforeDate: v.optional(v.string()),
    beforeDateCursor: v.optional(v.union(v.string(), v.null())),
    beforeDateScanComplete: v.optional(v.boolean()),
    sameDayCursor: v.optional(v.union(v.string(), v.null())),
    sameDayScanComplete: v.optional(v.boolean()),
  },
  handler: deleteExpiredEventsHandler,
});
