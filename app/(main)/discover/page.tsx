import type { Metadata } from "next";
import {
  type DiscoverDateTab,
  DiscoverFeed,
  type DiscoverFeedEvent,
} from "@/components/discover/discover-feed";
import {
  loadPublicCalendarEventsWindow,
  type PublicEvent,
} from "@/lib/events/public-events";
import { enrichDiscoverEventsWithApifyPosts } from "@/lib/discover/apify-posts";
import {
  addDaysToDateKey,
  getNightlifeDefaultDateKey,
  parseDateKeyToUtcNoon,
} from "@/lib/events/nightlife-date";
import { SITE_ORIGIN } from "@/lib/seo/site";

export const revalidate = 60;

type DiscoverPageProps = {
  searchParams?: Promise<{
    date?: string | string[];
  }>;
};

export async function generateMetadata({ searchParams }: DiscoverPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const hasDateFilter = Boolean(
    Array.isArray(resolvedSearchParams?.date)
      ? resolvedSearchParams.date[0]
      : resolvedSearchParams?.date,
  );
  const title = "Belgrade Events Tonight: Nightlife & Culture Picks";
  const description =
    "Discover what to do in Belgrade tonight: approved club nights, concerts, DJ sets, exhibitions, theatre, film, and cultural events.";

  return {
    title,
    description,
    alternates: {
      canonical: "/discover",
    },
    openGraph: {
      title: `${title} | Event Zeka`,
      description,
      type: "website",
      locale: "en_RS",

      siteName: "Event Zeka",
      url: `${SITE_ORIGIN}/discover`,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | Event Zeka`,
      description,
    },
    robots: {
      index: !hasDateFilter,
      follow: true,
      googleBot: {
        index: !hasDateFilter,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
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
    ...(event.venueId ? { venueId: event.venueId } : {}),
  };
}

async function loadDiscoverEvents(date: string): Promise<{
  error?: string;
  events: DiscoverFeedEvent[];
}> {
  const beforeDate = addDaysToDateKey(date, 1);
  const result = await loadPublicCalendarEventsWindow({
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
  const date = parseDateKeyToUtcNoon(dateKey);
  if (!date) {
    return `${dateKey} · Belgrade`;
  }

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
  return candidate && allowedDates.includes(candidate) && parseDateKeyToUtcNoon(candidate)
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
  const date = parseDateKeyToUtcNoon(dateKey);
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
  const resolvedSearchParams = await searchParams;
  const today = getNightlifeDefaultDateKey();
  const selectedDate = normalizeRequestedDate(resolvedSearchParams?.date, today);
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
