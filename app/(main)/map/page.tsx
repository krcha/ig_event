import type { Metadata } from "next";
import { Suspense } from "react";
import { EventCalendarMap } from "@/components/maps/event-calendar-map";
import { EventMapLoading } from "@/components/maps/event-map-loading";
import {
  attachReviewedEventMapAddresses,
  getEventMapEventWindow,
  getEventMapOpenNowDateKey,
  getEventMapOpenNowWindow,
  normalizeMapDateKey,
} from "@/lib/events/event-map";
import {
  addDaysToDateKey,
  dateKeyToLocalNoonDate,
  getCalendarDateKeyInTimeZone,
} from "@/lib/events/nightlife-date";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { loadPublicCalendarOverviewWindow } from "@/lib/events/public-calendar-overview";
import { SITE_ORIGIN } from "@/lib/seo/site";
import reviewedLocations from "@/data/venue-coordinates-2026-10-15.json";

export const dynamic = "force-dynamic";

type MapSearchParams = {
  date?: string | string[];
  open?: string | string[];
};

type EventMapPageProps = {
  searchParams?: Promise<MapSearchParams>;
};

export async function generateMetadata({ searchParams }: EventMapPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const hasDateFilter = Boolean(resolvedSearchParams?.date || resolvedSearchParams?.open);
  const title = "Belgrade Event Map: Explore Events by Day";
  const description =
    "Choose a day and see where Belgrade concerts, club nights, DJ sets, and cultural events are happening. Explore event venues on the map.";

  return {
    title,
    description,
    alternates: { canonical: "/map" },
    openGraph: {
      title: `${title} | Event Zeka`,
      description,
      type: "website",
      locale: "en_RS",
      siteName: "Event Zeka",
      url: new URL("/map", SITE_ORIGIN).toString(),
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

export default async function EventMapPage({ searchParams }: EventMapPageProps) {
  const resolvedSearchParams = await searchParams;
  const initialNow = Date.now();
  const requestedOpen = Array.isArray(resolvedSearchParams?.open)
    ? resolvedSearchParams.open[0]
    : resolvedSearchParams?.open;
  const openNowActive = requestedOpen === "now";
  const requestedDate = Array.isArray(resolvedSearchParams?.date)
    ? resolvedSearchParams.date[0]
    : resolvedSearchParams?.date;
  const todayDate = getCalendarDateKeyInTimeZone(new Date(initialNow));
  const selectedDate = openNowActive ? getEventMapOpenNowDateKey(initialNow) : normalizeMapDateKey(requestedDate, todayDate);

  return (
    <Suspense fallback={<EventMapLoading />}>
      <EventMapResults initialNow={initialNow} openNowActive={openNowActive} selectedDate={selectedDate} todayDate={todayDate} />
    </Suspense>
  );
}

async function EventMapResults({ initialNow, openNowActive, selectedDate, todayDate }: {
  initialNow: number;
  openNowActive: boolean;
  selectedDate: string;
  todayDate: string;
}) {
  const selectedWeekday = dateKeyToLocalNoonDate(selectedDate).getDay();
  const fromDate = addDaysToDateKey(selectedDate, -((selectedWeekday + 6) % 7));
  const beforeDate = addDaysToDateKey(fromDate, 7);
  const openNowWindow = getEventMapOpenNowWindow(initialNow);
  // Before 06:00 the display date is yesterday, but current civil-day starts
  // still belong to Open now. Use the clock-derived window, not display date.
  const eventWindow = openNowActive ? openNowWindow : getEventMapEventWindow(selectedDate, false);
  const [eventResult, overviewResult] = await Promise.all([
    loadPublicCalendarEventsWindow(eventWindow),
    loadPublicCalendarOverviewWindow({ beforeDate, fromDate }),
  ]);

  if (eventResult.error) {
    throw new Error(`Failed to load event map: ${eventResult.error}`);
  }
  if (overviewResult.error) {
    throw new Error(`Failed to load map day counts: ${overviewResult.error}`);
  }

  const countsByDate = new Map<string, number>();
  for (const group of overviewResult.groups) {
    countsByDate.set(group.date, (countsByDate.get(group.date) ?? 0) + group.count);
  }
  const selectedDayEvents = eventResult.events.filter((event) => event.date === selectedDate);
  // Reconcile the active chip with this response's detail snapshot when the
  // independent overview and detail caches refresh at different moments.
  countsByDate.set(selectedDate, selectedDayEvents.length);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDaysToDateKey(fromDate, index);
    return {
      date,
      eventCount: countsByDate.get(date) ?? 0,
    };
  });
  const events = attachReviewedEventMapAddresses(
    eventResult.events.filter((event) => openNowActive
      ? event.date >= openNowWindow.fromDate && event.date < openNowWindow.beforeDate
      : event.date === selectedDate),
    reviewedLocations.venues,
  );

  return (
    <EventCalendarMap
      days={days}
      events={events}
      initialNow={initialNow}
      openNowActive={openNowActive}
      selectedDate={selectedDate}
      todayDate={todayDate}
    />
  );
}
