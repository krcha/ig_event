import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "@/lib/events/approved-event-duplicates";
import {
  getDisplayEventTime,
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
} from "@/lib/events/event-time";
import { sortPublicEventsByDateVenueTimeTitle } from "@/lib/events/public-event-sort";
import { matchesPublicEventNameArtistOrVenue } from "@/lib/events/public-event-search";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
} from "@/lib/taxonomy/venue-types";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";

export type EventStatus = "pending" | "approved" | "rejected";
const DEFAULT_PUBLIC_EVENTS_PAGE_SIZE = 24;
const APPROVED_EVENTS_SCAN_BATCH_SIZE = 100;
const PUBLIC_EVENTS_CACHE_TTL_MS = 60_000;

export type PublicEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  dayPeriod?: EventDayPeriod;
  displayTimeEnd?: string;
  displayTimeLabel?: string;
  displayTimeSource?: EventTimeDisplaySource;
  displayTimeStart?: string;
  venue: string;
  venueCategory?: string;
  venueHours?: VenueHoursCacheFields;
  venueId?: string;
  artists: string[];
  eventType: string;
  ticketPrice?: string;
  attendance?: number | string;
  attendanceCount?: number | string;
  attendeeCount?: number | string;
  attendees?: number | string;
  attendeesCount?: number | string;
  going?: number | string;
  goingCount?: number | string;
  sourcePostedAt?: string;
  sourceCaption?: string;
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
  createdAt: number;
  updatedAt: number;
};

type VenueRecord = {
  _id: string;
  name: string;
  category?: string | null;
  googlePlaceId?: string | null;
  hoursError?: string | null;
  hoursExpiresAt?: number | null;
  hoursFetchedAt?: number | null;
  hoursJson?: string | null;
  hoursSource?: "osm" | "google" | "manual" | "none" | null;
  hoursTimezone?: string | null;
  osmElementId?: string | null;
  osmElementType?: string | null;
};

type PublicEventsCacheEntry = {
  expiresAt: number;
  promise: Promise<PublicEvent[]>;
};

const publicEventsCache = new Map<string, PublicEventsCacheEntry>();

type PaginatedEventsResponse = {
  page: PublicEvent[];
  continueCursor: string;
  isDone: boolean;
};

export type PublicEventsPageResult = {
  events: PublicEvent[];
  page: number;
  pageSize: number;
  searchQuery: string;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  error?: string;
};

type LoadUpcomingApprovedEventsOptions = {
  daysInPast?: number;
  fromDate?: string;
  beforeDate?: string;
};

type LoadUpcomingApprovedEventsPageOptions = {
  page?: number;
  pageSize?: number;
  searchQuery?: string;
};

const listApprovedUpcomingByDatePaginatedQuery =
  "events:listApprovedUpcomingByDatePaginated" as unknown as FunctionReference<"query">;
const listVenuesQuery = "venues:listVenues" as unknown as FunctionReference<"query">;

export function parseNormalizedEventDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

export function getStartOfLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getStartOfLocalDay(daysInPast = 0): Date {
  const date = getStartOfLocalToday();
  date.setDate(date.getDate() - daysInPast);
  return date;
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function normalizeVenueLookupKey(value: string): string {
  return toSearchableText(value);
}

function buildVenuesByName(venues: VenueRecord[]): Map<string, VenueRecord> {
  const venuesByName = new Map<string, VenueRecord>();

  for (const venue of venues) {
    const key = normalizeVenueLookupKey(venue.name);
    if (key && !venuesByName.has(key)) {
      venuesByName.set(key, venue);
    }
  }

  return venuesByName;
}

async function loadVenueLookupByName(convex: ConvexHttpClient): Promise<Map<string, VenueRecord>> {
  const venues = (await convex.query(listVenuesQuery, {})) as VenueRecord[];
  return buildVenuesByName(venues);
}

function normalizeDaysInPast(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(7, Math.trunc(value as number)));
}

function normalizePublicEventsPage(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.trunc(value as number));
}

function normalizePublicEventsPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PUBLIC_EVENTS_PAGE_SIZE;
  }
  return Math.max(1, Math.min(100, Math.trunc(value as number)));
}

function normalizeSearchQuery(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeDateBoundary(value: string | undefined): string | undefined {
  return value && parseNormalizedEventDate(value) ? value : undefined;
}

function matchesPublicEventSearch(event: PublicEvent, searchQuery: string): boolean {
  return matchesPublicEventNameArtistOrVenue(event, searchQuery);
}

function mapPublicEventToDuplicateRecord(event: PublicEvent): ApprovedEventDuplicateRecord {
  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    artists: event.artists,
    description: event.description ?? null,
    imageUrl: event.imageUrl ?? null,
    instagramPostUrl: event.instagramPostUrl ?? null,
    instagramPostId: event.instagramPostId ?? null,
    ticketPrice: event.ticketPrice ?? null,
    eventType: event.eventType,
    sourceCaption: event.sourceCaption ?? null,
    sourcePostedAt: event.sourcePostedAt ?? null,
    normalizedFieldsJson: event.normalizedFieldsJson ?? null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function filterDuplicatePublicEvents(events: PublicEvent[]): PublicEvent[] {
  const eventsByDate = new Map<string, PublicEvent[]>();

  for (const event of events) {
    const sameDateEvents = eventsByDate.get(event.date) ?? [];
    sameDateEvents.push(event);
    eventsByDate.set(event.date, sameDateEvents);
  }

  const hiddenDuplicateIds = new Set<string>();

  for (const sameDateEvents of eventsByDate.values()) {
    if (sameDateEvents.length < 2) {
      continue;
    }

    const cleanupGroups = buildApprovedEventAutoCleanupGroups(
      sameDateEvents.map(mapPublicEventToDuplicateRecord),
    );

    for (const group of cleanupGroups) {
      for (const duplicateId of group.duplicateEventIds) {
        hiddenDuplicateIds.add(duplicateId);
      }
    }
  }

  if (hiddenDuplicateIds.size === 0) {
    return events;
  }

  return events.filter((event) => !hiddenDuplicateIds.has(event._id));
}

function normalizePublicEvent(
  event: PublicEvent,
  venuesByName: Map<string, VenueRecord>,
): PublicEvent {
  const canonicalEventType = canonicalizeEventType(event.eventType);
  const venue = venuesByName.get(normalizeVenueLookupKey(event.venue));
  const venueCategory = venue?.category ?? undefined;
  const eventType =
    canonicalEventType === DEFAULT_EVENT_TYPE
      ? eventTypeFromVenueCategory(venueCategory)
      : canonicalEventType;
  const time = getDisplayEventTime(event.time);
  const displayTime = resolveEventTimeDisplay({
    date: event.date,
    time: event.time,
    venueHours: venue,
  });

  return {
    ...event,
    ...(time ? { time } : { time: undefined }),
    dayPeriod: displayTime.dayPeriod,
    ...(displayTime.endLabel ? { displayTimeEnd: displayTime.endLabel } : {}),
    displayTimeLabel: displayTime.label,
    displayTimeSource: displayTime.source,
    ...(displayTime.startLabel ? { displayTimeStart: displayTime.startLabel } : {}),
    eventType,
    ...(venue?.category ? { venueCategory: venue.category } : {}),
    ...(venue
      ? {
          venueHours: {
            googlePlaceId: venue.googlePlaceId ?? null,
            hoursError: venue.hoursError ?? null,
            hoursExpiresAt: venue.hoursExpiresAt ?? null,
            hoursFetchedAt: venue.hoursFetchedAt ?? null,
            hoursJson: venue.hoursJson ?? null,
            hoursSource: venue.hoursSource ?? null,
            hoursTimezone: venue.hoursTimezone ?? null,
            osmElementId: venue.osmElementId ?? null,
            osmElementType: venue.osmElementType ?? null,
          },
          venueId: venue._id,
        }
      : {}),
  };
}

async function loadApprovedUpcomingEventPage(
  convex: ConvexHttpClient,
  cursor: string | null,
  numItems: number,
  fromDate: string,
): Promise<PaginatedEventsResponse> {
  return (await convex.query(listApprovedUpcomingByDatePaginatedQuery, {
    fromDate,
    paginationOpts: {
      cursor,
      numItems,
    },
  })) as PaginatedEventsResponse;
}

async function loadAllApprovedUpcomingEvents(
  convex: ConvexHttpClient,
  fromDate: string,
  beforeDate: string | undefined,
): Promise<PublicEvent[]> {
  const events: PublicEvent[] = [];
  let cursor: string | null = null;

  while (true) {
    const page = await loadApprovedUpcomingEventPage(
      convex,
      cursor,
      APPROVED_EVENTS_SCAN_BATCH_SIZE,
      fromDate,
    );
    const reachedBeforeDate = beforeDate
      ? page.page.some((event) => event.date >= beforeDate)
      : false;
    const pageEvents = beforeDate
      ? page.page.filter((event) => event.date < beforeDate)
      : page.page;
    events.push(...pageEvents);

    if (page.isDone || reachedBeforeDate) {
      break;
    }

    cursor = page.continueCursor;
  }

  const venuesByName = await loadVenueLookupByName(convex);
  return sortPublicEventsByDateVenueTimeTitle(
    filterDuplicatePublicEvents(events).map((event) =>
      normalizePublicEvent(event, venuesByName),
    ),
  );
}

function getCachedApprovedUpcomingEvents(
  convex: ConvexHttpClient,
  fromDate: string,
  beforeDate?: string,
): Promise<PublicEvent[]> {
  const now = Date.now();
  const cacheKey = `${fromDate}:${beforeDate ?? ""}`;
  const cached = publicEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = loadAllApprovedUpcomingEvents(convex, fromDate, beforeDate).catch((error) => {
    const current = publicEventsCache.get(cacheKey);
    if (current?.promise === promise) {
      publicEventsCache.delete(cacheKey);
    }
    throw error;
  });

  publicEventsCache.set(cacheKey, {
    expiresAt: now + PUBLIC_EVENTS_CACHE_TTL_MS,
    promise,
  });

  return promise;
}

export async function loadUpcomingApprovedEvents(
  options: LoadUpcomingApprovedEventsOptions = {},
): Promise<{
  events: PublicEvent[];
  error?: string;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const fromDate =
    normalizeDateBoundary(options.fromDate) ??
    formatLocalDate(getStartOfLocalDay(normalizeDaysInPast(options.daysInPast)));
  const beforeDate = normalizeDateBoundary(options.beforeDate);
  if (!convexUrl) {
    return { events: [], error: "Convex is not configured yet." };
  }

  if (beforeDate && fromDate >= beforeDate) {
    return { events: [] };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const events = await getCachedApprovedUpcomingEvents(convex, fromDate, beforeDate);
    return { events };
  } catch (error) {
    return {
      events: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to load approved events.",
    };
  }
}

export async function loadUpcomingApprovedEventsPage(
  options: LoadUpcomingApprovedEventsPageOptions = {},
): Promise<PublicEventsPageResult> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const page = normalizePublicEventsPage(options.page);
  const pageSize = normalizePublicEventsPageSize(options.pageSize);
  const searchQuery = normalizeSearchQuery(options.searchQuery);

  if (!convexUrl) {
    return {
      events: [],
      page,
      pageSize,
      searchQuery,
      hasPreviousPage: page > 1,
      hasNextPage: false,
      error: "Convex is not configured yet.",
    };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const allEvents = await getCachedApprovedUpcomingEvents(
      convex,
      formatLocalDate(getStartOfLocalToday()),
    );
    const matchingEvents = allEvents.filter((event) =>
      matchesPublicEventSearch(event, searchQuery),
    );
    const offset = (page - 1) * pageSize;
    const pageEvents = matchingEvents.slice(offset, offset + pageSize);
    const hasNextPage = offset + pageSize < matchingEvents.length;

    return {
      events: pageEvents,
      page,
      pageSize,
      searchQuery,
      hasPreviousPage: page > 1,
      hasNextPage,
    };
  } catch (error) {
    return {
      events: [],
      page,
      pageSize,
      searchQuery,
      hasPreviousPage: page > 1,
      hasNextPage: false,
      error:
        error instanceof Error ? error.message : "Failed to load approved events.",
    };
  }
}
