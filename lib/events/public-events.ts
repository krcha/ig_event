import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { unstable_noStore as noStore } from "next/cache";

export type EventStatus = "pending" | "approved" | "rejected";

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
  normalizedFieldsJson?: string;
  status: EventStatus;
};

const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;

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

function logFilteredOutEvent(
  event: PublicEvent,
  reason: "not_approved" | "past_date" | "invalid_normalized_date",
) {
  console.info(
    JSON.stringify({
      level: "info",
      event: "public_events.filtered_out",
      reason,
      eventId: event._id,
      title: event.title,
      status: event.status,
      eventDate: event.date,
      eventTime: event.time ?? null,
      sourcePostedAt: event.sourcePostedAt ?? null,
    }),
  );
}

export function filterUpcomingApprovedEvents(events: PublicEvent[]): PublicEvent[] {
  const startOfToday = getStartOfLocalToday();
  const upcomingEvents: PublicEvent[] = [];
  let filteredNotApproved = 0;
  let filteredInvalidDate = 0;
  let filteredPastDate = 0;
  let approvedEvents = 0;

  for (const event of events) {
    if (event.status !== "approved") {
      filteredNotApproved += 1;
      logFilteredOutEvent(event, "not_approved");
      continue;
    }

    approvedEvents += 1;

    const parsedDate = parseNormalizedEventDate(event.date);
    if (!parsedDate) {
      filteredInvalidDate += 1;
      logFilteredOutEvent(event, "invalid_normalized_date");
      continue;
    }

    if (parsedDate < startOfToday) {
      filteredPastDate += 1;
      logFilteredOutEvent(event, "past_date");
      continue;
    }

    upcomingEvents.push(event);
  }

  upcomingEvents.sort((left, right) => {
    const leftDate = parseNormalizedEventDate(left.date);
    const rightDate = parseNormalizedEventDate(right.date);
    const leftTime = parseEventTimeMinutes(left.time);
    const rightTime = parseEventTimeMinutes(right.time);
    const leftScore =
      (leftDate ? leftDate.getTime() : Number.MAX_SAFE_INTEGER) +
      leftTime * 60 * 1000;
    const rightScore =
      (rightDate ? rightDate.getTime() : Number.MAX_SAFE_INTEGER) +
      rightTime * 60 * 1000;
    return leftScore - rightScore;
  });

  console.info(
    JSON.stringify({
      level: "info",
      event: "public_events.filter_summary",
      totalFetchedEvents: events.length,
      approvedEvents,
      upcomingEvents: upcomingEvents.length,
      filteredNotApproved,
      filteredInvalidDate,
      filteredPastDate,
      localToday: startOfToday.toISOString(),
    }),
  );

  return upcomingEvents;
}

export async function loadUpcomingApprovedEvents(): Promise<{
  events: PublicEvent[];
  error?: string;
}> {
  noStore();

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return { events: [], error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const events = (await convex.query(listByStatusQuery, {
      status: "approved",
      limit: 500,
    })) as PublicEvent[];

    return { events: filterUpcomingApprovedEvents(events) };
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
