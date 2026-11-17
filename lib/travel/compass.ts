import type { EventDiscoveryTaxonomy, MusicGenre } from "../taxonomy/event-discovery";
import type { VenueHoursCacheFields } from "../venues/venue-hours-cache";
import { getBelgradeNow, isVenueOpenNow, matchesOpenNowEvent } from "../venues/venue-open-now";
import { normalizeEventTime } from "../events/event-time";
import { estimateTravel, haversineMeters, type Coordinates } from "./location";
import { compareMusicGenres } from "../taxonomy/music-genre-relations";

export type CompassMusicProfile = {
  genres: MusicGenre[];
  basis: "programme" | "recent";
  evidence: "announcement" | "research" | "estimate" | "unknown";
  eventCount: number;
  fromDate?: string;
  toDate?: string;
  sources?: { eventId: string; date: string }[];
};

export type CompassPlace = Coordinates & {
  id: string;
  name: string;
  address?: string;
  hours?: VenueHoursCacheFields;
  hoursLabel?: string;
  musicProfile?: CompassMusicProfile;
  event?: { id: string; title: string; date: string; time?: string; taxonomy: EventDiscoveryTaxonomy };
};

export function getCompassGenres(place: CompassPlace): MusicGenre[] {
  return place.musicProfile?.genres ?? place.event?.taxonomy.genres ?? [];
}

export function getCompassMusicBasis(place: CompassPlace): CompassMusicProfile["basis"] {
  return place.musicProfile?.basis ?? "programme";
}

/** Genres are existing AI/source taxonomy, never inferred from venue names. */
export function matchesVibe(source: CompassPlace, candidate: CompassPlace, vibe: "same" | "different"): boolean {
  const a = source.event?.taxonomy;
  const b = candidate.event?.taxonomy;
  const left = getCompassGenres(source);
  const right = getCompassGenres(candidate);
  if (left.length && right.length) {
    const relation = compareMusicGenres(left, right).kind;
    return vibe === "same" ? relation === "same" || relation === "close" : relation === "contrast";
  }
  const musical = (taxonomy: EventDiscoveryTaxonomy | undefined) => taxonomy?.categories.some(category => category === "party" || category === "live");
  // Missing musical genres cannot prove a musical match or contrast.
  if ((left.length || musical(a)) && (right.length || musical(b))) return false;
  if (vibe === "different" && b && !musical(b) && (left.length || musical(a))) return true;
  if (vibe === "different" && a && !musical(a) && (right.length || musical(b))) return true;
  return a && b ? vibe === "same" ? a.primaryCategory === b.primaryCategory : a.primaryCategory !== b.primaryCategory : false;
}

export function eventStartedBy(event: Pick<NonNullable<CompassPlace["event"]>, "date" | "time">, instant: number): boolean {
  const time = normalizeEventTime(event.time);
  if (!time.startLabel) return true; // Announced for this outing; start time remains unknown.
  const current = getBelgradeNow(instant);
  const wall = Date.parse(`${current.date}T00:00:00Z`) + current.minuteOfDay * 60_000;
  const start = Date.parse(`${event.date}T00:00:00Z`) +
    (Number(time.startLabel.slice(0, 2)) * 60 + Number(time.startLabel.slice(3))) * 60_000;
  return Number.isFinite(start) && start <= wall;
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
    if (place.id === source.id) return false;
    if (vibe !== "nearby" && (!place.event || place.musicProfile?.basis === "recent" || !matchesVibe(source, place, vibe))) return false;
    if (place.hours?.hoursExpiresAt && place.hours.hoursExpiresAt < now) return false;
    if (!isVenueOpenNow(place.hours, now)) return false;
    if (place.event && vibe !== "nearby" && !matchesOpenNowEvent({ ...place.event, venueHours: place.hours }, now)) return false;
    const estimate = estimateTravel(origin, place);
    const minutes = estimate.walkMinutes > 10 ? estimate.driveMinutes : estimate.walkMinutes;
    const arrival = now + minutes * 60_000;
    const programmeAvailable = vibe === "nearby" || Boolean(place.event &&
      eventStartedBy(place.event, arrival) && !eventEndedBeforeArrival(place.event, arrival));
    return programmeAvailable && isVenueOpenNow(place.hours, arrival);
  }).map((place, index) => ({ place, index, distance: haversineMeters(origin, place) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index).map(({ place }) => place);
}
