import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const moderationStatus = v.union(v.literal("approved"), v.literal("rejected"));

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
