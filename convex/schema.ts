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
  events: defineTable({
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    timeSource: v.optional(eventTimeSource),
    timeEvidenceText: v.optional(v.string()),
    timeConfidence: v.optional(v.number()),
    timeStatus: v.optional(eventTimeStatus),
    venue: v.string(),
    venueCategory: v.optional(v.string()),
    venueId: v.optional(v.id("venues")),
    venueInstagramHandle: v.optional(v.string()),
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
    .index("by_image_storage_id", ["imageStorageId"])
    .index("by_status_promotionTier", ["status", "promotionTier"])
    .index("by_instagramPostId", ["instagramPostId"])
    .index("by_instagramPostUrl", ["instagramPostUrl"])
    .index("by_normalizedInstagramPostUrl", ["normalizedInstagramPostUrl"])
    .index("by_sourceOccurrenceKey", ["sourceOccurrenceKey"])
    .index("by_venueId", ["venueId"])
    .index("by_venueId_status_date", ["venueId", "status", "date"]),
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
    username: v.string(),
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
    .index("by_updatedAt", ["updatedAt"]),
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
    .index("by_status_updatedAt", ["status", "updatedAt"]),
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
