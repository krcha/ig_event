import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { normalizeHandle, toSearchableText } from "../lib/pipeline/venue-normalization";
import { canonicalizeVenueCategory } from "../lib/taxonomy/venue-types";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";

const DEFAULT_PUBLIC_VENUE_EVENT_LIMIT = 12;
const MAX_PUBLIC_VENUE_EVENT_LIMIT = 50;
const DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT = 500;
const MAX_PUBLIC_VENUE_DIRECTORY_LIMIT = 1000;
const PUBLIC_VENUE_FALLBACK_SCAN_LIMIT = 1000;

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

function normalizeLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(1, Math.min(maxValue, Math.trunc(value as number)));
}

function readDateParts(value: string): { day: number; month: number; year: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return { day, month, year };
}

function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function addDaysToDateKey(value: string, days: number): string {
  const parts = readDateParts(value);
  if (!parts) {
    return value;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateKey(date);
}

function compareVenueEvents(
  left: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
  right: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareVenueEventsDesc(
  left: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
  right: Pick<Doc<"events">, "_id" | "date" | "time" | "title">,
): number {
  return compareVenueEvents(right, left);
}

function eventMatchesVenueIdentity(event: Doc<"events">, venue: Doc<"venues">): boolean {
  if (event.venueId === venue._id) {
    return true;
  }

  const eventHandle = normalizeHandle(event.venueInstagramHandle ?? "");
  const venueHandle = normalizeHandle(venue.instagramHandle);
  if (eventHandle && venueHandle && eventHandle === venueHandle) {
    return true;
  }

  const eventVenue = toSearchableText(event.venue);
  const venueName = toSearchableText(venue.name);
  return Boolean(eventVenue && venueName && eventVenue === venueName);
}

function mergeUniqueEvents(events: Doc<"events">[]): Doc<"events">[] {
  const eventsById = new Map<Id<"events">, Doc<"events">>();
  for (const event of events) {
    eventsById.set(event._id, event);
  }
  return [...eventsById.values()];
}

function buildInstagramProfileUrl(handle: string): string {
  const normalized = handle.trim().replace(/^@+/, "");
  return normalized ? `https://www.instagram.com/${normalized}/` : "";
}

function toPublicVenue(venue: Doc<"venues">) {
  return {
    _id: venue._id,
    category: venue.category,
    googlePlaceId: venue.googlePlaceId,
    hoursError: venue.hoursError,
    hoursExpiresAt: venue.hoursExpiresAt,
    hoursFetchedAt: venue.hoursFetchedAt,
    hoursJson: venue.hoursJson,
    hoursSource: venue.hoursSource,
    hoursTimezone: venue.hoursTimezone,
    instagramFollowerCount: venue.instagramFollowerCount,
    instagramFollowerCountUpdatedAt: venue.instagramFollowerCountUpdatedAt,
    instagramHandle: venue.instagramHandle,
    instagramProfileUrl: buildInstagramProfileUrl(venue.instagramHandle),
    isActive: venue.isActive,
    latitude: venue.latitude,
    location: venue.location,
    longitude: venue.longitude,
    name: venue.name,
    neighborhood: venue.neighborhood,
    osmElementId: venue.osmElementId,
    osmElementType: venue.osmElementType,
    updatedAt: venue.updatedAt,
  };
}

function toPublicEvent(event: {
  _id: Id<"events">;
  artists: string[];
  date: string;
  description?: string;
  eventType: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  ticketPrice?: string;
  time?: string;
  title: string;
  venue: string;
  venueCategory?: string;
  venueId?: Id<"venues">;
}) {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    description: event.description,
    eventType: event.eventType,
    imageUrl: event.imageUrl,
    instagramPostUrl: event.instagramPostUrl,
    ticketPrice: event.ticketPrice,
    time: event.time,
    title: event.title,
    venue: event.venue,
    venueCategory: event.venueCategory,
    venueId: event.venueId,
  };
}

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

export const listVenueIngestionFieldsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db.query("venues").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((venue) => ({
        name: venue.name,
        instagramHandle: venue.instagramHandle,
      })),
    };
  },
});

export const listActiveVenueIngestionFieldsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((venue) => ({
        name: venue.name,
        instagramHandle: venue.instagramHandle,
      })),
    };
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
              instagramFollowerCount: venue.instagramFollowerCount,
              instagramFollowerCountUpdatedAt: venue.instagramFollowerCountUpdatedAt,
              instagramHandle: venue.instagramHandle,
              instagramProfileUrl: buildInstagramProfileUrl(venue.instagramHandle),
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

export const listPublicActiveVenueFields = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(
      args.limit,
      DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT,
      MAX_PUBLIC_VENUE_DIRECTORY_LIMIT,
    );

    const venues = await ctx.db
      .query("venues")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .take(limit);

    return venues.map(toPublicVenue).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  },
});

export const getPublicVenuePage = query({
  args: {
    id: v.id("venues"),
    historyLimit: v.optional(v.number()),
    today: v.string(),
    upcomingLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const venue = await ctx.db.get(args.id);
    if (!venue) {
      return null;
    }

    const upcomingLimit = normalizeLimit(
      args.upcomingLimit,
      DEFAULT_PUBLIC_VENUE_EVENT_LIMIT,
      MAX_PUBLIC_VENUE_EVENT_LIMIT,
    );
    const historyLimit = normalizeLimit(
      args.historyLimit,
      DEFAULT_PUBLIC_VENUE_EVENT_LIMIT,
      MAX_PUBLIC_VENUE_EVENT_LIMIT,
    );

    const [
      favoriteRefs,
      approvedEventsByVenueId,
      upcomingEventsByVenueId,
      historyEventsByVenueId,
      upcomingApprovedScan,
      historyApprovedScan,
    ] = await Promise.all([
      ctx.db
        .query("favoriteVenues")
        .withIndex("by_venue", (q) => q.eq("venueId", args.id))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_venueId_status_date", (q) =>
          q.eq("venueId", args.id).eq("status", "approved"),
        )
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_venueId_status_date", (q) =>
          q.eq("venueId", args.id).eq("status", "approved").gte("date", args.today),
        )
        .order("asc")
        .take(upcomingLimit),
      ctx.db
        .query("events")
        .withIndex("by_venueId_status_date", (q) =>
          q.eq("venueId", args.id).eq("status", "approved").lt("date", args.today),
        )
        .order("desc")
        .take(historyLimit),
      ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today),
        )
        .order("asc")
        .take(PUBLIC_VENUE_FALLBACK_SCAN_LIMIT),
      ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").lt("date", args.today),
        )
        .order("desc")
        .take(PUBLIC_VENUE_FALLBACK_SCAN_LIMIT),
    ]);
    const fallbackUpcomingEvents = upcomingApprovedScan.filter(
      (event) => !event.venueId && eventMatchesVenueIdentity(event, venue),
    );
    const fallbackHistoryEvents = historyApprovedScan.filter(
      (event) => !event.venueId && eventMatchesVenueIdentity(event, venue),
    );
    const upcomingEvents = mergeUniqueEvents([
      ...upcomingEventsByVenueId,
      ...fallbackUpcomingEvents,
    ])
      .sort(compareVenueEvents)
      .slice(0, upcomingLimit);
    const historyEvents = mergeUniqueEvents([
      ...historyEventsByVenueId,
      ...fallbackHistoryEvents,
    ])
      .sort(compareVenueEventsDesc)
      .slice(0, historyLimit);
    const approvedEvents = mergeUniqueEvents([
      ...approvedEventsByVenueId,
      ...fallbackUpcomingEvents,
      ...fallbackHistoryEvents,
    ]);
    const recentWindowStart = addDaysToDateKey(args.today, -30);
    const approvedUpcomingCount = approvedEvents.filter(
      (event) => event.date >= args.today,
    ).length;
    const approvedHistoryCount = approvedEvents.filter(
      (event) => event.date < args.today,
    ).length;
    const recentApprovedCount = approvedEvents.filter(
      (event) => event.date >= recentWindowStart && event.date < args.today,
    ).length;

    return {
      venue: toPublicVenue(venue),
      upcomingEvents: upcomingEvents.map(toPublicEvent),
      historyEvents: historyEvents.map(toPublicEvent),
      stats: {
        appFollowerCount: favoriteRefs.length,
        approvedEventCount: approvedEvents.length,
        approvedHistoryCount,
        approvedUpcomingCount,
        recentApprovedCount,
        recentWindowDays: 30,
      },
    };
  },
});

export const listPublicVenueDirectory = query({
  args: {
    limit: v.optional(v.number()),
    today: v.string(),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(
      args.limit,
      DEFAULT_PUBLIC_VENUE_DIRECTORY_LIMIT,
      MAX_PUBLIC_VENUE_DIRECTORY_LIMIT,
    );
    const [venues, upcomingEvents] = await Promise.all([
      ctx.db
        .query("venues")
        .withIndex("by_isActive", (q) => q.eq("isActive", true))
        .take(limit),
      ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today),
        )
        .take(1000),
    ]);
    const upcomingCountsByVenueId = new Map<string, number>();
    for (const event of upcomingEvents) {
      const venueId = event.venueId ?? venues.find((venue) =>
        eventMatchesVenueIdentity(event, venue),
      )?._id;
      if (!venueId) {
        continue;
      }
      upcomingCountsByVenueId.set(
        venueId,
        (upcomingCountsByVenueId.get(venueId) ?? 0) + 1,
      );
    }

    return venues
      .map((venue) => ({
        ...toPublicVenue(venue),
        upcomingEventCount: upcomingCountsByVenueId.get(venue._id) ?? 0,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
  },
});

export const createVenue = mutation({
  args: {
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
    isActive: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const { serviceSecret: _serviceSecret, ...venueArgs } = args;
    void _serviceSecret;
    const instagramHandle = normalizeHandle(venueArgs.instagramHandle);
    if (!instagramHandle) {
      throw new Error("Venue Instagram handle is required.");
    }
    const indexedVenue = await ctx.db
      .query("venues")
      .withIndex("by_instagramHandle", (q) => q.eq("instagramHandle", instagramHandle))
      .first();
    const existingVenue =
      indexedVenue ??
      (await ctx.db.query("venues").collect()).find(
        (venue) => normalizeHandle(venue.instagramHandle) === instagramHandle,
      );
    if (existingVenue) {
      return existingVenue._id;
    }
    const now = Date.now();
    return ctx.db.insert("venues", {
      ...venueArgs,
      instagramHandle,
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
      instagramFollowerCount: v.optional(v.number()),
      instagramFollowerCountUpdatedAt: v.optional(v.number()),
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
    let instagramHandle: string | undefined;
    if (args.patch.instagramHandle !== undefined) {
      const normalizedInstagramHandle = normalizeHandle(args.patch.instagramHandle);
      if (!normalizedInstagramHandle) {
        throw new Error("Venue Instagram handle is required.");
      }
      instagramHandle = normalizedInstagramHandle;
      const indexedVenue = await ctx.db
        .query("venues")
        .withIndex("by_instagramHandle", (q) =>
          q.eq("instagramHandle", normalizedInstagramHandle),
        )
        .first();
      const equivalentVenue =
        indexedVenue ??
        (await ctx.db.query("venues").collect()).find(
          (venue) => normalizeHandle(venue.instagramHandle) === normalizedInstagramHandle,
        );
      if (equivalentVenue && equivalentVenue._id !== args.id) {
        throw new Error("A venue with that normalized Instagram handle already exists.");
      }
    }
    const patch = {
      ...args.patch,
      ...(instagramHandle !== undefined ? { instagramHandle } : {}),
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
