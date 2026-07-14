import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "@/lib/events/approved-event-duplicates";
import {
  getDisplayEventTime,
  resolveEventTimeProvenance,
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
  type EventTimeSource,
  type EventTimeStatus,
} from "@/lib/events/event-time";
import { sanitizeVenueLinkedPublicEventFields } from "@/lib/events/public-event-venue-fields";
import { sortPublicEventsByDateVenueTimeTitle } from "@/lib/events/public-event-sort";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
} from "@/lib/taxonomy/venue-types";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  normalizeHandle,
  toSearchableText,
} from "@/lib/pipeline/venue-normalization";
import { loadVenueNameOverridesByHandle } from "@/lib/pipeline/venue-name-overrides";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";

export type EventStatus = "pending" | "approved" | "rejected";
const APPROVED_EVENTS_SCAN_BATCH_SIZE = 100;
const PUBLIC_EVENTS_CACHE_MAX_ENTRIES = 48;
const PUBLIC_EVENTS_CACHE_TTL_MS = 60_000;
const PUBLIC_DUPLICATE_CLEANUP_MAX_PAIRWISE_EVENTS = 20;
const DEFAULT_PUBLIC_EVENTS_WINDOW_DAYS = 90;
const DEFAULT_PUBLIC_EVENTS_PAGE_SIZE = 50;
const MAX_PUBLIC_EVENTS_PAGE_SIZE = 100;

export type PublicEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  timeSource?: EventTimeSource;
  timeEvidenceText?: string;
  timeConfidence?: number;
  timeStatus?: EventTimeStatus;
  dayPeriod?: EventDayPeriod;
  displayTimeEnd?: string;
  displayTimeLabel?: string;
  displayTimeSource?: EventTimeDisplaySource;
  displayTimeStart?: string;
  venue: string;
  venueCategory?: string;
  venueHours?: VenueHoursCacheFields;
  venueId?: string;
  venueInstagramHandle?: string;
  venueLatitude?: number;
  venueLocation?: string;
  venueLongitude?: number;
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
  instagramHandle?: string;
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
  instagramHandle: string;
  category?: string | null;
  googlePlaceId?: string | null;
  hoursError?: string | null;
  hoursExpiresAt?: number | null;
  hoursFetchedAt?: number | null;
  hoursJson?: string | null;
  hoursSource?: "osm" | "google" | "manual" | "none" | null;
  hoursTimezone?: string | null;
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
  neighborhood?: string | null;
  osmElementId?: string | null;
  osmElementType?: string | null;
};

type PublicEventsCacheEntry = {
  expiresAt: number;
  promise: Promise<PublicEvent[]>;
};

type VenueLookup = {
  canonicalVenueNamesByHandle: Record<string, string>;
  publicVenueIds: Set<string>;
  venueNameOverridesByHandle: Record<string, string>;
  venuesByHandle: Map<string, VenueRecord>;
  venuesByName: Map<string, VenueRecord>;
};

const publicEventsCache = new Map<string, PublicEventsCacheEntry>();

type PaginatedEventsResponse = {
  page: PublicEvent[];
  continueCursor: string;
  isDone: boolean;
};

type LoadUpcomingApprovedEventsOptions = {
  daysInPast?: number;
  daysAhead?: number;
  fromDate?: string;
  beforeDate?: string;
};

const listPublicEventsWindowQuery =
  "events:listPublicEventsWindow" as unknown as FunctionReference<"query">;
const listPublicCalendarEventsWindowQuery =
  "events:listPublicCalendarEventsWindow" as unknown as FunctionReference<"query">;
const listPublicVenueFieldsByIdsQuery =
  "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;
const listPublicActiveVenueFieldsQuery =
  "venues:listPublicActiveVenueFields" as unknown as FunctionReference<"query">;

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

function addDaysToLocalDateKey(value: string, days: number): string {
  const parsed = parseNormalizedEventDate(value);
  if (!parsed) {
    return value;
  }
  parsed.setDate(parsed.getDate() + days);
  return formatLocalDate(parsed);
}

function normalizeVenueLookupKey(value: string): string {
  return toSearchableText(value);
}

function isRealVenueId(value: string | null | undefined): value is string {
  return Boolean(value && !value.startsWith("event:"));
}

function buildVenuesByHandle(venues: VenueRecord[]): Map<string, VenueRecord> {
  const venuesByHandle = new Map<string, VenueRecord>();

  for (const venue of venues) {
    const key = normalizeHandle(venue.instagramHandle);
    if (key && !venuesByHandle.has(key)) {
      venuesByHandle.set(key, venue);
    }
  }

  return venuesByHandle;
}

function buildVenuesByName(
  venues: VenueRecord[],
  venueNameOverridesByHandle: Record<string, string>,
): Map<string, VenueRecord> {
  const venuesByName = new Map<string, VenueRecord>();

  for (const venue of venues) {
    for (const name of [
      venue.name,
      venueNameOverridesByHandle[normalizeHandle(venue.instagramHandle)],
    ]) {
      const key = normalizeVenueLookupKey(name ?? "");
      if (key && !venuesByName.has(key)) {
        venuesByName.set(key, venue);
      }
    }
  }

  return venuesByName;
}

function createVenueRecordFromEvent(
  event: PublicEvent,
  publicVenueIds: Set<string>,
): VenueRecord | null {
  if (
    (isRealVenueId(event.venueId) && !publicVenueIds.has(event.venueId)) ||
    (!event.venueId && !event.venueCategory && !event.venueInstagramHandle)
  ) {
    return null;
  }

  return {
    _id:
      isRealVenueId(event.venueId) && publicVenueIds.has(event.venueId)
        ? event.venueId
        : `event:${event._id}`,
    name: event.venue,
    instagramHandle: event.venueInstagramHandle ?? event.instagramHandle ?? "",
    category: event.venueCategory ?? null,
    latitude: event.venueLatitude ?? null,
    location: event.venueLocation ?? null,
    longitude: event.venueLongitude ?? null,
  };
}

async function loadVenueLookup(
  convex: ConvexHttpClient,
  events: PublicEvent[],
  options: { includeActiveVenueDirectory?: boolean } = {},
): Promise<VenueLookup> {
  const includeActiveVenueDirectory = options.includeActiveVenueDirectory ?? true;
  const venueIds = [
    ...new Set(events.map((event) => event.venueId).filter(isRealVenueId)),
  ];
  const [activeVenues, venues] = await Promise.all([
    includeActiveVenueDirectory
      ? (convex.query(listPublicActiveVenueFieldsQuery, { limit: 1000 }) as Promise<
          VenueRecord[]
        >)
      : Promise.resolve([]),
    venueIds.length > 0
      ? (convex.query(listPublicVenueFieldsByIdsQuery, {
          ids: venueIds,
        }) as Promise<VenueRecord[]>)
      : Promise.resolve([]),
  ]);
  const publicVenueIds = new Set(
    [...activeVenues, ...venues].map((venue) => venue._id),
  );
  const denormalizedVenues = events
    .map((event) => createVenueRecordFromEvent(event, publicVenueIds))
    .filter((venue): venue is VenueRecord => venue !== null);
  const lookupVenues = [...activeVenues, ...venues, ...denormalizedVenues];
  let venueNameOverridesByHandle: Record<string, string> = {};
  try {
    venueNameOverridesByHandle = await loadVenueNameOverridesByHandle();
  } catch {
    venueNameOverridesByHandle = {};
  }
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(
    lookupVenues.filter((venue) => venue.instagramHandle),
  );
  return {
    canonicalVenueNamesByHandle,
    publicVenueIds,
    venueNameOverridesByHandle,
    venuesByHandle: buildVenuesByHandle(lookupVenues),
    venuesByName: buildVenuesByName(lookupVenues, venueNameOverridesByHandle),
  };
}

function normalizeDaysInPast(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(7, Math.trunc(value as number)));
}

function normalizeDaysAhead(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PUBLIC_EVENTS_WINDOW_DAYS;
  }

  return Math.max(1, Math.min(366, Math.trunc(value as number)));
}

function normalizePublicPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PUBLIC_EVENTS_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PUBLIC_EVENTS_PAGE_SIZE, Math.trunc(value as number)));
}

function normalizeDateBoundary(value: string | undefined): string | undefined {
  return value && parseNormalizedEventDate(value) ? value : undefined;
}

function prunePublicEventsCache(now = Date.now()): void {
  for (const [key, entry] of publicEventsCache) {
    if (entry.expiresAt <= now) {
      publicEventsCache.delete(key);
    }
  }

  while (publicEventsCache.size > PUBLIC_EVENTS_CACHE_MAX_ENTRIES) {
    const oldestKey = publicEventsCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    publicEventsCache.delete(oldestKey);
  }
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

function getExactSourceDuplicateKey(event: PublicEvent): string | null {
  if (event.instagramPostId) {
    return `post-id:${event.instagramPostId}`;
  }
  if (event.instagramPostUrl) {
    return `post-url:${event.instagramPostUrl.trim().toLowerCase().replace(/\/+$/, "")}`;
  }
  return null;
}

function hideExactSourceDuplicates(
  events: PublicEvent[],
  hiddenDuplicateIds: Set<string>,
): void {
  const seenSourceKeys = new Set<string>();

  for (const event of events) {
    const sourceKey = getExactSourceDuplicateKey(event);
    if (!sourceKey) {
      continue;
    }
    if (seenSourceKeys.has(sourceKey)) {
      hiddenDuplicateIds.add(event._id);
      continue;
    }
    seenSourceKeys.add(sourceKey);
  }
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
    hideExactSourceDuplicates(sameDateEvents, hiddenDuplicateIds);

    if (sameDateEvents.length < 2) {
      continue;
    }
    if (sameDateEvents.length > PUBLIC_DUPLICATE_CLEANUP_MAX_PAIRWISE_EVENTS) {
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
  venueLookup: VenueLookup,
): PublicEvent {
  const hasNonPublicLinkedVenue =
    isRealVenueId(event.venueId) && !venueLookup.publicVenueIds.has(event.venueId);
  const publicEvent = sanitizeVenueLinkedPublicEventFields(
    event,
    !hasNonPublicLinkedVenue,
  );
  const canonicalEventType = canonicalizeEventType(publicEvent.eventType);
  const canonicalVenueName = canonicalizeVenueName(
    publicEvent.venue,
    venueLookup.canonicalVenueNamesByHandle,
    {
      handleVenueNamesByHandle: venueLookup.venueNameOverridesByHandle,
    },
  );
  const venue = hasNonPublicLinkedVenue
    ? undefined
    : venueLookup.venuesByHandle.get(
        normalizeHandle(publicEvent.venueInstagramHandle ?? ""),
      ) ??
      venueLookup.venuesByName.get(normalizeVenueLookupKey(publicEvent.venue)) ??
      (canonicalVenueName
        ? venueLookup.venuesByName.get(normalizeVenueLookupKey(canonicalVenueName))
        : undefined);
  const venueId =
    isRealVenueId(publicEvent.venueId) && venueLookup.publicVenueIds.has(publicEvent.venueId)
      ? publicEvent.venueId
      : isRealVenueId(venue?._id) && venueLookup.publicVenueIds.has(venue._id)
        ? venue._id
        : undefined;
  const venueCategory = venue?.category ?? undefined;
  const eventVenueCategory = publicEvent.venueCategory ?? undefined;
  const eventType =
    canonicalEventType === DEFAULT_EVENT_TYPE
      ? eventTypeFromVenueCategory(venueCategory ?? eventVenueCategory)
      : canonicalEventType;
  const time = getDisplayEventTime(publicEvent.time);
  const timeProvenance = resolveEventTimeProvenance(publicEvent);
  const displayTime = resolveEventTimeDisplay({
    date: publicEvent.date,
    time: publicEvent.time,
    venueHours: venue,
  });

  return {
    ...publicEvent,
    venueId,
    ...(time ? { time } : { time: undefined }),
    timeSource: timeProvenance.source,
    ...(timeProvenance.evidenceText
      ? { timeEvidenceText: timeProvenance.evidenceText }
      : { timeEvidenceText: undefined }),
    timeConfidence: timeProvenance.confidence,
    timeStatus: timeProvenance.status,
    dayPeriod: displayTime.dayPeriod,
    ...(displayTime.endLabel ? { displayTimeEnd: displayTime.endLabel } : {}),
    displayTimeLabel: displayTime.label,
    displayTimeSource: displayTime.source,
    ...(displayTime.startLabel ? { displayTimeStart: displayTime.startLabel } : {}),
    eventType,
    ...(venue?.instagramHandle || publicEvent.venueInstagramHandle
      ? { instagramHandle: venue?.instagramHandle || publicEvent.venueInstagramHandle }
      : {}),
    ...(venue?.category || publicEvent.venueCategory
      ? { venueCategory: venue?.category ?? publicEvent.venueCategory }
      : {}),
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
        }
      : {}),
  };
}

async function queryPublicEventsWindowPage(options: {
  convex: ConvexHttpClient;
  cursor?: string | null;
  pageSize?: number;
  fromDate: string;
  beforeDate: string;
}): Promise<PaginatedEventsResponse> {
  return (await options.convex.query(listPublicEventsWindowQuery, {
    fromDate: options.fromDate,
    beforeDate: options.beforeDate,
    paginationOpts: {
      cursor: options.cursor ?? null,
      numItems: normalizePublicPageSize(options.pageSize),
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
  const resolvedBeforeDate =
    beforeDate ?? addDaysToLocalDateKey(fromDate, DEFAULT_PUBLIC_EVENTS_WINDOW_DAYS);

  while (true) {
    const page = await queryPublicEventsWindowPage({
      cursor,
      fromDate,
      beforeDate: resolvedBeforeDate,
      pageSize: APPROVED_EVENTS_SCAN_BATCH_SIZE,
      convex,
    });
    events.push(...page.page);

    if (page.isDone) {
      break;
    }

    cursor = page.continueCursor;
  }

  const venueLookup = await loadVenueLookup(convex, events);
  return sortPublicEventsByDateVenueTimeTitle(
    filterDuplicatePublicEvents(events).map((event) =>
      normalizePublicEvent(event, venueLookup),
    ),
  );
}

async function loadAllPublicCalendarEventsWindow(
  convex: ConvexHttpClient,
  fromDate: string,
  beforeDate: string,
): Promise<PublicEvent[]> {
  const events = (await convex.query(listPublicCalendarEventsWindowQuery, {
    beforeDate,
    fromDate,
  })) as PublicEvent[];
  const venueLookup = await loadVenueLookup(convex, events, {
    includeActiveVenueDirectory: false,
  });

  return sortPublicEventsByDateVenueTimeTitle(
    filterDuplicatePublicEvents(events).map((event) =>
      normalizePublicEvent(event, venueLookup),
    ),
  );
}

function getCachedPublicCalendarEventsWindow(
  convex: ConvexHttpClient,
  fromDate: string,
  beforeDate: string,
): Promise<PublicEvent[]> {
  const now = Date.now();
  prunePublicEventsCache(now);
  const cacheKey = `calendar:${fromDate}:${beforeDate}`;
  const cached = publicEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    publicEventsCache.delete(cacheKey);
    publicEventsCache.set(cacheKey, cached);
    return cached.promise;
  }

  const promise = loadAllPublicCalendarEventsWindow(convex, fromDate, beforeDate).catch((error) => {
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
  prunePublicEventsCache(now);

  return promise;
}

export async function loadPublicCalendarEventsWindow(options: {
  beforeDate?: string;
  fromDate?: string;
}): Promise<{
  events: PublicEvent[];
  error?: string;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const fromDate = normalizeDateBoundary(options.fromDate);
  const beforeDate = normalizeDateBoundary(options.beforeDate);

  if (!convexUrl) {
    return { events: [], error: "Convex is not configured yet." };
  }

  if (!fromDate || !beforeDate) {
    return { events: [], error: "Calendar event window requires valid date boundaries." };
  }

  if (fromDate >= beforeDate) {
    return { events: [] };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const events = await getCachedPublicCalendarEventsWindow(convex, fromDate, beforeDate);
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

export async function loadPublicEventsWindowPage(options: {
  beforeDate?: string;
  cursor?: string | null;
  daysAhead?: number;
  daysInPast?: number;
  fromDate?: string;
  pageSize?: number;
} = {}): Promise<{
  events: PublicEvent[];
  continueCursor: string;
  isDone: boolean;
  error?: string;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const fromDate =
    normalizeDateBoundary(options.fromDate) ??
    formatLocalDate(getStartOfLocalDay(normalizeDaysInPast(options.daysInPast)));
  const beforeDate =
    normalizeDateBoundary(options.beforeDate) ??
    addDaysToLocalDateKey(fromDate, normalizeDaysAhead(options.daysAhead));

  if (!convexUrl) {
    return {
      events: [],
      continueCursor: options.cursor ?? "",
      isDone: true,
      error: "Convex is not configured yet.",
    };
  }

  if (fromDate >= beforeDate) {
    return {
      events: [],
      continueCursor: options.cursor ?? "",
      isDone: true,
    };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const page = await queryPublicEventsWindowPage({
      convex,
      cursor: options.cursor ?? null,
      fromDate,
      beforeDate,
      pageSize: options.pageSize,
    });
    const venueLookup = await loadVenueLookup(convex, page.page);
    const events = sortPublicEventsByDateVenueTimeTitle(
      filterDuplicatePublicEvents(page.page).map((event) =>
        normalizePublicEvent(event, venueLookup),
      ),
    );
    return {
      events,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  } catch (error) {
    return {
      events: [],
      continueCursor: options.cursor ?? "",
      isDone: true,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load approved events.",
    };
  }
}

function getCachedApprovedUpcomingEvents(
  convex: ConvexHttpClient,
  fromDate: string,
  beforeDate?: string,
): Promise<PublicEvent[]> {
  const now = Date.now();
  prunePublicEventsCache(now);
  const cacheKey = `${fromDate}:${beforeDate ?? ""}`;
  const cached = publicEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    publicEventsCache.delete(cacheKey);
    publicEventsCache.set(cacheKey, cached);
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
  prunePublicEventsCache(now);

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
  const beforeDate =
    normalizeDateBoundary(options.beforeDate) ??
    addDaysToLocalDateKey(fromDate, normalizeDaysAhead(options.daysAhead));
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
