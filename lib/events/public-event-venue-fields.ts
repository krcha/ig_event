export const VENUE_LINKED_PUBLIC_EVENT_FIELDS = [
  "venueCategory",
  "venueHours",
  "venueId",
  "venueInstagramHandle",
  "venueLatitude",
  "venueLocation",
  "venueLongitude",
] as const;

export type VenueLinkedPublicEventFields = {
  venueCategory?: unknown;
  venueHours?: unknown;
  venueId?: string;
  venueInstagramHandle?: unknown;
  venueLatitude?: unknown;
  venueLocation?: unknown;
  venueLongitude?: unknown;
};

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
