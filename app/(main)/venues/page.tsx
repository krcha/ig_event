import type { Metadata } from "next";
import { Suspense } from "react";
import { EventCalendarMap } from "@/components/maps/event-calendar-map";
import { EventMapLoading } from "@/components/maps/event-map-loading";
import {
  enrichEventMapCoordinates,
  normalizeMapDateKey,
} from "@/lib/events/event-map";
import {
  addDaysToDateKey,
  dateKeyToLocalNoonDate,
  getNightlifeDefaultDateKey,
} from "@/lib/events/nightlife-date";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { SITE_ORIGIN } from "@/lib/seo/site";
import { loadPublicVenueDirectory } from "@/lib/venues/public-venue-pages";

export const dynamic = "force-dynamic";

type MapSearchParams = {
  date?: string | string[];
};

type EventMapPageProps = {
  searchParams?: Promise<MapSearchParams>;
};

export async function generateMetadata({ searchParams }: EventMapPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const hasDateFilter = Boolean(resolvedSearchParams?.date);
  const title = "Belgrade Event Map: Explore Events by Day";
  const description =
    "Choose a day and see where Belgrade concerts, club nights, DJ sets, and cultural events are happening. Explore event venues on the map.";

  return {
    title,
    description,
    alternates: { canonical: "/venues" },
    openGraph: {
      title: `${title} | Event Zeka`,
      description,
      type: "website",
      locale: "en_RS",
      siteName: "Event Zeka",
      url: new URL("/venues", SITE_ORIGIN).toString(),
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
  const requestedDate = Array.isArray(resolvedSearchParams?.date)
    ? resolvedSearchParams.date[0]
    : resolvedSearchParams?.date;
  const todayDate = getNightlifeDefaultDateKey();
  const selectedDate = normalizeMapDateKey(requestedDate, todayDate);

  return (
    <Suspense fallback={<EventMapLoading />}>
      <EventMapResults selectedDate={selectedDate} todayDate={todayDate} />
    </Suspense>
  );
}

async function EventMapResults({ selectedDate, todayDate }: {
  selectedDate: string;
  todayDate: string;
}) {
  const selectedWeekday = dateKeyToLocalNoonDate(selectedDate).getDay();
  const fromDate = addDaysToDateKey(selectedDate, -((selectedWeekday + 6) % 7));
  const beforeDate = addDaysToDateKey(fromDate, 7);
  const [eventResult, venueResult] = await Promise.all([
    loadPublicCalendarEventsWindow({ beforeDate, fromDate }),
    loadPublicVenueDirectory(),
  ]);

  if (eventResult.error) {
    throw new Error(`Failed to load event map: ${eventResult.error}`);
  }
  if (venueResult.error) {
    throw new Error(`Failed to load map venues: ${venueResult.error}`);
  }

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDaysToDateKey(fromDate, index);
    return {
      date,
      eventCount: eventResult.events.filter((event) => event.date === date).length,
    };
  });
  const events = enrichEventMapCoordinates(
    eventResult.events.filter((event) => event.date === selectedDate),
    venueResult.venues,
  );

  return (
    <EventCalendarMap
      days={days}
      events={events}
      selectedDate={selectedDate}
      todayDate={todayDate}
    />
  );
}
