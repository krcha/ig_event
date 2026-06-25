import OpeningHours from "opening_hours";
import {
  BELGRADE_TIMEZONE,
  VENUE_HOURS_CACHE_TTL_MS,
  createEmptyVenueHoursJson,
  parseVenueHoursJson,
  serializeVenueHoursJson,
  shouldRefreshVenueHoursCache,
  type VenueHoursCacheFields,
  type VenueHoursDay,
  type VenueHoursJson,
  type VenueHoursSource,
  type VenueHoursWindow,
} from "@/lib/venues/venue-hours-cache";
import {
  normalizeVenueComparableText,
  toSearchableText,
} from "@/lib/pipeline/venue-normalization";
import { fetchGoogleVenueHours } from "@/lib/venues/google-hours";

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
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_USER_AGENT = "ig-event venue-hours refresh";
const OVERPASS_NAME_TAGS = ["name", "name:en", "name:sr", "alt_name"] as const;
const OSM_VENUE_SEARCH_ALIASES: Record<string, string[]> = {
  "20 44": ["20/44", "Klub 20/44"],
  "akademija 28": ["Akademija 28", "Академија 28"],
  "ben akiba beograd": ["Ben Akiba Comedy Club & Bar", "Ben Akiba"],
  chillton: ["Chillton", "Чилтон"],
  drugstore: ["Drugstore Beograd", "Drugstore"],
  "kc grad": ["KC Grad", "КЦ Град", "Kulturni centar Grad"],
  "klub 20 44": ["20/44", "Klub 20/44"],
  "kulturni centar grad": ["KC Grad", "КЦ Град", "Kulturni centar Grad"],
  "nula pet": ["Nula Pet", "Pab 0,5"],
  "pab 0 5": ["Nula Pet", "Pab 0,5"],
  "pricica coffee bar": ["Pričica Coffee Bar", "Pricica Coffee Bar"],
  silosi: ["Silosi Beograd", "Silosi"],
  "zappa baza": ["Zappa Baza"],
};
const OSM_VENUE_SEARCH_ALIASES_BY_HANDLE: Record<string, string[]> = {
  "20_44.nightclub": ["20/44", "Klub 20/44"],
  "_azbuka": ["Azbuka"],
  "berlinmonroe_craftroom": ["Berlin Monroe"],
  "betonbelgrade": ["Beton", "Beton Club", "Beton Club & Event Center"],
  "bitefartcafe": ["Bitef Art Cafe", "BitefArtCafe"],
  "bluzipivobar": ["Bluz i Pivo"],
  "cincin_belgrade": ["Čin Čin", "Cin Cin"],
  "dorcolplatz": ["Dorćol Platz", "Dorcol Platz"],
  "eje.belgrade": ["EJE", "Esthetic Joys Embassy"],
  "heartefact_": ["Hartefakt", "Heartefact"],
  "kcgrad": ["KC Grad", "Kulturni centar Grad"],
  "klubstudenatatehnike": ["KST", "Klub Studenata Tehnike"],
  "kranbeograd": ["Klub Kran", "Kran"],
  "kucicanavodi": ["Kućica na vodi", "Kucica na vodi", "Kućica"],
  "kvaka22_catch22": ["Kvaka 22", "Catch 22"],
  "muzej_jugoslavije": ["Muzej Jugoslavije"],
  "nulapet_0.5": ["Nula Pet", "Pab 0,5"],
  "pakaoklubbeograd": ["Pakao"],
  "silosibeograd": ["Silosi", "Silosi Beograd"],
  "sinnermanjazzclub": ["Sinnerman Jazz Club", "Sinnerman"],
  "umami.bg": ["Umami"],
  "vinyl.belgrade": ["Vinyl", "Vinyl Nightclub"],
  "vrtoglavicaklub": ["Vrtoglavica", "Klub Vrtoglavica"],
  "zappabarka": ["Zappa Barka", "Nova Zappa Barka"],
};
const GENERIC_OSM_SEARCH_TERMS = new Set([
  "bar",
  "beograd",
  "belgrade",
  "bg",
  "cafe",
  "club",
  "event",
  "events",
  "official",
  "pub",
  "rs",
  "serbia",
]);

type FetchLike = typeof fetch;

export type VenueForHoursRefresh = VenueHoursCacheFields & {
  _id?: string;
  instagramHandle?: string | null;
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
  nominatimFetch?: FetchLike;
  now?: number;
  overpassFallback?: boolean;
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

type ProviderResult = {
  googlePlaceId?: string;
  hoursJson: VenueHoursJson;
  osmElementId?: string;
  osmElementType?: string;
  source: VenueHoursSource;
};

type NominatimPlace = {
  address?: Record<string, string>;
  category?: string;
  display_name?: string;
  extratags?: Record<string, string>;
  name?: string;
  osm_id?: number | string;
  osm_type?: string;
  type?: string;
};

type NominatimSearchResult = {
  matchedWithoutHours: boolean;
  result: ProviderResult | null;
};

function formatTimeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(
    2,
    "0",
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function hasWeeklyWindows(hoursJson: VenueHoursJson): boolean {
  return hoursJson.weekly.some((day) => day.windows.length > 0);
}

function hasStoredUsableProviderHours(venue: VenueForHoursRefresh): boolean {
  if (
    venue.hoursSource !== "google" &&
    venue.hoursSource !== "manual" &&
    venue.hoursSource !== "osm"
  ) {
    return false;
  }
  const hoursJson = parseVenueHoursJson(venue.hoursJson);
  return Boolean(hoursJson && hasWeeklyWindows(hoursJson));
}

export function normalizeOsmOpeningHours(
  openingHoursValue: string,
  options: {
    generatedAt?: string;
    referenceDate?: Date;
    raw?: Record<string, unknown>;
    source?: Extract<VenueHoursSource, "manual" | "osm">;
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
    source: options.source ?? "osm",
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

function stripSafeVenueSearchSuffixes(value: string): string {
  return cleanVenueNameSearchTerm(value)
    .replace(/\b(?:official|beograd|belgrade|serbia)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripGenericVenueSearchDescriptors(value: string): string {
  return cleanVenueNameSearchTerm(value)
    .replace(/\b(?:official|beograd|belgrade|serbia)\b/giu, " ")
    .replace(
      /\b(?:restaurant\s*&\s*bar|cocktail\s+bar|lounge\s+bar|night\s*club|nightclub|event\s+center|coffee\s*&\s*breakfast|fine\s+bistro)\b/giu,
      " ",
    )
    .replace(/\b(?:gastro\s+bar|music\s+studio|creative\s+space)\b/giu, " ")
    .replace(/\b(?:club|klub|pub|pab|bar|cafe|coffee|bistro)\b$/iu, " ")
    .replace(/^(?:club|klub|pub|pab|bar|cafe|coffee|gastro\s+bar)\b/iu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeInstagramHandleForSearch(instagramHandle: string | null | undefined): string {
  return (instagramHandle ?? "").replace(/^@/, "").trim().toLowerCase();
}

function buildHandleAliasSearchTerms(instagramHandle: string | null | undefined): string[] {
  const handle = normalizeInstagramHandleForSearch(instagramHandle);
  return handle ? (OSM_VENUE_SEARCH_ALIASES_BY_HANDLE[handle] ?? []) : [];
}

function buildDerivedHandleSearchTerms(instagramHandle: string | null | undefined): string[] {
  const handle = normalizeInstagramHandleForSearch(instagramHandle);
  if (!handle) {
    return [];
  }

  const spacedHandle = handle
    .replace(/[._-]+/g, " ")
    .replace(/\b(?:bg|rs|ofc|official)\b/g, " ")
    .replace(/(?:beograd|belgrade)$/g, "")
    .replace(/^(?:club|klub)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return [cleanVenueNameSearchTerm(spacedHandle)];
}

function isUsefulVenueSearchTerm(value: string): boolean {
  const comparable = normalizeVenueComparableText(value);
  if (!comparable || comparable.length < 2) {
    return false;
  }
  if (GENERIC_OSM_SEARCH_TERMS.has(comparable)) {
    return false;
  }
  return /[a-z0-9]/i.test(toSearchableText(value));
}

function buildVenueNameSearchTerms(
  venueName: string,
  instagramHandle?: string | null,
): string[] {
  const aliasTerms = OSM_VENUE_SEARCH_ALIASES[normalizeVenueComparableText(venueName)] ?? [];
  const handleAliasTerms = buildHandleAliasSearchTerms(instagramHandle);
  const derivedHandleTerms = buildDerivedHandleSearchTerms(instagramHandle);
  const splitTerms = venueName
    .split(/\s+(?:\||·|•|\/|—)\s+|\s+[x×]\s+/iu)
    .map(cleanVenueNameSearchTerm);
  const descriptorTerms = [
    cleanVenueNameSearchTerm(venueName),
    ...splitTerms,
    cleanVenueNameSearchTerm(toSearchableText(venueName)),
  ]
    .map(stripGenericVenueSearchDescriptors)
    .filter(Boolean);
  const safeSuffixTerms = [
    cleanVenueNameSearchTerm(venueName),
    ...splitTerms,
  ]
    .map(stripSafeVenueSearchSuffixes)
    .filter(Boolean);
  const terms = [
    ...handleAliasTerms,
    ...aliasTerms,
    ...safeSuffixTerms,
    ...splitTerms,
    cleanVenueNameSearchTerm(venueName),
    ...descriptorTerms,
    ...derivedHandleTerms,
    cleanVenueNameSearchTerm(toSearchableText(venueName)),
  ].filter(isUsefulVenueSearchTerm);

  const seen = new Set<string>();
  const uniqueTerms: string[] = [];
  for (const term of terms) {
    const key = normalizeVenueComparableText(term);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueTerms.push(term);
  }

  return uniqueTerms.slice(0, 8);
}

function escapeOverpassRegex(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[.*+?^${}()|[\]]/g, "\\$&");
}

function buildOverpassQuery(venue: VenueForHoursRefresh): string | null {
  const terms = buildVenueNameSearchTerms(venue.name, venue.instagramHandle);
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

function scoreOsmElement(element: OverpassElement, venue: VenueForHoursRefresh): number {
  const requestedNames = buildVenueNameSearchTerms(venue.name, venue.instagramHandle)
    .map((term) => toSearchableText(term))
    .filter(Boolean);
  const candidateNames = [
    element.tags?.name,
    element.tags?.["name:en"],
    element.tags?.["name:sr"],
    element.tags?.alt_name,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => toSearchableText(value));

  if (requestedNames.some((requested) => candidateNames.some((candidate) => candidate === requested))) {
    return 100;
  }

  if (
    requestedNames.some((requested) =>
      candidateNames.some((candidate) => candidate.includes(requested)),
    )
  ) {
    return 70;
  }

  if (
    requestedNames.some((requested) =>
      candidateNames.some((candidate) => requested.includes(candidate)),
    )
  ) {
    return 60;
  }

  return 0;
}

function scoreOsmNameCandidate(candidateNames: string[], venue: VenueForHoursRefresh): number {
  const requestedNames = buildVenueNameSearchTerms(venue.name, venue.instagramHandle)
    .map((term) => toSearchableText(term))
    .filter(Boolean);
  const candidates = candidateNames.map((value) => toSearchableText(value)).filter(Boolean);

  if (requestedNames.some((requested) => candidates.some((candidate) => candidate === requested))) {
    return 100;
  }

  if (
    requestedNames.some((requested) =>
      candidates.some((candidate) => candidate.includes(requested)),
    )
  ) {
    return 70;
  }

  if (
    requestedNames.some((requested) =>
      candidates.some((candidate) => requested.includes(candidate) && candidate.length >= 4),
    )
  ) {
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

function normalizeNominatimOsmType(value: string | undefined): OverpassElement["type"] | null {
  if (value === "node" || value === "way" || value === "relation") {
    return value;
  }
  return null;
}

function buildNominatimQuery(venue: VenueForHoursRefresh): string | null {
  const venueName = venue.name.trim();
  if (!venueName) {
    return null;
  }

  const searchTerm = buildVenueNameSearchTerms(venueName, venue.instagramHandle)[0];
  if (!searchTerm) {
    return null;
  }

  const location = venue.location?.trim();
  return location ? `${searchTerm}, ${location}` : `${searchTerm}, Belgrade, Serbia`;
}

async function fetchNominatimHours(
  venue: VenueForHoursRefresh,
  options: Required<Pick<VenueHoursRefreshOptions, "nominatimFetch">> & {
    generatedAt: string;
  },
): Promise<NominatimSearchResult> {
  const query = buildNominatimQuery(venue);
  if (!query) {
    return { matchedWithoutHours: false, result: null };
  }

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);

  const response = await options.nominatimFetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": OVERPASS_USER_AGENT,
    },
    method: "GET",
  });
  const data = await readJsonResponse(response, "nominatim");
  const places = Array.isArray(data) ? data : [];
  const candidates = places
    .filter((place): place is NominatimPlace => isRecord(place))
    .map((place) => ({
      place,
      score: scoreOsmNameCandidate(
        [
          place.name,
          place.display_name,
          place.address?.amenity,
          place.address?.tourism,
          place.address?.shop,
        ].filter((value): value is string => Boolean(value)),
        venue,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = candidates[0]?.place;
  const openingHoursValue = best?.extratags?.opening_hours;
  if (!best) {
    return { matchedWithoutHours: false, result: null };
  }
  if (!openingHoursValue) {
    return { matchedWithoutHours: true, result: null };
  }

  const osmElementType = normalizeNominatimOsmType(best.osm_type);
  const osmElementId = best.osm_id === undefined ? "" : String(best.osm_id);
  const hoursJson = normalizeOsmOpeningHours(openingHoursValue, {
    generatedAt: options.generatedAt,
    raw: {
      displayName: best.display_name,
      elementId: osmElementId,
      elementType: osmElementType,
      name: best.name,
      provider: "nominatim",
    },
  });
  if (!hasWeeklyWindows(hoursJson)) {
    return { matchedWithoutHours: true, result: null };
  }

  return {
    matchedWithoutHours: false,
    result: {
      hoursJson,
      osmElementId,
      osmElementType: osmElementType ?? undefined,
      source: "osm",
    },
  };
}

async function fetchOsmHours(
  venue: VenueForHoursRefresh,
  options: Required<
    Pick<VenueHoursRefreshOptions, "nominatimFetch" | "overpassFallback" | "overpassFetch">
  > & {
    generatedAt: string;
  },
): Promise<ProviderResult | null> {
  const venueName = venue.name.trim();
  if (!venueName) {
    return null;
  }

  const nominatimResult = await fetchNominatimHours(venue, {
    generatedAt: options.generatedAt,
    nominatimFetch: options.nominatimFetch,
  });
  if (nominatimResult.result) {
    return nominatimResult.result;
  }
  if (nominatimResult.matchedWithoutHours) {
    return null;
  }
  if (!options.overpassFallback) {
    return null;
  }

  const query = buildOverpassQuery(venue);
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
    .map((element) => ({ element, score: scoreOsmElement(element, venue) }))
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
  if (!hasWeeklyWindows(hoursJson)) {
    return null;
  }

  return {
    hoursJson,
    osmElementId: String(best.id),
    osmElementType: best.type,
    source: "osm",
  };
}

function createPatchFromProviderResult(
  result: ProviderResult,
  now: number,
  error = "",
  existingGooglePlaceId = "",
): VenueHoursPatch {
  return {
    googlePlaceId: result.googlePlaceId ?? existingGooglePlaceId,
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

function createNonePatch(error: string, now: number, existingGooglePlaceId = ""): VenueHoursPatch {
  const generatedAt = new Date(now).toISOString();
  return {
    googlePlaceId: existingGooglePlaceId,
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

export function createManualVenueHoursPatch(
  openingHoursValue: string,
  now = Date.now(),
): VenueHoursPatch {
  const generatedAt = new Date(now).toISOString();
  const hoursJson = normalizeOsmOpeningHours(openingHoursValue, {
    generatedAt,
    raw: { manual: true },
    source: "manual",
  });

  return createPatchFromProviderResult({ hoursJson, source: "manual" }, now);
}

export async function fetchVenueHoursPatch(
  venue: VenueForHoursRefresh,
  options: VenueHoursRefreshOptions = {},
): Promise<VenueHoursPatch | null> {
  const now = options.now ?? Date.now();
  if (venue.hoursSource === "manual" && venue.hoursJson) {
    return null;
  }
  if (!options.force && !shouldRefreshVenueHoursCache(venue, now)) {
    return null;
  }

  const generatedAt = new Date(now).toISOString();
  const existingGooglePlaceId = venue.googlePlaceId ?? "";
  const nominatimFetch = options.nominatimFetch ?? fetch;
  const overpassFetch = options.overpassFetch ?? fetch;
  const errors: string[] = [];
  let providerError = false;

  try {
    const osmResult = await fetchOsmHours(venue, {
      generatedAt,
      nominatimFetch,
      overpassFallback: options.overpassFallback ?? false,
      overpassFetch,
    });
    if (osmResult) {
      return createPatchFromProviderResult(osmResult, now, "", existingGooglePlaceId);
    }
    errors.push("osm_no_match");
  } catch (error) {
    providerError = true;
    errors.push(error instanceof Error ? `osm_error:${error.message}` : "osm_error");
  }

  // Google fallback: only when OSM yielded nothing, a place_id is stored, and a
  // key is configured. Resolve place_ids first with scripts/resolve-venue-place-ids.mjs.
  if (!providerError && options.googleApiKey && existingGooglePlaceId) {
    try {
      const googleHoursJson = await fetchGoogleVenueHours(existingGooglePlaceId, {
        apiKey: options.googleApiKey,
        fetchImpl: options.googleFetch,
        generatedAt,
      });
      if (googleHoursJson) {
        return createPatchFromProviderResult(
          { googlePlaceId: existingGooglePlaceId, hoursJson: googleHoursJson, source: "google" },
          now,
          "",
          existingGooglePlaceId,
        );
      }
      errors.push("google_no_hours");
    } catch (error) {
      providerError = true;
      errors.push(error instanceof Error ? `google_error:${error.message}` : "google_error");
    }
  }

  if (providerError) {
    throw new Error(errors.join(";"));
  }

  if (hasStoredUsableProviderHours(venue)) {
    return null;
  }

  return createNonePatch(errors.join(";"), now, existingGooglePlaceId);
}
