import { getEventTimeSortMinutes } from "./event-time";
import { toSearchableText } from "../pipeline/venue-normalization";

export type ApprovalOccurrenceCandidate = {
  title: string;
  time?: string | null;
  artists?: string[] | null;
  sourceAccountHandle?: string | null;
  sourceOccurrenceKey?: string | null;
  normalizedFieldsJson?: string | null;
};

export type ApprovalOccurrenceRelation =
  | "unrelated"
  | "proven_duplicate"
  | "proven_distinct"
  | "ambiguous";

export function getNormalizedApprovalOccurrenceKey(
  candidate: ApprovalOccurrenceCandidate,
): string | null {
  const direct = candidate.sourceOccurrenceKey?.trim();
  if (direct) return direct;
  if (!candidate.normalizedFieldsJson) return null;
  try {
    const parsed = JSON.parse(candidate.normalizedFieldsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).sourceOccurrenceKey;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function comparableIdentity(candidate: ApprovalOccurrenceCandidate): {
  title: string;
  artists: Set<string>;
} {
  return {
    title: toSearchableText(candidate.title),
    artists: new Set(
      (candidate.artists ?? [])
        .map((artist) => toSearchableText(artist))
        .filter(Boolean),
    ),
  };
}

function normalizeSourceAccountHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/^@+/u, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/u.test(normalized) ? normalized : null;
}

function getNormalizedSourceAccountHandle(
  candidate: ApprovalOccurrenceCandidate,
): string | null {
  const direct = normalizeSourceAccountHandle(candidate.sourceAccountHandle);
  if (direct) return direct;
  if (!candidate.normalizedFieldsJson) return null;
  try {
    const parsed = JSON.parse(candidate.normalizedFieldsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeSourceAccountHandle(
      (parsed as Record<string, unknown>).sourceGroundingInstagramHandle,
    );
  } catch {
    return null;
  }
}

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

function isGenericTeaserTitle(title: string): boolean {
  const normalized = toSearchableText(title);
  if (!normalized) return false;
  if (GENERIC_TEASER_TITLES.has(normalized)) return true;

  const tokens = normalized.split(/\s+/u);
  const [prefix, ...qualifiers] = tokens;
  if (!prefix || !GENERIC_SEQUENCE_PREFIXES.has(prefix) || qualifiers.length > 2) {
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
  candidate: ApprovalOccurrenceCandidate,
  identity: ReturnType<typeof comparableIdentity>,
  minutes: number | null,
): boolean {
  return (
    minutes === null &&
    identity.artists.size === 0 &&
    isGenericTeaserTitle(candidate.title)
  );
}

function hasStrongerOccurrenceEvidence(
  identity: ReturnType<typeof comparableIdentity>,
  minutes: number | null,
): boolean {
  return minutes !== null || identity.artists.size > 0;
}

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

function significantTitleTokens(title: string): string[] {
  return title
    .split(/\s+/u)
    .filter(
      (token) =>
        token.length >= 3 &&
        !NON_DISTINCTIVE_TITLE_TOKENS.has(token),
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
 * Classify only candidates already known to share the same event date.
 * "ambiguous" is intentionally distinct from "duplicate": ingestion can
 * persist it as pending instead of dropping a legitimate child occurrence.
 * When venue context is unavailable, strong cross-source identity overlap
 * must still fail closed instead of being treated as unrelated.
 */
export function classifyApprovalOccurrenceRelation(options: {
  candidate: ApprovalOccurrenceCandidate;
  existing: ApprovalOccurrenceCandidate;
  sameVenue: boolean;
  sameSource: boolean;
  unknownVenue?: boolean;
}): ApprovalOccurrenceRelation {
  const { candidate, existing, sameVenue, sameSource, unknownVenue = false } = options;
  if (!sameVenue && !sameSource && !unknownVenue) return "unrelated";

  const candidateKey = getNormalizedApprovalOccurrenceKey(candidate);
  const existingKey = getNormalizedApprovalOccurrenceKey(existing);
  if (candidateKey && existingKey) {
    if (candidateKey === existingKey) return "proven_duplicate";
    if (sameSource) return "proven_distinct";
  }

  const candidateMinutes = getEventTimeSortMinutes(candidate.time);
  const existingMinutes = getEventTimeSortMinutes(existing.time);
  const candidateIdentity = comparableIdentity(candidate);
  const existingIdentity = comparableIdentity(existing);
  const candidateSourceAccountHandle = getNormalizedSourceAccountHandle(candidate);
  const existingSourceAccountHandle = getNormalizedSourceAccountHandle(existing);
  const sameSourceAccount = Boolean(
    candidateSourceAccountHandle &&
      candidateSourceAccountHandle === existingSourceAccountHandle,
  );

  // A venue or promoter account can publish an evidence-empty teaser before a richer
  // lineup post. Distinct post/occurrence keys do not prove that a generic
  // "Chapter four" row is a separate event. Hold the pair for coalescing or
  // review when the date (the caller's cohort), physical venue, and normalized
  // source account all agree and only one side carries meaningful time/artist
  // evidence. This stays deliberately narrower than the general title logic so
  // two independently named events at the same venue can still be distinct.
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
    Boolean(candidateIdentity.title) && candidateIdentity.title === existingIdentity.title;
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

  if (sameVenue && sameNamedOccurrence) {
    return "proven_duplicate";
  }

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
