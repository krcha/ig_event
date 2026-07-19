import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { addDaysToDateKey, getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
import { absoluteUrl } from "@/lib/seo/site";
import { loadPublicVenueDirectory } from "@/lib/venues/public-venue-pages";

export const dynamic = "force-dynamic";

const loadSitemapPublicData = unstable_cache(
  async (today: string) => {
    const eventResult = await loadPublicCalendarEventsWindow({
      fromDate: today,
      beforeDate: addDaysToDateKey(today, 367),
    });
    const venueResult = await loadPublicVenueDirectory({ limit: 2000, today });
    return { eventResult, venueResult };
  },
  ["seo-sitemap-public-data"],
  { revalidate: 3600 },
);

function safeLastModified(value: number | null | undefined): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const today = getNightlifeDefaultDateKey();
  const { eventResult, venueResult } = await loadSitemapPublicData(today);

  if (eventResult.error || venueResult.error) {
    throw new Error(
      `Unable to build SEO sitemap: ${eventResult.error ?? venueResult.error ?? "Unknown public data error."}`,
    );
  }

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl("/"),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: absoluteUrl("/discover"),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: absoluteUrl("/venues"),
      changeFrequency: "daily",
      priority: 0.8,
    },
  ];
  const eventRoutes: MetadataRoute.Sitemap = eventResult.events.map((event) => ({
    url: absoluteUrl(`/events/${event._id}`),
    lastModified: safeLastModified(event.updatedAt),
    changeFrequency: "daily",
    priority: 0.8,
  }));
  const venueRoutes: MetadataRoute.Sitemap = venueResult.venues.map((venue) => ({
    url: absoluteUrl(`/venues/${venue._id}`),
    lastModified: safeLastModified(venue.updatedAt),
    changeFrequency: "weekly",
    priority: venue.upcomingEventCount > 0 ? 0.7 : 0.5,
  }));
  const routesByUrl = new Map(
    [...staticRoutes, ...eventRoutes, ...venueRoutes].map((route) => [route.url, route]),
  );

  return [...routesByUrl.values()];
}
