import {
  BELGRADE_TIMEZONE,
  type VenueHoursDay,
  type VenueHoursJson,
  type VenueHoursWindow,
} from "@/lib/venues/venue-hours-cache";

const GOOGLE_PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const GOOGLE_HOURS_FIELD_MASK = "id,regularOpeningHours";

export type GoogleTimePoint = {
  day?: number;
  hour?: number;
  minute?: number;
};

export type GooglePeriod = {
  close?: GoogleTimePoint;
  open?: GoogleTimePoint;
};

export type GoogleRegularOpeningHours = {
  periods?: GooglePeriod[];
  weekdayDescriptions?: string[];
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatGoogleTime(point: GoogleTimePoint): string | null {
  const hour = point.hour ?? 0;
  const minute = point.minute ?? 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

function isWeekday(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

// Google represents an always-open place as a single period with open day 0,
// time 00:00 and NO close field. The shared time labels cap at 23:59, so we
// render that as every day open 00:00-23:59 (reads as "open all day").
function buildAlwaysOpenWeekly(): VenueHoursDay[] {
  return Array.from({ length: 7 }, (_unused, day) => ({
    closed: false,
    day,
    windows: [{ day, end: "23:59", start: "00:00" }],
  }));
}

/**
 * Map Google Places `regularOpeningHours` into the app's VenueHoursJson.
 * Google weekday numbering is already 0 = Sunday, matching parseEventDateWeekday,
 * so no offset is applied. Handles overnight windows (close.day !== open.day),
 * split days (multiple periods on the same open.day), and 24/7 venues.
 */
export function mapGoogleOpeningHoursToVenueHoursJson(
  regularOpeningHours: GoogleRegularOpeningHours | null | undefined,
  options: { generatedAt: string; placeId?: string; timezone?: string },
): VenueHoursJson {
  const timezone = options.timezone ?? BELGRADE_TIMEZONE;
  const periods = regularOpeningHours?.periods ?? [];
  const alwaysOpen =
    periods.length === 1 &&
    Boolean(periods[0]?.open) &&
    !periods[0]?.close &&
    periods[0]?.open?.day === 0 &&
    (periods[0]?.open?.hour ?? 0) === 0 &&
    (periods[0]?.open?.minute ?? 0) === 0;

  let weekly: VenueHoursDay[];
  if (alwaysOpen) {
    weekly = buildAlwaysOpenWeekly();
  } else {
    const windowsByDay = new Map<number, VenueHoursWindow[]>();
    for (let day = 0; day < 7; day += 1) {
      windowsByDay.set(day, []);
    }

    for (const period of periods) {
      const open = period.open;
      const close = period.close;
      if (!open || !close || !isWeekday(open.day)) {
        continue;
      }
      const start = formatGoogleTime(open);
      const end = formatGoogleTime(close);
      if (!start || !end) {
        continue;
      }
      const spansNextDay = !isWeekday(close.day) || close.day !== open.day || end <= start;
      windowsByDay.get(open.day)?.push({
        day: open.day,
        end,
        ...(spansNextDay ? { spansNextDay: true } : {}),
        start,
      });
    }

    weekly = Array.from({ length: 7 }, (_unused, day) => {
      const windows = (windowsByDay.get(day) ?? []).sort((left, right) =>
        left.start.localeCompare(right.start),
      );
      return { closed: windows.length === 0, day, windows };
    });
  }

  return {
    generatedAt: options.generatedAt,
    raw: {
      placeId: options.placeId ?? null,
      source: "google",
      weekdayDescriptions: regularOpeningHours?.weekdayDescriptions ?? null,
    },
    source: "google",
    timezone,
    version: 1,
    weekly,
  };
}

export function venueHoursJsonHasWindows(hoursJson: VenueHoursJson): boolean {
  return hoursJson.weekly.some((day) => day.windows.length > 0);
}

/**
 * Fetch opening hours for a single Google place_id via Place Details (New).
 * Returns null when the place publishes no hours (so callers fall through to
 * an empty/none patch). Throws on HTTP errors so callers can log + skip.
 */
export async function fetchGoogleVenueHours(
  placeId: string,
  options: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    generatedAt: string;
    timezone?: string;
  },
): Promise<VenueHoursJson | null> {
  const trimmedPlaceId = placeId.trim();
  if (!trimmedPlaceId) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${GOOGLE_PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(trimmedPlaceId)}`,
    {
      headers: {
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": GOOGLE_HOURS_FIELD_MASK,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`google_places_${response.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }

  const data = (await response.json()) as {
    regularOpeningHours?: GoogleRegularOpeningHours;
  };
  if (!data.regularOpeningHours) {
    return null;
  }

  const hoursJson = mapGoogleOpeningHoursToVenueHoursJson(data.regularOpeningHours, {
    generatedAt: options.generatedAt,
    placeId: trimmedPlaceId,
    timezone: options.timezone,
  });

  return venueHoursJsonHasWindows(hoursJson) ? hoursJson : null;
}
