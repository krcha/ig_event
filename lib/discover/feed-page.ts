import "server-only";

import { createHash } from "node:crypto";
import type { DiscoverFeedEvent } from "@/components/discover/discover-feed";
import { enrichDiscoverEventsWithApifyPosts } from "@/lib/discover/apify-posts";
import { getDiscoverDisplayImageUrl } from "@/lib/discover/discover-image-source";
import { loadPublicCalendarEventsWindow, type PublicEvent } from "@/lib/events/public-events";
import { addDaysToDateKey } from "@/lib/events/nightlife-date";

export const DISCOVER_PAGE_SIZE = 9;

function mapPublicEvent(event: PublicEvent): DiscoverFeedEvent {
  const imageUrl = getDiscoverDisplayImageUrl(event, null);
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    eventType: event.eventType,
    ...(imageUrl ? { imageUrl } : {}),
    ...(event.imageStorageId ? { imageStorageId: event.imageStorageId } : {}),
    ...(event.instagramHandle ? { instagramHandle: event.instagramHandle } : {}),
    ...(event.instagramPostId ? { instagramPostId: event.instagramPostId } : {}),
    ...(event.instagramPostUrl ? { instagramPostUrl: event.instagramPostUrl } : {}),
    ...(event.sourceCaption ? { sourceCaption: event.sourceCaption } : {}),
    ...(event.sourcePostedAt ? { sourcePostedAt: event.sourcePostedAt } : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    title: event.title,
    venue: event.venue,
    ...(event.venueId ? { venueId: event.venueId } : {}),
  };
}

async function loadDiscoverDayEvents(date: string): Promise<{
  error?: string;
  events: PublicEvent[];
}> {
  const result = await loadPublicCalendarEventsWindow({
    beforeDate: addDaysToDateKey(date, 1),
    fromDate: date,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    events: result.events.filter((event) => event.date === date),
  };
}

async function enrichBatch(events: PublicEvent[]): Promise<DiscoverFeedEvent[]> {
  return enrichDiscoverEventsWithApifyPosts(events.map(mapPublicEvent));
}

function getDayRevision(events: PublicEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(event._id);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function loadDiscoverEventsPage(date: string, requestedPage: number): Promise<{
  currentPage: number;
  error?: string;
  events: DiscoverFeedEvent[];
  firstEventNumber: number;
  lastEventNumber: number;
  revision: string;
  totalEvents: number;
  totalPages: number;
}> {
  const result = await loadDiscoverDayEvents(date);
  const totalEvents = result.events.length;
  const totalPages = Math.max(1, Math.ceil(totalEvents / DISCOVER_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const startIndex = (currentPage - 1) * DISCOVER_PAGE_SIZE;
  const pageEvents = result.events.slice(startIndex, startIndex + DISCOVER_PAGE_SIZE);

  return {
    currentPage,
    ...(result.error ? { error: result.error } : {}),
    events: await enrichBatch(pageEvents),
    firstEventNumber: pageEvents.length > 0 ? startIndex + 1 : 0,
    lastEventNumber: startIndex + pageEvents.length,
    revision: getDayRevision(result.events),
    totalEvents,
    totalPages,
  };
}

export async function loadDiscoverEventsAfter(date: string, afterEventId: string, revision: string): Promise<{
  cursorMissing: boolean;
  feedChanged: boolean;
  error?: string;
  events: DiscoverFeedEvent[];
  hasMore: boolean;
  nextCursor: string | null;
  totalEvents: number;
}> {
  const result = await loadDiscoverDayEvents(date);
  if (result.error) {
    return {
      cursorMissing: false,
      feedChanged: false,
      error: result.error,
      events: [],
      hasMore: false,
      nextCursor: null,
      totalEvents: 0,
    };
  }

  if (getDayRevision(result.events) !== revision) {
    return {
      cursorMissing: false,
      feedChanged: true,
      events: [],
      hasMore: false,
      nextCursor: null,
      totalEvents: result.events.length,
    };
  }

  const cursorIndex = result.events.findIndex((event) => event._id === afterEventId);
  if (cursorIndex < 0) {
    return {
      cursorMissing: true,
      feedChanged: false,
      events: [],
      hasMore: false,
      nextCursor: null,
      totalEvents: result.events.length,
    };
  }

  const startIndex = cursorIndex + 1;
  const pageEvents = result.events.slice(startIndex, startIndex + DISCOVER_PAGE_SIZE);
  return {
    cursorMissing: false,
    feedChanged: false,
    events: await enrichBatch(pageEvents),
    hasMore: startIndex + pageEvents.length < result.events.length,
    nextCursor: pageEvents.at(-1)?._id ?? null,
    totalEvents: result.events.length,
  };
}
