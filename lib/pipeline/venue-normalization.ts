export type CanonicalVenueRecord = {
  name: string;
  instagramHandle: string;
  aliases?: string[];
  location?: string | null;
};

export type VenueSource =
  | "evidence_handle"
  | "evidence_name"
  | "handle_map"
  | "location_name"
  | "model"
  | null;

export type VenueNormalization = {
  venue: string | null;
  source: VenueSource;
  wasFallback: boolean;
  rawModelVenue: string;
  rawLocationName: string;
  evidenceHandle?: string;
};

type CanonicalVenueMap = Record<string, string>;
export type CanonicalVenueAliasesByHandle = Record<string, string[]>;
type StaticVenueMap = Record<string, string>;

export const MAX_VENUE_ALIASES = 20;
export const MAX_VENUE_ALIAS_LENGTH = 120;

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
  immutableEvidenceTexts?: Array<string | null | undefined>;
  canonicalVenueNamesByHandle: CanonicalVenueMap;
  canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
  handleVenueNamesByHandle?: CanonicalVenueMap;
  staticVenueByHandle?: StaticVenueMap;
  allowCanonicalHandleFallback?: boolean;
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
      "KC Gradu",
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
      "Chillton Bašta",
      "Chillton Bašti",
      "Chillton Bashta",
      "Chillton Bashti",
      "Čilton Bašta",
      "Čilton Bašti",
    ],
    canonicalHandle: "chillton_bashta",
  },
  {
    aliases: [
      "Dub Gastro Pub",
      "Dub Gastro",
    ],
    canonicalHandle: "dubgastropub",
  },
  {
    aliases: [
      "Klub Studenata Tehnike KST",
      "Klub Studenata Tehnike",
      "KST Beograd",
      "KST",
    ],
    canonicalHandle: "klubstudenatatehnike",
  },
  {
    aliases: [
      "Freestyler",
      "Freestyler Belgrade",
      "Splav Freestyler",
    ],
    canonicalHandle: "freestylerbelgrade_official",
  },
  {
    aliases: [
      "Kolarac",
      "Art bioskop Kolarac",
      "Kolarac Art Bioskop",
      "Bioskop Kolarac",
    ],
    canonicalHandle: "kolarac_art_bioskop",
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
      "Museum of Yugoslavia",
    ],
    canonicalHandle: "muzej_jugoslavije",
  },
  {
    aliases: [
      "Ljubica",
    ],
    canonicalHandle: "ljubicabeograd",
  },
  {
    aliases: [
      "Supa",
      "Šupa",
      "шупа",
      "Kafe Supa",
      "Kafe Šupa",
      "Кафе Шупа",
      "Cafe Supa",
      "Cafe Šupa",
    ],
    canonicalHandle: "kafesupa",
  },
  {
    aliases: [
      "Spomen muzej Ive Andrica",
      "Spomen-muzej Ive Andrica",
      "Spomen-muzej Ive Andrića",
      "Спомен музеј Иве Андрића",
      "Спомен-музеј Иве Андрића",
      "Memorial Museum of Ivo Andric",
      "Memorial Museum of Ivo Andrić",
    ],
    canonicalHandle: "muzejgradabeograda",
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

export function normalizeVenueAliases(values: string[]): string[] {
  if (values.length > MAX_VENUE_ALIASES) {
    throw new Error(`A venue can have at most ${MAX_VENUE_ALIASES} aliases.`);
  }

  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const alias = rawValue.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!alias) {
      throw new Error("Venue aliases cannot be empty.");
    }
    if (alias.length > MAX_VENUE_ALIAS_LENGTH) {
      throw new Error(
        `Venue aliases cannot exceed ${MAX_VENUE_ALIAS_LENGTH} characters.`,
      );
    }
    const key = normalizeVenueComparableText(alias);
    if (!key) {
      throw new Error("Venue aliases must contain letters or numbers.");
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

export function buildCanonicalVenueAliasesByHandle(
  venues: CanonicalVenueRecord[],
): CanonicalVenueAliasesByHandle {
  const aliasesByHandle: CanonicalVenueAliasesByHandle = {};
  for (const venue of venues) {
    const normalizedHandle = normalizeHandle(venue.instagramHandle);
    if (!normalizedHandle) {
      continue;
    }
    const aliases = normalizeVenueAliases(venue.aliases ?? []);
    if (aliases.length > 0) {
      aliasesByHandle[normalizedHandle] = aliases;
    }
  }
  return aliasesByHandle;
}

export function buildCanonicalVenueLocationsByHandle(
  venues: CanonicalVenueRecord[],
): Record<string, string> {
  const locationsByHandle: Record<string, string> = {};
  for (const venue of venues) {
    const normalizedHandle = normalizeHandle(venue.instagramHandle);
    const normalizedLocation = normalizeString(venue.location);
    if (!normalizedHandle || !normalizedLocation) {
      continue;
    }
    locationsByHandle[normalizedHandle] = normalizedLocation;
  }
  return locationsByHandle;
}

type VenueNameEntry = {
  name: string;
  handle: string | null;
  matchedAlias?: string;
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
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle,
): VenueNameEntry[] {
  const entries: VenueNameEntry[] = [];
  const seen = new Set<string>();
  const addEntry = (name: string, handle: string | null, matchedAlias?: string) => {
    const normalizedName = normalizeString(name);
    const key = `${normalizeHandle(handle ?? "")}:${normalizeVenueComparableText(normalizedName)}`;
    if (!normalizedName || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({
      name: normalizedName,
      handle: handle ? normalizeHandle(handle) : null,
      ...(matchedAlias ? { matchedAlias } : {}),
    });
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
  for (const [handle, aliases] of Object.entries(canonicalVenueAliasesByHandle)) {
    for (const alias of aliases) {
      addEntry(alias, handle, alias);
    }
  }
  for (const rule of VENUE_ALIAS_RULES) {
    const canonicalHandle = normalizeHandle(rule.canonicalHandle);
    if (
      !getPreferredVenueNameForHandle(
        canonicalHandle,
        canonicalVenueNamesByHandle,
        staticVenueByHandle,
        handleVenueNamesByHandle,
      )
    ) {
      continue;
    }
    for (const alias of rule.aliases) {
      addEntry(alias, canonicalHandle, alias);
    }
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

  const [longer, shorter] = normalizedLeft.length >= normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  const shorterTokenCount = shorter.split(" ").filter(Boolean).length;
  if (shorter.length < 4 && shorterTokenCount < 2) {
    return false;
  }
  return ` ${longer} `.includes(` ${shorter} `);
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

function findUniqueVenueEntry(entries: VenueNameEntry[]): VenueNameEntry | null {
  const uniqueEntries = new Map<string, VenueNameEntry>();
  for (const entry of entries) {
    const key = entry.handle
      ? `handle:${normalizeHandle(entry.handle)}`
      : `name:${normalizeVenueComparableText(entry.name)}`;
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, entry);
    }
  }
  return uniqueEntries.size === 1 ? [...uniqueEntries.values()][0] : null;
}

function findEntryByVenueName(
  name: string,
  entries: VenueNameEntry[],
): VenueNameEntry | null {
  const normalizedName = normalizeVenueComparableText(name);
  if (!normalizedName) {
    return null;
  }

  return findUniqueVenueEntry(
    entries.filter((entry) => normalizeVenueComparableText(entry.name) === normalizedName),
  );
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
    canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
  },
): VenueCanonicalizationResult | null {
  const normalizedCandidate = normalizeVenueComparableText(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  const preferredVenue = options?.preferredVenue ?? null;
  const staticVenueByHandle = options?.staticVenueByHandle ?? {};
  const handleVenueNamesByHandle = options?.handleVenueNamesByHandle ?? {};
  const canonicalVenueAliasesByHandle = options?.canonicalVenueAliasesByHandle ?? {};
  const canonicalVenueEntries = buildCanonicalVenueEntries(
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
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

  const exactMatches = canonicalVenueEntries.filter(
    (entry) => normalizeVenueComparableText(entry.name) === normalizedCandidate,
  );
  const exactMatch = findUniqueVenueEntry(exactMatches);
  if (exactMatch) {
    return buildCanonicalizationResult(
      exactMatch,
      exactMatch.matchedAlias ? "alias" : "exact",
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
      exactMatch.matchedAlias,
    );
  }
  if (exactMatches.length > 0) {
    return null;
  }

  const candidateTokenCount = normalizedCandidate.split(" ").filter(Boolean).length;
  if (candidateTokenCount < 2) {
    return null;
  }

  const compatibleMatch = findUniqueVenueEntry(
    canonicalVenueEntries.filter(
      (entry) => !entry.matchedAlias && areVenueNamesCompatible(candidate, entry.name),
    ),
  );
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
    canonicalVenueAliasesByHandle?: CanonicalVenueAliasesByHandle;
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

const LOCATIVE_NEGATION_WORDS = new Set([
  "arent",
  "dont",
  "isnt",
  "ne",
  "necemo",
  "never",
  "nije",
  "nikako",
  "nismo",
  "nisu",
  "no",
  "not",
  "wasnt",
  "wont",
]);

const VIDIMO_SE_TIME_WORDS = new Set([
  "around",
  "at",
  "cetvrtak",
  "danas",
  "friday",
  "from",
  "h",
  "monday",
  "nedelja",
  "nocas",
  "od",
  "oko",
  "ponedeljak",
  "petak",
  "sati",
  "sreda",
  "subota",
  "sutra",
  "saturday",
  "sunday",
  "thursday",
  "today",
  "tomorrow",
  "tonight",
  "tuesday",
  "u",
  "utorak",
  "veceras",
  "wednesday",
]);

function getImmediateEvidenceClause(value: string): string {
  let clauseStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const periodWithinNumber =
      character === "." &&
      /\d/u.test(value[index - 1] ?? "") &&
      /\d/u.test(value[index + 1] ?? "");
    if (!periodWithinNumber && /[.!?;,\n\r—–]/u.test(character)) {
      clauseStart = index + 1;
    }
  }

  return value.slice(clauseStart);
}

function hasRecentLocativeNegation(value: string): boolean {
  const words = toSearchableText(value.replace(/[’']/gu, ""))
    .split(" ")
    .filter(Boolean)
    .slice(-4);
  return words.some((word) => LOCATIVE_NEGATION_WORDS.has(word));
}

function isTightlyBoundVidimoSeTail(value: string): boolean {
  const words = toSearchableText(value).split(" ").filter(Boolean);
  return words.every(
    (word) => VIDIMO_SE_TIME_WORDS.has(word) || /^\d{1,4}h?$/u.test(word),
  );
}

function hasImmediateLocativeHandleContext(evidence: string, mentionStart: number): boolean {
  const contextStart = Math.max(0, mentionStart - 96);
  const clause = getImmediateEvidenceClause(evidence.slice(contextStart, mentionStart));
  const pinMatch = /📍\s*$/u.exec(clause);
  if (pinMatch) {
    return !hasRecentLocativeNegation(clause.slice(0, pinMatch.index));
  }

  const directCueMatch =
    /\b(?:at|in|u|na|kod|venue|location|lokacija|mesto)\s*(?::|-)?\s*$/iu.exec(clause);
  if (directCueMatch) {
    return !hasRecentLocativeNegation(clause.slice(0, directCueMatch.index));
  }

  const vidimoSeMatch = /\bvidimo\s+se\b(.*)$/iu.exec(clause);
  if (!vidimoSeMatch || hasRecentLocativeNegation(clause.slice(0, vidimoSeMatch.index))) {
    return false;
  }

  return isTightlyBoundVidimoSeTail(vidimoSeMatch[1] ?? "");
}

function findUniqueCanonicalVenueHandleMention(
  evidenceTexts: Array<string | null | undefined>,
  postingHandle: string,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
):
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "unique"; handle: string; venue: string; locative: boolean } {
  const normalizedPostingHandle = normalizeHandle(postingHandle);
  const matchedHandles = new Set<string>();
  const locativeHandles = new Set<string>();
  const exactHandlePattern =
    /(?:^|[^\p{L}\p{N}._])[@#]([a-z0-9_]+(?:\.[a-z0-9_]+)*)/giu;

  for (const rawEvidence of evidenceTexts) {
    const evidence = normalizeString(rawEvidence);
    if (!evidence) continue;

    for (const match of evidence.matchAll(exactHandlePattern)) {
      const handle = normalizeHandle(match[1] ?? "");
      if (!handle || handle === normalizedPostingHandle) continue;
      if (
        !getPreferredVenueNameForHandle(
          handle,
          canonicalVenueNamesByHandle,
          staticVenueByHandle,
          handleVenueNamesByHandle,
        )
      ) {
        continue;
      }
      matchedHandles.add(handle);
      const rawMatch = match[0] ?? "";
      const sigilOffset = Math.max(rawMatch.indexOf("@"), rawMatch.indexOf("#"));
      const mentionStart = (match.index ?? 0) + Math.max(0, sigilOffset);
      if (hasImmediateLocativeHandleContext(evidence, mentionStart)) {
        locativeHandles.add(handle);
      }
    }
  }

  if (matchedHandles.size === 0) return { kind: "none" };
  if (matchedHandles.size > 1) return { kind: "ambiguous" };
  const handle = [...matchedHandles][0];
  const venue = getPreferredVenueNameForHandle(
    handle,
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
  );
  return venue
    ? { kind: "unique", handle, venue, locative: locativeHandles.has(handle) }
    : { kind: "none" };
}

type VenueNameEvidenceMatch = {
  entry: VenueNameEntry;
  evidenceIndex: number;
  startToken: number;
  endToken: number;
};

function stripProfileReferencesFromVenueNameEvidence(value: string): string {
  return value
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(
      /(^|[^\p{L}\p{N}._])[@#][\p{L}\p{N}._]+/gu,
      "$1",
    );
}

function findExactTokenPhraseStarts(
  evidenceTokens: string[],
  venueTokens: string[],
): number[] {
  if (venueTokens.length === 0 || venueTokens.length > evidenceTokens.length) {
    return [];
  }

  const starts: number[] = [];
  const lastStart = evidenceTokens.length - venueTokens.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (
      venueTokens.every(
        (token, offset) => evidenceTokens[start + offset] === token,
      )
    ) {
      starts.push(start);
    }
  }
  return starts;
}

function hasShortVenueNameContext(
  evidenceTokens: string[],
  startToken: number,
  venueTokens: string[],
): boolean {
  const compactName = venueTokens.join("");
  if (venueTokens.length !== 1 || compactName.length > 4) {
    return true;
  }
  const nearbyPrefix = evidenceTokens.slice(Math.max(0, startToken - 2), startToken);
  return nearbyPrefix.some((token) =>
    new Set([
      "at",
      "basta",
      "club",
      "klub",
      "location",
      "lokacija",
      "na",
      "u",
      "venue",
    ]).has(token),
  );
}

function findUniqueCanonicalVenueNameMention(
  evidenceTexts: Array<string | null | undefined>,
  canonicalVenueNamesByHandle: CanonicalVenueMap,
  staticVenueByHandle: StaticVenueMap,
  handleVenueNamesByHandle: CanonicalVenueMap,
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle,
):
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "unique"; venue: string } {
  const entries = buildCanonicalVenueEntries(
    canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
  );
  const matches: VenueNameEvidenceMatch[] = [];

  for (const [evidenceIndex, rawEvidence] of evidenceTexts.entries()) {
    const evidence = stripProfileReferencesFromVenueNameEvidence(
      normalizeString(rawEvidence),
    );
    const evidenceTokens = toSearchableText(evidence).split(" ").filter(Boolean);
    if (evidenceTokens.length === 0) continue;

    for (const entry of entries) {
      const normalizedName = toSearchableText(entry.name);
      const compactName = normalizedName.replace(/\s+/gu, "");
      if (compactName.length < 3 || !/[a-z]/u.test(compactName)) {
        continue;
      }
      const venueTokens = normalizedName.split(" ").filter(Boolean);
      for (const startToken of findExactTokenPhraseStarts(
        evidenceTokens,
        venueTokens,
      )) {
        if (!hasShortVenueNameContext(evidenceTokens, startToken, venueTokens)) {
          continue;
        }
        matches.push({
          entry,
          evidenceIndex,
          startToken,
          endToken: startToken + venueTokens.length,
        });
      }
    }
  }

  if (matches.length === 0) return { kind: "none" };

  // Prefer the longest exact phrase at a given occurrence. This lets a precise
  // name such as "Chillton Bašta" win over the separately configured
  // "Chillton" alias, while a second standalone "Chillton" occurrence still
  // makes the evidence ambiguous and therefore fails closed.
  const unshadowedMatches = matches.filter((match) =>
    !matches.some(
      (other) =>
        other.evidenceIndex === match.evidenceIndex &&
        other.startToken <= match.startToken &&
        other.endToken >= match.endToken &&
        other.endToken - other.startToken > match.endToken - match.startToken,
    ),
  );
  const uniqueEntry = findUniqueVenueEntry(
    unshadowedMatches.map((match) => match.entry),
  );
  if (!uniqueEntry) return { kind: "ambiguous" };

  return {
    kind: "unique",
    venue: getDisplayVenueNameForEntry(
      uniqueEntry,
      canonicalVenueNamesByHandle,
      staticVenueByHandle,
      handleVenueNamesByHandle,
    ),
  };
}

export function normalizeVenueFromEvidence(
  input: NormalizeVenueInput,
): VenueNormalization {
  const staticVenueByHandle = input.staticVenueByHandle ?? {};
  const handleVenueNamesByHandle = input.handleVenueNamesByHandle ?? {};
  const canonicalVenueAliasesByHandle = input.canonicalVenueAliasesByHandle ?? {};
  const allowCanonicalHandleFallback = input.allowCanonicalHandleFallback !== false;
  const hardMappedVenue = allowCanonicalHandleFallback
    ? getConfiguredVenueNameForHandle(input.handle, handleVenueNamesByHandle, {}) ?? ""
    : "";
  const mappedVenue = allowCanonicalHandleFallback
    ? getConfiguredVenueNameForHandle(
        input.handle,
        input.canonicalVenueNamesByHandle,
        staticVenueByHandle,
      ) ?? ""
    : "";
  const locationName = trimWrappedPunctuation(normalizeString(input.locationName));
  const modelVenue = trimWrappedPunctuation(normalizeString(input.rawModelVenue));
  const canonicalHandleMention = findUniqueCanonicalVenueHandleMention(
    input.immutableEvidenceTexts ?? [],
    input.handle,
    input.canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
  );

  // A uniquely named canonical venue is authoritative for promoters and
  // unknown sources. A configured physical venue account retains precedence
  // over a casual tag, unless the immutable text explicitly places the event
  // at the tagged venue (for example, "at @kcgrad" or "vidimo se @kcgrad").
  if (
    canonicalHandleMention.kind === "unique" &&
    (!hardMappedVenue || canonicalHandleMention.locative)
  ) {
    return {
      venue: canonicalHandleMention.venue,
      source: "evidence_handle",
      wasFallback: false,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
      evidenceHandle: canonicalHandleMention.handle,
    };
  }

  if (hardMappedVenue) {
    const canonicalHardMappedVenue =
      canonicalizeVenueName(hardMappedVenue, input.canonicalVenueNamesByHandle, {
        preferredVenue: mappedVenue || null,
        staticVenueByHandle,
        handleVenueNamesByHandle,
        canonicalVenueAliasesByHandle,
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
        canonicalVenueAliasesByHandle,
      }) ?? explicitVenue.venue;
    return {
      venue: canonicalExplicitVenue,
      source: explicitVenue.source,
      wasFallback: explicitVenue.wasFallback,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  const canonicalNameMention = findUniqueCanonicalVenueNameMention(
    input.immutableEvidenceTexts ?? [],
    input.canonicalVenueNamesByHandle,
    staticVenueByHandle,
    handleVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
  );
  if (canonicalNameMention.kind === "unique") {
    return {
      venue: canonicalNameMention.venue,
      source: "evidence_name",
      wasFallback: false,
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
