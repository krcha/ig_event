export type VenueHoursSource = "osm" | "google" | "manual" | "none";

export type VenueHoursWindow = {
  day: number;
  end: string;
  spansNextDay?: boolean;
  start: string;
};

export type VenueHoursDay = {
  closed: boolean;
  day: number;
  windows: VenueHoursWindow[];
};

export type VenueHoursJson = {
  generatedAt: string;
  raw?: Record<string, unknown>;
  source: VenueHoursSource;
  timezone: string;
  version: 1;
  weekly: VenueHoursDay[];
};

export type VenueHoursCacheFields = {
  googlePlaceId?: string | null;
  hoursError?: string | null;
  hoursExpiresAt?: number | null;
  hoursFetchedAt?: number | null;
  hoursJson?: string | null;
  hoursSource?: VenueHoursSource | null;
  hoursTimezone?: string | null;
  osmElementId?: string | null;
  osmElementType?: string | null;
};

export type VenueHoursWindowForDate =
  | { status: "closed" }
  | { status: "open"; window: VenueHoursWindow }
  | { status: "unknown" };

export const BELGRADE_TIMEZONE = "Europe/Belgrade";
export const VENUE_HOURS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const TIME_LABEL_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVenueHoursSource(value: unknown): value is VenueHoursSource {
  return value === "osm" || value === "google" || value === "manual" || value === "none";
}

function isTimeLabel(value: unknown): value is string {
  return typeof value === "string" && TIME_LABEL_PATTERN.test(value);
}

function normalizeWeekday(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) {
    return null;
  }

  return value;
}

function parseVenueHoursWindow(value: unknown): VenueHoursWindow | null {
  if (!isRecord(value)) {
    return null;
  }

  const day = normalizeWeekday(value.day);
  if (day === null || !isTimeLabel(value.start) || !isTimeLabel(value.end)) {
    return null;
  }

  return {
    day,
    end: value.end,
    ...(value.spansNextDay === true ? { spansNextDay: true } : {}),
    start: value.start,
  };
}

function parseVenueHoursDay(value: unknown): VenueHoursDay | null {
  if (!isRecord(value)) {
    return null;
  }

  const day = normalizeWeekday(value.day);
  if (day === null || !Array.isArray(value.windows)) {
    return null;
  }

  const windows = value.windows
    .map(parseVenueHoursWindow)
    .filter((window): window is VenueHoursWindow => Boolean(window))
    .sort((left, right) => left.start.localeCompare(right.start));

  return {
    closed: value.closed === true || windows.length === 0,
    day,
    windows,
  };
}

export function parseVenueHoursJson(value: string | null | undefined): VenueHoursJson | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isVenueHoursSource(parsed.source)) {
      return null;
    }

    const timezone = typeof parsed.timezone === "string" ? parsed.timezone : BELGRADE_TIMEZONE;
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
    const weekly = Array.isArray(parsed.weekly)
      ? parsed.weekly
          .map(parseVenueHoursDay)
          .filter((day): day is VenueHoursDay => Boolean(day))
      : [];

    return {
      generatedAt,
      raw: isRecord(parsed.raw) ? parsed.raw : undefined,
      source: parsed.source,
      timezone,
      version: 1,
      weekly,
    };
  } catch {
    return null;
  }
}

export function serializeVenueHoursJson(value: VenueHoursJson): string {
  return JSON.stringify(value);
}

export function parseEventDateWeekday(value: string | null | undefined): number | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed.getDay();
}

export function getVenueHoursWindowForDate(
  venueHours: VenueHoursCacheFields | null | undefined,
  eventDate: string | null | undefined,
): VenueHoursWindowForDate {
  const hoursJson = parseVenueHoursJson(venueHours?.hoursJson);
  const weekday = parseEventDateWeekday(eventDate);
  if (!hoursJson || weekday === null) {
    return { status: "unknown" };
  }

  const day = hoursJson.weekly.find((candidate) => candidate.day === weekday);
  if (!day) {
    return { status: "unknown" };
  }

  const window = day.windows[0];
  if (!window || day.closed) {
    return { status: "closed" };
  }

  return { status: "open", window };
}

export function shouldRefreshVenueHoursCache(
  venueHours: VenueHoursCacheFields,
  now = Date.now(),
): boolean {
  if (venueHours.hoursSource === "manual" && venueHours.hoursJson) {
    return false;
  }

  return !venueHours.hoursExpiresAt || venueHours.hoursExpiresAt < now;
}

export function formatVenueHoursWindow(window: VenueHoursWindow): string {
  return `${window.start}–${window.end}`;
}

export function createEmptyVenueHoursJson(options: {
  error?: string;
  generatedAt: string;
  source?: VenueHoursSource;
  timezone?: string;
}): VenueHoursJson {
  return {
    generatedAt: options.generatedAt,
    raw: options.error ? { error: options.error } : undefined,
    source: options.source ?? "none",
    timezone: options.timezone ?? BELGRADE_TIMEZONE,
    version: 1,
    weekly: [],
  };
}
