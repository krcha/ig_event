import type { EventDiscoveryTaxonomy, MusicGenre } from "../taxonomy/event-discovery";
import { compareMusicGenres, type MusicGenreComparison } from "../taxonomy/music-genre-relations";
import type { VenueHoursCacheFields } from "../venues/venue-hours-cache";
import { getBelgradeNow, getOpenNowEventState, getVenueClosingForEventStart, isVenueOpenNow } from "../venues/venue-open-now";
import { normalizeEventTime } from "../events/event-time";
import { estimateTravel, type Coordinates } from "./location";
import type { CompassVenueType } from "./venue-profile";

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
  venueType?: CompassVenueType;
  musicProfile?: CompassMusicProfile;
  recentMusicProfile?: CompassMusicProfile;
  event?: { id: string; title: string; date: string; time?: string; taxonomy: EventDiscoveryTaxonomy };
  programmes?: CompassProgramme[];
};

export type CompassProgramme = NonNullable<CompassPlace["event"]> & { musicProfile?: CompassMusicProfile };
export type CompassSourceReference = "venue" | { eventId: string };
type CompassMode = "same" | "different";
export type CompassRecommendationReason = "same-genre" | "related-genre" | "same-activity" | "same-venue-type" |
  "contrast-genre-and-venue" | "contrast-genre" | "contrast-activity" | "contrast-venue-type" | "nearby";
type CompassMatch = { score: number; reason: CompassRecommendationReason; basis: "programme" | "venue" };
export type CompassRecommendation = (CompassMatch | { score: null; reason: "nearby"; basis: "nearby" }) & {
  programmeTiming?: "at-arrival" | "unknown-start";
};
export type CompassRankedPlace = CompassPlace & { openNow: boolean; recommendation: CompassRecommendation };
type CompassGenreEvidence = { sourceEstimated?: boolean; candidateEstimated?: boolean };

export function getCompassGenres(place: CompassPlace): MusicGenre[] {
  return place.musicProfile?.genres ?? place.event?.taxonomy.genres ?? [];
}

export function getCompassMusicBasis(place: CompassPlace): CompassMusicProfile["basis"] {
  return place.musicProfile?.basis ?? "programme";
}

export function matchesCompassMode(score: number | null | undefined, mode: CompassMode): boolean {
  return score != null && (mode === "same" ? score >= 70 : score <= 30);
}

function musicMatch(relation: MusicGenreComparison, evidence: CompassGenreEvidence = {}): CompassMatch | undefined {
  const estimated = Boolean(evidence.sourceEstimated || evidence.candidateEstimated);
  if (relation.kind === "same") return { score: estimated ? 92 : 100, reason: "same-genre", basis: "programme" };
  if (relation.kind === "close") {
    const score = relation.shared.length ? 94 : 86;
    return { score: estimated ? score - 8 : score, reason: "related-genre", basis: "programme" };
  }
  if (relation.kind === "contrast") {
    if (estimated) return;
    const regionalFolk = [...relation.left, ...relation.right].includes("folk");
    return { score: regionalFolk ? 12 : 20, reason: "contrast-genre", basis: "programme" };
  }
  // Admit a small unclassified component around an actual shared core, but
  // require a contrast to have no musically overlapping component at all.
  if (relation.kind === "mixed" && !relation.contrastPairs.length && relation.shared.length) {
    const supportedLeft = new Set([...relation.shared, ...relation.closePairs.map(([left]) => left)]);
    const supportedRight = new Set([...relation.shared, ...relation.closePairs.map(([, right]) => right)]);
    if (!estimated && supportedLeft.size / relation.left.length >= 2 / 3 && supportedRight.size / relation.right.length >= 2 / 3) {
      return { score: 74, reason: "related-genre", basis: "programme" };
    }
  }
}

export function compareCompassMusic(source: readonly MusicGenre[], candidate: readonly MusicGenre[], evidence?: CompassGenreEvidence): CompassMatch | undefined {
  return musicMatch(compareMusicGenres(source, candidate), evidence);
}

function isMusicEvent(taxonomy: EventDiscoveryTaxonomy | undefined): boolean {
  return Boolean(taxonomy && (taxonomy.genres.length || taxonomy.categories.some(category => category === "party" || category === "live")));
}

function musicFormat(taxonomy: EventDiscoveryTaxonomy): "dj" | "live" | undefined {
  const dj = taxonomy.formats.includes("dj-set");
  const live = taxonomy.formats.some(format => format === "concert" || format === "live-performance" || format === "tribute");
  if (dj !== live) return dj ? "dj" : "live";
}

function accountForMusicFormat(match: CompassMatch | undefined, source: EventDiscoveryTaxonomy | undefined, candidate: EventDiscoveryTaxonomy | undefined): CompassMatch | undefined {
  if (!match || match.reason !== "same-genre" || !source || !candidate) return match;
  const sourceFormat = musicFormat(source);
  const candidateFormat = musicFormat(candidate);
  if (sourceFormat && candidateFormat && sourceFormat !== candidateFormat) return { ...match, score: match.score - 8 };
  return match;
}

function compareCompassActivities(source: EventDiscoveryTaxonomy | undefined, candidate: EventDiscoveryTaxonomy | undefined): CompassMatch | undefined {
  if (!source || !candidate) return;
  const sourceMusic = isMusicEvent(source);
  const candidateMusic = isMusicEvent(candidate);
  const sourceCategory = source.primaryCategory;
  const candidateCategory = candidate.primaryCategory;
  const sourceKnown = sourceMusic || sourceCategory !== "other";
  const candidateKnown = candidateMusic || candidateCategory !== "other";
  if (!sourceKnown || !candidateKnown) return;
  if (sourceMusic && candidateMusic) {
    const sourceFormat = musicFormat(source);
    const candidateFormat = musicFormat(candidate);
    if (!sourceFormat || !candidateFormat || source.genres.length || candidate.genres.length) return;
    return sourceFormat === candidateFormat
      ? { score: 75, reason: "same-activity", basis: "programme" }
      : { score: 30, reason: "contrast-activity", basis: "programme" };
  }
  if (sourceMusic !== candidateMusic) return { score: 26, reason: "contrast-activity", basis: "programme" };
  if (source.formats.some(format => format !== "festival" && candidate.formats.includes(format))) {
    return { score: 86, reason: "same-activity", basis: "programme" };
  }
  if (sourceCategory === candidateCategory) {
    return { score: source.formats.length && candidate.formats.length ? 64 : 74, reason: "same-activity", basis: "programme" };
  }
  if (!source.categories.some(category => category !== "other" && candidate.categories.includes(category))) {
    return { score: 28, reason: "contrast-activity", basis: "programme" };
  }
}

export function compareCompassEvents(source: EventDiscoveryTaxonomy, candidate: EventDiscoveryTaxonomy, evidence?: CompassGenreEvidence): CompassMatch | undefined {
  if (source.genres.length && candidate.genres.length) {
    return accountForMusicFormat(compareCompassMusic(source.genres, candidate.genres, evidence), source, candidate);
  }
  return compareCompassActivities(source, candidate);
}

const CONTRASTING_VENUE_TYPES = [
  ["club", "kafana"], ["club", "cocktail-bar"], ["club", "wine-bar"],
  ["cocktail-bar", "kafana"], ["wine-bar", "kafana"], ["live-music-venue", "cocktail-bar"],
] satisfies [CompassVenueType, CompassVenueType][];

function venuesContrast(a: CompassVenueType | undefined, b: CompassVenueType | undefined): boolean {
  return CONTRASTING_VENUE_TYPES.some(([left, right]) => (a === left && b === right) || (a === right && b === left));
}

function compareCompassPlaces(source: CompassPlace, candidate: CompassPlace, mode: CompassMode): CompassMatch | undefined {
  const sourceGenres = source.musicProfile?.basis === "recent" && source.venueType && !source.event ? [] : getCompassGenres(source);
  const candidateGenres = candidate.musicProfile?.basis === "recent" ? [] : getCompassGenres(candidate);
  const relation = compareMusicGenres(sourceGenres, candidateGenres);
  const a = source.event?.taxonomy;
  const b = candidate.event?.taxonomy;
  const byMusic = accountForMusicFormat(musicMatch(relation, {
    sourceEstimated: source.musicProfile?.evidence === "estimate",
    candidateEstimated: candidate.musicProfile?.evidence === "estimate",
  }), a, b);
  const venueContrast = venuesContrast(source.venueType, candidate.venueType);

  if (byMusic) {
    if (mode === "different" && byMusic.reason === "contrast-genre" && venueContrast) {
      return { score: byMusic.score - 8, reason: "contrast-genre-and-venue", basis: "programme" };
    }
    return byMusic;
  }
  // An active crossover with shared music cannot be a strong contrast merely
  // because it happens in a different type of venue.
  if (mode === "different" && (relation.shared.length || relation.closePairs.length)) return;

  const byActivity = compareCompassActivities(a, b);
  if (byActivity && matchesCompassMode(byActivity.score, mode)) return byActivity;
  const isRegularVenueVisit = (taxonomy: EventDiscoveryTaxonomy | undefined) =>
    !taxonomy || ((taxonomy.primaryCategory === "other" || taxonomy.primaryCategory === "food") && !isMusicEvent(taxonomy));
  if (mode === "same" && source.venueType && source.venueType === candidate.venueType &&
      !sourceGenres.length && !candidateGenres.length && isRegularVenueVisit(a) && isRegularVenueVisit(b)) {
    return { score: 90, reason: "same-venue-type", basis: "venue" };
  }
  const electronicToKafana = candidate.venueType === "kafana" && source.venueType !== "kafana" &&
    sourceGenres.some(genre => genre === "electronic" || genre === "house" || genre === "techno" || genre === "trance" || genre === "drum-and-bass");
  if (mode === "different" && (venueContrast || electronicToKafana)) return { score: 29, reason: "contrast-venue-type", basis: "venue" };
}

/** Compatibility for callers comparing an already resolved pair. */
export function matchesVibe(source: CompassPlace, candidate: CompassPlace, vibe: CompassMode): boolean {
  return matchesCompassMode(compareCompassPlaces(source, candidate, vibe)?.score, vibe);
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

export function isCompassProgrammeInOuting(event: Pick<CompassProgramme, "date" | "time">, now: number): boolean {
  if (getOpenNowEventState(event, now) !== "inactive") return true;
  const time = normalizeEventTime(event.time);
  return Boolean(time.startLabel && time.endLabel && eventStartedBy(event, now) && !eventEndedBeforeArrival(event, now));
}

export function getCompassSourceProgrammes(place: CompassPlace, now: number): CompassProgramme[] {
  const programmes = place.programmes ?? (place.event ? [{ ...place.event, musicProfile: place.musicProfile }] : []);
  return programmes.flatMap(event => {
    const time = normalizeEventTime(event.time);
    if (!isCompassProgrammeInOuting(event, now) ||
      !eventStartedBy(event, now) || eventEndedBeforeArrival(event, now)) return [];
    return [{ event, start: time.startLabel ? `${event.date}T${time.startLabel}` : "" }];
  }).sort((a, b) => b.start.localeCompare(a.start)).map(({ event }) => event);
}

export function getCompassSourceAt(place: CompassPlace, now: number, reference?: CompassSourceReference): CompassPlace {
  if (!place.programmes && !reference) return place;
  const programmes = reference === "venue" ? [] : getCompassSourceProgrammes(place, now);
  const [firstProgramme] = programmes;
  const activeProgramme = typeof reference === "object"
    ? programmes.find(programme => programme.id === reference.eventId)
    : !place.venueType || normalizeEventTime(firstProgramme?.time).startLabel ? firstProgramme : undefined;
  const recent = place.recentMusicProfile ?? (place.musicProfile?.basis === "recent" ? place.musicProfile : undefined);
  const canUseRecent = !reference && (activeProgramme ? isMusicEvent(activeProgramme.taxonomy) : !place.venueType);
  const musicProfile = canUseRecent && !activeProgramme?.taxonomy.genres.length
    ? recent ?? activeProgramme?.musicProfile : activeProgramme?.musicProfile;
  return { ...place, event: activeProgramme, musicProfile, programmes: undefined };
}

export function compassCandidates(places: readonly CompassPlace[], source: CompassPlace, origin: Coordinates, vibe: CompassMode | "nearby", now: number): CompassRankedPlace[] {
  const currentSource = getCompassSourceAt(source, now);
  return places.flatMap((place, index) => {
    if (place.id === source.id) return [];
    const estimate = estimateTravel(origin, place);
    const minutes = estimate.walkMinutes > 10 ? estimate.driveMinutes : estimate.walkMinutes;
    const arrival = now + minutes * 60_000;
    if ((place.hours?.hoursExpiresAt && place.hours.hoursExpiresAt < arrival) || !isVenueOpenNow(place.hours, arrival)) return [];
    const [event] = getCompassSourceProgrammes(place, arrival);
    const destination = { ...place, event, musicProfile: event?.musicProfile };
    const match = vibe === "nearby" ? { score: null, reason: "nearby", basis: "nearby" } as const
      : compareCompassPlaces(currentSource, destination, vibe);
    if (!match || (vibe !== "nearby" && !matchesCompassMode(match.score, vibe))) return [];
    const openNow = isVenueOpenNow(place.hours, now);
    if (vibe === "nearby" && !openNow) return [];

    const programmeTiming = match.basis === "programme" && event
      ? normalizeEventTime(event.time).startLabel ? "at-arrival" : "unknown-start" : undefined;
    const local = getBelgradeNow(arrival);
    const closing = getVenueClosingForEventStart({ date: local.date, startTime: local.time, venueHours: place.hours });
    const ranked: CompassRankedPlace = { ...destination, openNow, hoursLabel: closing?.time, recommendation: { ...match, programmeTiming } };
    return [{ ranked, index, distance: estimate.meters, timingPriority: programmeTiming === "unknown-start" ? 1 : 0 }];
  }).sort((a, b) => {
    const scoreDifference = (b.ranked.recommendation.score ?? 0) - (a.ranked.recommendation.score ?? 0);
    return a.timingPriority - b.timingPriority || (vibe === "same" ? scoreDifference : -scoreDifference) ||
      a.distance - b.distance || a.index - b.index;
  }).map(({ ranked }) => ranked);
}
