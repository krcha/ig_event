import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { localizedMetadata } from "@/lib/i18n/seo";
import { travelText } from "@/lib/travel/copy";
import { getOpenNowEventWindow } from "@/lib/venues/venue-open-now";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { addDaysToDateKey } from "@/lib/events/nightlife-date";
import { loadPublicVenueDirectory } from "@/lib/venues/public-venue-pages";
import { projectCompassPlaces } from "@/lib/travel/compass-projection";
import { CompassFlow } from "@/components/travel/compass-flow";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return localizedMetadata({ locale, path: "/next", title: travelText(locale, "next"), description: travelText(locale, "locationIntro"), index: false });
}

export default async function NextPlacePage() {
  const now = Date.now();
  const window = getOpenNowEventWindow(now);
  const [directory, calendar] = await Promise.all([
    loadPublicVenueDirectory(),
    loadPublicCalendarEventsWindow({
      ...window,
      beforeDate: addDaysToDateKey(window.beforeDate, 1),
      includeEventTaxonomy: true,
    }),
  ]);
  const places = projectCompassPlaces(directory.venues, calendar.events, now);
  return <CompassFlow places={places} initialNow={now} loadFailed={Boolean(directory.error || calendar.error)} />;
}
