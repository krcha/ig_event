import OpeningHours from "opening_hours";
import {
  BELGRADE_TIMEZONE,
  VENUE_HOURS_CACHE_TTL_MS,
  createEmptyVenueHoursJson,
  serializeVenueHoursJson,
  shouldRefreshVenueHoursCache,
  type VenueHoursCacheFields,
  type VenueHoursDay,
  type VenueHoursJson,
  type VenueHoursSource,
  type VenueHoursWindow,
} from "@/lib/venues/venue-hours-cache";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";

const BELGRADE_BBOX = {
  east: 20.62,
  north: 44.9,
  south: 44.68,
  west: 20.32,
};
const BELGRADE_CENTER = {
  lat: 44.8125,
  lon: 20.4612,
};
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_USER_AGENT = "ig-event venue-hours refresh";
const OVERPASS_NAME_TAGS = ["name", "name:en", "name:sr", "alt_name"] as const;
const GOOGLE_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";
const GOOGLE_TEXT_SEARCH_FIELD_MASK = "places.id,places.name,places.displayName,places.formattedAddress";
const GOOGLE_PLACE_DETAILS_FIELD_MASK =
  "regularOpeningHours,currentOpeningHours,timeZone";

type FetchLike = typeof fetch;

export type VenueForHoursRefresh = VenueHoursCacheFields & {
  _id?: string;
  isActive?: boolean;
  location?: string | null;
  name: string;
};

export type VenueHoursPatch = {
  googlePlaceId: string;
  hoursError: string;
  hoursExpiresAt: number;
  hoursFetchedAt: number;
  hoursJson: string;
  hoursSource: VenueHoursSource;
  hoursTimezone: string;
  osmElementId: string;
  osmElementType: string;
};

export type VenueHoursRefreshOptions = {
  force?: boolean;
  googleApiKey?: string;
  googleFetch?: FetchLike;
  now?: number;
  overpassFetch?: FetchLike;
};

type OverpassElement = {
  center?: { lat?: number; lon?: number };
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  type: "node" | "way" | "relation";
};

type GooglePlaceSummary = {
  displayName?: { text?: string };
  formattedAddress?: string;
  id?: string;
  name?: string;
};

type GoogleOpeningPoint = {
  day?: number;
  hour?: number;
  minute?: number;
};

type GoogleOpeningPeriod = {
  close?: GoogleOpeningPoint;
  open?: GoogleOpeningPoint;
};

type GoogleOpeningHours = {
  periods?: GoogleOpeningPeriod[];
  weekdayDescriptions?: string[];
};

type GooglePlaceDetails = {
  currentOpeningHours?: GoogleOpeningHours;
  regularOpeningHours?: GoogleOpeningHours;
  timeZone?: string | { id?: string };
};

type ProviderResult = {
  googlePlaceId?: string;
  hoursJson: VenueHoursJson;
  osmElementId?: string;
  osmElementType?: string;
  source: VenueHoursSource;
};

function formatTimeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(
    2,
    "0",
  )}`;
}

function formatGoogleTime(point: GoogleOpeningPoint | undefined, fallback = "00:00"): string {
  if (!point || !Number.isInteger(point.hour) || !Number.isInteger(point.minute)) {
    return fallback;
  }

  const hour = Math.max(0, Math.min(23, point.hour ?? 0));
  const minute = Math.max(0, Math.min(59, point.minute ?? 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoogleWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function createWeekSkeleton(): VenueHoursDay[] {
  return Array.from({ length: 7 }, (_, day) => ({
    closed: true,
    day,
    windows: [],
  }));
}

function startOfSundayWeek(referenceDate: Date): Date {
  const start = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
  );
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

function buildVenueHoursJson(options: {
  generatedAt: string;
  raw?: Record<string, unknown>;
  source: VenueHoursSource;
  timezone?: string;
  weekly: VenueHoursDay[];
}): VenueHoursJson {
  return {
    generatedAt: options.generatedAt,
    raw: options.raw,
    source: options.source,
    timezone: options.timezone ?? BELGRADE_TIMEZONE,
    version: 1,
    weekly: options.weekly,
  };
}

function sortWeeklyWindows(weekly: VenueHoursDay[]): VenueHoursDay[] {
  return weekly.map((day) => ({
    ...day,
    closed: day.windows.length === 0,
    windows: [...day.windows].sort((left, right) => left.start.localeCompare(right.start)),
  }));
}

export function normalizeOsmOpeningHours(
  openingHoursValue: string,
  options: {
    generatedAt?: string;
    referenceDate?: Date;
    raw?: Record<string, unknown>;
  } = {},
): VenueHoursJson {
  const referenceDate = options.referenceDate ?? new Date();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const openingHours = new OpeningHours(openingHoursValue, {
    address: { country_code: "rs", state: "Belgrade" },
    lat: BELGRADE_CENTER.lat,
    lon: BELGRADE_CENTER.lon,
  });
  const weekStart = startOfSundayWeek(referenceDate);
  const weekly = createWeekSkeleton();

  for (let offset = 0; offset < 7; offset += 1) {
    const dayStart = new Date(weekStart);
    dayStart.setDate(weekStart.getDate() + offset);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);
    const intervalStart = new Date(dayStart);
    intervalStart.setDate(dayStart.getDate() - 1);
    const intervalEnd = new Date(dayEnd);
    intervalEnd.setDate(dayEnd.getDate() + 1);
    const intervals = openingHours.getOpenIntervals(intervalStart, intervalEnd);
    const windows = intervals
      .filter(([start]) => start >= dayStart && start < dayEnd)
      .map(([start, end]): VenueHoursWindow => {
        const startLabel = formatTimeLabel(start);
        const endLabel = formatTimeLabel(end);
        return {
          day: dayStart.getDay(),
          end: endLabel,
          ...(end.getDate() !== start.getDate() || endLabel <= startLabel
            ? { spansNextDay: true }
            : {}),
          start: startLabel,
        };
      });

    weekly[dayStart.getDay()] = {
      closed: windows.length === 0,
      day: dayStart.getDay(),
      windows,
    };
  }

  return buildVenueHoursJson({
    generatedAt,
    raw: {
      opening_hours: openingHoursValue,
      warnings: openingHours.getWarnings(),
      ...options.raw,
    },
    source: "osm",
    weekly: sortWeeklyWindows(weekly),
  });
}

function normalizeGoogleOpeningHours(
  details: GooglePlaceDetails,
  options: {
    generatedAt?: string;
    placeSummary?: GooglePlaceSummary;
  } = {},
): VenueHoursJson | null {
  const hours = details.currentOpeningHours ?? details.regularOpeningHours;
  if (!hours || !Array.isArray(hours.periods) || hours.periods.length === 0) {
    return null;
  }

  const periods = hours.periods;
  const weekly = createWeekSkeleton();
  for (const period of periods) {
    const openDay = period.open?.day;
    if (!isGoogleWeekday(openDay)) {
      continue;
    }

    const start = formatGoogleTime(period.open);
    const end = formatGoogleTime(period.close, "23:59");
    const closeDay = period.close?.day;
    const window: VenueHoursWindow = {
      day: openDay,
      end,
      ...(Number.isInteger(closeDay) && closeDay !== openDay ? { spansNextDay: true } : {}),
      start,
    };
    weekly[openDay].windows.push(window);
    weekly[openDay].closed = false;
  }

  const hasWindows = weekly.some((day) => day.windows.length > 0);
  if (!hasWindows) {
    return null;
  }

  const timezone =
    typeof details.timeZone === "string"
      ? details.timeZone
      : details.timeZone?.id ?? BELGRADE_TIMEZONE;

  return buildVenueHoursJson({
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    raw: {
      currentOpeningHours: Boolean(details.currentOpeningHours),
      formattedAddress: options.placeSummary?.formattedAddress,
      googleName: options.placeSummary?.displayName?.text ?? options.placeSummary?.name,
      regularOpeningHours: Boolean(details.regularOpeningHours),
      weekdayDescriptions: hours.weekdayDescriptions?.slice(0, 7),
    },
    source: "google",
    timezone,
    weekly: sortWeeklyWindows(weekly),
  });
}

function cleanVenueNameSearchTerm(value: string): string {
  return value
    .replace(/^[\s"'“”‘’#@•·|,:;!?-]+|[\s"'“”‘’•·|,:;!?-]+$/gu, "")
    .replace(/[^\p{L}\p{N}\s&'’./-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildVenueNameSearchTerms(venueName: string): string[] {
  const splitTerms = venueName
    .split(/\s+(?:\||·|•)\s+|\s+[x×]\s+/iu)
    .map(cleanVenueNameSearchTerm);
  const terms = [
    cleanVenueNameSearchTerm(venueName),
    ...splitTerms,
    cleanVenueNameSearchTerm(toSearchableText(venueName)),
  ].filter((term) => term.length >= 2);

  return [...new Set(terms)].slice(0, 4);
}

function escapeOverpassRegex(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[.*+?^${}()|[\]]/g, "\\$&");
}

function buildOverpassQuery(venueName: string): string | null {
  const terms = buildVenueNameSearchTerms(venueName);
  if (terms.length === 0) {
    return null;
  }

  const bbox = `${BELGRADE_BBOX.south},${BELGRADE_BBOX.west},${BELGRADE_BBOX.north},${BELGRADE_BBOX.east}`;
  const selectors = terms.flatMap((term) => {
    const escapedName = escapeOverpassRegex(term);
    return OVERPASS_NAME_TAGS.flatMap((tag) => [
      `  node["${tag}"~"${escapedName}",i]["opening_hours"](${bbox});`,
      `  way["${tag}"~"${escapedName}",i]["opening_hours"](${bbox});`,
      `  relation["${tag}"~"${escapedName}",i]["opening_hours"](${bbox});`,
    ]);
  });

  return `
[out:json][timeout:20];
(
${selectors.join("\n")}
);
out center tags 20;
`;
}

function scoreOsmElement(element: OverpassElement, venueName: string): number {
  const requested = toSearchableText(venueName);
  const candidateNames = [
    element.tags?.name,
    element.tags?.["name:en"],
    element.tags?.["name:sr"],
    element.tags?.alt_name,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => toSearchableText(value));

  if (candidateNames.some((candidate) => candidate === requested)) {
    return 100;
  }

  if (candidateNames.some((candidate) => candidate.includes(requested))) {
    return 70;
  }

  if (candidateNames.some((candidate) => requested.includes(candidate))) {
    return 60;
  }

  return 0;
}

async function readJsonResponse(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${provider}_${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }

  return response.json() as Promise<unknown>;
}

async function fetchOsmHours(
  venue: VenueForHoursRefresh,
  options: Required<Pick<VenueHoursRefreshOptions, "overpassFetch">> & {
    generatedAt: string;
  },
): Promise<ProviderResult | null> {
  const venueName = venue.name.trim();
  if (!venueName) {
    return null;
  }

  const query = buildOverpassQuery(venueName);
  if (!query) {
    return null;
  }

  const response = await options.overpassFetch(OVERPASS_URL, {
    body: new URLSearchParams({ data: query }).toString(),
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": OVERPASS_USER_AGENT,
    },
    method: "POST",
  });
  const data = await readJsonResponse(response, "overpass");
  const elements = isRecord(data) && Array.isArray(data.elements) ? data.elements : [];
  const candidates = elements
    .filter((element): element is OverpassElement => {
      if (!isRecord(element) || typeof element.id !== "number") {
        return false;
      }
      return (
        (element.type === "node" || element.type === "way" || element.type === "relation") &&
        isRecord(element.tags) &&
        typeof element.tags.opening_hours === "string"
      );
    })
    .map((element) => ({ element, score: scoreOsmElement(element, venueName) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = candidates[0]?.element;
  const openingHoursValue = best?.tags?.opening_hours;
  if (!best || !openingHoursValue) {
    return null;
  }

  const hoursJson = normalizeOsmOpeningHours(openingHoursValue, {
    generatedAt: options.generatedAt,
    raw: {
      elementId: best.id,
      elementType: best.type,
      name: best.tags?.name,
    },
  });

  return {
    hoursJson,
    osmElementId: String(best.id),
    osmElementType: best.type,
    source: "osm",
  };
}

function getGooglePlaceId(place: GooglePlaceSummary): string | undefined {
  return place.id ?? place.name?.replace(/^places\//, "");
}

async function fetchGoogleHours(
  venue: VenueForHoursRefresh,
  options: Required<Pick<VenueHoursRefreshOptions, "googleFetch" | "googleApiKey">> & {
    generatedAt: string;
  },
): Promise<ProviderResult | null> {
  const textSearchResponse = await options.googleFetch(GOOGLE_TEXT_SEARCH_URL, {
    body: JSON.stringify({
      languageCode: "en",
      textQuery: `${venue.name} Belgrade`,
    }),
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": options.googleApiKey,
      "x-goog-fieldmask": GOOGLE_TEXT_SEARCH_FIELD_MASK,
    },
    method: "POST",
  });
  const textSearchData = await readJsonResponse(textSearchResponse, "google_text_search");
  const places = isRecord(textSearchData) && Array.isArray(textSearchData.places)
    ? textSearchData.places
    : [];
  const place = places.find((candidate): candidate is GooglePlaceSummary => isRecord(candidate));
  const placeId = place ? getGooglePlaceId(place) : undefined;
  if (!placeId) {
    return null;
  }

  const detailsResponse = await options.googleFetch(
    `${GOOGLE_PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`,
    {
      headers: {
        "x-goog-api-key": options.googleApiKey,
        "x-goog-fieldmask": GOOGLE_PLACE_DETAILS_FIELD_MASK,
      },
      method: "GET",
    },
  );
  const detailsData = await readJsonResponse(detailsResponse, "google_place_details");
  const details = isRecord(detailsData) ? (detailsData as GooglePlaceDetails) : {};
  const hoursJson = normalizeGoogleOpeningHours(details, {
    generatedAt: options.generatedAt,
    placeSummary: place,
  });
  if (!hoursJson) {
    return null;
  }

  return {
    googlePlaceId: placeId,
    hoursJson,
    source: "google",
  };
}

function createPatchFromProviderResult(
  result: ProviderResult,
  now: number,
  error = "",
): VenueHoursPatch {
  return {
    googlePlaceId: result.googlePlaceId ?? "",
    hoursError: error,
    hoursExpiresAt: now + VENUE_HOURS_CACHE_TTL_MS,
    hoursFetchedAt: now,
    hoursJson: serializeVenueHoursJson(result.hoursJson),
    hoursSource: result.source,
    hoursTimezone: result.hoursJson.timezone,
    osmElementId: result.osmElementId ?? "",
    osmElementType: result.osmElementType ?? "",
  };
}

function createNonePatch(error: string, now: number): VenueHoursPatch {
  const generatedAt = new Date(now).toISOString();
  return {
    googlePlaceId: "",
    hoursError: error,
    hoursExpiresAt: now + VENUE_HOURS_CACHE_TTL_MS,
    hoursFetchedAt: now,
    hoursJson: serializeVenueHoursJson(createEmptyVenueHoursJson({ error, generatedAt })),
    hoursSource: "none",
    hoursTimezone: BELGRADE_TIMEZONE,
    osmElementId: "",
    osmElementType: "",
  };
}

export async function fetchVenueHoursPatch(
  venue: VenueForHoursRefresh,
  options: VenueHoursRefreshOptions = {},
): Promise<VenueHoursPatch | null> {
  const now = options.now ?? Date.now();
  if (!options.force && !shouldRefreshVenueHoursCache(venue, now)) {
    return null;
  }

  const generatedAt = new Date(now).toISOString();
  const overpassFetch = options.overpassFetch ?? fetch;
  const googleFetch = options.googleFetch ?? fetch;
  const googleApiKey = options.googleApiKey ?? process.env.GOOGLE_PLACES_API_KEY?.trim();
  const errors: string[] = [];
  let providerError = false;

  try {
    const osmResult = await fetchOsmHours(venue, { generatedAt, overpassFetch });
    if (osmResult) {
      return createPatchFromProviderResult(osmResult, now);
    }
    errors.push("osm_no_match");
  } catch (error) {
    providerError = true;
    errors.push(error instanceof Error ? `osm_error:${error.message}` : "osm_error");
  }

  if (!googleApiKey) {
    errors.push("google_api_key_missing");
    if (providerError) {
      throw new Error(errors.join(";"));
    }
    return createNonePatch(errors.join(";"), now);
  }

  try {
    const googleResult = await fetchGoogleHours(venue, {
      generatedAt,
      googleApiKey,
      googleFetch,
    });
    if (googleResult) {
      return createPatchFromProviderResult(googleResult, now, errors.join(";"));
    }
    errors.push("google_no_match_or_no_hours");
  } catch (error) {
    providerError = true;
    errors.push(error instanceof Error ? `google_error:${error.message}` : "google_error");
  }

  if (providerError) {
    throw new Error(errors.join(";"));
  }

  return createNonePatch(errors.join(";"), now);
}
