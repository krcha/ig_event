import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { canonicalizeVenueCategory } from "../lib/taxonomy/venue-types";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";

const venueHoursSource = v.union(
  v.literal("osm"),
  v.literal("google"),
  v.literal("manual"),
  v.literal("none"),
);

const venueHoursPatch = {
  hoursSource: v.optional(venueHoursSource),
  hoursJson: v.optional(v.string()),
  hoursFetchedAt: v.optional(v.number()),
  hoursExpiresAt: v.optional(v.number()),
  hoursTimezone: v.optional(v.string()),
  osmElementId: v.optional(v.string()),
  osmElementType: v.optional(v.string()),
  googlePlaceId: v.optional(v.string()),
  hoursError: v.optional(v.string()),
};

export const listVenues = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db.query("venues").order("asc").collect();
  },
});

export const listActiveVenues = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .collect();
  },
});

export const getVenue = query({
  args: { id: v.id("venues") },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    return ctx.db.get(args.id);
  },
});

export const listPublicVenueFieldsByIds = query({
  args: {
    ids: v.array(v.id("venues")),
  },
  handler: async (ctx, args) => {
    const uniqueIds = [...new Set(args.ids)];
    const venues = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
    return venues.flatMap((venue) =>
      venue
        ? [
            {
              _id: venue._id,
              category: venue.category,
              hoursJson: venue.hoursJson,
              hoursSource: venue.hoursSource,
              hoursTimezone: venue.hoursTimezone,
              instagramHandle: venue.instagramHandle,
              isActive: venue.isActive,
              latitude: venue.latitude,
              location: venue.location,
              longitude: venue.longitude,
              name: venue.name,
              neighborhood: venue.neighborhood,
            },
          ]
        : [],
    );
  },
});

export const createVenue = mutation({
  args: {
    name: v.string(),
    instagramHandle: v.string(),
    category: v.string(),
    location: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    neighborhood: v.optional(v.string()),
    lastFullScrapeAttemptAt: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const { serviceSecret: _serviceSecret, ...venueArgs } = args;
    void _serviceSecret;
    const now = Date.now();
    return ctx.db.insert("venues", {
      ...venueArgs,
      category: canonicalizeVenueCategory(venueArgs.category),
      isActive: venueArgs.isActive ?? true,
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
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      neighborhood: v.optional(v.string()),
      lastFullScrapeAttemptAt: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const patch = {
      ...args.patch,
      ...(args.patch.category !== undefined
        ? { category: canonicalizeVenueCategory(args.patch.category) }
        : {}),
    };
    await ctx.db.patch(args.id, { ...patch, updatedAt: now });
  },
});

export const patchVenueHours = mutation({
  args: {
    id: v.id("venues"),
    patch: v.object(venueHoursPatch),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await ctx.db.patch(args.id, args.patch);
  },
});

export const removeVenue = mutation({
  args: { id: v.id("venues") },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    const favoriteRefs = await ctx.db
      .query("favoriteVenues")
      .withIndex("by_venue", (q) => q.eq("venueId", args.id))
      .collect();

    for (const favoriteRef of favoriteRefs) {
      await ctx.db.delete(favoriteRef._id);
    }

    await ctx.db.delete(args.id);
  },
});
