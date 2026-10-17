import {
  BELGRADE_TIMEZONE,
  parseVenueHoursJson,
  type VenueHoursCacheFields,
  type VenueHoursWindow,
} from "@/lib/venues/venue-hours-cache";

export type BelgradeNow = {
  date: string;
  minuteOfDay: number;
  month: string;
  time: string;
  weekday: number;
};

const belgradeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: BELGRADE_TIMEZONE,
  year: "numeric",
});

/** Read Belgrade wall time independently of the server or browser timezone. */
export function getBelgradeNow(now: Date | number = Date.now()): BelgradeNow {
  const parts = belgradeFormatter.formatToParts(now);
  const readPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = readPart("year");
  const month = readPart("month");
  const day = readPart("day");
  const hour = readPart("hour");
  const minute = readPart("minute");

  return {
    date: `${year}-${month}-${day}`,
    minuteOfDay: Number(hour) * 60 + Number(minute),
    month: `${year}-${month}`,
    time: `${hour}:${minute}`,
    weekday: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay(),
  };
}

function readMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function spansMidnight(window: VenueHoursWindow): boolean {
  return window.spansNextDay === true || readMinutes(window.end) <= readMinutes(window.start);
}

function getOpeningState(
  venueHours: VenueHoursCacheFields | null | undefined,
  now: Date | number,
): { current: BelgradeNow; open: boolean; previousDayCarry: boolean } | null {
  if (!Number.isFinite(now instanceof Date ? now.getTime() : now)) {
    return null;
  }

  const hours = parseVenueHoursJson(venueHours?.hoursJson);
  if (!hours || hours.source === "none") {
    return null;
  }

  const current = getBelgradeNow(now);
  const { minuteOfDay, weekday } = current;
  const previousWeekday = (weekday + 6) % 7;
  const currentWindows = hours.weekly
    .filter((day) => day.day === weekday && !day.closed)
    .flatMap((day) => day.windows.filter((window) => window.day === day.day));
  const previousWindows = hours.weekly
    .filter((day) => day.day === previousWeekday && !day.closed)
    .flatMap((day) => day.windows.filter((window) => window.day === day.day));
  const directCarry = previousWindows.some(
    (window) => spansMidnight(window) && minuteOfDay < readMinutes(window.end),
  );
  const currentOpen = currentWindows.some((window) =>
    minuteOfDay >= readMinutes(window.start) &&
    (spansMidnight(window) || minuteOfDay < readMinutes(window.end)),
  );
  // Google sometimes clips a single overnight period into two calendar days.
  const splitCarry = previousWindows.some(
    (window) => window.start !== "00:00" && window.end === "00:00" && spansMidnight(window),
  ) && currentWindows.some(
    (window) => window.start === "00:00" &&
      !spansMidnight(window) && minuteOfDay < readMinutes(window.end),
  );

  return { current, open: directCarry || currentOpen, previousDayCarry: directCarry || splitCarry };
}

/** Weekly venue opening hours only; this does not infer an event's start time. */
export function isVenueOpenNow(
  venueHours: VenueHoursCacheFields | null | undefined,
  now: Date | number = Date.now(),
): boolean {
  return getOpeningState(venueHours, now)?.open ?? false;
}

/** Show today's open venues plus yesterday's ongoing overnight openings. */
export function matchesOpenNowEvent(
  event: { date?: string | null; venueHours?: VenueHoursCacheFields | null },
  now: Date | number = Date.now(),
): boolean {
  const state = getOpeningState(event.venueHours, now);
  if (!state?.open || !event.date) {
    return false;
  }
  if (event.date === state.current.date) {
    return true;
  }
  if (!state.previousDayCarry) {
    return false;
  }

  const [year, month, day] = state.current.date.split("-").map(Number);
  const previousDate = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
  return event.date === previousDate;
}
