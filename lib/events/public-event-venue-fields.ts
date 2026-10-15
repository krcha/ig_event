import { getVenueCoordinates } from "../venues/coordinates.ts";

export const VENUE_LINKED_PUBLIC_EVENT_FIELDS = [
  "venueAliases",
  "venueCategory",
  "venueHours",
  "venueId",
  "venueInstagramHandle",
  "venueLatitude",
  "venueLocation",
  "venueLongitude",
] as const;

export type VenueLinkedPublicEventFields = {
  venueAliases?: unknown;
  venueCategory?: unknown;
  venueHours?: unknown;
  venueId?: string;
  venueInstagramHandle?: unknown;
  venueLatitude?: unknown;
  venueLocation?: unknown;
  venueLongitude?: unknown;
};

type PublicVenueDisplayFields = {
  _id: string;
  aliases?: string[];
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
  name: string;
};

/** Curated venue labels are read projections; source-bound event fields stay stored as received. */
export function projectPublicEventVenueDisplay<
  T extends { venue: string; venueId?: string },
>(event: T, venue: PublicVenueDisplayFields | undefined): T & {
  venueAliases?: string[];
  venueLatitude?: number;
  venueLocation?: string;
  venueLongitude?: number;
} {
  if (!venue || (event.venueId && event.venueId !== venue._id)) {
    return event;
  }

  const projected = {
    ...event,
    venue: venue.name,
    venueAliases: [...new Set([event.venue, ...(venue.aliases ?? [])])].filter(
      (name) => Boolean(name.trim()) && name !== venue.name,
    ),
  } as T & {
    venueAliases?: string[];
    venueLatitude?: number;
    venueLocation?: string;
    venueLongitude?: number;
  };
  // A current public venue supersedes old denormalized location fields, even
  // when an operator has removed its coordinates or address.
  delete projected.venueLatitude;
  delete projected.venueLongitude;
  delete projected.venueLocation;
  const coordinates = getVenueCoordinates(venue.latitude, venue.longitude);
  if (coordinates) {
    projected.venueLatitude = coordinates.latitude;
    projected.venueLongitude = coordinates.longitude;
  }
  if (venue.location?.trim()) projected.venueLocation = venue.location.trim();
  return projected;
}

/**
 * Remove venue-owned denormalized data when an event points at a venue that is
 * not public. The event and its source fields remain visible.
 */
export function sanitizeVenueLinkedPublicEventFields<
  T extends VenueLinkedPublicEventFields,
>(event: T, isLinkedVenuePublic: boolean): T {
  const hasVenueLinkedFields = VENUE_LINKED_PUBLIC_EVENT_FIELDS.some(
    (field) => Object.hasOwn(event, field) && event[field] !== undefined,
  );
  if (!hasVenueLinkedFields || (event.venueId && isLinkedVenuePublic)) {
    return event;
  }

  const sanitized = { ...event } as T & Record<string, unknown>;
  for (const field of VENUE_LINKED_PUBLIC_EVENT_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}
