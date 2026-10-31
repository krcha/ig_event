import { getEventTimeSortMinutes } from "@/lib/events/event-time";

import { CALENDAR_TIME_BANDS, type CalendarTimeBandKey } from "./calendar-time-band-definitions";
export { CALENDAR_TIME_BANDS } from "./calendar-time-band-definitions";
export type { CalendarTimeBandKey, CalendarTimeBandDefinition } from "./calendar-time-band-definitions";

export type CalendarTimeBandEvent = {
  time?: string | null;
  timeStatus?: "confirmed" | "inferred" | "unknown";
  displayTimeStart?: string | null;
};


export function getCalendarTimeBandKey(
  event: CalendarTimeBandEvent,
): CalendarTimeBandKey {
  if (event.timeStatus === "unknown") {
    return "time-not-announced";
  }

  const minutes = getEventTimeSortMinutes(event.displayTimeStart ?? event.time);
  if (minutes === null) {
    return "time-not-announced";
  }
  if (minutes < 6 * 60) {
    return "after-midnight";
  }
  if (minutes < 18 * 60) {
    return "daytime";
  }
  if (minutes < 22 * 60) {
    return "evening";
  }
  return "night";
}

export function groupCalendarEventsByTimeBand<T extends CalendarTimeBandEvent>(
  events: readonly T[],
) {
  const buckets = new Map<CalendarTimeBandKey, T[]>(
    CALENDAR_TIME_BANDS.map((band) => [band.key, []]),
  );

  events.forEach((event) => {
    buckets.get(getCalendarTimeBandKey(event))?.push(event);
  });

  return CALENDAR_TIME_BANDS.map((band) => ({
    ...band,
    events: buckets.get(band.key) ?? [],
  })).filter((band) => band.events.length > 0);
}
