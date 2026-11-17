import type { PublicEvent } from "../events/public-events";
import { getEventDiscoveryTaxonomy, type MusicGenre } from "../taxonomy/event-discovery";
import { compareMusicGenres } from "../taxonomy/music-genre-relations";
import { getNightlifeDefaultDateKey, addDaysToDateKey } from "../events/nightlife-date";
import { getBelgradeNow, getOpenNowEventState, getVenueClosingForEventStart } from "../venues/venue-open-now";
import type { PublicVenue } from "../venues/public-venue-pages";
import { isCoordinates } from "./location";
import { eventEndedBeforeArrival, eventStartedBy, type CompassMusicProfile, type CompassPlace } from "./compass";

export const COMPASS_HISTORY_DAYS = 30;
const musical = (event: PublicEvent) => getEventDiscoveryTaxonomy(event).categories.some(category => category === "party" || category === "live");

function programmeProfile(event: PublicEvent): CompassMusicProfile {
  const genres = [...getEventDiscoveryTaxonomy(event).genres];
  return {
    genres, basis: "programme", eventCount: 1,
    evidence: !genres.length ? "unknown" : event.performerGenreResearch?.estimated ? "estimate" : event.performerGenreResearch?.sources.length ? "research" : "announcement",
    fromDate: event.date, toDate: event.date, sources: [{ eventId: event._id, date: event.date }],
  };
}

/** Historical context is never a claim about the music playing tonight. */
export function buildRecentVenueMusicProfile(events: readonly PublicEvent[], now: number): CompassMusicProfile | undefined {
  const today = getNightlifeDefaultDateKey(new Date(now));
  const since = addDaysToDateKey(today, -COMPASS_HISTORY_DAYS);
  const byDate = new Map<string, PublicEvent[]>();
  for (const event of events) {
    if (event.date < since || event.date >= today || !musical(event)) continue;
    const rows = byDate.get(event.date) ?? [];
    if (!rows.some(row => row._id === event._id)) rows.push(event);
    byDate.set(event.date, rows);
  }
  // Unknown nights count against coverage; three labeled nights among many
  // unknown programmes cannot establish a typical musical direction.
  const dates = [...byDate.keys()].sort().reverse().slice(0, 12);
  if (dates.length < 3) return;
  const samples = dates.map(date => ({ date, rows: byDate.get(date)!, genres: [...new Set(byDate.get(date)!.flatMap(row => getEventDiscoveryTaxonomy(row).genres))] }));
  const seeds = [...new Set(samples.flatMap(sample => sample.genres))];
  const candidates = seeds.map(seed => ({ seed, support: samples.filter(sample => {
    const relation = compareMusicGenres([seed], sample.genres).kind;
    return relation === "same" || relation === "close";
  }) })).sort((a, b) => b.support.length - a.support.length || a.seed.localeCompare(b.seed));
  const best = candidates[0];
  if (!best || best.support.length < Math.ceil(dates.length * 2 / 3)) return;
  const genres: MusicGenre[] = [...new Set(best.support.flatMap(sample => sample.genres))].slice(0, 3);
  const rows = best.support.flatMap(sample => sample.rows);
  const dated = best.support.map(sample => sample.date).sort();
  return {
    genres, basis: "recent", evidence: rows.some(row => row.performerGenreResearch?.estimated) ? "estimate" : rows.some(row => row.performerGenreResearch?.sources.length) ? "research" : "announcement",
    eventCount: best.support.length, fromDate: dated[0], toDate: dated.at(-1),
    sources: best.support.slice(0, 3).map(sample => ({ eventId: sample.rows[0]._id, date: sample.date })),
  };
}

export function selectCompassProgramme(events: readonly PublicEvent[], now: number): PublicEvent | undefined {
  return events.filter(event => getOpenNowEventState({ date: event.date, time: event.timeStatus === "unknown" ? undefined : event.time }, now) !== "inactive" &&
    !eventEndedBeforeArrival({ date: event.date, time: event.timeStatus === "unknown" ? undefined : event.time }, now))
    .map((event, index) => {
      const time = event.timeStatus === "unknown" ? undefined : event.time;
      const started = eventStartedBy({ date: event.date, time }, now);
      const start = time?.match(/^(\d{2}):(\d{2})/);
      const timestamp = start ? Date.parse(`${event.date}T00:00:00Z`) + (Number(start[1]) * 60 + Number(start[2])) * 60_000 : 0;
      return { event, index, rank: started && start ? 0 : !start ? 1 : 2, timestamp };
    }).sort((a, b) => a.rank - b.rank || (a.rank === 0 ? b.timestamp - a.timestamp : a.timestamp - b.timestamp) || a.index - b.index)[0]?.event;
}

export function projectCompassMusicContext(rows: readonly PublicEvent[], now: number): { musicProfile: CompassMusicProfile; event?: CompassPlace["event"] } {
  const event = selectCompassProgramme(rows, now);
  const eventTime = event?.timeStatus === "unknown" ? undefined : event?.time;
  const currentProgramme = event && eventStartedBy({ date: event.date, time: eventTime }, now);
  const knownNonMusicProgramme = currentProgramme && event && !musical(event);
  const direct = currentProgramme && event ? programmeProfile(event) : undefined;
  const recent = !direct?.genres.length && !knownNonMusicProgramme ? buildRecentVenueMusicProfile(rows, now) : undefined;
  const musicProfile: CompassMusicProfile = direct?.genres.length ? direct : recent ?? direct ?? { genres: [], basis: "programme", evidence: "unknown", eventCount: 0 };
  return { musicProfile,
    ...(event ? { event: { id: event._id, title: event.title, date: event.date, ...(eventTime ? { time: eventTime } : {}), taxonomy: { ...getEventDiscoveryTaxonomy(event), genres: [...getEventDiscoveryTaxonomy(event).genres] } } } : {}),
  };
}

export function projectCompassPlaces(venues: readonly PublicVenue[], events: readonly PublicEvent[], now: number): CompassPlace[] {
  const current = getBelgradeNow(now);
  const byVenue = new Map<string, PublicEvent[]>();
  for (const event of events) {
    if (!event.venueId) continue;
    const rows = byVenue.get(event.venueId) ?? [];
    rows.push(event); byVenue.set(event.venueId, rows);
  }
  return venues.flatMap(venue => {
    const point = { latitude: venue.latitude!, longitude: venue.longitude! };
    if (!isCoordinates(point)) return [];
    const rows = byVenue.get(venue._id) ?? [];
    const context = projectCompassMusicContext(rows, now);
    const closing = getVenueClosingForEventStart({ date: current.date, startTime: current.time, venueHours: venue });
    return [{ ...point, id: venue._id, name: venue.name,
      ...(venue.location ? { address: venue.location } : {}),
      hours: { hoursJson: venue.hoursJson, hoursSource: venue.hoursSource, hoursTimezone: venue.hoursTimezone, hoursExpiresAt: venue.hoursExpiresAt },
      ...(closing ? { hoursLabel: closing.time } : {}), ...context,
    }];
  });
}
