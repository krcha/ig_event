import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  formatMinutesSinceMidnight,
  getConfiguredEventTimezone,
  getEventExpiryCutoff,
  isEventExpiredAtCutoff,
} from "../lib/events/event-retention";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueNameDetailed,
  normalizeHandle,
  toSearchableText,
} from "../lib/pipeline/venue-normalization";
import { canonicalizeEventType } from "../lib/taxonomy/venue-types";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const promotionTier = v.union(v.literal("featured"), v.literal("promoted"));
const moderationStatus = v.union(v.literal("approved"), v.literal("rejected"));
const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 100;
const DISCOVER_ORGANIC_SCAN_LIMIT = 120;

type VenueDenormalizedFields = {
  venueCategory?: string | undefined;
  venueId?: Id<"venues"> | undefined;
  venueInstagramHandle?: string | undefined;
  venueLatitude?: number | undefined;
  venueLocation?: string | undefined;
  venueLongitude?: number | undefined;
};

const CLEARED_VENUE_DENORMALIZED_FIELDS: VenueDenormalizedFields = {
  venueCategory: undefined,
  venueId: undefined,
  venueInstagramHandle: undefined,
  venueLatitude: undefined,
  venueLocation: undefined,
  venueLongitude: undefined,
};

function normalizeLookup(value: string): string {
  return toSearchableText(value).replace(/\s+/g, " ").trim();
}

async function resolveVenueDenormalizedFields(
  ctx: QueryCtx | MutationCtx,
  venueName: string | undefined,
): Promise<VenueDenormalizedFields> {
  const rawVenueName = venueName ?? "";
  const lookupName = normalizeLookup(rawVenueName);
  if (!lookupName) {
    return CLEARED_VENUE_DENORMALIZED_FIELDS;
  }

  const venues = (await ctx.db.query("venues").collect()).filter(
    (venue) => venue.isActive !== false,
  );
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
  const canonicalization = canonicalizeVenueNameDetailed(
    rawVenueName,
    canonicalVenueNamesByHandle,
  );
  const canonicalHandle = canonicalization?.handle
    ? normalizeHandle(canonicalization.handle)
    : null;
  const canonicalLookupName = normalizeLookup(canonicalization?.venue ?? rawVenueName);
  const venue = venues.find((candidate) => {
    if (canonicalHandle && normalizeHandle(candidate.instagramHandle) === canonicalHandle) {
      return true;
    }
    return normalizeLookup(candidate.name) === canonicalLookupName;
  });
  if (!venue) {
    return CLEARED_VENUE_DENORMALIZED_FIELDS;
  }

  return {
    ...CLEARED_VENUE_DENORMALIZED_FIELDS,
    venueCategory: venue.category,
    venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle,
    ...(venue.latitude !== undefined ? { venueLatitude: venue.latitude } : {}),
    ...(venue.location ? { venueLocation: venue.location } : {}),
    ...(venue.longitude !== undefined ? { venueLongitude: venue.longitude } : {}),
  };
}

async function writeEventAuditLog(
  ctx: MutationCtx,
  eventId: Id<"events">,
  action: string,
  options: {
    actor?: string;
    note?: string;
    patch?: unknown;
  } = {},
) {
  await ctx.db.insert("eventAuditLog", {
    eventId,
    action,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.patch !== undefined ? { patchJson: JSON.stringify(options.patch) } : {}),
    createdAt: Date.now(),
  });
}

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
  const legacySavedEvents = await ctx.db
    .query("userSavedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  const savedEvents = await ctx.db
    .query("savedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();

  for (const savedEvent of legacySavedEvents) {
    await ctx.db.delete(savedEvent._id);
  }

  for (const savedEvent of savedEvents) {
    await ctx.db.delete(savedEvent._id);
  }

  await ctx.db.delete(eventId);
  return legacySavedEvents.length + savedEvents.length;
}

async function reassignSavedEventReferences(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
): Promise<{ movedCount: number; dedupedCount: number }> {
  if (fromEventId === toEventId) {
    return { movedCount: 0, dedupedCount: 0 };
  }

  const legacySavedEvents = await ctx.db
    .query("userSavedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();
  const savedEvents = await ctx.db
    .query("savedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();

  let movedCount = 0;
  let dedupedCount = 0;

  for (const savedEvent of legacySavedEvents) {
    const existingPrimarySave = await ctx.db
      .query("userSavedEvents")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", savedEvent.userId).eq("eventId", toEventId),
      )
      .unique();

    if (existingPrimarySave) {
      await ctx.db.delete(savedEvent._id);
      dedupedCount += 1;
      continue;
    }

    await ctx.db.patch(savedEvent._id, {
      eventId: toEventId,
    });
    movedCount += 1;
  }

  for (const savedEvent of savedEvents) {
    const existingPrimarySave = await ctx.db
      .query("savedEvents")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", savedEvent.userId).eq("eventId", toEventId),
      )
      .unique();

    if (existingPrimarySave) {
      await ctx.db.delete(savedEvent._id);
      dedupedCount += 1;
      continue;
    }

    await ctx.db.patch(savedEvent._id, {
      eventId: toEventId,
    });
    movedCount += 1;
  }

  return { movedCount, dedupedCount };
}

export const getEvent = query({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    return ctx.db.get(args.id);
  },
});

export const listEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    const limit = args.limit ?? 100;
    return ctx.db.query("events").order("desc").take(limit);
  },
});

export const getPublicApprovedEvent = query({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.id);
    if (!event || event.status !== "approved") {
      return null;
    }

    return event;
  },
});

export const getByInstagramPostId = query({
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
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
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
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
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) =>
        q.eq("instagramPostId", args.instagramPostId),
      )
      .collect();
  },
});

export const listByInstagramPostUrl = query({
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
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
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const limit = args.limit ?? 100;
    return ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);
  },
});

export const listByStatusPaginated = query({
  args: {
    status: eventStatus,
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const listByStatusDateWindow = query({
  args: {
    status: eventStatus,
    fromDate: v.string(),
    beforeDate: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", args.status).gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .collect();
  },
});

export const listPublicEventsWindow = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .paginate(args.paginationOpts);
  },
});

function toPublicCalendarEvent(event: Doc<"events">) {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    eventType: event.eventType,
    status: event.status,
    title: event.title,
    venue: event.venue,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.instagramPostId ? { instagramPostId: event.instagramPostId } : {}),
    ...(event.instagramPostUrl ? { instagramPostUrl: event.instagramPostUrl } : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    ...(event.venueCategory ? { venueCategory: event.venueCategory } : {}),
    ...(event.venueId ? { venueId: event.venueId } : {}),
    ...(event.venueInstagramHandle
      ? { venueInstagramHandle: event.venueInstagramHandle }
      : {}),
    ...(event.venueLatitude !== undefined ? { venueLatitude: event.venueLatitude } : {}),
    ...(event.venueLocation ? { venueLocation: event.venueLocation } : {}),
    ...(event.venueLongitude !== undefined ? { venueLongitude: event.venueLongitude } : {}),
  };
}

export const listPublicCalendarEventsWindow = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .collect();

    return events.map(toPublicCalendarEvent);
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

function getUtcDayForDateKey(value: string): number {
  const parts = readDateParts(value);
  if (!parts) {
    return 1;
  }

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function getUpcomingWeekendDates(today: string): Set<string> {
  const day = getUtcDayForDateKey(today);
  const startOffset = day >= 1 && day <= 4 ? 5 - day : 0;
  const endOffset = day === 5 ? 2 : day === 6 ? 1 : day === 0 ? 0 : startOffset + 2;
  const dates = new Set<string>();

  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const date = addDaysToDateKey(today, offset);
    const dateDay = getUtcDayForDateKey(date);
    if (dateDay === 5 || dateDay === 6 || dateDay === 0) {
      dates.add(date);
    }
  }

  return dates;
}

function isPromotionActive(
  event: { promotionEnd?: string; promotionStart?: string },
  today: string,
): boolean {
  return Boolean(
    event.promotionStart &&
      event.promotionEnd &&
      event.promotionStart <= today &&
      today <= event.promotionEnd,
  );
}

function comparePromotionEvents(
  left: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
  right: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
): number {
  const priorityDelta =
    (left.promotionPriority ?? Number.POSITIVE_INFINITY) -
    (right.promotionPriority ?? Number.POSITIVE_INFINITY);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareOrganicEvents(
  left: { _id: Id<"events">; date: string; time?: string; title: string },
  right: { _id: Id<"events">; date: string; time?: string; title: string },
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

function hasFreeTicketPrice(value: string | undefined): boolean {
  const normalized = value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return (
    !normalized ||
    normalized === "0" ||
    normalized === "free" ||
    normalized === "besplatno" ||
    normalized === "slobodan ulaz" ||
    normalized === "slobodne donacije" ||
    normalized === "donacije"
  );
}

export const getDiscoverFeed = query({
  args: {
    today: v.string(),
  },
  handler: async (ctx, args) => {
    const featuredCandidates = await ctx.db
      .query("events")
      .withIndex("by_status_promotionTier", (q) =>
        q.eq("status", "approved").eq("promotionTier", "featured"),
      )
      .collect();
    const promotedCandidates = await ctx.db
      .query("events")
      .withIndex("by_status_promotionTier", (q) =>
        q.eq("status", "approved").eq("promotionTier", "promoted"),
      )
      .collect();

    const featured = featuredCandidates
      .filter((event) => isPromotionActive(event, args.today))
      .sort(comparePromotionEvents)
      .slice(0, 1);
    const promoted = promotedCandidates
      .filter((event) => isPromotionActive(event, args.today))
      .sort(comparePromotionEvents)
      .slice(0, 10);
    const paidIds = new Set([...featured, ...promoted].map((event) => event._id));

    const tonight = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").eq("date", args.today),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => !paidIds.has(event._id))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    const weekendDates = getUpcomingWeekendDates(args.today);
    const weekendEnd = [...weekendDates].sort().at(-1) ?? args.today;
    const weekend = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today).lte("date", weekendEnd),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => weekendDates.has(event.date))
      .filter((event) => !paidIds.has(event._id))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    const free = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => !paidIds.has(event._id))
      .filter((event) => hasFreeTicketPrice(event.ticketPrice))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    return {
      featured,
      free,
      promoted,
      tonight,
      weekend,
    };
  },
});

export const listByDate = query({
  args: {
    date: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
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
    promotionTier: v.optional(promotionTier),
    promotionStart: v.optional(v.string()),
    promotionEnd: v.optional(v.string()),
    promotionPriority: v.optional(v.number()),
    status: v.optional(eventStatus),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const { serviceSecret: _serviceSecret, ...eventArgs } = args;
    void _serviceSecret;
    const now = Date.now();
    const venueFields = await resolveVenueDenormalizedFields(ctx, eventArgs.venue);
    const eventId = await ctx.db.insert("events", {
      ...eventArgs,
      ...venueFields,
      eventType: canonicalizeEventType(eventArgs.eventType),
      status: eventArgs.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    });

    await writeEventAuditLog(ctx, eventId, "created", {
      actor,
      patch: eventArgs,
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
      promotionTier: v.optional(promotionTier),
      promotionStart: v.optional(v.string()),
      promotionEnd: v.optional(v.string()),
      promotionPriority: v.optional(v.number()),
      status: v.optional(eventStatus),
      reviewedAt: v.optional(v.number()),
      reviewedBy: v.optional(v.string()),
      moderationNote: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const venueFields =
      args.patch.venue !== undefined
        ? await resolveVenueDenormalizedFields(ctx, args.patch.venue)
        : {};
    const patch = {
      ...args.patch,
      ...venueFields,
      ...(args.patch.eventType !== undefined
        ? { eventType: canonicalizeEventType(args.patch.eventType) }
        : {}),
    };
    await ctx.db.patch(args.id, { ...patch, updatedAt: now });
    await writeEventAuditLog(ctx, args.id, "updated", {
      actor,
      patch,
    });
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
    const identity = await requireAdminIdentity(ctx);
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
    await writeEventAuditLog(ctx, args.id, args.status, {
      actor: identity.subject,
      note: args.moderationNote,
      patch: { status: args.status },
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
    const identity = await requireAdminIdentity(ctx);
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
      await writeEventAuditLog(ctx, id, args.status, {
        actor: identity.subject,
        note: args.moderationNote,
        patch: { status: args.status },
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
    const identity = await requireAdminIdentity(ctx);
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }

    if (existingEvent.status !== "approved") {
      throw new Error("Only approved events can be removed.");
    }

    await deleteEventWithSavedReferences(ctx, args.id);
    await writeEventAuditLog(ctx, args.id, "deleted", {
      actor: identity.subject,
      patch: { status: existingEvent.status },
    });
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
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
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
      const venueFields =
        args.patch.venue !== undefined
          ? await resolveVenueDenormalizedFields(ctx, args.patch.venue)
          : {};
      const patch = {
        ...args.patch,
        ...venueFields,
        ...(args.patch.eventType !== undefined
          ? { eventType: canonicalizeEventType(args.patch.eventType) }
          : {}),
      };
      await ctx.db.patch(args.primaryId, {
        ...patch,
        updatedAt: now,
      });
      await writeEventAuditLog(ctx, args.primaryId, "merged_primary_updated", {
        actor,
        patch,
      });
    }

    for (const duplicateId of duplicateIds) {
      await reassignSavedEventReferences(ctx, duplicateId, args.primaryId);
      await ctx.db.delete(duplicateId);
      await writeEventAuditLog(ctx, duplicateId, "merged_deleted_duplicate", {
        actor,
        patch: { primaryId: args.primaryId },
      });
    }

    await writeEventAuditLog(ctx, args.primaryId, "merged_duplicates", {
      actor,
      patch: { duplicateIds },
    });

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
