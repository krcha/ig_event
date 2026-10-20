import { getEventTimeSortMinutes } from "./event-time.ts";
import { addDaysToDateKey, getCalendarDateKeyInTimeZone, getNightlifeDefaultDateKey } from "./nightlife-date.ts";
import type { PublicEvent } from "./public-events";
import type { PublicVenueDirectoryItem } from "../venues/public-venue-pages";
import { matchesOpenNowEvent } from "../venues/venue-open-now.ts";

export const MAP_MIN_DATE = "2000-01-01";
export const MAP_MAX_DATE = "2099-12-31";

export function getEventMapOpenNowDateKey(now: Date | number = Date.now()): string {
  return getNightlifeDefaultDateKey(now instanceof Date ? now : new Date(now), { rolloverHour: 6 });
}

export function getEventMapOpenNowWindow(now: Date | number = Date.now()): { fromDate: string; beforeDate: string } {
  // The displayed nightlife day rolls over at 06:00. Live event candidates
  // still include both civil dates so an after-midnight start remains visible.
  const today = getCalendarDateKeyInTimeZone(now instanceof Date ? now : new Date(now));
  return { fromDate: addDaysToDateKey(today, -1), beforeDate: addDaysToDateKey(today, 1) };
}

export type EventMapLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  venueId: string | null;
  events: PublicEvent[];
};

type CoordinatePair = { latitude: number; longitude: number };

function validCoordinates(latitude: unknown, longitude: unknown): CoordinatePair | null {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  return { latitude, longitude };
}

export function normalizeMapDateKey(value: string | undefined, fallback: string): string {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < MAP_MIN_DATE ||
    value > MAP_MAX_DATE
  ) {
    return fallback;
  }

  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : fallback;
}

export function buildEventMapHref(date: string, options: { openNow?: boolean } = {}): string {
  const query = new URLSearchParams({ date });
  if (options.openNow) query.set("open", "now");
  return `/map?${query.toString()}`;
}

export function getEventMapEventWindow(selectedDate: string, openNow: boolean): {
  fromDate: string;
  beforeDate: string;
} {
  return {
    fromDate: openNow ? addDaysToDateKey(selectedDate, -1) : selectedDate,
    beforeDate: addDaysToDateKey(selectedDate, 1),
  };
}

export function filterEventMapEvents(
  events: readonly PublicEvent[],
  options: { selectedDate: string; openNow: boolean; now: number },
): PublicEvent[] {
  return events.filter((event) => options.openNow
    ? matchesOpenNowEvent(event, options.now)
    : event.date === options.selectedDate);
}

export function enrichEventMapCoordinates(
  events: PublicEvent[],
  venues: readonly Pick<PublicVenueDirectoryItem, "_id" | "latitude" | "longitude">[],
  reviewedLocations: readonly { id: string; latitude: number; longitude: number; address?: string }[] = [],
): PublicEvent[] {
  const venuesById = new Map(venues.map((venue) => [venue._id, venue]));
  const reviewedById = new Map(reviewedLocations.map((venue) => [venue.id, venue]));

  return events.map((event) => {
    const venue = event.venueId ? venuesById.get(event.venueId) : undefined;
    const currentCoordinates = validCoordinates(venue?.latitude, venue?.longitude);
    const coordinates = currentCoordinates ?? validCoordinates(event.venueLatitude, event.venueLongitude);

    if (!coordinates) {
      return event;
    }

    // An address is display evidence for the reviewed point, not an identity
    // guess. Ignore it if a later operator changes either coordinate.
    const reviewed = venue && currentCoordinates ? reviewedById.get(venue._id) : undefined;
    const reviewedAddress = reviewed?.latitude === coordinates.latitude &&
      reviewed.longitude === coordinates.longitude ? reviewed.address?.trim() : undefined;

    return {
      ...event,
      venueLatitude: coordinates.latitude,
      venueLongitude: coordinates.longitude,
      ...(reviewedAddress ? { venueLocation: reviewedAddress } : {}),
    };
  });
}

/** Calendar events already contain the current public venue read projection. */
export function attachReviewedEventMapAddresses(
  events: PublicEvent[],
  reviewedLocations: readonly { id: string; latitude: number; longitude: number; address?: string }[],
): PublicEvent[] {
  const reviewedById = new Map(reviewedLocations.map((venue) => [venue.id, venue]));

  return events.map((event) => {
    const coordinates = validCoordinates(event.venueLatitude, event.venueLongitude);
    const reviewed = event.venueId ? reviewedById.get(event.venueId) : undefined;
    const address = coordinates && reviewed?.latitude === coordinates.latitude &&
      reviewed.longitude === coordinates.longitude ? reviewed.address?.trim() : undefined;

    // Reviewed snapshots may label an exact live point, but never restore
    // removed coordinates or bind an unlinked event to a venue by its name.
    return address ? { ...event, venueLocation: address } : event;
  });
}

function compareEvents(left: PublicEvent, right: PublicEvent): number {
  const dateOrder = left.date.localeCompare(right.date);
  if (dateOrder !== 0) {
    return dateOrder;
  }

  const leftTime = left.timeStatus === "unknown"
    ? null
    : getEventTimeSortMinutes(left.displayTimeStart ?? left.time);
  const rightTime = right.timeStatus === "unknown"
    ? null
    : getEventTimeSortMinutes(right.displayTimeStart ?? right.time);
  if (leftTime !== rightTime) {
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return leftTime - rightTime;
  }

  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left._id.localeCompare(right._id);
}

function normalizeVenueLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function buildEventMapData(events: readonly PublicEvent[]): {
  locations: EventMapLocation[];
  unmappedEvents: PublicEvent[];
} {
  const locationsById = new Map<string, EventMapLocation>();
  const unmappedEvents: PublicEvent[] = [];

  for (const event of [...events].sort(compareEvents)) {
    const coordinates = validCoordinates(event.venueLatitude, event.venueLongitude);
    if (!coordinates) {
      unmappedEvents.push(event);
      continue;
    }

    const venueId = event.venueId || null;
    const identity = venueId ? `id:${venueId}` : `name:${normalizeVenueLabel(event.venue)}`;
    // Coordinates are part of the identity so different branches and stale
    // snapshots never share a marker solely because their venue labels match.
    const id = JSON.stringify([identity, coordinates.latitude, coordinates.longitude]);
    const existing = locationsById.get(id);
    if (existing) {
      existing.events.push(event);
      if (!existing.address && event.venueLocation?.trim()) {
        existing.address = event.venueLocation.trim();
      }
      continue;
    }

    locationsById.set(id, {
      id,
      name: event.venue.trim(),
      ...coordinates,
      address: event.venueLocation?.trim() || null,
      venueId,
      events: [event],
    });
  }

  const locations = [...locationsById.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id),
  );

  return { locations, unmappedEvents };
}
