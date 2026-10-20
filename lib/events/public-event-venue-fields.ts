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
  location?: string | null;
  name: string;
};

/** Curated venue labels are read projections; source-bound event fields stay stored as received. */
export function projectPublicEventVenueDisplay<
  T extends { venue: string; venueId?: string },
>(event: T, venue: PublicVenueDisplayFields | undefined): T & {
  venueAliases?: string[];
  venueLocation?: string;
} {
  if (!venue || (event.venueId && event.venueId !== venue._id)) {
    return event;
  }

  return {
    ...event,
    venue: venue.name,
    venueAliases: [...new Set([event.venue, ...(venue.aliases ?? [])])].filter(
      (name) => Boolean(name.trim()) && name !== venue.name,
    ),
    ...(venue.location ? { venueLocation: venue.location } : {}),
  };
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
