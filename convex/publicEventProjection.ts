import type { Doc } from "./_generated/dataModel";
import { sanitizeVenueLinkedPublicEventFields } from "../lib/events/public-event-venue-fields";

const PUBLIC_DUPLICATE_FIELD_KEYS = new Set([
  "description",
  "locationName",
  "multiEventSplitCount",
  "multiEventSplitDetected",
  "normalizedDate",
  "normalizedVenue",
  "postAltText",
  "rawTitle",
  "rawVenue",
  "reasoningNotes",
  "sourceCaptionFromModel",
  "splitEventIndex",
  "splitSourceLine",
  "titleContextCandidate",
  "titleDerivedFromContext",
  "titleUsedFallback",
]);

function compactDuplicateFields(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const compact = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => PUBLIC_DUPLICATE_FIELD_KEYS.has(key)),
    );
    return Object.keys(compact).length > 0 ? JSON.stringify(compact) : undefined;
  } catch {
    return undefined;
  }
}

export function projectPublicEvent(
  event: Doc<"events">,
  hasPublicLinkedVenue: boolean,
  options: { includeDuplicateFields?: boolean } = {},
) {
  const publicEvent = sanitizeVenueLinkedPublicEventFields(event, hasPublicLinkedVenue);
  const normalizedFieldsJson = options.includeDuplicateFields
    ? compactDuplicateFields(event.normalizedFieldsJson)
    : undefined;

  return {
    _id: publicEvent._id,
    artists: publicEvent.artists,
    createdAt: publicEvent.createdAt,
    date: publicEvent.date,
    description: publicEvent.description,
    eventType: publicEvent.eventType,
    imageStorageId: publicEvent.imageStorageId,
    imageUrl: publicEvent.imageUrl,
    instagramPostId: publicEvent.instagramPostId,
    instagramPostUrl: publicEvent.instagramPostUrl,
    ...(normalizedFieldsJson ? { normalizedFieldsJson } : {}),
    sourceCaption: publicEvent.sourceCaption,
    sourcePostedAt: publicEvent.sourcePostedAt,
    status: publicEvent.status,
    ticketPrice: publicEvent.ticketPrice,
    time: publicEvent.time,
    timeConfidence: publicEvent.timeConfidence,
    timeEvidenceText: publicEvent.timeEvidenceText,
    timeSource: publicEvent.timeSource,
    timeStatus: publicEvent.timeStatus,
    title: publicEvent.title,
    updatedAt: publicEvent.updatedAt,
    venue: publicEvent.venue,
    venueCategory: publicEvent.venueCategory,
    venueId: publicEvent.venueId,
    venueInstagramHandle: publicEvent.venueInstagramHandle,
    venueLatitude: publicEvent.venueLatitude,
    venueLocation: publicEvent.venueLocation,
    venueLongitude: publicEvent.venueLongitude,
  };
}
