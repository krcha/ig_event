import { REVIEWED_OCCURRENCE_LOCATION_PAIRS } from "../../config/reviewed-occurrence-locations";

// Keep both public venue identities. This relationship is only evidence when
// comparing separately sourced listings for the same program slot.
export function venuesShareReviewedOccurrenceLocation(
  leftVenueId?: string | null,
  rightVenueId?: string | null,
): boolean {
  return REVIEWED_OCCURRENCE_LOCATION_PAIRS.some(([left, right]) =>
    (leftVenueId === left && rightVenueId === right) || (leftVenueId === right && rightVenueId === left));
}
