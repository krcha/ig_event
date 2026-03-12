const DEFAULT_EVENT_TIMEZONE = "Europe/Belgrade";
const EVENT_RETENTION_DAYS = 3;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type EventExpiryCutoff = {
  isoDate: string;
  minutesSinceMidnight: number;
};

function normalizeTimezone(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function getUtcDateTimeParts(date: Date): EventExpiryCutoff {
  return {
    isoDate: date.toISOString().slice(0, 10),
    minutesSinceMidnight: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

export function getConfiguredEventTimezone(): string {
  return normalizeTimezone(process.env.EVENTS_TIMEZONE) ?? DEFAULT_EVENT_TIMEZONE;
}

export function parseEventTimeMinutes(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return 0;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return 0;
  }

  return hours * 60 + minutes;
}

export function getEventExpiryCutoff(
  now = new Date(),
  timeZone = getConfiguredEventTimezone(),
): EventExpiryCutoff {
  const cutoffInstant = new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_IN_MS);

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(cutoffInstant);

    const values = new Map<string, string>();
    for (const part of parts) {
      if (part.type !== "literal") {
        values.set(part.type, part.value);
      }
    }

    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");

    if (!year || !month || !day || !hour || !minute) {
      return getUtcDateTimeParts(cutoffInstant);
    }

    return {
      isoDate: `${year}-${month}-${day}`,
      minutesSinceMidnight:
        Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10),
    };
  } catch {
    return getUtcDateTimeParts(cutoffInstant);
  }
}

export function isEventExpiredAtCutoff(
  event: { date: string; time?: string },
  cutoff: EventExpiryCutoff,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
    return false;
  }

  const dateComparison = event.date.localeCompare(cutoff.isoDate);
  if (dateComparison < 0) {
    return true;
  }
  if (dateComparison > 0) {
    return false;
  }

  return parseEventTimeMinutes(event.time) <= cutoff.minutesSinceMidnight;
}

export function formatMinutesSinceMidnight(value: number): string {
  const normalized = Math.max(0, Math.min(23 * 60 + 59, Math.trunc(value)));
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
