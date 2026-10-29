import type { Doc } from "./_generated/dataModel";
import { sanitizeVenueLinkedPublicEventFields } from "../lib/events/public-event-venue-fields";
import { normalizeVenueComparableText } from "../lib/domain/venues/normalization";
import { venueRequiresPhysicalDetails } from "../lib/taxonomy/venue-types";

export function projectPublicEvent(
  event: Doc<"events">,
  hasPublicLinkedVenue: boolean,
  linkedVenue?: Doc<"venues">,
) {
  const isLinkedPromoter = linkedVenue !== undefined &&
    !venueRequiresPhysicalDetails(linkedVenue.category);
  const publicEvent = sanitizeVenueLinkedPublicEventFields(
    event,
    hasPublicLinkedVenue && !isLinkedPromoter,
  );
  const venueClaim = normalizeVenueComparableText(event.venue);
  // Reclassification must not rewrite source facts. Only the public location
  // label changes when the old claim names the linked nonphysical organizer.
  const claimsLinkedPromoter = linkedVenue && isLinkedPromoter &&
    Boolean(venueClaim) &&
    [linkedVenue.name, linkedVenue.instagramHandle, ...(linkedVenue.aliases ?? [])]
      .some((claim) => normalizeVenueComparableText(claim) === venueClaim);

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
    reviewedSourceUpdate: publicEvent.reviewedSourceUpdate,
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
    venue: claimsLinkedPromoter ? "Venue to be announced" : publicEvent.venue,
    venueCategory: publicEvent.venueCategory,
    venueId: publicEvent.venueId,
    venueInstagramHandle: publicEvent.venueInstagramHandle,
    venueLatitude: publicEvent.venueLatitude,
    venueLocation: publicEvent.venueLocation,
    venueLongitude: publicEvent.venueLongitude,
  };
}
