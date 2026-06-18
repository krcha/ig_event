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

export type VenueCanonicalizationReason =
  | "preferred"
  | "handle"
  | "alias"
  | "exact"
  | "compatible";

export type VenueCanonicalizationResult = {
  venue: string;
  reason: VenueCanonicalizationReason;
  handle: string | null;
  matchedVenue: string;
  matchedAlias?: string;
};

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

const STYLED_LATIN_TO_ASCII: Record<string, string> = {
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ǫ: "q",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
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

const VENUE_ALIAS_RULES: Array<{
  aliases: string[];
  canonicalHandle: string;
}> = [
  {
    aliases: [
      "20/44",
      "20 44",
      "Klub 20/44",
      "Klub 20 44",
    ],
    canonicalHandle: "20_44.nightclub",
  },
  {
    aliases: [
      "KC Grad",
      "K C Grad",
      "Kulturni centar Grad",
      "Kulturni Centar GRAD",
    ],
    canonicalHandle: "kcgrad",
  },
  {
    aliases: [
      "Silosi",
      "Silosi Beograd",
      "Silosi Belgrade",
      "Medonosni vrt Silosa",
      "Medonosni vrt Silosi",
    ],
    canonicalHandle: "silosibeograd",
  },
  {
    aliases: [
      "Kvaka 22",
      "Catch 22",
      "Catch22",
    ],
    canonicalHandle: "kvaka22_catch22",
  },
  {
    aliases: [
      "Chillton",
      "Cilton",
      "Čilton",
    ],
    canonicalHandle: "chillton_chillton",
  },
  {
    aliases: [
      "Sinnerman",
      "SinnerMan",
      "Sinnerman Jazz",
    ],
    canonicalHandle: "sinnermanjazzclub",
  },
  {
    aliases: [
      "Beton",
      "Beton Club",
      "Beton Event Center",
    ],
    canonicalHandle: "betonbelgrade",
  },
  {
    aliases: [
      "Nula Pet",
      "Nula pet _0.5",
      "0,5",
      "0.5",
      "Pab 0,5",
      "Pab 0.5",
      "Pub 0,5",
      "Pub 0.5",
      "Basta Paba Nula Pet",
      "Bašta Paba Nula Pet",
    ],
    canonicalHandle: "nulapet_0.5",
  },
  {
    aliases: [
      "Amfiteatar ispod Muzeja istorije Jugoslavije",
      "Amphitheater in front of the Museum of Yugoslav History",
      "Muzej istorije Jugoslavije",
      "Museum of Yugoslav History",
    ],
    canonicalHandle: "muzej_jugoslavije",
  },
  {
    aliases: [
      "Ljubica",
    ],
    canonicalHandle: "ljubicabeograd",
  },
];

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
    .replace(/[ᴀʙᴄᴅᴇɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/g, (character) => {
      return STYLED_LATIN_TO_ASCII[character] ?? character;
    })
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

export function normalizeVenueComparableText(value: string): string {
  return toSearchableText(value)
    .replace(/\bkulturni\s+centar\b/g, "kc")
    .replace(/\bk\s+c\b/g, "kc")
    .replace(/\bpab\b/g, "pub")
    .replace(/\bzero\s+five\b/g, "0 5")
    .replace(/\bnula\s+pet\b/g, "0 5")
    .replace(/\s+/g, " ")
    .trim();
}

type VenueNameEntry = {
  name: string;
  handle: string | null;
};

function getPreferredVenueNameForHandle(
  handle: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
): string {
  const normalizedHandle = normalizeHandle(handle);
  return (
    handleVenueNamesByHandle[normalizedHandle] ??
    canonicalVenueNamesByHandle[normalizedHandle] ??
    staticVenueByHandle[normalizedHandle] ??
    ""
  );
}

function buildCanonicalVenueEntries(
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
): VenueNameEntry[] {
  const entries: VenueNameEntry[] = [];
  const seen = new Set<string>();
  const addEntry = (name: string, handle: string | null) => {
    const normalizedName = normalizeString(name);
    const key = `${normalizeHandle(handle ?? "")}:${normalizeVenueComparableText(normalizedName)}`;
    if (!normalizedName || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ name: normalizedName, handle: handle ? normalizeHandle(handle) : null });
  };

  for (const [handle, name] of Object.entries(staticVenueByHandle)) {
    addEntry(name, handle);
  }
  for (const [handle, name] of Object.entries(canonicalVenueNamesByHandle)) {
    addEntry(name, handle);
  }
  for (const [handle, name] of Object.entries(handleVenueNamesByHandle)) {
    addEntry(name, handle);
  }

  return entries;
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

function getDisplayVenueNameForEntry(
  entry: VenueNameEntry,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
): string {
  if (!entry.handle) {
    return entry.name;
  }
  return (
    getPreferredVenueNameForHandle(
      entry.handle,
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    ) || entry.name
  );
}

function findEntryByVenueName(
  name: string,
  entries: VenueNameEntry[],
): VenueNameEntry | null {
  const normalizedName = normalizeVenueComparableText(name);
  if (!normalizedName) {
    return null;
  }

  return entries.find((entry) => normalizeVenueComparableText(entry.name) === normalizedName) ?? null;
}

function findVenueAliasRule(candidate: string): {
  alias: string;
  canonicalHandle: string;
} | null {
  const normalizedCandidate = normalizeVenueComparableText(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  for (const rule of VENUE_ALIAS_RULES) {
    for (const alias of rule.aliases) {
      if (normalizeVenueComparableText(alias) === normalizedCandidate) {
        return {
          alias,
          canonicalHandle: normalizeHandle(rule.canonicalHandle),
        };
      }
    }
  }

  return null;
}

function buildCanonicalizationResult(
  entry: VenueNameEntry,
  reason: VenueCanonicalizationReason,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
  matchedAlias?: string,
): VenueCanonicalizationResult {
  return {
    venue: getDisplayVenueNameForEntry(
      entry,
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    ),
    reason,
    handle: entry.handle,
    matchedVenue: entry.name,
    ...(matchedAlias ? { matchedAlias } : {}),
  };
}

export function canonicalizeVenueNameDetailed(
  candidate: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  options?: {
    preferredVenue?: string | null;
    staticVenueByHandle?: StaticVenueMap;
    handleVenueNamesByHandle?: CanonicalVenueMap;
  },
): VenueCanonicalizationResult | null {
  const normalizedCandidate = normalizeVenueComparableText(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  const preferredVenue = options?.preferredVenue ?? null;
  const staticVenueByHandle = options?.staticVenueByHandle ?? {};
  const handleVenueNamesByHandle = options?.handleVenueNamesByHandle ?? {};
  const canonicalVenueEntries = buildCanonicalVenueEntries(
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
  );

  if (preferredVenue && areVenueNamesCompatible(candidate, preferredVenue)) {
    const preferredEntry = findEntryByVenueName(preferredVenue, canonicalVenueEntries) ?? {
      name: preferredVenue,
      handle: null,
    };
    return buildCanonicalizationResult(
      preferredEntry,
      "preferred",
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    );
  }

  const mappedByHandle = getConfiguredVenueNameForHandle(
    candidate,
    {
      ...canonicalVenueNamesByHandle,
      ...handleVenueNamesByHandle,
    },
    staticVenueByHandle,
  );
  if (mappedByHandle) {
    const mappedEntry = {
      name: mappedByHandle,
      handle: normalizeHandle(candidate),
    };
    return buildCanonicalizationResult(
      mappedEntry,
      "handle",
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    );
  }

  const aliasRule = findVenueAliasRule(candidate);
  if (aliasRule) {
    const aliasVenue = getPreferredVenueNameForHandle(
      aliasRule.canonicalHandle,
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    );
    if (aliasVenue) {
      return buildCanonicalizationResult(
        {
          name: aliasVenue,
          handle: aliasRule.canonicalHandle,
        },
        "alias",
        canonicalVenueNamesByHandle,
        staticVenueByHandle,
        handleVenueNamesByHandle,
        aliasRule.alias,
      );
    }
  }

  const exactMatch = canonicalVenueEntries.find(
    (entry) => normalizeVenueComparableText(entry.name) === normalizedCandidate,
  );
  if (exactMatch) {
    return buildCanonicalizationResult(
      exactMatch,
      "exact",
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    );
  }

  const candidateTokenCount = normalizedCandidate.split(" ").filter(Boolean).length;
  if (candidateTokenCount < 2) {
    return null;
  }

  const compatibleMatch =
    canonicalVenueEntries.find((entry) => areVenueNamesCompatible(candidate, entry.name)) ?? null;
  return compatibleMatch
    ? buildCanonicalizationResult(
        compatibleMatch,
        "compatible",
        canonicalVenueNamesByHandle,
        staticVenueByHandle,
        handleVenueNamesByHandle,
      )
    : null;
}

export function canonicalizeVenueName(
  candidate: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  options?: {
    preferredVenue?: string | null;
    staticVenueByHandle?: StaticVenueMap;
    handleVenueNamesByHandle?: CanonicalVenueMap;
  },
): string | null {
  return canonicalizeVenueNameDetailed(candidate, canonicalVenueNamesByHandle, options)?.venue ?? null;
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
    const canonicalHardMappedVenue =
      canonicalizeVenueName(hardMappedVenue, input.canonicalVenueNamesByHandle, {
        preferredVenue: mappedVenue || null,
        staticVenueByHandle,
        handleVenueNamesByHandle,
      }) ?? hardMappedVenue;
    return {
      venue: canonicalHardMappedVenue,
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
        handleVenueNamesByHandle,
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
