import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const ingestionJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);
const ingestionJobMode = v.union(
  v.literal("full_scrape"),
  v.literal("saved_posts"),
);
const eventTimeSource = v.union(
  v.literal("alt_text"),
  v.literal("caption"),
  v.literal("description"),
  v.literal("model"),
  v.literal("poster"),
  v.literal("schedule_entry"),
  v.literal("unknown"),
);
const eventTimeStatus = v.union(
  v.literal("confirmed"),
  v.literal("inferred"),
  v.literal("unknown"),
);
const venuePublicStatus = v.union(
  v.literal("pending"),
  v.literal("published"),
  v.literal("hidden"),
);

export default defineSchema({
  instagramSources: defineTable({
    handle: v.string(),
    role: v.union(v.literal("venue"), v.literal("promoter"), v.literal("unknown")),
    venueId: v.optional(v.id("venues")),
    active: v.boolean(),
    discoveredAt: v.number(),
    activatedAt: v.number(),
    deactivatedAt: v.optional(v.number()),
    lastSeenFollowingAt: v.optional(v.number()),
    lastFetchAttemptAt: v.optional(v.number()),
    lastSuccessfulFetchThroughAt: v.optional(v.number()),
    lastFetchCompletedAt: v.optional(v.number()),
    lastFetchStatus: v.optional(v.string()),
    lastFetchError: v.optional(v.string()),
    continuationActive: v.optional(v.boolean()),
    continuationBoundaryAt: v.optional(v.number()),
    continuationResultsLimit: v.optional(v.number()),
    continuationReason: v.optional(v.string()),
    deferredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_active", ["active"])
    .index("by_active_lastFetchAttemptAt", ["active", "lastFetchAttemptAt"])
    .index("by_role_active", ["role", "active"]),

  instagramFollowingSyncState: defineTable({
    key: v.string(),
    sourceHandle: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    lastCompleteSyncAt: v.optional(v.number()),
    snapshotComplete: v.boolean(),
    capped: v.boolean(),
    rawItemCount: v.number(),
    validItemCount: v.number(),
    malformedItemCount: v.number(),
    maxItems: v.number(),
    discoveredCount: v.optional(v.number()),
    activatedCount: v.optional(v.number()),
    deactivatedCount: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  ingestionDailyBudgets: defineTable({
    key: v.string(),
    provider: v.string(),
    dayKey: v.string(),
    limitMicros: v.number(),
    reservedMicros: v.number(),
    chargedMicros: v.number(),
    releasedMicros: v.number(),
    reservationCount: v.number(),
    reconciledCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_provider_day", ["provider", "dayKey"]),

  ingestionCostReservations: defineTable({
    reservationId: v.string(),
    provider: v.string(),
    dayKey: v.string(),
    owner: v.string(),
    handle: v.optional(v.string()),
    reservedMicros: v.number(),
    chargedMicros: v.optional(v.number()),
    releasedMicros: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("reconciled"), v.literal("released")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_reservationId", ["reservationId"])
    .index("by_provider_day", ["provider", "dayKey"])
    .index("by_owner", ["owner"]),

  instagramEventSources: defineTable({
    eventId: v.id("events"),
    sourceIdentity: v.string(),
    sourceFingerprint: v.string(),
    sourceOccurrenceKey: v.string(),
    instagramPostId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    sourceHandle: v.optional(v.string()),
    linkedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_source_occurrence", ["sourceIdentity", "sourceOccurrenceKey"])
    .index("by_post_id", ["instagramPostId"])
    .index("by_post_url", ["instagramPostUrl"]),

  events: defineTable({
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    timeSource: v.optional(eventTimeSource),
    timeEvidenceText: v.optional(v.string()),
    timeConfidence: v.optional(v.number()),
    timeStatus: v.optional(eventTimeStatus),
    venue: v.string(),
    normalizedVenueIdentity: v.optional(v.string()),
    venueCategory: v.optional(v.string()),
    venueId: v.optional(v.id("venues")),
    venueInstagramHandle: v.optional(v.string()),
    normalizedVenueInstagramHandle: v.optional(v.string()),
    venueLatitude: v.optional(v.number()),
    venueLocation: v.optional(v.string()),
    venueLongitude: v.optional(v.number()),
    artists: v.array(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    instagramPostUrl: v.optional(v.string()),
    normalizedInstagramPostUrl: v.optional(v.string()),
    instagramPostId: v.optional(v.string()),
    ticketPrice: v.optional(v.string()),
    eventType: v.string(),
    sourceCaption: v.optional(v.string()),
    sourcePostedAt: v.optional(v.string()),
    rawExtractionJson: v.optional(v.string()),
    normalizedFieldsJson: v.optional(v.string()),
    sourceOccurrenceKey: v.optional(v.string()),
    promotionTier: v.optional(v.union(v.literal("featured"), v.literal("promoted"))),
    promotionStart: v.optional(v.string()),
    promotionEnd: v.optional(v.string()),
    promotionPriority: v.optional(v.number()),
    status: eventStatus,
    reviewedAt: v.optional(v.number()),
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_date", ["date"])
    .index("by_status", ["status"])
    .index("by_status_date", ["status", "date"])
    .index("by_normalizedVenueHandle_status_date", ["normalizedVenueInstagramHandle", "status", "date"])
    .index("by_normalizedVenueIdentity_status_date", ["normalizedVenueIdentity", "status", "date"])
    .index("by_image_storage_id", ["imageStorageId"])
    .index("by_status_promotionTier", ["status", "promotionTier"])
    .index("by_instagramPostId", ["instagramPostId"])
    .index("by_instagramPostUrl", ["instagramPostUrl"])
    .index("by_normalizedInstagramPostUrl", ["normalizedInstagramPostUrl"])
    .index("by_sourceOccurrenceKey", ["sourceOccurrenceKey"])
    .index("by_venueId", ["venueId"])
    .index("by_venueId_status_date", ["venueId", "status", "date"]),
  instagramSourceOccurrenceReceipts: defineTable({
    sourceIdentity: v.string(),
    sourceFingerprint: v.string(),
    expectedKeys: v.array(v.string()),
    expectedOccurrences: v.optional(
      v.array(
        v.object({
          key: v.string(),
          date: v.string(),
          time: v.optional(v.string()),
          venue: v.string(),
          title: v.string(),
          artists: v.array(v.string()),
        }),
      ),
    ),
    satisfiedKeys: v.array(v.string()),
    deferredChildCount: v.number(),
    deferredChildKeys: v.array(v.string()),
    satisfiedOccurrences: v.array(
      v.object({
        key: v.string(),
        eventId: v.id("events"),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_sourceIdentity", ["sourceIdentity"]),
  venues: defineTable({
    name: v.string(),
    instagramHandle: v.string(),
    instagramFollowerCount: v.optional(v.number()),
    instagramFollowerCountUpdatedAt: v.optional(v.number()),
    category: v.string(),
    location: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    neighborhood: v.optional(v.string()),
    lastFullScrapeAttemptAt: v.optional(v.number()),
    hoursSource: v.optional(
      v.union(
        v.literal("osm"),
        v.literal("google"),
        v.literal("manual"),
        v.literal("none"),
      ),
    ),
    hoursJson: v.optional(v.string()),
    hoursFetchedAt: v.optional(v.number()),
    hoursExpiresAt: v.optional(v.number()),
    hoursTimezone: v.optional(v.string()),
    osmElementId: v.optional(v.string()),
    osmElementType: v.optional(v.string()),
    googlePlaceId: v.optional(v.string()),
    hoursError: v.optional(v.string()),
    // Optional during rollout so legacy rows remain readable before migration.
    // New writes use scrapeActive and publicStatus; isActive remains only for
    // backward-compatible reads and an exact rollback path.
    isActive: v.optional(v.boolean()),
    scrapeActive: v.optional(v.boolean()),
    publicStatus: v.optional(venuePublicStatus),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_instagramHandle", ["instagramHandle"])
    .index("by_isActive", ["isActive"])
    .index("by_scrapeActive", ["scrapeActive"])
    .index("by_publicStatus", ["publicStatus"]),
  users: defineTable({
    clerkId: v.string(),
    email: v.optional(v.string()),
    preferences: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_clerkId", ["clerkId"]),
  savedEvents: defineTable({
    userId: v.string(),
    eventId: v.id("events"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_event", ["eventId"])
    .index("by_user_event", ["userId", "eventId"]),
  favoriteVenues: defineTable({
    userId: v.string(),
    venueId: v.id("venues"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_venue", ["venueId"])
    .index("by_user_venue", ["userId", "venueId"]),
  userSavedEvents: defineTable({
    userId: v.id("users"),
    eventId: v.id("events"),
    savedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_event", ["eventId"])
    .index("by_user_event", ["userId", "eventId"]),
  scrapedPosts: defineTable({
    handle: v.string(),
    postId: v.string(),
    caption: v.optional(v.string()),
    altText: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    imageUrls: v.array(v.string()),
    postedAtMs: v.optional(v.number()),
    postType: v.optional(v.string()),
    locationName: v.optional(v.string()),
    instagramPostUrl: v.string(),
    normalizedInstagramPostUrl: v.optional(v.string()),
    postedAt: v.optional(v.string()),
    sourceKey: v.optional(v.string()),
    sourceRevision: v.optional(v.number()),
    blocksPaidFetch: v.optional(v.boolean()),
    username: v.string(),
    processingStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("retryable_failure"),
      ),
    ),
    processingAttempts: v.optional(v.number()),
    processingOutcome: v.optional(v.string()),
    processingError: v.optional(v.string()),
    analysisRevision: v.optional(v.number()),
    analysisResultJson: v.optional(v.string()),
    analysisCompletedAt: v.optional(v.number()),
    analysisModel: v.optional(v.string()),
    analysisInputTokens: v.optional(v.number()),
    analysisOutputTokens: v.optional(v.number()),
    analysisTotalTokens: v.optional(v.number()),
    processingLeaseOwner: v.optional(v.string()),
    processingLeaseExpiresAt: v.optional(v.number()),
    processingRetryAt: v.optional(v.number()),
    lastProcessedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_handle_postedAtMs", ["handle", "postedAtMs"])
    .index("by_handle_postId", ["handle", "postId"])
    .index("by_image_storage_id", ["imageStorageId"])
    .index("by_handle_postUrl", ["handle", "instagramPostUrl"])
    .index("by_postId", ["postId"])
    .index("by_instagramPostUrl", ["instagramPostUrl"])
    .index("by_normalizedInstagramPostUrl", ["normalizedInstagramPostUrl"])
    .index("by_blocksPaidFetch", ["blocksPaidFetch"])
    .index("by_handle_blocksPaidFetch", ["handle", "blocksPaidFetch"])
    .index("by_updatedAt", ["updatedAt"]),
  instagramHandleFetchLeases: defineTable({
    handle: v.string(),
    owner: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_expiresAt", ["expiresAt"]),
  ingestionProviderLeases: defineTable({
    provider: v.string(),
    owner: v.string(),
    leaseExpiresAt: v.number(),
    blockedAt: v.optional(v.number()),
    blockedStatus: v.optional(v.number()),
    blockedCode: v.optional(v.string()),
    circuitState: v.optional(
      v.union(v.literal("closed"), v.literal("open"), v.literal("half_open")),
    ),
    cooldownUntil: v.optional(v.number()),
    failureCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_provider", ["provider"]),
  instagramPaidFetchControl: defineTable({
    key: v.string(),
    backlogIndexReady: v.boolean(),
    leaseOwner: v.optional(v.string()),
    leaseHandle: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    leaseBoundaryKey: v.optional(v.string()),
    leaseResultsLimit: v.optional(v.number()),
    leaseFetchStartedAt: v.optional(v.number()),
    leaseCheckpointAt: v.optional(v.number()),
    leaseBudgetDayKey: v.optional(v.string()),
    leaseReservationId: v.optional(v.string()),
    leaseReservedMicros: v.optional(v.number()),
    leaseWindowStatus: v.optional(v.union(v.literal("active"), v.literal("saturated"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  instagramHandleFetchStates: defineTable({
    handle: v.string(),
    boundaryKey: v.string(),
    nextResultsLimit: v.number(),
    hardBlocked: v.boolean(),
    lastRequestedMaxItems: v.number(),
    lastRawItemCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_handle", ["handle"]),
  mediaAssets: defineTable({
    sourceKey: v.string(),
    sourceKind: v.literal("instagram_post"),
    instagramPostId: v.optional(v.string()),
    normalizedInstagramPostUrl: v.optional(v.string()),
    storageId: v.id("_storage"),
    url: v.string(),
    upstreamUrl: v.string(),
    mimeType: v.string(),
    byteLength: v.number(),
    checksumSha256: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastAttachedAt: v.number(),
  })
    .index("by_sourceKey", ["sourceKey"])
    .index("by_instagramPostId", ["instagramPostId"])
    .index("by_normalizedInstagramPostUrl", ["normalizedInstagramPostUrl"])
    .index("by_updatedAt", ["updatedAt"]),
  ingestionJobs: defineTable({
    source: v.string(),
    mode: v.optional(ingestionJobMode),
    status: ingestionJobStatus,
    handles: v.array(v.string()),
    resultsLimit: v.optional(v.number()),
    daysBack: v.optional(v.number()),
    batchSize: v.number(),
    summaryJson: v.string(),
    stateJson: v.string(),
    stateVersion: v.optional(v.number()),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    finishedAt: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status_updatedAt", ["status", "updatedAt"])
    .index("by_mode_createdAt", ["mode", "createdAt"])
    .index("by_source_createdAt", ["source", "createdAt"]),
  eventAuditLog: defineTable({
    eventId: v.id("events"),
    action: v.string(),
    actor: v.optional(v.string()),
    patchJson: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_createdAt", ["createdAt"]),
  venueAuditLog: defineTable({
    venueId: v.id("venues"),
    action: v.string(),
    actor: v.optional(v.string()),
    beforeJson: v.string(),
    afterJson: v.string(),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_venue", ["venueId"])
    .index("by_createdAt", ["createdAt"]),
});
