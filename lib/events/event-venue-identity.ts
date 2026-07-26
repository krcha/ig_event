import { normalizeHandle, toSearchableText } from "../pipeline/venue-normalization";

export type EventVenueIdentityInput = {
  venue: string;
  venueInstagramHandle?: string;
};

export type NormalizedEventVenueIdentity = {
  normalizedVenueIdentity?: string;
  normalizedVenueInstagramHandle?: string;
};

export function buildNormalizedEventVenueIdentity(
  event: EventVenueIdentityInput,
): NormalizedEventVenueIdentity {
  const normalizedVenueIdentity = toSearchableText(event.venue).replace(/\s+/gu, " ").trim();
  const normalizedVenueInstagramHandle = normalizeHandle(event.venueInstagramHandle ?? "");

  return {
    ...(normalizedVenueIdentity ? { normalizedVenueIdentity } : {}),
    ...(normalizedVenueInstagramHandle ? { normalizedVenueInstagramHandle } : {}),
  };
}
