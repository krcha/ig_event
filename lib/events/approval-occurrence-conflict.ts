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

function normalizedOccurrenceKey(candidate: ApprovalOccurrenceCandidate): string | null {
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

/**
 * Classify only candidates already known to share the same event date.
 * "ambiguous" is intentionally distinct from "duplicate": ingestion can
 * persist it as pending instead of dropping a legitimate child occurrence.
 */
export function classifyApprovalOccurrenceRelation(options: {
  candidate: ApprovalOccurrenceCandidate;
  existing: ApprovalOccurrenceCandidate;
  sameVenue: boolean;
  sameSource: boolean;
}): ApprovalOccurrenceRelation {
  const { candidate, existing, sameVenue, sameSource } = options;
  if (!sameVenue && !sameSource) return "unrelated";

  const candidateKey = normalizedOccurrenceKey(candidate);
  const existingKey = normalizedOccurrenceKey(existing);
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
  const sharedArtist = [...candidateIdentity.artists].some((artist) =>
    existingIdentity.artists.has(artist),
  );
  const sameReliableTime =
    candidateMinutes !== null &&
    existingMinutes !== null &&
    candidateMinutes === existingMinutes;

  if ((sameTitle || sharedArtist) && (sameReliableTime || sameSource)) {
    return "proven_duplicate";
  }

  return "ambiguous";
}
