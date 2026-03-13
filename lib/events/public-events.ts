import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { unstable_noStore as noStore } from "next/cache";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "@/lib/events/approved-event-duplicates";

export type EventStatus = "pending" | "approved" | "rejected";
const DEFAULT_PUBLIC_EVENTS_PAGE_SIZE = 24;
const APPROVED_EVENTS_SCAN_BATCH_SIZE = 100;

export type PublicEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  eventType: string;
  ticketPrice?: string;
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
};

type LoadUpcomingApprovedEventsPageOptions = {
  page?: number;
  pageSize?: number;
  searchQuery?: string;
};

const listApprovedUpcomingByDatePaginatedQuery =
  "events:listApprovedUpcomingByDatePaginated" as unknown as FunctionReference<"query">;

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

function normalizeDaysInPast(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(7, Math.trunc(value as number)));
}

export function parseEventTimeMinutes(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return 0;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return 0;
  }

  return hours * 60 + minutes;
}

function comparePublicEvents(left: PublicEvent, right: PublicEvent): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = parseEventTimeMinutes(left.time) - parseEventTimeMinutes(right.time);
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

function matchesPublicEventSearch(event: PublicEvent, searchQuery: string): boolean {
  if (!searchQuery) {
    return true;
  }

  const searchableEventText = toSearchableText(
    [
      event.title,
      event.venue,
      event.eventType,
      event.ticketPrice ?? "",
      event.artists.join(" "),
    ].join(" "),
  );

  return searchableEventText.includes(toSearchableText(searchQuery));
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
  const cleanupGroups = buildApprovedEventAutoCleanupGroups(
    events.map(mapPublicEventToDuplicateRecord),
  );
  if (cleanupGroups.length === 0) {
    return events;
  }

  const hiddenDuplicateIds = new Set(
    cleanupGroups.flatMap((group) => group.duplicateEventIds),
  );

  return events.filter((event) => !hiddenDuplicateIds.has(event._id));
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
    events.push(...page.page);

    if (page.isDone) {
      break;
    }

    cursor = page.continueCursor;
  }

  return filterDuplicatePublicEvents(events).sort(comparePublicEvents);
}

export async function loadUpcomingApprovedEvents(
  options: LoadUpcomingApprovedEventsOptions = {},
): Promise<{
  events: PublicEvent[];
  error?: string;
}> {
  noStore();

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const fromDate = formatLocalDate(getStartOfLocalDay(normalizeDaysInPast(options.daysInPast)));
  if (!convexUrl) {
    return { events: [], error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const events = await loadAllApprovedUpcomingEvents(convex, fromDate);
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
  noStore();

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
    const allEvents = await loadAllApprovedUpcomingEvents(
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
