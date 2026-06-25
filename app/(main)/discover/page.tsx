import {
  type DiscoverDateTab,
  DiscoverFeed,
  type DiscoverFeedEvent,
} from "@/components/discover/discover-feed";
import {
  loadUpcomingApprovedEvents,
  type PublicEvent,
} from "@/lib/events/public-events";
import { enrichDiscoverEventsWithApifyPosts } from "@/lib/discover/apify-posts";

export const revalidate = 60;

type DiscoverPageProps = {
  searchParams?: {
    date?: string | string[];
  };
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

function mapPublicEvent(event: PublicEvent): DiscoverFeedEvent {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    eventType: event.eventType,
    ...(event.imageUrl ? { imageUrl: event.imageUrl } : {}),
    ...(event.instagramHandle ? { instagramHandle: event.instagramHandle } : {}),
    ...(event.instagramPostId ? { instagramPostId: event.instagramPostId } : {}),
    ...(event.instagramPostUrl ? { instagramPostUrl: event.instagramPostUrl } : {}),
    ...(event.sourceCaption ? { sourceCaption: event.sourceCaption } : {}),
    ...(event.sourcePostedAt ? { sourcePostedAt: event.sourcePostedAt } : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    title: event.title,
    venue: event.venue,
  };
}

async function loadDiscoverEvents(date: string): Promise<{
  error?: string;
  events: DiscoverFeedEvent[];
}> {
  const beforeDate = addDaysToDateKey(date, 1);
  const result = await loadUpcomingApprovedEvents({
    beforeDate,
    fromDate: date,
  });

  const events = result.events
    .filter((event) => event.date === date)
    .map(mapPublicEvent);

  return {
    ...(result.error ? { error: result.error } : {}),
    events: await enrichDiscoverEventsWithApifyPosts(events),
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

function getDateTabDates(today: string): string[] {
  return [addDaysToDateKey(today, -1), today, addDaysToDateKey(today, 1)];
}

function normalizeRequestedDate(
  value: string | string[] | undefined,
  today: string,
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const allowedDates = getDateTabDates(today);
  return candidate && allowedDates.includes(candidate) && parseDateKey(candidate)
    ? candidate
    : today;
}

function buildDateTabs(today: string, selectedDate: string): DiscoverDateTab[] {
  const [yesterday, current, tomorrow] = getDateTabDates(today);
  const tabs = [
    { label: "Yesterday", date: yesterday },
    { label: "Today", date: current },
    { label: "Tomorrow", date: tomorrow },
  ];

  return tabs.map((tab) => ({
    active: tab.date === selectedDate,
    href: tab.date === today ? "/discover" : `/discover?date=${tab.date}`,
    label: tab.label,
    sublabel: formatEventDateShort(tab.date),
  }));
}

function formatEventDateShort(dateKey: string): string {
  const date = parseDateKey(dateKey);
  if (!date) {
    return dateKey;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Belgrade",
  }).format(date);
}

export default async function DiscoverPage({ searchParams }: DiscoverPageProps) {
  const today = getBelgradeDateKey();
  const selectedDate = normalizeRequestedDate(searchParams?.date, today);
  const { error, events } = await loadDiscoverEvents(selectedDate);
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <DiscoverFeed
      authEnabled={authEnabled}
      dateTabs={buildDateTabs(today, selectedDate)}
      error={error}
      events={events}
      subline={formatDiscoverSubline(selectedDate)}
    />
  );
}
