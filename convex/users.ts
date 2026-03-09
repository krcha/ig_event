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
