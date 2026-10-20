import {
  BELGRADE_TIMEZONE,
  parseVenueHoursJson,
  type VenueHoursCacheFields,
  type VenueHoursWindow,
} from "@/lib/venues/venue-hours-cache";
import { normalizeEventTime } from "../events/event-time.ts";

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
  timeZoneName: "longOffset",
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

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

type OpeningInterval = { end: number; start: number };
type InstantResolver = (wallMinutes: number, boundary: "start" | "end") => number | null;

function readDateMinutes(date: string | null | undefined): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    return null;
  }
  return parsed / 60_000;
}

function createBelgradeInstantResolver(): InstantResolver {
  const candidatesByWallMinute = new Map<number, number[]>();
  return (wallMinutes, boundary) => {
    let candidates = candidatesByWallMinute.get(wallMinutes);
    if (!candidates) {
      const wallTimestamp = wallMinutes * 60_000;
      const candidateOffsets = new Set<string>();
      // Sample both sides of any clock change, then round-trip the candidate.
      // An offset sampled only at noon can be wrong for an earlier event.
      for (const dayOffset of [-1, 0, 1]) {
        const zone = belgradeFormatter
          .formatToParts(wallTimestamp + dayOffset * 86_400_000)
          .find((part) => part.type === "timeZoneName")?.value;
        const offset = zone?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
        if (offset) {
          candidateOffsets.add(offset);
        }
      }
      const wallLabel = new Date(wallTimestamp).toISOString().slice(0, 16);
      candidates = [...candidateOffsets]
        .map((offset) => Date.parse(`${wallLabel}:00${offset}`))
        .filter((instant) => {
          const local = getBelgradeNow(instant);
          return `${local.date}T${local.time}` === wallLabel;
        })
        .sort((left, right) => left - right);
      candidatesByWallMinute.set(wallMinutes, candidates);
    }
    // A missing spring hour identifies no real instant. During the repeated
    // autumn hour use the widest supported interval, preventing disappearance
    // and revival when the local clock moves backward.
    return candidates.length
      ? candidates[boundary === "start" ? 0 : candidates.length - 1]
      : null;
  };
}

/** Calendar-minute coordinates describe Belgrade wall time, never the host timezone. */
function getOpeningIntervals(
  venueHours: VenueHoursCacheFields | null | undefined,
  date: string,
  lastDayOffset = 0,
): OpeningInterval[] {
  const hours = parseVenueHoursJson(venueHours?.hoursJson);
  const dateMinutes = readDateMinutes(date);
  if (!hours || hours.source === "none" || dateMinutes === null) {
    return [];
  }

  const weekday = new Date(dateMinutes * 60_000).getUTCDay();
  const intervals: OpeningInterval[] = [];
  for (let offset = -1; offset <= lastDayOffset; offset += 1) {
    const openingWeekday = (weekday + offset + 7) % 7;
    const dayStart = dateMinutes + offset * DAY_MINUTES;
    for (const day of hours.weekly) {
      if (day.day !== openingWeekday || day.closed) {
        continue;
      }
      for (const window of day.windows) {
        if (window.day !== day.day) {
          continue;
        }
        intervals.push({
          end: dayStart + readMinutes(window.end) + (spansMidnight(window) ? DAY_MINUTES : 0),
          start: dayStart + readMinutes(window.start),
        });
      }
    }
  }

  // A Google overnight period can end at midnight and resume at 00:00 on the
  // next day. Join touching periods, while preserving every actual closing gap.
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const continuous: OpeningInterval[] = [];
  for (const interval of intervals) {
    const previous = continuous[continuous.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      continuous.push({ ...interval });
    }
  }
  return continuous;
}

/** Presentation/filter assumption only; this never supplies canonical event-time evidence. */
export function getVenueClosingForEventStart(options: {
  date: string;
  startTime: string;
  venueHours?: VenueHoursCacheFields | null;
}): { date: string; time: string } | null {
  const closingMinutes = resolveVenueClosingMinutes(options, createBelgradeInstantResolver());
  if (closingMinutes === null) {
    return null;
  }
  const closing = new Date(closingMinutes * 60_000).toISOString();
  return { date: closing.slice(0, 10), time: closing.slice(11, 16) };
}

function resolveVenueClosingMinutes(options: {
  date: string;
  startTime: string;
  venueHours?: VenueHoursCacheFields | null;
}, resolveInstant: InstantResolver): number | null {
  const dateMinutes = readDateMinutes(options.date);
  if (dateMinutes === null || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(options.startTime)) {
    return null;
  }
  const intervals = getOpeningIntervals(options.venueHours, options.date, 8);
  if (intervals.length === 0) {
    return null;
  }
  const eventStart = dateMinutes + readMinutes(options.startTime);
  const eventStartInstant = resolveInstant(eventStart, "start");
  if (eventStartInstant === null) {
    return null;
  }
  const opening = intervals.find((interval) => {
    const start = resolveInstant(interval.start, "start");
    const end = resolveInstant(interval.end, "end");
    return start !== null && end !== null && start <= eventStartInstant && eventStartInstant < end;
  });
  // A full uninterrupted weekly cycle means the place is always open. It does
  // not establish an event end, and must not acquire an artificial closing time.
  if (!opening || opening.end - eventStart >= WEEK_MINUTES) {
    return null;
  }

  return opening.end;
}

function getOpeningState(
  venueHours: VenueHoursCacheFields | null | undefined,
  now: Date | number,
): { current: BelgradeNow; open: boolean; previousDayCarry: boolean } | null {
  if (!Number.isFinite(now instanceof Date ? now.getTime() : now)) {
    return null;
  }

  const current = getBelgradeNow(now);
  const todayStart = readDateMinutes(current.date)!;
  const nowTimestamp = now instanceof Date ? now.getTime() : now;
  const resolveInstant = createBelgradeInstantResolver();
  const activeOpening = getOpeningIntervals(venueHours, current.date).find((interval) => {
    const start = resolveInstant(interval.start, "start");
    const end = resolveInstant(interval.end, "end");
    return start !== null && end !== null && start <= nowTimestamp && nowTimestamp < end;
  });

  // All-day cycles establish that the place is open, but do not establish that
  // yesterday's unknown-time event continues through today's new calendar day.
  const previousDayCarry = Boolean(activeOpening &&
    activeOpening.start < todayStart &&
    activeOpening.start % DAY_MINUTES !== 0 &&
    activeOpening.end - activeOpening.start < DAY_MINUTES);
  return { current, open: Boolean(activeOpening), previousDayCarry };
}

/** Weekly venue opening hours only; this does not infer an event's start time. */
export function isVenueOpenNow(
  venueHours: VenueHoursCacheFields | null | undefined,
  now: Date | number = Date.now(),
): boolean {
  return getOpeningState(venueHours, now)?.open ?? false;
}

/** Apply announced event bounds first, with venue closing as a start-only fallback. */
export function matchesOpenNowEvent(
  event: { date?: string | null; time?: string | null; venueHours?: VenueHoursCacheFields | null },
  now: Date | number = Date.now(),
): boolean {
  const nowTimestamp = now instanceof Date ? now.getTime() : now;
  const dateMinutes = readDateMinutes(event.date);
  if (!Number.isFinite(nowTimestamp) || dateMinutes === null) {
    return false;
  }

  const eventTime = normalizeEventTime(event.time);
  if (eventTime.startLabel) {
    const resolveInstant = createBelgradeInstantResolver();
    const start = dateMinutes + readMinutes(eventTime.startLabel);
    let end: number;
    if (eventTime.endLabel) {
      end = dateMinutes + readMinutes(eventTime.endLabel);
      if (end <= start) {
        end += DAY_MINUTES;
      }
    } else {
      const closing = resolveVenueClosingMinutes({
        date: event.date!,
        startTime: eventTime.startLabel,
        venueHours: event.venueHours,
      }, resolveInstant);
      if (closing === null) {
        return false;
      }
      end = closing;
    }
    const startInstant = resolveInstant(start, "start");
    const endInstant = resolveInstant(end, "end");
    return startInstant !== null && endInstant !== null &&
      startInstant <= nowTimestamp && nowTimestamp < endInstant;
  }

  // Unknown event times still use venue availability for today, or the verified
  // continuation of yesterday's overnight opening.
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
