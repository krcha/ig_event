import { v, type Infer } from "convex/values";

export const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

const moderationDuplicateContextEvent = v.object({
  _id: v.id("events"),
  title: v.string(),
  date: v.string(),
  time: v.optional(v.string()),
  venue: v.string(),
  normalizedVenueIdentity: v.optional(v.string()),
  normalizedVenueInstagramHandle: v.optional(v.string()),
  artists: v.array(v.string()),
  description: v.optional(v.string()),
  eventType: v.string(),
  sourceCaption: v.optional(v.string()),
  status: eventStatus,
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const moderationDuplicateContextResult = v.object({
  events: v.array(moderationDuplicateContextEvent),
  truncated: v.boolean(),
});

export const pendingModerationUniquenessReviewItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
});

const pendingModerationUniquenessDisposition = v.union(
  v.literal("unique"),
  v.literal("duplicate"),
  v.literal("ambiguous"),
  v.literal("ineligible"),
  v.literal("indeterminate"),
);

const pendingModerationUniquenessReason = v.union(
  v.literal("unique_no_conflict"),
  v.literal("duplicate_same_occurrence"),
  v.literal("ambiguous_same_date_occurrence"),
  v.literal("ineligible_title"),
  v.literal("ineligible_invalid_date"),
  v.literal("ineligible_expired_event"),
  v.literal("ineligible_source_policy"),
  v.literal("indeterminate_venue_limit"),
  v.literal("indeterminate_pending_cohort_limit"),
  v.literal("indeterminate_approved_cohort_limit"),
  v.literal("indeterminate_batch_incomplete"),
);

export const pendingModerationUniquenessClassification = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  disposition: pendingModerationUniquenessDisposition,
  reason: pendingModerationUniquenessReason,
  conflictIds: v.array(v.id("events")),
});

export const pendingModerationUniquenessResult = v.object({
  complete: v.boolean(),
  items: v.array(pendingModerationUniquenessClassification),
});

export const approveUniquePendingEventsResult = v.object({
  complete: v.boolean(),
  approvedIds: v.array(v.id("events")),
  skipped: v.array(pendingModerationUniquenessClassification),
});

export const promotionTier = v.union(
  v.literal("featured"),
  v.literal("promoted"),
);

export const eventTimeSource = v.union(
  v.literal("alt_text"),
  v.literal("caption"),
  v.literal("description"),
  v.literal("model"),
  v.literal("poster"),
  v.literal("schedule_entry"),
  v.literal("unknown"),
);

export const eventTimeStatus = v.union(
  v.literal("confirmed"),
  v.literal("inferred"),
  v.literal("unknown"),
);

export const eventDateEvidenceSource = v.union(
  v.literal("caption"),
  v.literal("poster"),
  v.literal("alt_text"),
  v.literal("unknown"),
);

export const eventTimeEvidenceKind = v.union(
  v.literal("start_time_stated"),
  v.literal("not_stated"),
  v.literal("unreadable"),
  v.literal("doors_open_only"),
);

export const eventDocument = v.object({
  _creationTime: v.number(),
  _id: v.id("events"),
  artists: v.array(v.string()),
  canonicalSourceUrl: v.optional(v.string()),
  createdAt: v.number(),
  date: v.string(),
  dateEvidenceIsRelative: v.optional(v.boolean()),
  dateEvidenceResolvedDate: v.optional(v.string()),
  dateEvidenceSource: v.optional(eventDateEvidenceSource),
  dateEvidenceText: v.optional(v.string()),
  description: v.optional(v.string()),
  eventType: v.string(),
  humanReviewedLegacySourcePolicyVersion: v.optional(v.literal(1)),
  humanReviewedStructuredSourcePolicyVersion: v.optional(v.literal(1)),
  imageStorageId: v.optional(v.id("_storage")),
  imageUrl: v.optional(v.string()),
  instagramPostId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
  moderationNote: v.optional(v.string()),
  normalizedFieldsJson: v.optional(v.string()),
  normalizedInstagramPostUrl: v.optional(v.string()),
  normalizedVenueIdentity: v.optional(v.string()),
  normalizedVenueInstagramHandle: v.optional(v.string()),
  occurrenceArtistFingerprint: v.optional(v.string()),
  occurrenceDateKey: v.optional(v.string()),
  occurrenceEventType: v.optional(v.string()),
  occurrenceSignatureHash: v.optional(v.string()),
  occurrenceSignatureVersion: v.optional(v.number()),
  occurrenceTimeIdentity: v.optional(v.string()),
  occurrenceTitleFamily: v.optional(v.string()),
  occurrenceVenueIdentity: v.optional(v.string()),
  promotionEnd: v.optional(v.string()),
  promotionPriority: v.optional(v.number()),
  promotionStart: v.optional(v.string()),
  promotionTier: v.optional(promotionTier),
  publicationEvaluatedAt: v.optional(v.number()),
  publicationPolicyVersion: v.optional(v.number()),
  publicationReason: v.optional(v.string()),
  publicationState: v.optional(
    v.union(
      v.literal("publishable"),
      v.literal("hidden"),
      v.literal("pending_verification"),
    ),
  ),
  rawExtractionJson: v.optional(v.string()),
  reviewedAt: v.optional(v.number()),
  reviewedBy: v.optional(v.string()),
  sourceCaption: v.optional(v.string()),
  sourceConflictFields: v.optional(v.array(v.string())),
  sourceOccurrenceKey: v.optional(v.string()),
  sourcePostedAt: v.optional(v.string()),
  status: eventStatus,
  ticketPrice: v.optional(v.string()),
  time: v.optional(v.string()),
  timeConfidence: v.optional(v.number()),
  timeEvidenceKind: v.optional(eventTimeEvidenceKind),
  timeEvidenceText: v.optional(v.string()),
  timeSource: v.optional(eventTimeSource),
  timeStatus: v.optional(eventTimeStatus),
  title: v.string(),
  updatedAt: v.number(),
  venue: v.string(),
  venueCategory: v.optional(v.string()),
  venueId: v.optional(v.id("venues")),
  venueInstagramHandle: v.optional(v.string()),
  venueLatitude: v.optional(v.number()),
  venueLocation: v.optional(v.string()),
  venueLongitude: v.optional(v.number()),
});

export const eventUpdatePatch = v.object({
  title: v.optional(v.string()),
  date: v.optional(v.string()),
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
  venue: v.optional(v.string()),
  artists: v.optional(v.array(v.string())),
  description: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageStorageId: v.optional(v.id("_storage")),
  instagramPostUrl: v.optional(v.string()),
  instagramPostId: v.optional(v.string()),
  ticketPrice: v.optional(v.string()),
  clearTicketPrice: v.optional(v.boolean()),
  eventType: v.optional(v.string()),
  sourceCaption: v.optional(v.string()),
  sourcePostedAt: v.optional(v.string()),
  rawExtractionJson: v.optional(v.string()),
  normalizedFieldsJson: v.optional(v.string()),
  promotionTier: v.optional(promotionTier),
  promotionStart: v.optional(v.string()),
  promotionEnd: v.optional(v.string()),
  promotionPriority: v.optional(v.number()),
  status: v.optional(eventStatus),
  reviewedAt: v.optional(v.number()),
  reviewedBy: v.optional(v.string()),
  moderationNote: v.optional(v.string()),
});

export type EventUpdatePatch = Infer<typeof eventUpdatePatch>;

export const moderationStatus = v.union(
  v.literal("approved"),
  v.literal("rejected"),
);

export const sourceGroundingReprocessItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  nextNormalizedFieldsJson: v.string(),
});

export type SourceGroundingReprocessItem = Infer<
  typeof sourceGroundingReprocessItem
>;

export const eventEvidencePolicyPatch = v.object({
  artists: v.optional(v.array(v.string())),
  dateEvidenceIsRelative: v.boolean(),
  dateEvidenceResolvedDate: v.string(),
  dateEvidenceSource: eventDateEvidenceSource,
  dateEvidenceText: v.string(),
  normalizedFieldsJson: v.string(),
  sourceConflictFields: v.array(v.string()),
  status: eventStatus,
  title: v.optional(v.string()),
  venue: v.optional(v.string()),
});

export const eventEvidencePolicyReprocessItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  patch: eventEvidencePolicyPatch,
});

export type EventEvidencePolicyReprocessItem = Infer<
  typeof eventEvidencePolicyReprocessItem
>;

export const trustedV2VenueRepairResult = v.object({
  updated: v.boolean(),
  updatedAt: v.number(),
  status: eventStatus,
});

export const nightlifeLineupCandidateVersion = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
});

export type NightlifeLineupCandidateVersion = Infer<
  typeof nightlifeLineupCandidateVersion
>;

export const nightlifeLineupCoalescingPatch = v.object({
  title: v.string(),
  time: v.string(),
  timeSource: eventTimeSource,
  timeEvidenceText: v.string(),
  timeConfidence: v.number(),
  timeStatus: eventTimeStatus,
  timeEvidenceKind: eventTimeEvidenceKind,
  artists: v.array(v.string()),
  description: v.string(),
  normalizedFieldsJson: v.string(),
  sourceOccurrenceKey: v.string(),
  sourceFingerprint: v.string(),
});

export type NightlifeLineupCoalescingPatch = Infer<
  typeof nightlifeLineupCoalescingPatch
>;

export const nightlifeLineupCoalescingResult = v.object({
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  receiptUpdatedAt: v.number(),
  deletedDuplicateCount: v.number(),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});

export const crossPostPromotionCandidateVersion = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
  expectedSourceIdentity: v.string(),
  expectedSourceFingerprint: v.string(),
  expectedOccurrenceKey: v.string(),
  expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
});

export type CrossPostPromotionCandidateVersion = Infer<
  typeof crossPostPromotionCandidateVersion
>;

export const crossPostPromotionCoalescingResult = v.object({
  operationId: v.string(),
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  foldedVariantIds: v.array(v.id("events")),
  variantUpdatedAts: v.array(
    v.object({ id: v.id("events"), updatedAt: v.number() }),
  ),
  variantReceiptUpdatedAts: v.array(
    v.object({
      eventId: v.id("events"),
      receiptId: v.id("instagramSourceOccurrenceReceipts"),
      updatedAt: v.number(),
    }),
  ),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});

export const crossPostPromotionCoalescingContextResult = v.object({
  state: v.union(
    v.literal("ready"),
    v.literal("legacy_migration_ready"),
    v.literal("already_coalesced"),
  ),
  targetVenue: v.any(),
  candidates: v.array(
    v.object({
      event: v.any(),
      sourceLink: v.any(),
      receipt: v.any(),
    }),
  ),
});
