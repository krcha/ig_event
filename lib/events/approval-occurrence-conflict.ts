import { getEventTimeSortMinutes } from "./event-time";
import { toSearchableText } from "../pipeline/venue-normalization";

export type ApprovalOccurrenceCandidate = {
  title: string;
  time?: string | null;
  artists?: string[] | null;
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
  if (
    candidateMinutes !== null &&
    existingMinutes !== null &&
    candidateMinutes !== existingMinutes
  ) {
    return "proven_distinct";
  }

  const candidateIdentity = comparableIdentity(candidate);
  const existingIdentity = comparableIdentity(existing);
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
