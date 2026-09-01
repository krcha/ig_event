import { getEventTimeSortMinutes } from "../../events/event-time";
import { toSearchableText } from "../venues/normalization";

export type OccurrenceRelationshipCandidate = {
  artists?: readonly string[] | null;
  normalizedFieldsJson?: string | null;
  sourceAccountHandle?: string | null;
  sourceOccurrenceKey?: string | null;
  time?: string | null;
  title: string;
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
  if (sameVenue && sameNamedOccurrence) return "proven_duplicate";
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
