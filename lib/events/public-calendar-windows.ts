const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MAX_PUBLIC_CALENDAR_WINDOW_DAYS = 45;

function dateKeyToUtcMs(value: string): number | null {
  const match = value.match(DATE_KEY_PATTERN);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function formatUtcDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function buildPublicCalendarDateWindows(
  fromDate: string,
  beforeDate: string,
  maximumDays = MAX_PUBLIC_CALENDAR_WINDOW_DAYS,
): Array<{ fromDate: string; beforeDate: string }> {
  const fromTimestamp = dateKeyToUtcMs(fromDate);
  const beforeTimestamp = dateKeyToUtcMs(beforeDate);
  if (
    fromTimestamp === null ||
    beforeTimestamp === null ||
    fromTimestamp >= beforeTimestamp ||
    !Number.isInteger(maximumDays) ||
    maximumDays < 1
  ) {
    return [];
  }

  const maximumSpanMs = maximumDays * 86_400_000;
  const windows: Array<{ fromDate: string; beforeDate: string }> = [];
  for (let cursor = fromTimestamp; cursor < beforeTimestamp; ) {
    const next = Math.min(cursor + maximumSpanMs, beforeTimestamp);
    windows.push({
      fromDate: formatUtcDateKey(cursor),
      beforeDate: formatUtcDateKey(next),
    });
    cursor = next;
  }
  return windows;
}
