import type { Doc } from "./_generated/dataModel";
import { sanitizeVenueLinkedPublicEventFields } from "../lib/events/public-event-venue-fields";

export function projectPublicEvent(event: Doc<"events">, hasPublicLinkedVenue: boolean) {
  const publicEvent = sanitizeVenueLinkedPublicEventFields(event, hasPublicLinkedVenue);

  return {
    _id: publicEvent._id,
    artists: publicEvent.artists,
    createdAt: publicEvent.createdAt,
    date: publicEvent.date,
    dateEvidenceIsRelative: publicEvent.dateEvidenceIsRelative,
    dateEvidenceResolvedDate: publicEvent.dateEvidenceResolvedDate,
    dateEvidenceSource: publicEvent.dateEvidenceSource,
    dateEvidenceText: publicEvent.dateEvidenceText,
    description: publicEvent.description,
    eventType: publicEvent.eventType,
    imageStorageId: publicEvent.imageStorageId,
    imageUrl: publicEvent.imageUrl,
    instagramPostId: publicEvent.instagramPostId,
    instagramPostUrl: publicEvent.instagramPostUrl,
    sourceCaption: publicEvent.sourceCaption,
    sourcePostedAt: publicEvent.sourcePostedAt,
    status: publicEvent.status,
    ticketPrice: publicEvent.ticketPrice,
    time: publicEvent.time,
    timeConfidence: publicEvent.timeConfidence,
    timeEvidenceText: publicEvent.timeEvidenceText,
    timeEvidenceKind: publicEvent.timeEvidenceKind,
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
