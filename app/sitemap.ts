import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
import { loadValidatedSitemapPublicData } from "@/lib/seo/sitemap-data";
import { absoluteUrl } from "@/lib/seo/site";
import { loadPublicVenueDirectory } from "@/lib/venues/public-venue-pages";
import { LOCALES, type Locale } from "@/i18n/config";
import { getEventContentLocales } from "@/lib/i18n/event-content";
import { localizedAbsoluteUrl } from "@/lib/i18n/seo";

export const dynamic = "force-dynamic";

const loadSitemapPublicData = unstable_cache(
  (today: string) =>
    loadValidatedSitemapPublicData({
      today,
      loadEvents: loadPublicCalendarEventsWindow,
      loadVenues: loadPublicVenueDirectory,
    }),
  ["seo-sitemap-public-data-v2"],
  { revalidate: 3600 },
);

function safeLastModified(value: number | null | undefined): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function languageRoutes(route: MetadataRoute.Sitemap[number], locales: readonly Locale[] = LOCALES): MetadataRoute.Sitemap {
  const parsed = new URL(route.url);
  const path = `${parsed.pathname}${parsed.search}`;
  const languages = Object.fromEntries([
    ...locales.map(locale => [locale === "sr" ? "sr-Latn" : locale, localizedAbsoluteUrl(path, locale)]),
    ["x-default", localizedAbsoluteUrl(path, "sr")],
  ]);
  return locales.map(locale => ({ ...route, url: localizedAbsoluteUrl(path, locale), alternates: { languages } }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const today = getNightlifeDefaultDateKey();
  const { eventResult, venueResult } = await loadSitemapPublicData(today);

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
      url: absoluteUrl("/map"),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: absoluteUrl("/venues/directory"),
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];
  const eventRoutes: MetadataRoute.Sitemap = eventResult.events.flatMap((event) => languageRoutes({
    url: absoluteUrl(`/events/${event._id}`),
    lastModified: safeLastModified(event.updatedAt),
    changeFrequency: "daily",
    priority: 0.8,
  }, getEventContentLocales(event)));
  const venueRoutes: MetadataRoute.Sitemap = venueResult.venues.flatMap((venue) => languageRoutes({
    url: absoluteUrl(`/venues/${venue._id}`),
    lastModified: safeLastModified(venue.updatedAt),
    changeFrequency: "weekly",
    priority: 0.6,
  }));
  const routesByUrl = new Map(
    [...staticRoutes.flatMap(route => languageRoutes(route)), ...eventRoutes, ...venueRoutes].map((route) => [route.url, route]),
  );

  return [...routesByUrl.values()];
}
