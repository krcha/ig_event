import type { UserIdentity } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { sanitizeVenueLinkedPublicEventFields } from "../lib/events/public-event-venue-fields";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import { isAdminSubject, requireViewerIdentity } from "./authz";

type ViewerLibraryUser = {
  clerkId: string;
  email?: string;
  preferences?: unknown;
};

export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    if (identity.subject !== args.clerkId && !isAdminSubject(identity.subject)) {
      throw new Error("Cannot read another user.");
    }

    return ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

async function upsertViewerRecord(
  ctx: MutationCtx,
  identity: UserIdentity,
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
  const now = Date.now();

  if (existing) {
    await ctx.db.patch(existing._id, {
      ...(identity.email ? { email: identity.email } : {}),
      updatedAt: now,
    });
    return existing._id;
  }

  return ctx.db.insert("users", {
    clerkId: identity.subject,
    ...(identity.email ? { email: identity.email } : {}),
    preferences: {},
    createdAt: now,
    updatedAt: now,
  });
}

export const upsertViewer = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return upsertViewerRecord(ctx, identity);
  },
});

export const upsertUser = mutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    if (identity.subject !== args.clerkId && !isAdminSubject(identity.subject)) {
      throw new Error("Cannot upsert another user.");
    }
    return upsertViewerRecord(ctx, {
      ...identity,
      email: args.email ?? identity.email,
      subject: args.clerkId,
    });
  },
});

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

async function loadPublicVenueIdsForSavedEvents(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Set<Id<"venues">>> {
  const venueIds = [
    ...new Set(
      events
        .map((event) => event.venueId)
        .filter((venueId): venueId is Id<"venues"> => venueId !== undefined),
    ),
  ];
  const venues = await Promise.all(venueIds.map((venueId) => ctx.db.get(venueId)));
  return new Set(
    venues
      .filter((venue): venue is Doc<"venues"> => venue !== null && isVenuePublic(venue))
      .map((venue) => venue._id),
  );
}

async function loadLibraryForUser(ctx: QueryCtx, userId: string) {
  const savedRefs = await ctx.db
    .query("savedEvents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .collect();
  const favoriteRefs = await ctx.db
    .query("favoriteVenues")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .collect();
  const approvedSavedEvents = (
    await Promise.all(savedRefs.map((ref) => ctx.db.get(ref.eventId)))
  )
    .filter(notNull)
    .filter((event) => event.status === "approved");
  const publicVenueIds = await loadPublicVenueIdsForSavedEvents(ctx, approvedSavedEvents);
  const savedEvents = approvedSavedEvents.map((event) =>
    sanitizeVenueLinkedPublicEventFields(
      event,
      event.venueId !== undefined && publicVenueIds.has(event.venueId),
    ),
  );
  const favoriteVenues = (
    await Promise.all(favoriteRefs.map((ref) => ctx.db.get(ref.venueId)))
  )
    .filter(notNull)
    .filter(isVenuePublic);

  return {
    savedEventIds: savedEvents.map((event) => event._id),
    savedEvents,
    favoriteVenueIds: favoriteVenues.map((venue) => venue._id),
    favoriteVenues,
  };
}

async function requireViewerForUser(ctx: QueryCtx | MutationCtx, userId: string) {
  const identity = await requireViewerIdentity(ctx);
  if (identity.subject !== userId && !isAdminSubject(identity.subject)) {
    throw new Error("Cannot access another user's library.");
  }
  return identity;
}

export const getMyLibrary = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return {
      ...(await loadLibraryForUser(ctx, identity.subject)),
      userId: identity.subject,
    };
  },
});

export const updatePreferences = mutation({
  args: {
    preferences: v.any(),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const userId = await upsertViewerRecord(ctx, identity);
    const now = Date.now();
    await ctx.db.patch(userId, {
      preferences: args.preferences,
      updatedAt: now,
    });
    return { preferences: args.preferences, updatedAt: now };
  },
});

export const listSavedEvents = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await requireViewerForUser(ctx, args.userId);
    const library = await loadLibraryForUser(ctx, args.userId);
    return {
      savedEventIds: library.savedEventIds,
      savedEvents: library.savedEvents,
    };
  },
});

export const listFavoriteVenues = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await requireViewerForUser(ctx, args.userId);
    const library = await loadLibraryForUser(ctx, args.userId);
    return {
      favoriteVenueIds: library.favoriteVenueIds,
      favoriteVenues: library.favoriteVenues,
    };
  },
});

export const listLibrary = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await requireViewerForUser(ctx, args.userId);
    return loadLibraryForUser(ctx, args.userId);
  },
});

async function toggleSavedEventForUser(
  ctx: MutationCtx,
  userId: string,
  eventId: Id<"events">,
  saved?: boolean,
) {
  const existing = await ctx.db
    .query("savedEvents")
    .withIndex("by_user_event", (q) =>
      q.eq("userId", userId).eq("eventId", eventId),
    )
    .unique();

  const event = await ctx.db.get(eventId);
  const shouldSave = saved ?? !existing;

  if (!event || event.status !== "approved") {
    if (existing && !shouldSave) {
      await ctx.db.delete(existing._id);
      return { eventId, saved: false };
    }
    throw new Error("Approved event not found.");
  }

  if (existing && !shouldSave) {
    await ctx.db.delete(existing._id);
    return { eventId, saved: false };
  }

  if (existing) {
    return {
      createdAt: existing.createdAt,
      eventId,
      saved: true,
      savedEventId: existing._id,
    };
  }

  if (!shouldSave) {
    return { eventId, saved: false };
  }

  const createdAt = Date.now();
  const savedEventId = await ctx.db.insert("savedEvents", {
    userId,
    eventId,
    createdAt,
  });

  return { createdAt, eventId, saved: true, savedEventId };
}

export const toggleMySavedEvent = mutation({
  args: {
    eventId: v.id("events"),
    saved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    await upsertViewerRecord(ctx, identity);
    return toggleSavedEventForUser(ctx, identity.subject, args.eventId, args.saved);
  },
});

export const toggleSavedEvent = mutation({
  args: {
    userId: v.string(),
    eventId: v.id("events"),
    saved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireViewerForUser(ctx, args.userId);
    return toggleSavedEventForUser(ctx, args.userId, args.eventId, args.saved);
  },
});

async function toggleFavoriteVenueForUser(
  ctx: MutationCtx,
  userId: string,
  venueId: Id<"venues">,
  favorite?: boolean,
) {
  const existing = await ctx.db
    .query("favoriteVenues")
    .withIndex("by_user_venue", (q) =>
      q.eq("userId", userId).eq("venueId", venueId),
    )
    .unique();
  const shouldFavorite = favorite ?? !existing;
  const venue = await ctx.db.get(venueId);

  // A stale favorite can always be removed, but pending/hidden venues must be
  // indistinguishable from missing venues when a public user tries to add one.
  if (!venue || !isVenuePublic(venue)) {
    if (existing && !shouldFavorite) {
      await ctx.db.delete(existing._id);
      return { favorite: false, venueId };
    }
    throw new Error("Venue not found.");
  }

  if (existing && !shouldFavorite) {
    await ctx.db.delete(existing._id);
    return { favorite: false, venueId };
  }

  if (existing) {
    return {
      createdAt: existing.createdAt,
      favorite: true,
      favoriteVenueId: existing._id,
      venueId,
    };
  }

  if (!shouldFavorite) {
    return { favorite: false, venueId };
  }

  const createdAt = Date.now();
  const favoriteVenueId = await ctx.db.insert("favoriteVenues", {
    userId,
    venueId,
    createdAt,
  });

  return { createdAt, favorite: true, favoriteVenueId, venueId };
}

export const toggleMyFavoriteVenue = mutation({
  args: {
    venueId: v.id("venues"),
    favorite: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    await upsertViewerRecord(ctx, identity);
    return toggleFavoriteVenueForUser(ctx, identity.subject, args.venueId, args.favorite);
  },
});

export const toggleFavoriteVenue = mutation({
  args: {
    userId: v.string(),
    venueId: v.id("venues"),
    favorite: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireViewerForUser(ctx, args.userId);
    return toggleFavoriteVenueForUser(ctx, args.userId, args.venueId, args.favorite);
  },
});

export const saveEvent = mutation({
  args: { userId: v.id("users"), eventId: v.id("events") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user || (user as ViewerLibraryUser).clerkId !== identity.subject) {
      throw new Error("Cannot save for another user.");
    }
    const event = await ctx.db.get(args.eventId);
    if (!event || event.status !== "approved") {
      throw new Error("Approved event not found.");
    }

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
    const identity = await requireViewerIdentity(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user || (user as ViewerLibraryUser).clerkId !== identity.subject) {
      throw new Error("Cannot unsave for another user.");
    }

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
