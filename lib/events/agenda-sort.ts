import { getCalendarTimeBandKey } from "./calendar-time-bands";
import { getEventTimeSortMinutes } from "./event-time";
import type { CalendarEventSummary } from "./calendar-agenda-types";
import { AGENDA_BAND_ORDER, type AgendaSortMode } from "./agenda-sort-options";
import { haversineMeters, type Coordinates } from "../travel/location";
export { normalizeAgendaSortMode } from "./agenda-sort-options";

const collator = new Intl.Collator("sr-Latn", { sensitivity: "base", numeric: true });

/** Sort the complete selection before projection/virtualization; equal keys retain source order. */
export function sortAgendaEvents<T extends CalendarEventSummary>(events: readonly T[], mode: AgendaSortMode, origin?: Coordinates | null): T[] {
  const validOrigin = validCoordinates(origin) ? origin : null;
  return events.map((event, index) => ({
    event, index,
    distance: validOrigin && validCoordinates({ latitude: event.venueLatitude, longitude: event.venueLongitude })
      ? haversineMeters(validOrigin, { latitude: event.venueLatitude!, longitude: event.venueLongitude! }) : Infinity,
    followers: instagramFollowerRank(event.venueInstagramFollowerCount),
    rank: AGENDA_BAND_ORDER.indexOf(getCalendarTimeBandKey(event)),
    minutes: event.timeStatus !== "unknown"
      ? getEventTimeSortMinutes(event.displayTimeStart ?? event.time) : null,
  })).sort((a, b) => {
    let result = 0;
    if (mode === "distance" && validOrigin) result = a.distance === b.distance ? 0 : a.distance - b.distance;
    else if (mode === "venue") result = collator.compare(a.event.venue, b.event.venue);
    else {
      const popularity = mode === "popularity" ? b.followers - a.followers : 0;
      result = popularity || a.rank - b.rank || (a.minutes ?? Number.MAX_SAFE_INTEGER) - (b.minutes ?? Number.MAX_SAFE_INTEGER);
    }
    return result || a.index - b.index;
  }).map(({ event }) => event);
}

function instagramFollowerRank(count: number | undefined): number {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : -1;
}

function validCoordinates(value: { latitude?: number; longitude?: number } | null | undefined): value is Coordinates {
  return Boolean(value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    && Math.abs(value.latitude!) <= 90 && Math.abs(value.longitude!) <= 180);
}
