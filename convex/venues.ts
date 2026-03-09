import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listVenues = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("venues").order("asc").collect();
  },
});

export const listActiveVenues = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .collect();
  },
});

export const createVenue = mutation({
  args: {
    name: v.string(),
    instagramHandle: v.string(),
    category: v.string(),
    location: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("venues", {
      ...args,
      isActive: args.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateVenue = mutation({
  args: {
    id: v.id("venues"),
    patch: v.object({
      name: v.optional(v.string()),
      instagramHandle: v.optional(v.string()),
      category: v.optional(v.string()),
      location: v.optional(v.string()),
      isActive: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.id, { ...args.patch, updatedAt: now });
  },
});

export const removeVenue = mutation({
  args: { id: v.id("venues") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
