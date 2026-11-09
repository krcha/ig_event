import { getEventTimeSortMinutes, normalizeEventTime } from "../../events/event-time";
import { toSearchableText } from "../venues/normalization";
import { venuesShareReviewedOccurrenceLocation } from "../venues/reviewed-occurrence-locations";

export type OccurrenceRelationshipCandidate = {
  artists?: readonly string[] | null;
  date?: string | null;
  normalizedFieldsJson?: string | null;
  sourceAccountHandle?: string | null;
  sourceOccurrenceKey?: string | null;
  time?: string | null;
  title: string;
  venueId?: string | null;
};

export type OccurrenceRelationshipInvariant =
  | "unrelated"
  | "proven_duplicate"
  | "proven_distinct"
  | "ambiguous";

type ComparableIdentity = {
  artists: Set<string>;
  title: string;
};

const GENERIC_TEASER_TITLES = new Set([
  "announcement",
  "coming soon",
  "najava",
  "new chapter",
  "save the date",
  "teaser",
  "uskoro",
]);

const GENERIC_SEQUENCE_PREFIXES = new Set([
  "chapter",
  "deo",
  "dio",
  "edition",
  "episode",
  "epizoda",
  "izdanje",
  "part",
  "poglavlje",
  "season",
  "sezona",
  "vol",
  "volume",
]);

const GENERIC_SEQUENCE_QUALIFIERS = new Set([
  "eight",
  "eighth",
  "five",
  "fifth",
  "four",
  "fourth",
  "nine",
  "ninth",
  "one",
  "second",
  "seven",
  "seventh",
  "six",
  "sixth",
  "ten",
  "tenth",
  "third",
  "three",
  "two",
]);

const NON_DISTINCTIVE_TITLE_TOKENS = new Set([
  "a",
  "an",
  "and",
  "beograd",
  "belgrade",
  "concert",
  "event",
  "grupa",
  "grupe",
  "i",
  "koncert",
  "live",
  "music",
  "na",
  "night",
  "party",
  "the",
  "u",
  "za",
]);

const GENERIC_SLOT_TOKENS = new Set([
  ...NON_DISTINCTIVE_TITLE_TOKENS,
  "exhibition", "film", "gallery", "galerija", "izlozba", "opening", "otvaranje",
  "predstava", "program", "projekcija", "radionica", "screening", "svirka", "zurka",
]);

const WEEKDAY_SCHEDULE_TOKENS = [
  "sun|sunday|ned|nedelja", "mon|monday|pon|ponedeljak", "tue|tues|tuesday|uto|utorak",
  "wed|wednesday|sre|sreda", "thu|thur|thurs|thursday|cet|cetvrtak",
  "fri|friday|pet|petak", "sat|saturday|sub|subota",
];

const GENERIC_BILLED_ARTIST_TOKENS = new Set([
  "artist",
  "artists",
  "band",
  "bend",
  "crew",
  "friends",
  "gost",
  "gosti",
  "guest",
  "guests",
  "house",
  "lineup",
  "resident",
  "residents",
  "support",
  "surprise",
  "tba",
  "tbd",
  "techno",
]);

function parseNormalizedFields(
  candidate: OccurrenceRelationshipCandidate,
): Record<string, unknown> | null {
  if (!candidate.normalizedFieldsJson) return null;
  try {
    const parsed = JSON.parse(candidate.normalizedFieldsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The authoritative compatibility-aware source-occurrence key reader. New
 * callers should persist the key directly; the JSON fallback exists only for
 * rows written before the first-class occurrence model.
 */
export function getNormalizedOccurrenceRelationshipKey(
  candidate: OccurrenceRelationshipCandidate,
): string | null {
  const direct = candidate.sourceOccurrenceKey?.trim();
  if (direct) return direct;
  const value = parseNormalizedFields(candidate)?.sourceOccurrenceKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function comparableIdentity(
  candidate: OccurrenceRelationshipCandidate,
): ComparableIdentity {
  return {
    artists: new Set(
      (candidate.artists ?? [])
        .map((artist) => toSearchableText(artist))
        .filter(Boolean),
    ),
    title: toSearchableText(candidate.title),
  };
}

function normalizeSourceAccountHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^@+/u, "")
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/u.test(normalized) ? normalized : null;
}

function getNormalizedSourceAccountHandle(
  candidate: OccurrenceRelationshipCandidate,
): string | null {
  return normalizeSourceAccountHandle(candidate.sourceAccountHandle);
}

function isGenericTeaserTitle(title: string): boolean {
  const normalized = toSearchableText(title);
  if (!normalized) return false;
  if (GENERIC_TEASER_TITLES.has(normalized)) return true;

  const tokens = normalized.split(/\s+/u);
  const [prefix, ...qualifiers] = tokens;
  if (
    !prefix ||
    !GENERIC_SEQUENCE_PREFIXES.has(prefix) ||
    qualifiers.length > 2
  ) {
    return false;
  }
  return qualifiers.every(
    (token) =>
      /^\d{1,3}$/u.test(token) ||
      /^[ivxlcdm]{1,8}$/u.test(token) ||
      GENERIC_SEQUENCE_QUALIFIERS.has(token),
  );
}

function isWeakGenericTeaser(
  candidate: OccurrenceRelationshipCandidate,
  identity: ComparableIdentity,
  minutes: number | null,
): boolean {
  return (
    minutes === null &&
    identity.artists.size === 0 &&
    isGenericTeaserTitle(candidate.title)
  );
}

function hasStrongerOccurrenceEvidence(
  identity: ComparableIdentity,
  minutes: number | null,
): boolean {
  return minutes !== null || identity.artists.size > 0;
}

function significantTitleTokens(title: string): string[] {
  return title
    .split(/\s+/u)
    .filter(
      (token) => token.length >= 3 && !NON_DISTINCTIVE_TITLE_TOKENS.has(token),
    );
}

function titlesNameSameOccurrence(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = significantTitleTokens(left);
  const rightTokens = significantTitleTokens(right);
  const [shorter, longer] =
    leftTokens.length <= rightTokens.length
      ? [leftTokens, rightTokens]
      : [rightTokens, leftTokens];
  return (
    shorter.length > 0 &&
    shorter.join("").length >= 5 &&
    shorter.every((token) => longer.includes(token))
  );
}

function titlesProveDistinct(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftAllTokens = left.split(/\s+/u);
  const rightAllTokens = right.split(/\s+/u);
  if (
    leftAllTokens.some((token) => NON_DISTINCTIVE_TITLE_TOKENS.has(token)) ||
    rightAllTokens.some((token) => NON_DISTINCTIVE_TITLE_TOKENS.has(token))
  ) {
    return false;
  }
  const leftTokens = significantTitleTokens(left);
  const rightTokens = significantTitleTokens(right);
  return (
    leftTokens.length >= 2 &&
    rightTokens.length >= 2 &&
    leftTokens.every((token) => !rightTokens.includes(token)) &&
    rightTokens.every((token) => !leftTokens.includes(token))
  );
}

function sourceBoundLineup(
  candidate: OccurrenceRelationshipCandidate,
): readonly string[] | null {
  const artists = candidate.artists;
  if (!artists || artists.length < 3 || artists.length > 12) return null;

  const identities = artists.map(toSearchableText);
  if (
    identities.some((identity) => !identity) ||
    new Set(identities.map((identity) => identity.replaceAll(" ", ""))).size !== artists.length ||
    toSearchableText(candidate.title) !== identities.join(" ")
  ) {
    return null;
  }

  const fields = parseNormalizedFields(candidate);
  const attestedArtists = fields?.artists;
  if (
    !fields ||
    fields.sourceOccurrencePlanUnverified === true ||
    !Array.isArray(attestedArtists) ||
    attestedArtists.length !== artists.length ||
    !artists.every((artist, index) => artist === attestedArtists[index])
  ) {
    return null;
  }

  if (
    fields.sourceGroundingRowVerified === true &&
    fields.sourceGroundingArtistsVerified === true
  ) {
    return artists;
  }
  if (
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.structuredEvidenceVerified !== true ||
    fields.identityEvidenceVerified !== true ||
    typeof fields.rowSourceText !== "string"
  ) {
    return null;
  }
  const sourceRow = ` ${toSearchableText(fields.rowSourceText)} `;
  return identities.every((identity) => sourceRow.includes(` ${identity} `))
    ? artists
    : null;
}

function billedArtistMatch(
  left: string,
  right: string,
): "exact" | "alias" | "expansion" | null {
  const handlePattern = /^@[a-z0-9][a-z0-9._]{1,29}$/iu;
  const leftIsHandle = handlePattern.test(left);
  const rightIsHandle = handlePattern.test(right);
  const name = toSearchableText(leftIsHandle ? right : left);
  const words = name.split(" ");
  const compactName = words.join("");
  if (
    compactName.length < 4 ||
    words.some((word) =>
      GENERIC_BILLED_ARTIST_TOKENS.has(word) || NON_DISTINCTIVE_TITLE_TOKENS.has(word),
    )
  ) {
    return null;
  }
  if (leftIsHandle === rightIsHandle) {
    return toSearchableText(left) === toSearchableText(right) ? "exact" : null;
  }

  const handle = toSearchableText(leftIsHandle ? left : right).replaceAll(" ", "");
  if (handle === compactName || handle === `dj${compactName}`) {
    const distinctive =
      compactName.length >= 8 ||
      (compactName.length >= 7 && words.length >= 2 && words.every((word) => word.length >= 2));
    return distinctive ? "alias" : "exact";
  }
  return /^[a-z]{4,12}$/u.test(name) &&
    handle.startsWith(name) && /^[a-z]{5,}$/u.test(handle.slice(name.length))
    ? "expansion"
    : null;
}

function lineupsSuggestCrossSourceCollision(
  left: OccurrenceRelationshipCandidate,
  right: OccurrenceRelationshipCandidate,
): boolean {
  const leftLineup = sourceBoundLineup(left);
  const rightLineup = sourceBoundLineup(right);
  if (!leftLineup || !rightLineup || leftLineup.length !== rightLineup.length) {
    return false;
  }

  // Require the same bill order. A single weak name expansion can only
  // corroborate the stronger aliases and never proves a shared occurrence.
  const matches = leftLineup.map((artist, index) =>
    billedArtistMatch(artist, rightLineup[index]),
  );
  return (
    matches.every(Boolean) &&
    matches.filter((match) => match === "alias").length >= 2 &&
    matches.filter((match) => match === "expansion").length <= 1
  );
}

function readConfirmedTitleSlot(candidate: OccurrenceRelationshipCandidate) {
  const fields = parseNormalizedFields(candidate);
  const date = fields?.normalizedDate;
  const minutes = getEventTimeSortMinutes(candidate.time);
  if (
    !fields || typeof date !== "string" || date !== candidate.date || !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    typeof fields.title !== "string" || toSearchableText(fields.title) !== toSearchableText(candidate.title) ||
    fields.titleUsedFallback === true || fields.titleDerivedFromContext === true ||
    fields.sourceOccurrencePlanUnverified === true ||
    (Array.isArray(fields.sourceConflictFields) && fields.sourceConflictFields.length > 0) ||
    fields.timeStatus !== "confirmed" || fields.timeEvidenceKind !== "start_time_stated" ||
    fields.timeEvidenceVerified !== true || typeof fields.time !== "string" ||
    minutes === null || getEventTimeSortMinutes(fields.time) !== minutes
  ) return null;

  const exactDate = fields.dateEvidenceVerified === true || fields.sourceGroundingDateVerified === true;
  if (!exactDate) {
    // A calendar row may omit the month because the source is a monthly
    // programme. Corroborate its inferred date with a separately dated post.
    const civilDate = new Date(`${date}T00:00:00Z`);
    const weekday = WEEKDAY_SCHEDULE_TOKENS[civilDate.getUTCDay()];
    const sourceRow = typeof fields.rowSourceText === "string" ? toSearchableText(fields.rowSourceText) : "";
    if (!weekday || !new RegExp(`^(?:${weekday}) 0?${civilDate.getUTCDate()}(?: |$)`, "u").test(sourceRow) ||
      !` ${sourceRow} `.includes(` ${toSearchableText(candidate.title)} `)) return null;
  }
  return { date, exactDate, minutes, end: normalizeEventTime(fields.time).endLabel };
}

function confirmedTitleSlotMatches(
  left: OccurrenceRelationshipCandidate,
  right: OccurrenceRelationshipCandidate,
): boolean {
  const leftIdentity = comparableIdentity(left);
  const rightIdentity = comparableIdentity(right);
  const compactTitle = leftIdentity.title.replaceAll(" ", "");
  if (compactTitle.length < 8 || compactTitle !== rightIdentity.title.replaceAll(" ", "") ||
    [leftIdentity.title, rightIdentity.title].some((title) =>
      isGenericTeaserTitle(title) || !title.split(" ").some((token) =>
        token.length >= 4 && /\p{L}/u.test(token) && !GENERIC_SLOT_TOKENS.has(token))) ||
    leftIdentity.artists.size !== rightIdentity.artists.size ||
    [...leftIdentity.artists].some((artist) => !rightIdentity.artists.has(artist))) return false;

  const leftSlot = readConfirmedTitleSlot(left);
  const rightSlot = readConfirmedTitleSlot(right);
  return Boolean(leftSlot && rightSlot && leftSlot.date === rightSlot.date &&
    leftSlot.minutes === rightSlot.minutes && (leftSlot.exactDate || rightSlot.exactDate) &&
    (!leftSlot.end || !rightSlot.end || leftSlot.end === rightSlot.end));
}

/**
 * Authoritative same-day occurrence relationship invariant.
 *
 * Callers establish the date cohort and venue/source facts. This function is
 * deliberately conservative: evidence must prove sameness or distinctness;
 * otherwise the result is ambiguous and cannot authorize topology mutation.
 */
export function classifyOccurrenceRelationshipInvariant(options: {
  candidate: OccurrenceRelationshipCandidate;
  existing: OccurrenceRelationshipCandidate;
  sameSource: boolean;
  sameVenue: boolean;
  unknownVenue?: boolean;
}): OccurrenceRelationshipInvariant {
  const {
    candidate,
    existing,
    sameVenue,
    sameSource,
    unknownVenue = false,
  } = options;
  // The reviewed venues occupy the same location, but their distinct source
  // bindings cannot share an automatic receipt. Keep the overlap for review.
  if (!sameSource && venuesShareReviewedOccurrenceLocation(candidate.venueId, existing.venueId) &&
    confirmedTitleSlotMatches(candidate, existing)) return "ambiguous";
  if (!sameVenue && !sameSource && !unknownVenue) return "unrelated";

  const candidateKey = getNormalizedOccurrenceRelationshipKey(candidate);
  const existingKey = getNormalizedOccurrenceRelationshipKey(existing);
  if (candidateKey && existingKey) {
    if (candidateKey === existingKey) return "proven_duplicate";
    if (sameSource) return "proven_distinct";
  }

  const candidateMinutes = getEventTimeSortMinutes(candidate.time);
  const existingMinutes = getEventTimeSortMinutes(existing.time);
  const candidateIdentity = comparableIdentity(candidate);
  const existingIdentity = comparableIdentity(existing);
  const candidateSourceAccountHandle =
    getNormalizedSourceAccountHandle(candidate);
  const existingSourceAccountHandle =
    getNormalizedSourceAccountHandle(existing);
  const sameSourceAccount = Boolean(
    candidateSourceAccountHandle &&
    candidateSourceAccountHandle === existingSourceAccountHandle,
  );

  if (
    sameVenue &&
    !sameSource &&
    sameSourceAccount &&
    ((isWeakGenericTeaser(candidate, candidateIdentity, candidateMinutes) &&
      hasStrongerOccurrenceEvidence(existingIdentity, existingMinutes)) ||
      (isWeakGenericTeaser(existing, existingIdentity, existingMinutes) &&
        hasStrongerOccurrenceEvidence(candidateIdentity, candidateMinutes)))
  ) {
    return "ambiguous";
  }

  if (
    candidateMinutes !== null &&
    existingMinutes !== null &&
    candidateMinutes !== existingMinutes
  ) {
    return "proven_distinct";
  }

  const sameTitle =
    Boolean(candidateIdentity.title) &&
    candidateIdentity.title === existingIdentity.title;
  const sameNamedOccurrence = titlesNameSameOccurrence(
    candidateIdentity.title,
    existingIdentity.title,
  );
  const sharedArtist = [...candidateIdentity.artists].some((artist) =>
    existingIdentity.artists.has(artist),
  );
  const sameReliableTime =
    candidateMinutes !== null &&
    existingMinutes !== null &&
    candidateMinutes === existingMinutes;

  if (!sameVenue && !sameSource) {
    if (!unknownVenue || (!sameTitle && !sharedArtist)) return "unrelated";
    return sameReliableTime ? "proven_duplicate" : "ambiguous";
  }
  if (
    sameVenue && !sameSource && lineupsSuggestCrossSourceCollision(candidate, existing)
  ) {
    return "ambiguous";
  }
  if (sameVenue && sameNamedOccurrence) return "proven_duplicate";
  if (sameVenue && !sameSource && sameReliableTime &&
    (!candidate.venueId || !existing.venueId || candidate.venueId === existing.venueId) &&
    confirmedTitleSlotMatches(candidate, existing)) return "proven_duplicate";
  if (
    sameVenue &&
    !sameSource &&
    !sharedArtist &&
    titlesProveDistinct(candidateIdentity.title, existingIdentity.title)
  ) {
    return "proven_distinct";
  }
  if ((sameTitle || sharedArtist) && (sameReliableTime || sameSource)) {
    return "proven_duplicate";
  }
  return "ambiguous";
}
