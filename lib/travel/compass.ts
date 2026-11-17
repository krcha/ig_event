import type { EventDiscoveryTaxonomy, MusicGenre } from "../taxonomy/event-discovery";
import type { VenueHoursCacheFields } from "../venues/venue-hours-cache";
import { getBelgradeNow, isVenueOpenNow, matchesOpenNowEvent } from "../venues/venue-open-now";
import { normalizeEventTime } from "../events/event-time";
import { estimateTravel, haversineMeters, type Coordinates } from "./location";

export type CompassPlace = Coordinates & {
  id: string;
  name: string;
  address?: string;
  hours?: VenueHoursCacheFields;
  hoursLabel?: string;
  event?: { id: string; title: string; date: string; time?: string; taxonomy: EventDiscoveryTaxonomy };
};

const families: readonly (readonly MusicGenre[])[] = [
  ["electronic", "house", "techno", "trance", "drum-and-bass"],
  ["rock", "indie-alternative", "metal-punk"],
  ["hip-hop", "rnb-soul"],
  ["disco-funk", "pop"],
  ["jazz-blues"], ["folk", "etno-world"], ["latin", "afro-amapiano"],
  ["reggae-dub"], ["classical", "ambient"],
];

/** Genres are existing AI/source taxonomy, never inferred from venue names. */
export function matchesVibe(source: CompassPlace, candidate: CompassPlace, vibe: "same" | "different"): boolean {
  const a = source.event?.taxonomy;
  const b = candidate.event?.taxonomy;
  if (!a || !b) return false;
  if (a.genres.length && b.genres.length) {
    const related = a.genres.some((genre) => b.genres.some((other) => genre === other ||
      families.some((family) => family.includes(genre) && family.includes(other))));
    return vibe === "same" ? related : !related;
  }
  const musical = (category: string) => category === "party" || category === "live";
  // Missing musical genres cannot prove a musical match or contrast.
  if (musical(a.primaryCategory) && musical(b.primaryCategory)) return false;
  return vibe === "same" ? a.primaryCategory === b.primaryCategory : a.primaryCategory !== b.primaryCategory;
}

export function eventEndedBeforeArrival(event: Pick<NonNullable<CompassPlace["event"]>, "date" | "time">, arrival: number): boolean {
  const time = normalizeEventTime(event.time);
  if (!time.startLabel || !time.endLabel) return false;
  const minutes = (label: string) => Number(label.slice(0, 2)) * 60 + Number(label.slice(3));
  const end = Date.parse(`${event.date}T00:00:00Z`) + minutes(time.endLabel) * 60_000 +
    (minutes(time.endLabel) <= minutes(time.startLabel) ? 86_400_000 : 0);
  const current = getBelgradeNow(arrival);
  const wall = Date.parse(`${current.date}T00:00:00Z`) + current.minuteOfDay * 60_000;
  return Number.isFinite(end) && wall >= end;
}

export function compassCandidates(places: readonly CompassPlace[], source: CompassPlace, origin: Coordinates, vibe: "same" | "different" | "nearby", now: number): CompassPlace[] {
  return places.filter((place) => {
    if (place.id === source.id || !place.event || (vibe !== "nearby" && !matchesVibe(source, place, vibe))) return false;
    if (place.hours?.hoursExpiresAt && place.hours.hoursExpiresAt < now) return false;
    if (!matchesOpenNowEvent({ ...place.event, venueHours: place.hours }, now)) return false;
    const estimate = estimateTravel(origin, place);
    const minutes = estimate.walkMinutes > 10 ? estimate.driveMinutes : estimate.walkMinutes;
    const arrival = now + minutes * 60_000;
    return !eventEndedBeforeArrival(place.event, arrival) && isVenueOpenNow(place.hours, arrival);
  }).map((place, index) => ({ place, index, distance: haversineMeters(origin, place) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index).map(({ place }) => place);
}
