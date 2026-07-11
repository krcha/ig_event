export const NIGHTLIFE_EVENT_TIME_ZONE = "Europe/Belgrade";
export const NIGHTLIFE_BUSINESS_DAY_ROLLOVER_HOUR = 7;

function getDateTimeParts(
  now: Date,
  timeZone = NIGHTLIFE_EVENT_TIME_ZONE,
): { day: number; hour: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    day: Number.parseInt(values.get("day") ?? "1", 10),
    hour: Number.parseInt(values.get("hour") ?? "0", 10),
    month: Number.parseInt(values.get("month") ?? "1", 10),
    year: Number.parseInt(values.get("year") ?? "1970", 10),
  };
}

export function parseDateKeyToUtcNoon(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, 12));
}

export function dateKeyToLocalNoonDate(value: string): Date {
  const parsed = parseDateKeyToUtcNoon(value);
  if (!parsed) {
    return new Date();
  }

  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12);
}

export function formatUtcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function addDaysToDateKey(value: string, days: number): string {
  const date = parseDateKeyToUtcNoon(value);
  if (!date) {
    return value;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDateKey(date);
}

export function getCalendarDateKeyInTimeZone(
  now = new Date(),
  timeZone = NIGHTLIFE_EVENT_TIME_ZONE,
): string {
  const { day, month, year } = getDateTimeParts(now, timeZone);
  return formatUtcDateKey(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function getNightlifeDefaultDateKey(
  now = new Date(),
  options: { rolloverHour?: number; timeZone?: string } = {},
): string {
  const rolloverHour = options.rolloverHour ?? NIGHTLIFE_BUSINESS_DAY_ROLLOVER_HOUR;
  const timeZone = options.timeZone ?? NIGHTLIFE_EVENT_TIME_ZONE;
  const { day, hour, month, year } = getDateTimeParts(now, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  if (hour < rolloverHour) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return formatUtcDateKey(date);
}
