export type CanonicalVenueRecord = {
  name: string;
  instagramHandle: string;
};

export type VenueSource = "handle_map" | "location_name" | "model" | null;

export type VenueNormalization = {
  venue: string | null;
  source: VenueSource;
  wasFallback: boolean;
  rawModelVenue: string;
  rawLocationName: string;
};

type CanonicalVenueMap = Record<string, string>;
type StaticVenueMap = Record<string, string>;

type NormalizeVenueInput = {
  handle: string;
  rawModelVenue: string;
  locationName?: string | null;
  canonicalVenueNamesByHandle: CanonicalVenueMap;
  handleVenueNamesByHandle?: CanonicalVenueMap;
  staticVenueByHandle?: StaticVenueMap;
};

const SERBIAN_CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "dj",
  е: "e",
  ж: "z",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "c",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "c",
  џ: "dz",
  ш: "s",
};

const SERBIAN_LATIN_TO_ASCII: Record<string, string> = {
  đ: "dj",
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
};

const GENERIC_ARTIST_VALUES = new Set([
  "artist",
  "artists",
  "dj",
  "djs",
  "guest",
  "guests",
  "host",
  "hosts",
  "lineup",
  "live",
  "program",
  "special guest",
  "special guests",
]);

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function trimWrappedPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’•·|,:;!?-]+|[\s"'“”‘’•·|,:;!?-]+$/gu, "").trim();
}

export function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

export function getConfiguredVenueNameForHandle(
  handle: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap = {},
): string {
  const normalized = normalizeHandle(handle);
  return canonicalVenueNamesByHandle[normalized] ?? staticVenueByHandle[normalized] ?? "";
}

export function buildCanonicalVenueNamesByHandle(
  venues: CanonicalVenueRecord[],
): CanonicalVenueMap {
  const namesByHandle: CanonicalVenueMap = {};
  for (const venue of venues) {
    const normalizedHandle = normalizeHandle(venue.instagramHandle);
    const normalizedName = normalizeString(venue.name);
    if (!normalizedHandle || !normalizedName) {
      continue;
    }
    namesByHandle[normalizedHandle] = normalizedName;
  }
  return namesByHandle;
}

export function toSearchableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[đčćžš]/g, (character) => {
      return SERBIAN_LATIN_TO_ASCII[character] ?? character;
    })
    .replace(/[\u0400-\u04ff]/g, (character) => {
      return SERBIAN_CYRILLIC_TO_LATIN[character] ?? character;
    })
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVenueComparableText(value: string): string {
  return toSearchableText(value)
    .replace(/\bkulturni\s+centar\b/g, "kc")
    .replace(/\bk\s+c\b/g, "kc")
    .replace(/\s+/g, " ")
    .trim();
}

function listCanonicalVenueNames(
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
): string[] {
  return [...new Set([
    ...Object.values(staticVenueByHandle),
    ...Object.values(canonicalVenueNamesByHandle),
  ])].filter((value) => value.length > 0);
}

function areVenueNamesCompatible(left: string, right: string): boolean {
  const normalizedLeft = normalizeVenueComparableText(left);
  const normalizedRight = normalizeVenueComparableText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

export function canonicalizeVenueName(
  candidate: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  options?: {
    preferredVenue?: string | null;
    staticVenueByHandle?: StaticVenueMap;
  },
): string | null {
  const normalizedCandidate = normalizeVenueComparableText(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  const preferredVenue = options?.preferredVenue ?? null;
  const staticVenueByHandle = options?.staticVenueByHandle ?? {};
  if (preferredVenue && areVenueNamesCompatible(candidate, preferredVenue)) {
    return preferredVenue;
  }

  const mappedByHandle = getConfiguredVenueNameForHandle(
    candidate,
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
  );
  if (mappedByHandle) {
    return mappedByHandle;
  }

  const canonicalVenueNames = listCanonicalVenueNames(
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
  );
  const exactMatch = canonicalVenueNames.find(
    (name) => normalizeVenueComparableText(name) === normalizedCandidate,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const candidateTokenCount = normalizedCandidate.split(" ").filter(Boolean).length;
  if (candidateTokenCount < 2) {
    return null;
  }

  return canonicalVenueNames.find((name) => areVenueNamesCompatible(candidate, name)) ?? null;
}

export function isLowConfidenceVenue(value: string): boolean {
  const searchable = normalizeVenueComparableText(value);
  if (!searchable) {
    return true;
  }
  const exactGenericValues = new Set([
    "belgrade",
    "beograd",
    "serbia",
    "srbija",
    "belgrade serbia",
    "beograd srbija",
    "belgrade klub",
    "belgrade club",
    "beograd klub",
    "beograd club",
    "club",
    "klub",
    "nightclub",
    "night club",
    "party",
    "event",
  ]);
  if (exactGenericValues.has(searchable)) {
    return true;
  }
  if (/^(belgrade|beograd)\s+(club|klub)$/.test(searchable)) {
    return true;
  }
  if (/^(belgrade|beograd)\s+(serbia|srbija)$/.test(searchable)) {
    return true;
  }
  return false;
}

function pickExplicitVenueCandidate(
  locationName: string,
  modelVenue: string,
): {
  venue: string;
  source: Exclude<VenueSource, "handle_map" | null>;
  wasFallback: boolean;
} | null {
  const hasLocationName = locationName.length > 0 && !isLowConfidenceVenue(locationName);
  const hasModelVenue = modelVenue.length > 0 && !isLowConfidenceVenue(modelVenue);

  if (hasLocationName && hasModelVenue) {
    if (areVenueNamesCompatible(locationName, modelVenue)) {
      return {
        venue: locationName,
        source: "location_name",
        wasFallback: true,
      };
    }

    return {
      venue: modelVenue,
      source: "model",
      wasFallback: false,
    };
  }

  if (hasLocationName) {
    return {
      venue: locationName,
      source: "location_name",
      wasFallback: true,
    };
  }

  if (hasModelVenue) {
    return {
      venue: modelVenue,
      source: "model",
      wasFallback: false,
    };
  }

  return null;
}

export function normalizeVenueFromEvidence(
  input: NormalizeVenueInput,
): VenueNormalization {
  const staticVenueByHandle = input.staticVenueByHandle ?? {};
  const handleVenueNamesByHandle = input.handleVenueNamesByHandle ?? {};
  const hardMappedVenue =
    getConfiguredVenueNameForHandle(input.handle, handleVenueNamesByHandle, {}) ?? "";
  const mappedVenue =
    getConfiguredVenueNameForHandle(
      input.handle,
      input.canonicalVenueNamesByHandle,
      staticVenueByHandle,
    ) ?? "";
  const locationName = trimWrappedPunctuation(normalizeString(input.locationName));
  const modelVenue = trimWrappedPunctuation(normalizeString(input.rawModelVenue));

  if (hardMappedVenue) {
    return {
      venue: hardMappedVenue,
      source: "handle_map",
      wasFallback: true,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  const explicitVenue = pickExplicitVenueCandidate(locationName, modelVenue);
  if (explicitVenue) {
    const canonicalExplicitVenue =
      canonicalizeVenueName(explicitVenue.venue, input.canonicalVenueNamesByHandle, {
        preferredVenue: mappedVenue || null,
        staticVenueByHandle,
      }) ?? explicitVenue.venue;
    return {
      venue: canonicalExplicitVenue,
      source: explicitVenue.source,
      wasFallback: explicitVenue.wasFallback,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  if (mappedVenue) {
    return {
      venue: mappedVenue,
      source: "handle_map",
      wasFallback: true,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  return {
    venue: null,
    source: null,
    wasFallback: true,
    rawModelVenue: modelVenue,
    rawLocationName: locationName,
  };
}

export function normalizeExtractedArtists(values: string[]): string[] {
  const normalizedArtists: string[] = [];
  const seenArtists = new Set<string>();

  for (const value of values) {
    const cleaned = trimWrappedPunctuation(normalizeString(value)).replace(/\s+/g, " ");
    if (!cleaned) {
      continue;
    }

    const comparable = toSearchableText(cleaned);
    if (!comparable || GENERIC_ARTIST_VALUES.has(comparable) || seenArtists.has(comparable)) {
      continue;
    }

    seenArtists.add(comparable);
    normalizedArtists.push(cleaned);
  }

  return normalizedArtists;
}

export function normalizeExtractedDescription(value: string): string {
  return normalizeString(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
