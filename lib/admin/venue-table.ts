import { normalizeTaxonomyText, venueRequiresPhysicalDetails } from "@/lib/taxonomy/venue-types";
import { getVenueCoordinates } from "@/lib/venues/coordinates";
import { parseVenueHoursJson } from "@/lib/venues/venue-hours-cache";

export type VenueTableColumn = "name" | "instagram" | "category" | "location" | "hours" | "publication" | "scraping";
export type VenueTableSort = { column: VenueTableColumn; direction: "asc" | "desc" };
export type VenueTableFilters = {
  name: string;
  instagram: string;
  category: string;
  mapStatus: "all" | "present" | "missing" | "not_applicable";
  hours: "all" | "known" | "missing" | "google" | "manual" | "osm" | "not_applicable";
  publication: "all" | "pending" | "published" | "hidden";
  scraping: "all" | "scraping" | "paused";
};
export const EMPTY_VENUE_TABLE_FILTERS: VenueTableFilters = {
  name: "", instagram: "", category: "all", mapStatus: "all", hours: "all", publication: "all", scraping: "all",
};
export const DEFAULT_VENUE_TABLE_SORT: VenueTableSort = { column: "name", direction: "asc" };
export type VenueTableRow = {
  id: string;
  name: string;
  instagramHandle: string;
  aliases: string[];
  category: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  hoursSource: "google" | "manual" | "osm" | "none" | null;
  hoursJson: string | null;
  publicStatus: "pending" | "published" | "hidden";
  scrapeActive: boolean;
  updatedAt: number;
};

export function getVenueMapState(venue: VenueTableRow): "present" | "missing" | "not_applicable" {
  if (!venueRequiresPhysicalDetails(venue.category)) return "not_applicable";
  return getVenueCoordinates(venue.latitude, venue.longitude) ? "present" : "missing";
}

export function getVenueHoursState(venue: VenueTableRow): "google" | "manual" | "osm" | "missing" | "not_applicable" {
  if (!venueRequiresPhysicalDetails(venue.category)) return "not_applicable";
  const hours = parseVenueHoursJson(venue.hoursJson);
  if (!hours || hours.source === "none" || !hours.weekly.some((day) => day.closed || day.windows.length > 0)) return "missing";
  return venue.hoursSource === "google" || venue.hoursSource === "manual" || venue.hoursSource === "osm" ? venue.hoursSource : "missing";
}

function hoursLabel(venue: VenueTableRow): string {
  const state = getVenueHoursState(venue);
  return ({ google: "Google", manual: "Manual", osm: "OpenStreetMap", missing: "Missing", not_applicable: "Not applicable" })[state];
}

function locationLabel(venue: VenueTableRow): string {
  const state = getVenueMapState(venue);
  return state === "not_applicable" ? "Not applicable" : venue.location || (state === "present" ? "On map" : "Map missing");
}

const collator = new Intl.Collator("sr-Latn", { numeric: true, sensitivity: "base" });
const contains = (value: string, query: string) => normalizeTaxonomyText(value).includes(normalizeTaxonomyText(query));

export function filterAndSortVenues<T extends VenueTableRow>(
  venues: readonly T[],
  globalQuery: string,
  filters: VenueTableFilters,
  sort: VenueTableSort,
): T[] {
  const next = venues.filter((venue) => {
    const mapState = getVenueMapState(venue);
    const hoursState = getVenueHoursState(venue);
    if (filters.name && !contains([venue.name, ...venue.aliases].join(" "), filters.name)) return false;
    if (filters.instagram && !contains(venue.instagramHandle, filters.instagram)) return false;
    if (filters.category !== "all" && venue.category !== filters.category) return false;
    if (filters.mapStatus !== "all" && mapState !== filters.mapStatus) return false;
    if (filters.hours === "known" ? hoursState === "missing" || hoursState === "not_applicable" : filters.hours !== "all" && filters.hours !== hoursState) return false;
    if (filters.publication !== "all" && venue.publicStatus !== filters.publication) return false;
    if (filters.scraping === "scraping" && !venue.scrapeActive) return false;
    if (filters.scraping === "paused" && venue.scrapeActive) return false;
    return !globalQuery || contains([
      venue.name, ...venue.aliases, venue.instagramHandle, venue.category,
      locationLabel(venue), hoursLabel(venue), venue.publicStatus,
      venue.scrapeActive ? "scraping enabled on" : "paused",
    ].join(" "), globalQuery);
  });
  function value(venue: VenueTableRow): string {
    switch (sort.column) {
      case "name": return venue.name;
      case "instagram": return venue.instagramHandle;
      case "category": return venue.category;
      case "location": return locationLabel(venue);
      case "hours": return hoursLabel(venue);
      case "publication": return venue.publicStatus;
      case "scraping": return venue.scrapeActive ? "On" : "Paused";
    }
  }
  return next.sort((left, right) =>
    collator.compare(value(left), value(right)) * (sort.direction === "asc" ? 1 : -1) ||
    collator.compare(left.name, right.name) || left.id.localeCompare(right.id),
  );
}
