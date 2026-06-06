import { toSearchableText } from "../pipeline/venue-normalization.ts";

export type PublicEventSearchFields = {
  title: string;
  venue: string;
  artists: string[];
};

export function getPublicEventNameArtistVenueSearchText(
  event: PublicEventSearchFields,
): string {
  return [event.title, event.venue, event.artists.join(" ")].join(" ");
}

export function matchesPublicEventNameArtistOrVenue(
  event: PublicEventSearchFields,
  searchQuery: string | undefined,
): boolean {
  const normalizedQuery = toSearchableText(searchQuery ?? "");
  if (!normalizedQuery) {
    return true;
  }

  return toSearchableText(getPublicEventNameArtistVenueSearchText(event)).includes(
    normalizedQuery,
  );
}
