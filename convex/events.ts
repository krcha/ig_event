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
import { normalizeEventTimeWritePatch } from "../lib/events/event-time-write";
import { isSensibleEventTitleForApproval } from "../lib/events/event-title-approval";
import {
  assertExpectedEventStatus,
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
} from "../lib/events/event-update-precondition";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueNameDetailed,
  normalizeHandle,
  toSearchableText,
} from "../lib/pipeline/venue-normalization";
import { sanitizeVenueLinkedPublicEventFields } from "../lib/events/public-event-venue-fields";
import { canonicalizeEventType } from "../lib/taxonomy/venue-types";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import { assertPublicEventImageWrite } from "../lib/images/public-event-image";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const promotionTier = v.union(v.literal("featured"), v.literal("promoted"));
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
const moderationStatus = v.union(v.literal("approved"), v.literal("rejected"));
const sourceGroundingReprocessItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  nextNormalizedFieldsJson: v.string(),
});
const MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE = 100;
const MAX_EVENTS_GET_MANY_BY_IDS = 100;
const SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS = new Set([
  "caption_source_event_mismatch",
  "unverified_core_event_source",
]);
const SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS = new Set([
  ...SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS,
  "requires_human_approval",
]);
const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 100;
const DISCOVER_ORGANIC_SCAN_LIMIT = 120;

function readModerationPendingReasons(normalizedFieldsJson: string | undefined): string[] {
  try {
    const parsed = JSON.parse(normalizedFieldsJson ?? "{}");
    return Array.isArray(parsed?.moderationPendingReasons)
      ? parsed.moderationPendingReasons.filter(
          (reason: unknown): reason is string => typeof reason === "string" && reason.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function assertSourceGroundingReprocessReasons(event: Doc<"events">): void {
  const reasons = readModerationPendingReasons(event.normalizedFieldsJson);
  if (!reasons.some((reason) => SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS.has(reason))) {
    throw new Error(`Source-grounding hold required for event ${event._id}.`);
  }
  const nonRemovable = reasons.filter(
    (reason) => !SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS.has(reason),
  );
  if (nonRemovable.length > 0) {
    throw new Error(
      `Unrelated moderation holds block source-grounding reprocessing for event ${event._id}: ${nonRemovable.join(", ")}.`,
    );
  }
}

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

function normalizeSourceCaption(value: string | undefined): string {
  return value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
}

function normalizeInstagramSourceUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!/(^|\.)instagram\.com$/iu.test(parsed.hostname)) return "";
    return parsed.pathname.replace(/\/+$/u, "").toLowerCase();
  } catch {
    return "";
  }
}

type ApprovalCandidateFields = {
  title: string;
  date: string;
  venue: string;
  venueId?: Id<"venues">;
  venueInstagramHandle?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
};

type ServiceSourceCandidateFields = ApprovalCandidateFields & {
  sourceCaption?: string;
};

async function assertPersistedServiceSourcePolicy(
  ctx: MutationCtx,
  candidate: ServiceSourceCandidateFields,
): Promise<void> {
  const handle = normalizeHandle(candidate.venueInstagramHandle ?? "");
  const postId = candidate.instagramPostId?.trim() ?? "";
  const postUrl = normalizeInstagramSourceUrl(candidate.instagramPostUrl);
  const sourceCaption = normalizeSourceCaption(candidate.sourceCaption);
  if (!handle || !postId || !postUrl || !sourceCaption) {
    throw new Error("Service approval requires a persisted Instagram source post.");
  }
  const persisted = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) => q.eq("handle", handle).eq("postId", postId))
    .first();
  if (
    !persisted ||
    normalizeHandle(persisted.handle) !== handle ||
    normalizeHandle(persisted.username) !== handle ||
    persisted.postId !== postId ||
    normalizeInstagramSourceUrl(persisted.instagramPostUrl) !== postUrl ||
    normalizeSourceCaption(persisted.caption) !== sourceCaption
  ) {
    throw new Error("Service approval source does not match the persisted Instagram post.");
  }
}

async function assertApprovalCandidatePolicy(
  ctx: MutationCtx,
  candidate: ApprovalCandidateFields,
  excludeEventIds: Id<"events">[] = [],
): Promise<void> {
  if (!isSensibleEventTitleForApproval(candidate)) {
    throw new Error("Event title is not suitable for approval.");
  }

  const sameDateEvents = await ctx.db
    .query("events")
    .withIndex("by_date", (q) => q.eq("date", candidate.date))
    .collect();
  const candidateVenue = normalizeLookup(candidate.venue);
  const candidatePostUrl = normalizeLookup(candidate.instagramPostUrl ?? "");
  const candidatePostId = candidate.instagramPostId?.trim() ?? "";
  const excluded = new Set(excludeEventIds);
  const conflict = sameDateEvents.find((event) => {
    if (excluded.has(event._id) || event.status !== "approved") {
      return false;
    }
    const sameVenue =
      (candidate.venueId !== undefined &&
        event.venueId !== undefined &&
        event.venueId === candidate.venueId) ||
      (Boolean(candidate.venueInstagramHandle) &&
        normalizeHandle(event.venueInstagramHandle ?? "") ===
          normalizeHandle(candidate.venueInstagramHandle ?? "")) ||
      (Boolean(candidateVenue) && normalizeLookup(event.venue) === candidateVenue);
    const sameSourceEvent =
      (Boolean(candidatePostId) && event.instagramPostId?.trim() === candidatePostId) ||
      (Boolean(candidatePostUrl) &&
        normalizeLookup(event.instagramPostUrl ?? "") === candidatePostUrl);
    return sameVenue || sameSourceEvent;
  });

  if (conflict) {
    throw new Error("An approved event already exists for this venue and date.");
  }
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

  const venues = (await ctx.db.query("venues").collect()).filter(isVenuePublic);
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

async function loadPublicVenueIdsForEvents(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Set<Id<"venues">>> {
  const venueIds = [
    ...new Set(events.map((event) => event.venueId).filter((id): id is Id<"venues"> => id !== undefined)),
  ];
  const venues = await Promise.all(venueIds.map((venueId) => ctx.db.get(venueId)));
  return new Set(
    venues
      .filter((venue): venue is Doc<"venues"> => venue !== null && isVenuePublic(venue))
      .map((venue) => venue._id),
  );
}

function sanitizePublicEventWithVenueIds(
  event: Doc<"events">,
  publicVenueIds: Set<Id<"venues">>,
): Doc<"events"> {
  return sanitizeVenueLinkedPublicEventFields(
    event,
    event.venueId !== undefined && publicVenueIds.has(event.venueId),
  );
}

async function sanitizePublicEventVenueFields(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Doc<"events">> {
  const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, [event]);
  return sanitizePublicEventWithVenueIds(event, publicVenueIds);
}

async function sanitizePublicEventPage(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Doc<"events">[]> {
  const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, events);
  return events.map((event) => sanitizePublicEventWithVenueIds(event, publicVenueIds));
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
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.id);
    if (!eventId) {
      return null;
    }

    const event = await ctx.db.get(eventId);
    if (!event || event.status !== "approved") {
      return null;
    }

    return sanitizePublicEventVenueFields(ctx, event);
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

export const getManyByIds = query({
  args: {
    ids: v.array(v.id("events")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.ids.length === 0 || args.ids.length > MAX_EVENTS_GET_MANY_BY_IDS) {
      throw new Error(`Event ID reads require 1-${MAX_EVENTS_GET_MANY_BY_IDS} IDs.`);
    }
    if (new Set(args.ids).size !== args.ids.length) {
      throw new Error("Event ID reads require unique IDs.");
    }
    const events = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return events.filter((event): event is Doc<"events"> => event !== null);
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
    const result = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await sanitizePublicEventPage(ctx, result.page),
    };
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
    ...(event.timeSource ? { timeSource: event.timeSource } : {}),
    ...(event.timeEvidenceText ? { timeEvidenceText: event.timeEvidenceText } : {}),
    ...(event.timeConfidence !== undefined ? { timeConfidence: event.timeConfidence } : {}),
    ...(event.timeStatus ? { timeStatus: event.timeStatus } : {}),
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

    const publicEvents = await sanitizePublicEventPage(ctx, events);
    return publicEvents.map(toPublicCalendarEvent);
  },
});

export const listApprovedUpcomingByDatePaginated = query({
  args: {
    fromDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate),
      )
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await sanitizePublicEventPage(ctx, result.page),
    };
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

    const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, [
      ...featured,
      ...free,
      ...promoted,
      ...tonight,
      ...weekend,
    ]);
    const sanitizeGroup = (events: Doc<"events">[]) =>
      events.map((event) => sanitizePublicEventWithVenueIds(event, publicVenueIds));

    return {
      featured: sanitizeGroup(featured),
      free: sanitizeGroup(free),
      promoted: sanitizeGroup(promoted),
      tonight: sanitizeGroup(tonight),
      weekend: sanitizeGroup(weekend),
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
    timeSource: v.optional(eventTimeSource),
    timeEvidenceText: v.optional(v.union(v.string(), v.null())),
    timeConfidence: v.optional(v.number()),
    timeStatus: v.optional(eventTimeStatus),
    venue: v.string(),
    artists: v.array(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    instagramPostUrl: v.optional(v.string()),
    instagramPostId: v.optional(v.string()),
    ticketPrice: v.optional(v.string()),
    eventType: v.string(),
    sourceCaption: v.optional(v.string()),
    sourcePostedAt: v.optional(v.string()),
    rawExtractionJson: v.optional(v.string()),
    normalizedFieldsJson: v.optional(v.string()),
    sourceOccurrenceKey: v.optional(v.string()),
    promotionTier: v.optional(promotionTier),
    promotionStart: v.optional(v.string()),
    promotionEnd: v.optional(v.string()),
    promotionPriority: v.optional(v.number()),
    status: v.optional(eventStatus),
    returnCreateDisposition: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const {
      serviceSecret: _serviceSecret,
      returnCreateDisposition,
      ...eventArgs
    } = args;
    if (eventArgs.sourceOccurrenceKey) {
      const existingOccurrence = await ctx.db
        .query("events")
        .withIndex("by_sourceOccurrenceKey", (q) =>
          q.eq("sourceOccurrenceKey", eventArgs.sourceOccurrenceKey),
        )
        .unique();
      if (existingOccurrence) {
        return returnCreateDisposition
          ? { eventId: existingOccurrence._id, created: false }
          : existingOccurrence._id;
      }
    }
    const venueFields = await resolveVenueDenormalizedFields(ctx, eventArgs.venue);
    if (kind === "service") {
      if (eventArgs.status === "approved" && !venueFields.venueInstagramHandle) {
        throw new Error(
          "Service-authenticated event creation cannot approve an event without a resolved source venue handle.",
        );
      }
      assertServiceCreateEventPolicy(args.status, args.normalizedFieldsJson, {
        ...eventArgs,
        ...venueFields,
      });
      if (eventArgs.status === "approved") {
        await assertPersistedServiceSourcePolicy(ctx, { ...eventArgs, ...venueFields });
      }
    }
    void _serviceSecret;
    const now = Date.now();
    assertPublicEventImageWrite(eventArgs.imageUrl, eventArgs.imageStorageId);
    if (eventArgs.status === "approved") {
      await assertApprovalCandidatePolicy(ctx, { ...eventArgs, ...venueFields });
    }
    const normalizedEventArgs = normalizeEventTimeWritePatch(eventArgs);
    const eventId = await ctx.db.insert("events", {
      ...normalizedEventArgs,
      ...(eventArgs.instagramPostUrl
        ? { normalizedInstagramPostUrl: normalizeInstagramPostUrl(eventArgs.instagramPostUrl) }
        : {}),
      ...venueFields,
      eventType: canonicalizeEventType(eventArgs.eventType),
      status: eventArgs.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    });

    await writeEventAuditLog(ctx, eventId, "created", {
      actor,
      patch: normalizedEventArgs,
    });

    return returnCreateDisposition
      ? { eventId, created: true }
      : eventId;
  },
});

export const updateEvent = mutation({
  args: {
    id: v.id("events"),
    patch: v.object({
      title: v.optional(v.string()),
      date: v.optional(v.string()),
      time: v.optional(v.string()),
      timeSource: v.optional(eventTimeSource),
      timeEvidenceText: v.optional(v.union(v.string(), v.null())),
      timeConfidence: v.optional(v.number()),
      timeStatus: v.optional(eventTimeStatus),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      imageStorageId: v.optional(v.id("_storage")),
      instagramPostUrl: v.optional(v.string()),
      instagramPostId: v.optional(v.string()),
      ticketPrice: v.optional(v.string()),
      clearTicketPrice: v.optional(v.boolean()),
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
    expectedStatus: v.optional(eventStatus),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }
    assertExpectedEventStatus(existingEvent.status, args.expectedStatus);

    const now = Date.now();
    const { clearTicketPrice, ...eventPatch } = args.patch;
    if (clearTicketPrice && eventPatch.ticketPrice !== undefined) {
      throw new Error("ticketPrice and clearTicketPrice cannot be used together.");
    }
    const venueFields =
      eventPatch.venue !== undefined
        ? await resolveVenueDenormalizedFields(ctx, eventPatch.venue)
        : {};
    const nextImageStorageId =
      eventPatch.imageStorageId ??
      (eventPatch.imageUrl !== undefined && eventPatch.imageUrl === existingEvent.imageUrl
        ? existingEvent.imageStorageId
        : undefined);
    assertPublicEventImageWrite(eventPatch.imageUrl, nextImageStorageId);
    const imagePairPatch =
      eventPatch.imageUrl !== undefined
        ? {
            imageUrl: eventPatch.imageUrl,
            imageStorageId: nextImageStorageId,
          }
        : {};
    const patch = {
      ...normalizeEventTimeWritePatch(eventPatch),
      ...(clearTicketPrice ? { ticketPrice: undefined } : {}),
      ...imagePairPatch,
      ...venueFields,
      ...(eventPatch.instagramPostUrl !== undefined
        ? {
            normalizedInstagramPostUrl: normalizeInstagramPostUrl(eventPatch.instagramPostUrl),
          }
        : {}),
      ...(eventPatch.eventType !== undefined
        ? { eventType: canonicalizeEventType(eventPatch.eventType) }
        : {}),
    };
    const effectiveEvent = { ...existingEvent, ...patch };
    if (kind === "service") {
      if (patch.status === "approved" && !effectiveEvent.venueInstagramHandle) {
        throw new Error(
          "Service-authenticated event updates cannot approve an event without a resolved source venue handle.",
        );
      }
      assertServiceUpdateEventPolicy(existingEvent.status, patch, existingEvent);
      if (patch.status === "approved") {
        await assertPersistedServiceSourcePolicy(ctx, effectiveEvent);
      }
    }
    if (effectiveEvent.status === "approved") {
      await assertApprovalCandidatePolicy(
        ctx,
        {
          title: effectiveEvent.title,
          date: effectiveEvent.date,
          venue: effectiveEvent.venue,
          venueId: effectiveEvent.venueId,
          venueInstagramHandle: effectiveEvent.venueInstagramHandle,
          instagramPostId: effectiveEvent.instagramPostId,
          instagramPostUrl: effectiveEvent.instagramPostUrl,
        },
        [args.id],
      );
    }
    await ctx.db.patch(args.id, { ...patch, updatedAt: now });
    const auditPatch = clearTicketPrice
      ? { ...patch, clearTicketPrice: true }
      : patch;
    await writeEventAuditLog(ctx, args.id, "updated", {
      actor,
      patch: auditPatch,
    });
  },
});

export const reprocessPendingSourceGroundingBatch = mutation({
  args: {
    serviceSecret: v.string(),
    items: v.array(sourceGroundingReprocessItem),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (kind !== "service") {
      throw new Error("Service authentication required.");
    }
    if (args.items.length === 0) {
      throw new Error("Source-grounding reprocessing requires at least one event.");
    }
    if (args.items.length > MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE) {
      throw new Error(
        `Source-grounding reprocessing is limited to ${MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE} events.`,
      );
    }

    const eventIds = new Set<string>();
    const prepared: Array<{
      event: Doc<"events">;
      item: (typeof args.items)[number];
    }> = [];
    for (const item of args.items) {
      if (eventIds.has(item.id)) {
        throw new Error(`Duplicate source-grounding reprocess event ID: ${item.id}.`);
      }
      eventIds.add(item.id);
      if (!Number.isSafeInteger(item.expectedUpdatedAt)) {
        throw new Error(`Invalid expectedUpdatedAt for event ${item.id}.`);
      }
      if (item.nextNormalizedFieldsJson === item.expectedNormalizedFieldsJson) {
        throw new Error(`Source-grounding attestation did not change for event ${item.id}.`);
      }

      const event = await ctx.db.get(item.id);
      if (!event) {
        throw new Error(`Event not found: ${item.id}.`);
      }
      assertExpectedEventStatus(event.status, "pending");
      if (event.updatedAt !== item.expectedUpdatedAt) {
        throw new Error(`Event changed during reprocessing: ${item.id}.`);
      }
      if (event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson) {
        throw new Error(`Normalized fields changed during reprocessing: ${item.id}.`);
      }
      assertSourceGroundingReprocessReasons(event);
      prepared.push({ event, item });
    }

    const now = Date.now();
    for (const { event, item } of prepared) {
      if (!event.venueInstagramHandle) {
        throw new Error(`Resolved source venue handle required for event ${event._id}.`);
      }
      const policyPatch = {
        status: "approved" as const,
        normalizedFieldsJson: item.nextNormalizedFieldsJson,
      };
      assertServiceUpdateEventPolicy(event.status, policyPatch, event);
      await assertPersistedServiceSourcePolicy(ctx, event);
      await assertApprovalCandidatePolicy(ctx, event, [event._id]);
      await ctx.db.patch(event._id, {
        status: "approved",
        normalizedFieldsJson: item.nextNormalizedFieldsJson,
        updatedAt: now,
      });
      await writeEventAuditLog(ctx, event._id, "source_grounding_reprocessed", {
        actor,
        patch: policyPatch,
      });
    }

    return {
      updatedCount: prepared.length,
      eventIds: prepared.map(({ event }) => event._id),
    };
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

    if (args.status === "approved") {
      const venueFields = await resolveVenueDenormalizedFields(ctx, existingEvent.venue);
      await assertApprovalCandidatePolicy(
        ctx,
        {
          title: existingEvent.title,
          date: existingEvent.date,
          venue: existingEvent.venue,
          venueId: venueFields.venueId ?? existingEvent.venueId,
          venueInstagramHandle:
            venueFields.venueInstagramHandle ?? existingEvent.venueInstagramHandle,
          instagramPostId: existingEvent.instagramPostId,
          instagramPostUrl: existingEvent.instagramPostUrl,
        },
        [args.id],
      );
      await ctx.db.patch(args.id, venueFields);
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

      if (args.status === "approved") {
        try {
          const venueFields = await resolveVenueDenormalizedFields(ctx, existingEvent.venue);
          await assertApprovalCandidatePolicy(
            ctx,
            {
              title: existingEvent.title,
              date: existingEvent.date,
              venue: existingEvent.venue,
              venueId: venueFields.venueId ?? existingEvent.venueId,
              venueInstagramHandle:
                venueFields.venueInstagramHandle ?? existingEvent.venueInstagramHandle,
              instagramPostId: existingEvent.instagramPostId,
              instagramPostUrl: existingEvent.instagramPostUrl,
            },
            [id],
          );
          await ctx.db.patch(id, venueFields);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/^(?:Event title is not suitable for approval|An approved event already exists for this venue and date)\.$/.test(
              error.message,
            )
          ) {
            throw error;
          }
          skippedCount += 1;
          continue;
        }
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
      timeSource: v.optional(eventTimeSource),
      timeEvidenceText: v.optional(v.union(v.string(), v.null())),
      timeConfidence: v.optional(v.number()),
      timeStatus: v.optional(eventTimeStatus),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      imageStorageId: v.optional(v.id("_storage")),
      ticketPrice: v.optional(v.string()),
      eventType: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const primaryEvent = await ctx.db.get(args.primaryId);
    if (!primaryEvent) {
      throw new Error("Primary event not found.");
    }
    if (primaryEvent.status !== "approved") {
      throw new Error("Only approved events can be merged.");
    }
    if (kind === "service") {
      assertServiceUpdateEventPolicy(primaryEvent.status, args.patch);
    }

    const duplicateIds = [...new Set(args.duplicateIds)].filter((id) => id !== args.primaryId);
    const duplicateEvents: Doc<"events">[] = [];
    for (const duplicateId of duplicateIds) {
      const duplicateEvent = await ctx.db.get(duplicateId);
      if (!duplicateEvent) {
        throw new Error("Duplicate event not found.");
      }
      if (duplicateEvent.status !== "approved") {
        throw new Error("Only approved duplicate events can be removed.");
      }
      duplicateEvents.push(duplicateEvent);
    }

    const now = Date.now();
    if (Object.keys(args.patch).length > 0) {
      assertPublicEventImageWrite(args.patch.imageUrl, args.patch.imageStorageId);
      const venueFields =
        args.patch.venue !== undefined
          ? await resolveVenueDenormalizedFields(ctx, args.patch.venue)
          : {};
      const patch = {
        ...normalizeEventTimeWritePatch(args.patch),
        ...(args.patch.imageUrl !== undefined
          ? {
              imageUrl: args.patch.imageUrl,
              imageStorageId:
                args.patch.imageStorageId ??
                [primaryEvent, ...duplicateEvents].find(
                  (event) =>
                    event.imageUrl === args.patch.imageUrl && event.imageStorageId !== undefined,
                )?.imageStorageId,
            }
          : {}),
        ...venueFields,
        ...(args.patch.eventType !== undefined
          ? { eventType: canonicalizeEventType(args.patch.eventType) }
          : {}),
      };
      const effectiveEvent = { ...primaryEvent, ...patch };
      await assertApprovalCandidatePolicy(
        ctx,
        {
          title: effectiveEvent.title,
          date: effectiveEvent.date,
          venue: effectiveEvent.venue,
          venueId: effectiveEvent.venueId,
          venueInstagramHandle: effectiveEvent.venueInstagramHandle,
          instagramPostId: effectiveEvent.instagramPostId,
          instagramPostUrl: effectiveEvent.instagramPostUrl,
        },
        [args.primaryId, ...duplicateIds],
      );
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
