import { getEventTimeSortMinutes } from "@/lib/events/event-time";

export type CalendarTimeBandKey =
  | "after-midnight"
  | "daytime"
  | "evening"
  | "night"
  | "time-not-announced";

export type CalendarTimeBandDefinition = {
  key: CalendarTimeBandKey;
  label: string;
  description: string;
};

export type CalendarTimeBandEvent = {
  time?: string | null;
  timeStatus?: "confirmed" | "inferred" | "unknown";
  displayTimeStart?: string | null;
};

export const CALENDAR_TIME_BANDS: readonly CalendarTimeBandDefinition[] = [
  {
    key: "after-midnight",
    label: "After midnight",
    description: "00:00-05:59",
  },
  {
    key: "daytime",
    label: "Daytime",
    description: "06:00-17:59",
  },
  {
    key: "evening",
    label: "Evening",
    description: "18:00-21:59",
  },
  {
    key: "night",
    label: "Night",
    description: "22:00-23:59",
  },
  {
    key: "time-not-announced",
    label: "Time not announced",
    description: "No source-confirmed start time",
  },
] as const;

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
