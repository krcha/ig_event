import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { localizedMetadata } from "@/lib/i18n/seo";
import { travelText } from "@/lib/travel/copy";
import { getOpenNowEventWindow, getBelgradeNow, getOpenNowEventState, getVenueClosingForEventStart } from "@/lib/venues/venue-open-now";
import { loadPublicCalendarEventsWindow } from "@/lib/events/public-events";
import { loadPublicVenueDirectory } from "@/lib/venues/public-venue-pages";
import { getEventDiscoveryTaxonomy } from "@/lib/taxonomy/event-discovery";
import { isCoordinates } from "@/lib/travel/location";
import { eventEndedBeforeArrival, type CompassPlace } from "@/lib/travel/compass";
import { CompassFlow } from "@/components/travel/compass-flow";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return localizedMetadata({ locale, path: "/next", title: travelText(locale, "next"), description: travelText(locale, "locationIntro"), index: false });
}

export default async function NextPlacePage() {
  const now = Date.now();
  const [directory, calendar] = await Promise.all([
    loadPublicVenueDirectory(),
    loadPublicCalendarEventsWindow({ ...getOpenNowEventWindow(now), includeEventTaxonomy: true }),
  ]);
  const current = getBelgradeNow(now);
  const places: CompassPlace[] = directory.venues.flatMap((venue) => {
    const point = { latitude: venue.latitude!, longitude: venue.longitude! };
    if (!isCoordinates(point)) return [];
    const events = calendar.events.filter((event) => event.venueId === venue._id &&
      getOpenNowEventState({ date: event.date, time: event.time }, now) !== "inactive" && !eventEndedBeforeArrival(event, now));
    // Retain the complete lineup for this venue; several genres can coexist.
    const first = events[0];
    const taxonomy = first ? { ...getEventDiscoveryTaxonomy(first),
      genres: [...new Set(events.flatMap((event) => getEventDiscoveryTaxonomy(event).genres))] } : undefined;
    const closing = getVenueClosingForEventStart({ date: current.date, startTime: current.time, venueHours: venue });
    return [{
      ...point, id: venue._id, name: venue.name,
      ...(venue.location ? { address: venue.location } : {}),
      hours: { hoursJson: venue.hoursJson, hoursSource: venue.hoursSource, hoursTimezone: venue.hoursTimezone, hoursExpiresAt: venue.hoursExpiresAt },
      ...(closing ? { hoursLabel: closing.time } : {}),
      ...(first && taxonomy ? { event: { id: first._id, title: first.title, date: first.date, ...(first.time ? { time: first.time } : {}), taxonomy } } : {}),
    }];
  });
  return <CompassFlow places={places} initialNow={now} loadFailed={Boolean(directory.error || calendar.error)} />;
}
