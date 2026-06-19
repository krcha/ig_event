import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  DiscoverFeed,
  type DiscoverFeedEvent,
  type DiscoverFeedData,
} from "@/components/discover/discover-feed";
import {
  loadUpcomingApprovedEvents,
  type PublicEvent,
} from "@/lib/events/public-events";

export const revalidate = 60;

const getDiscoverFeedQuery =
  "events:getDiscoverFeed" as unknown as FunctionReference<"query">;

const EMPTY_DISCOVER_FEED: DiscoverFeedData = {
  featured: [],
  free: [],
  promoted: [],
  tonight: [],
  weekend: [],
};

function getBelgradeDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Belgrade",
    year: "numeric",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function parseDateKey(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  return new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
      12,
    ),
  );
}

function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function addDaysToDateKey(value: string, days: number): string {
  const date = parseDateKey(value);
  if (!date) {
    return value;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateKey(date);
}

function getWeekendDates(today: string): Set<string> {
  const todayDate = parseDateKey(today);
  const day = todayDate?.getUTCDay() ?? 1;
  const startOffset = day >= 1 && day <= 4 ? 5 - day : 0;
  const endOffset = day === 5 ? 2 : day === 6 ? 1 : day === 0 ? 0 : startOffset + 2;
  const dates = new Set<string>();

  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const dateKey = addDaysToDateKey(today, offset);
    const date = parseDateKey(dateKey);
    const dateDay = date?.getUTCDay();
    if (dateDay === 5 || dateDay === 6 || dateDay === 0) {
      dates.add(dateKey);
    }
  }

  return dates;
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

function mapPublicEvent(event: PublicEvent): DiscoverFeedEvent {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    ...(event.description ? { description: event.description } : {}),
    eventType: event.eventType,
    ...(event.imageUrl ? { imageUrl: event.imageUrl } : {}),
    ...(event.instagramPostUrl ? { instagramPostUrl: event.instagramPostUrl } : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    title: event.title,
    venue: event.venue,
  };
}

async function loadFallbackDiscoverFeed(today: string): Promise<{
  error?: string;
  feed: DiscoverFeedData;
}> {
  const beforeDate = addDaysToDateKey(today, 14);
  const result = await loadUpcomingApprovedEvents({
    beforeDate,
    fromDate: today,
  });
  const events = result.events.map(mapPublicEvent);
  const weekendDates = getWeekendDates(today);

  return {
    ...(result.error ? { error: result.error } : {}),
    feed: {
      featured: [],
      promoted: [],
      tonight: events.filter((event) => event.date === today).slice(0, 12),
      weekend: events.filter((event) => weekendDates.has(event.date)).slice(0, 12),
      free: events.filter((event) => hasFreeTicketPrice(event.ticketPrice)).slice(0, 12),
    },
  };
}

function formatDiscoverSubline(dateKey: string): string {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return `${dateKey} · Belgrade`;
  }

  const date = new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
      12,
    ),
  );

  const label = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Belgrade",
    weekday: "long",
  }).format(date);
  return `${label} · Belgrade`;
}

function normalizeFeed(value: unknown): DiscoverFeedData {
  const candidate = value as Partial<DiscoverFeedData>;
  return {
    featured: Array.isArray(candidate.featured) ? candidate.featured : [],
    free: Array.isArray(candidate.free) ? candidate.free : [],
    promoted: Array.isArray(candidate.promoted) ? candidate.promoted : [],
    tonight: Array.isArray(candidate.tonight) ? candidate.tonight : [],
    weekend: Array.isArray(candidate.weekend) ? candidate.weekend : [],
  };
}

async function loadDiscoverFeed(today: string): Promise<{
  error?: string;
  feed: DiscoverFeedData;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return {
      error: "Convex is not configured yet.",
      feed: EMPTY_DISCOVER_FEED,
    };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const feed = await convex.query(getDiscoverFeedQuery, { today });
    return { feed: normalizeFeed(feed) };
  } catch {
    return loadFallbackDiscoverFeed(today);
  }
}

export default async function DiscoverPage() {
  const today = getBelgradeDateKey();
  const { error, feed } = await loadDiscoverFeed(today);

  return (
    <DiscoverFeed
      error={error}
      feed={feed}
      subline={formatDiscoverSubline(today)}
    />
  );
}
