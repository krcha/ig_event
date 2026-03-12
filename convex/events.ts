import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  formatMinutesSinceMidnight,
  getConfiguredEventTimezone,
  getEventExpiryCutoff,
  isEventExpiredAtCutoff,
} from "../lib/events/event-retention";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const moderationStatus = v.union(v.literal("approved"), v.literal("rejected"));
const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 100;

function normalizeExpiredEventDeleteBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE;
  }

  return Math.max(1, Math.min(500, Math.trunc(value as number)));
}

async function deleteEventWithSavedReferences(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<number> {
  const savedEvents = await ctx.db
    .query("userSavedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();

  for (const savedEvent of savedEvents) {
    await ctx.db.delete(savedEvent._id);
  }

  await ctx.db.delete(eventId);
  return savedEvents.length;
}

export const getEvent = query({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

export const listEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return ctx.db.query("events").order("desc").take(limit);
  },
});

export const getByInstagramPostId = query({
  args: { instagramPostId: v.string() },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) =>
        q.eq("instagramPostId", args.instagramPostId),
      )
      .take(1);
    return matches[0] ?? null;
  },
});

export const getByInstagramPostUrl = query({
  args: { instagramPostUrl: v.string() },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", args.instagramPostUrl),
      )
      .take(1);
    return matches[0] ?? null;
  },
});

export const listByInstagramPostId = query({
  args: { instagramPostId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) =>
        q.eq("instagramPostId", args.instagramPostId),
      )
      .collect();
  },
});

export const listByInstagramPostUrl = query({
  args: { instagramPostUrl: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", args.instagramPostUrl),
      )
      .collect();
  },
});

export const listByStatus = query({
  args: {
    status: eventStatus,
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);
  },
});

export const listApprovedUpcomingByDatePaginated = query({
  args: {
    fromDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate),
      )
      .paginate(args.paginationOpts);
  },
});

export const listByDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("events")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .collect();
  },
});

export const createEvent = mutation({
  args: {
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    venue: v.string(),
    artists: v.array(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    instagramPostId: v.optional(v.string()),
    ticketPrice: v.optional(v.string()),
    eventType: v.string(),
    sourceCaption: v.optional(v.string()),
    sourcePostedAt: v.optional(v.string()),
    rawExtractionJson: v.optional(v.string()),
    normalizedFieldsJson: v.optional(v.string()),
    status: v.optional(eventStatus),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const eventId = await ctx.db.insert("events", {
      ...args,
      status: args.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    });

    return eventId;
  },
});

export const updateEvent = mutation({
  args: {
    id: v.id("events"),
    patch: v.object({
      title: v.optional(v.string()),
      date: v.optional(v.string()),
      time: v.optional(v.string()),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      instagramPostUrl: v.optional(v.string()),
      instagramPostId: v.optional(v.string()),
      ticketPrice: v.optional(v.string()),
      eventType: v.optional(v.string()),
      sourceCaption: v.optional(v.string()),
      sourcePostedAt: v.optional(v.string()),
      rawExtractionJson: v.optional(v.string()),
      normalizedFieldsJson: v.optional(v.string()),
      status: v.optional(eventStatus),
      reviewedAt: v.optional(v.number()),
      reviewedBy: v.optional(v.string()),
      moderationNote: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.id, { ...args.patch, updatedAt: now });
  },
});

export const setEventStatus = mutation({
  args: {
    id: v.id("events"),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }

    if (existingEvent.status !== "pending") {
      throw new Error("Only pending events can be moderated.");
    }

    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      reviewedAt: now,
      reviewedBy: args.reviewedBy,
      moderationNote: args.moderationNote,
      updatedAt: now,
    });
  },
});

export const setEventStatuses = mutation({
  args: {
    ids: v.array(v.id("events")),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const uniqueIds = [...new Set(args.ids)];
    let updatedCount = 0;
    let skippedCount = 0;

    for (const id of uniqueIds) {
      const existingEvent = await ctx.db.get(id);
      if (!existingEvent || existingEvent.status !== "pending") {
        skippedCount += 1;
        continue;
      }

      await ctx.db.patch(id, {
        status: args.status,
        reviewedAt: now,
        reviewedBy: args.reviewedBy,
        moderationNote: args.moderationNote,
        updatedAt: now,
      });
      updatedCount += 1;
    }

    return {
      updatedCount,
      skippedCount,
    };
  },
});

export const deleteApprovedEvent = mutation({
  args: {
    id: v.id("events"),
  },
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }

    if (existingEvent.status !== "approved") {
      throw new Error("Only approved events can be removed.");
    }

    await deleteEventWithSavedReferences(ctx, args.id);
  },
});

export const mergeApprovedEvents = mutation({
  args: {
    primaryId: v.id("events"),
    duplicateIds: v.array(v.id("events")),
    patch: v.object({
      title: v.optional(v.string()),
      date: v.optional(v.string()),
      time: v.optional(v.string()),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      ticketPrice: v.optional(v.string()),
      eventType: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const primaryEvent = await ctx.db.get(args.primaryId);
    if (!primaryEvent) {
      throw new Error("Primary event not found.");
    }
    if (primaryEvent.status !== "approved") {
      throw new Error("Only approved events can be merged.");
    }

    const duplicateIds = [...new Set(args.duplicateIds)].filter((id) => id !== args.primaryId);
    for (const duplicateId of duplicateIds) {
      const duplicateEvent = await ctx.db.get(duplicateId);
      if (!duplicateEvent) {
        throw new Error("Duplicate event not found.");
      }
      if (duplicateEvent.status !== "approved") {
        throw new Error("Only approved duplicate events can be removed.");
      }
    }

    const now = Date.now();
    if (Object.keys(args.patch).length > 0) {
      await ctx.db.patch(args.primaryId, {
        ...args.patch,
        updatedAt: now,
      });
    }

    for (const duplicateId of duplicateIds) {
      await deleteEventWithSavedReferences(ctx, duplicateId);
    }

    return {
      primaryId: args.primaryId,
      deletedDuplicateCount: duplicateIds.length,
    };
  },
});

export const deleteExpiredEvents = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = normalizeExpiredEventDeleteBatchSize(args.batchSize);
    const timeZone = getConfiguredEventTimezone();
    const cutoff = getEventExpiryCutoff(new Date(), timeZone);
    const eventsBeforeCutoffDate = await ctx.db
      .query("events")
      .withIndex("by_date", (q) => q.lt("date", cutoff.isoDate))
      .take(batchSize);

    const deletedEventIds: Id<"events">[] = [];
    let deletedSavedEventCount = 0;

    for (const event of eventsBeforeCutoffDate) {
      deletedSavedEventCount += await deleteEventWithSavedReferences(ctx, event._id);
      deletedEventIds.push(event._id);
    }

    const remainingSlots = batchSize - deletedEventIds.length;
    let skippedSameDayEventCount = 0;
    let sameDayExpiredEventCount = 0;

    if (remainingSlots > 0) {
      const eventsOnCutoffDate = await ctx.db
        .query("events")
        .withIndex("by_date", (q) => q.eq("date", cutoff.isoDate))
        .collect();
      const sameDayExpiredEvents = eventsOnCutoffDate.filter((event) =>
        isEventExpiredAtCutoff(event, cutoff),
      );

      sameDayExpiredEventCount = sameDayExpiredEvents.length;
      skippedSameDayEventCount = Math.max(0, sameDayExpiredEvents.length - remainingSlots);

      for (const event of sameDayExpiredEvents.slice(0, remainingSlots)) {
        deletedSavedEventCount += await deleteEventWithSavedReferences(ctx, event._id);
        deletedEventIds.push(event._id);
      }
    }

    return {
      deletedEventCount: deletedEventIds.length,
      deletedEventIds,
      deletedSavedEventCount,
      cutoffDate: cutoff.isoDate,
      cutoffTime: formatMinutesSinceMidnight(cutoff.minutesSinceMidnight),
      timeZone,
      hasMore:
        eventsBeforeCutoffDate.length === batchSize || skippedSameDayEventCount > 0,
      skippedSameDayEventCount,
      sameDayExpiredEventCount,
    };
  },
});
