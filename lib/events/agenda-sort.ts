import { getCalendarTimeBandKey } from "./calendar-time-bands";
import { getEventTimeSortMinutes } from "./event-time";
import type { CalendarEventSummary } from "./calendar-agenda-types";
import { AGENDA_BAND_ORDER, type AgendaSortMode } from "./agenda-sort-options";
export { normalizeAgendaSortMode } from "./agenda-sort-options";

const collator = new Intl.Collator("sr-Latn", { sensitivity: "base", numeric: true });

/** Sort the complete selection before projection/virtualization; equal keys retain source order. */
export function sortAgendaEvents<T extends CalendarEventSummary>(events: readonly T[], mode: AgendaSortMode): T[] {
  const order = AGENDA_BAND_ORDER[mode === "late" ? "late" : "time"];
  return events.map((event, index) => ({
    event, index,
    rank: order.indexOf(getCalendarTimeBandKey(event)),
    minutes: event.timeStatus !== "unknown"
      ? getEventTimeSortMinutes(event.displayTimeStart ?? event.time) : null,
  })).sort((a, b) => {
    let result = 0;
    if (mode === "venue") result = collator.compare(a.event.venue, b.event.venue);
    else if (mode === "title") result = collator.compare(a.event.title, b.event.title);
    else {
      result = a.rank - b.rank;
      if (!result) {
        if (a.minutes !== null && b.minutes !== null) result = (a.minutes - b.minutes) * (mode === "late" ? -1 : 1);
        else if (a.minutes !== null || b.minutes !== null) result = a.minutes === null ? 1 : -1;
      }
    }
    return result || a.index - b.index;
  }).map(({ event }) => event);
}
