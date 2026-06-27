import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  getDisplayEventTime,
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
} from "@/lib/events/event-time";
import {
  loadUpcomingApprovedEvents,
  type PublicEvent,
} from "@/lib/events/public-events";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
} from "@/lib/taxonomy/venue-types";
import type { VenueHoursCacheFields, VenueHoursSource } from "@/lib/venues/venue-hours-cache";

const DEFAULT_RECENT_INSTAGRAM_POST_LIMIT = 6;
const PUBLIC_VENUE_FALLBACK_UPCOMING_DAYS = 366;

const getPublicVenuePageQuery =
  "venues:getPublicVenuePage" as unknown as FunctionReference<"query">;
const listPublicVenueDirectoryQuery =
  "venues:listPublicVenueDirectory" as unknown as FunctionReference<"query">;
const listPublicRecentPostsByHandleQuery =
  "scrapedPosts:listPublicRecentPostsByHandle" as unknown as FunctionReference<"query">;

export type PublicVenue = VenueHoursCacheFields & {
  _id: string;
  category?: string | null;
  instagramFollowerCount?: number | null;
  instagramFollowerCountUpdatedAt?: number | null;
  instagramHandle: string;
  instagramProfileUrl?: string | null;
  isActive: boolean;
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
  name: string;
  neighborhood?: string | null;
  updatedAt?: number | null;
};

export type PublicVenueDirectoryItem = PublicVenue & {
  upcomingEventCount: number;
};

export type PublicVenueEvent = {
  _id: string;
  artists: string[];
  date: string;
  dayPeriod?: EventDayPeriod;
  description?: string;
  displayTimeEnd?: string;
  displayTimeLabel?: string;
  displayTimeSource?: EventTimeDisplaySource;
  displayTimeStart?: string;
  eventType: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  ticketPrice?: string;
  time?: string;
  title: string;
  venue: string;
  venueCategory?: string;
  venueHours?: VenueHoursCacheFields;
  venueId?: string;
};

export type PublicVenueStats = {
  appFollowerCount: number;
  approvedEventCount: number;
  approvedHistoryCount: number;
  approvedUpcomingCount: number;
  recentApprovedCount: number;
  recentWindowDays: number;
};

export type PublicInstagramPost = {
  _id: string;
  imageUrl?: string | null;
  instagramPostUrl: string;
  locationName?: string | null;
  postType?: string | null;
  postedAt?: string | null;
  postedAtMs?: number | null;
};

type RawPublicVenuePageResponse = {
  venue: PublicVenue;
  upcomingEvents: PublicVenueEvent[];
  historyEvents: PublicVenueEvent[];
  stats: PublicVenueStats;
} | null;

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function getPublicVenueTodayKey(): string {
  return formatLocalDateKey(new Date());
}

function venueHoursFromVenue(venue: PublicVenue): VenueHoursCacheFields {
  return {
    googlePlaceId: venue.googlePlaceId ?? null,
    hoursError: venue.hoursError ?? null,
    hoursExpiresAt: venue.hoursExpiresAt ?? null,
    hoursFetchedAt: venue.hoursFetchedAt ?? null,
    hoursJson: venue.hoursJson ?? null,
    hoursSource: (venue.hoursSource ?? null) as VenueHoursSource | null,
    hoursTimezone: venue.hoursTimezone ?? null,
    osmElementId: venue.osmElementId ?? null,
    osmElementType: venue.osmElementType ?? null,
  };
}

function normalizeVenueEvent(event: PublicVenueEvent, venue: PublicVenue): PublicVenueEvent {
  const venueHours = venueHoursFromVenue(venue);
  const canonicalEventType = canonicalizeEventType(event.eventType);
  const displayTime = resolveEventTimeDisplay({
    date: event.date,
    time: event.time,
    venueHours,
  });

  return {
    ...event,
    dayPeriod: displayTime.dayPeriod,
    displayTimeEnd: displayTime.endLabel,
    displayTimeLabel: displayTime.label,
    displayTimeSource: displayTime.source,
    displayTimeStart: displayTime.startLabel,
    eventType:
      canonicalEventType === DEFAULT_EVENT_TYPE
        ? eventTypeFromVenueCategory(venue.category ?? event.venueCategory)
        : canonicalEventType,
    time: getDisplayEventTime(event.time) ?? undefined,
    venueCategory: venue.category ?? event.venueCategory,
    venueHours,
    venueId: event.venueId ?? venue._id,
  };
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLocaleLowerCase();
}

function compareVenueEvents(left: PublicVenueEvent, right: PublicVenueEvent): number {
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

function eventMatchesVenue(event: PublicEvent, venue: PublicVenue): boolean {
  if (event.venueId === venue._id) {
    return true;
  }

  const eventHandle = normalizeHandle(event.venueInstagramHandle ?? event.instagramHandle ?? "");
  const venueHandle = normalizeHandle(venue.instagramHandle);
  if (eventHandle && venueHandle && eventHandle === venueHandle) {
    return true;
  }

  const eventVenue = toSearchableText(event.venue);
  const venueName = toSearchableText(venue.name);
  return Boolean(eventVenue && venueName && eventVenue === venueName);
}

function publicEventToVenueEvent(event: PublicEvent, venue: PublicVenue): PublicVenueEvent {
  return normalizeVenueEvent(
    {
      _id: event._id,
      artists: event.artists,
      date: event.date,
      description: event.description,
      displayTimeEnd: event.displayTimeEnd,
      displayTimeLabel: event.displayTimeLabel,
      displayTimeSource: event.displayTimeSource,
      displayTimeStart: event.displayTimeStart,
      eventType: event.eventType,
      imageUrl: event.imageUrl,
      instagramPostUrl: event.instagramPostUrl,
      ticketPrice: event.ticketPrice,
      time: event.time,
      title: event.title,
      venue: event.venue,
      venueCategory: event.venueCategory,
      venueId: event.venueId,
    },
    venue,
  );
}

function mergeUniqueVenueEvents(events: PublicVenueEvent[]): PublicVenueEvent[] {
  const eventsById = new Map<string, PublicVenueEvent>();
  for (const event of events) {
    eventsById.set(event._id, event);
  }
  return [...eventsById.values()];
}

async function loadFallbackUpcomingVenueEvents(options: {
  limit: number | undefined;
  today: string;
  venue: PublicVenue;
}): Promise<PublicVenueEvent[]> {
  const result = await loadUpcomingApprovedEvents({
    daysAhead: PUBLIC_VENUE_FALLBACK_UPCOMING_DAYS,
    fromDate: options.today,
  });
  if (result.events.length === 0) {
    return [];
  }

  return result.events
    .filter((event) => eventMatchesVenue(event, options.venue))
    .map((event) => publicEventToVenueEvent(event, options.venue))
    .sort(compareVenueEvents)
    .slice(0, options.limit);
}

function mergeVenueStats(
  stats: PublicVenueStats,
  pageUpcomingEvents: PublicVenueEvent[],
  pageHistoryEvents: PublicVenueEvent[],
  fallbackUpcomingEvents: PublicVenueEvent[],
  today: string,
): PublicVenueStats {
  const mergedEvents = mergeUniqueVenueEvents([
    ...pageUpcomingEvents,
    ...pageHistoryEvents,
    ...fallbackUpcomingEvents,
  ]);
  const approvedUpcomingCount = mergedEvents.filter((event) => event.date >= today).length;
  const approvedHistoryCount = mergedEvents.filter((event) => event.date < today).length;

  return {
    ...stats,
    approvedEventCount: Math.max(stats.approvedEventCount, mergedEvents.length),
    approvedHistoryCount: Math.max(stats.approvedHistoryCount, approvedHistoryCount),
    approvedUpcomingCount: Math.max(stats.approvedUpcomingCount, approvedUpcomingCount),
  };
}

async function loadRecentInstagramPosts(
  convex: ConvexHttpClient,
  handle: string,
): Promise<PublicInstagramPost[]> {
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedHandle) {
    return [];
  }

  try {
    return (await convex.query(listPublicRecentPostsByHandleQuery, {
      handle: normalizedHandle,
      limit: DEFAULT_RECENT_INSTAGRAM_POST_LIMIT,
    })) as PublicInstagramPost[];
  } catch {
    return [];
  }
}

export async function loadPublicVenuePage(
  venueId: string,
  options: {
    historyLimit?: number;
    today?: string;
    upcomingLimit?: number;
  } = {},
): Promise<{
  error?: string;
  historyEvents: PublicVenueEvent[];
  recentInstagramPosts: PublicInstagramPost[];
  stats: PublicVenueStats | null;
  upcomingEvents: PublicVenueEvent[];
  venue: PublicVenue | null;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return {
      venue: null,
      upcomingEvents: [],
      historyEvents: [],
      recentInstagramPosts: [],
      stats: null,
      error: "Convex is not configured yet.",
    };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const today = options.today ?? getPublicVenueTodayKey();
    const page = (await convex.query(getPublicVenuePageQuery, {
      id: venueId,
      historyLimit: options.historyLimit,
      today,
      upcomingLimit: options.upcomingLimit,
    })) as RawPublicVenuePageResponse;

    if (!page) {
      return {
        venue: null,
        upcomingEvents: [],
        historyEvents: [],
        recentInstagramPosts: [],
        stats: null,
      };
    }

    const pageUpcomingEvents = page.upcomingEvents.map((event) =>
      normalizeVenueEvent(event, page.venue),
    );
    const pageHistoryEvents = page.historyEvents.map((event) =>
      normalizeVenueEvent(event, page.venue),
    );
    const fallbackUpcomingEvents = await loadFallbackUpcomingVenueEvents({
      limit: options.upcomingLimit,
      today,
      venue: page.venue,
    });
    const upcomingEvents = mergeUniqueVenueEvents([
      ...pageUpcomingEvents,
      ...fallbackUpcomingEvents,
    ])
      .sort(compareVenueEvents)
      .slice(0, options.upcomingLimit);

    return {
      venue: page.venue,
      upcomingEvents,
      historyEvents: pageHistoryEvents,
      recentInstagramPosts: await loadRecentInstagramPosts(
        convex,
        page.venue.instagramHandle,
      ),
      stats: mergeVenueStats(
        page.stats,
        pageUpcomingEvents,
        pageHistoryEvents,
        fallbackUpcomingEvents,
        today,
      ),
    };
  } catch (error) {
    return {
      venue: null,
      upcomingEvents: [],
      historyEvents: [],
      recentInstagramPosts: [],
      stats: null,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load this venue.",
    };
  }
}

export async function loadPublicVenueDirectory(options: {
  limit?: number;
  today?: string;
} = {}): Promise<{
  error?: string;
  venues: PublicVenueDirectoryItem[];
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return { venues: [], error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const venues = (await convex.query(listPublicVenueDirectoryQuery, {
      limit: options.limit,
      today: options.today ?? getPublicVenueTodayKey(),
    })) as PublicVenueDirectoryItem[];
    return { venues };
  } catch (error) {
    return {
      venues: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to load venues.",
    };
  }
}
