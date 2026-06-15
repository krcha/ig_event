import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

export const upsertUser = mutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email ?? existing.email,
        updatedAt: now,
      });
      return existing._id;
    }

    return ctx.db.insert("users", {
      clerkId: args.clerkId,
      email: args.email,
      preferences: {},
      createdAt: now,
      updatedAt: now,
    });
  },
});

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

export const listSavedEvents = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const savedRefs = await ctx.db
      .query("savedEvents")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const savedEvents = (await Promise.all(savedRefs.map((ref) => ctx.db.get(ref.eventId)))).filter(
      notNull,
    );

    return {
      savedEventIds: savedRefs.map((ref) => ref.eventId),
      savedEvents,
    };
  },
});

export const listFavoriteVenues = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const favoriteRefs = await ctx.db
      .query("favoriteVenues")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const favoriteVenues = (
      await Promise.all(favoriteRefs.map((ref) => ctx.db.get(ref.venueId)))
    ).filter(notNull);

    return {
      favoriteVenueIds: favoriteRefs.map((ref) => ref.venueId),
      favoriteVenues,
    };
  },
});

export const listLibrary = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const savedRefs = await ctx.db
      .query("savedEvents")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const favoriteRefs = await ctx.db
      .query("favoriteVenues")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const savedEvents = (await Promise.all(savedRefs.map((ref) => ctx.db.get(ref.eventId)))).filter(
      notNull,
    );
    const favoriteVenues = (
      await Promise.all(favoriteRefs.map((ref) => ctx.db.get(ref.venueId)))
    ).filter(notNull);

    return {
      savedEventIds: savedRefs.map((ref) => ref.eventId),
      savedEvents,
      favoriteVenueIds: favoriteRefs.map((ref) => ref.venueId),
      favoriteVenues,
    };
  },
});

export const toggleSavedEvent = mutation({
  args: { userId: v.string(), eventId: v.id("events") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      throw new Error("Event not found.");
    }

    const existing = await ctx.db
      .query("savedEvents")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", args.userId).eq("eventId", args.eventId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { eventId: args.eventId, saved: false };
    }

    const createdAt = Date.now();
    const savedEventId = await ctx.db.insert("savedEvents", {
      userId: args.userId,
      eventId: args.eventId,
      createdAt,
    });

    return { createdAt, eventId: args.eventId, saved: true, savedEventId };
  },
});

export const toggleFavoriteVenue = mutation({
  args: { userId: v.string(), venueId: v.id("venues") },
  handler: async (ctx, args) => {
    const venue = await ctx.db.get(args.venueId);
    if (!venue) {
      throw new Error("Venue not found.");
    }

    const existing = await ctx.db
      .query("favoriteVenues")
      .withIndex("by_user_venue", (q) =>
        q.eq("userId", args.userId).eq("venueId", args.venueId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { favorite: false, venueId: args.venueId };
    }

    const createdAt = Date.now();
    const favoriteVenueId = await ctx.db.insert("favoriteVenues", {
      userId: args.userId,
      venueId: args.venueId,
      createdAt,
    });

    return { createdAt, favorite: true, favoriteVenueId, venueId: args.venueId };
  },
});

export const saveEvent = mutation({
  args: { userId: v.id("users"), eventId: v.id("events") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userSavedEvents")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("eventId"), args.eventId))
      .first();

    if (existing) {
      return existing._id;
    }

    return ctx.db.insert("userSavedEvents", {
      userId: args.userId,
      eventId: args.eventId,
      savedAt: Date.now(),
    });
  },
});

export const unsaveEvent = mutation({
  args: { userId: v.id("users"), eventId: v.id("events") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userSavedEvents")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("eventId"), args.eventId))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
