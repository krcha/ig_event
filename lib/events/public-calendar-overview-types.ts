import {
  getEventPrimaryCategory,
  type EventPrimaryCategory,
} from "../taxonomy/event-categories";
import {
  matchesPublicEventNameArtistOrVenue,
  type PublicEventSearchFields,
} from "./public-event-search";
import {
  getPublicEventVenueFilterValue,
  matchesPublicEventVenueFilter,
} from "./public-event-venue-filter";

export type PublicCalendarOverviewGroup = {
  date: string;
  category: EventPrimaryCategory;
  venueValue: string;
  count: number;
  legacyVenueMatchCount: number;
};

export type PublicCalendarOverviewVenue = {
  value: string;
  label: string;
  names: string[];
  location?: string;
};

export type PublicCalendarOverviewPage = {
  page: PublicCalendarOverviewGroup[];
  venues: PublicCalendarOverviewVenue[];
  continueCursor: string;
  isDone: boolean;
  rawPageCount: number;
  scanLimitReached: boolean;
};

export type PublicCalendarOverviewEvent = PublicEventSearchFields & {
  date: string;
  description?: string;
  eventType: string;
  venueId?: string;
  venueLocation?: string;
};

/** Aggregate authorized public rows without returning detailed event bodies. */
export function buildPublicCalendarOverviewPage(
  events: readonly PublicCalendarOverviewEvent[],
  filters: { q?: string; venue?: string } = {},
): Pick<PublicCalendarOverviewPage, "page" | "venues"> {
  const buckets = new Map<string, PublicCalendarOverviewGroup>();
  const venues = new Map<string, PublicCalendarOverviewVenue>();

  for (const event of events) {
    const venueValue = getPublicEventVenueFilterValue(event);
    const existingVenue = venues.get(venueValue);
    const names = [event.venue, ...(event.venueAliases ?? [])];
    if (existingVenue) {
      existingVenue.names = [...new Set([...existingVenue.names, ...names])];
      if (event.venueLocation) existingVenue.location = event.venueLocation;
    } else {
      venues.set(venueValue, {
        value: venueValue,
        label: event.venue,
        names: [...new Set(names)],
        ...(event.venueLocation ? { location: event.venueLocation } : {}),
      });
    }

    // The month venue selector includes all public venues, even when no event
    // at that venue matches the current title/artist/venue search.
    if (!matchesPublicEventNameArtistOrVenue(event, filters.q)) continue;
    const category = getEventPrimaryCategory(event);
    const key = JSON.stringify([event.date, category, venueValue]);
    const bucket = buckets.get(key) ?? {
      date: event.date,
      category,
      venueValue,
      count: 0,
      legacyVenueMatchCount: 0,
    };
    bucket.count += 1;
    if (matchesPublicEventVenueFilter(event, filters.venue)) bucket.legacyVenueMatchCount += 1;
    buckets.set(key, bucket);
  }

  return {
    page: [...buckets.values()].sort((left, right) =>
      left.date.localeCompare(right.date) ||
      left.venueValue.localeCompare(right.venueValue) ||
      left.category.localeCompare(right.category),
    ),
    venues: [...venues.values()].sort((left, right) =>
      left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
    ),
  };
}
