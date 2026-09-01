import {
  classifyOccurrenceRelationshipInvariant,
  getNormalizedOccurrenceRelationshipKey,
  type OccurrenceRelationshipCandidate,
  type OccurrenceRelationshipInvariant,
} from "../domain/reconciliation/occurrence-relation";

export type ApprovalOccurrenceCandidate = OccurrenceRelationshipCandidate & {
  artists?: string[] | null;
};

export type ApprovalOccurrenceRelation = OccurrenceRelationshipInvariant;

function readLegacyInstagramSourceAccount(
  normalizedFieldsJson: string | null | undefined,
): string | null {
  if (!normalizedFieldsJson) return null;
  try {
    const parsed = JSON.parse(normalizedFieldsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)
      .sourceGroundingInstagramHandle;
    if (typeof value !== "string") return null;
    const normalized = value
      .normalize("NFKC")
      .trim()
      .replace(/^@+/u, "")
      .toLowerCase();
    return /^[a-z0-9._]{1,30}$/u.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Legacy approval rows still carry their source account inside normalized
 * fields. Adapt that physical Instagram representation before entering the
 * provider-neutral reconciliation invariant.
 */
function adaptLegacyApprovalOccurrence(
  candidate: ApprovalOccurrenceCandidate,
): ApprovalOccurrenceCandidate {
  if (candidate.sourceAccountHandle) return candidate;
  const sourceAccountHandle = readLegacyInstagramSourceAccount(
    candidate.normalizedFieldsJson,
  );
  return sourceAccountHandle ? { ...candidate, sourceAccountHandle } : candidate;
}

export function getNormalizedApprovalOccurrenceKey(
  candidate: ApprovalOccurrenceCandidate,
): string | null {
  return getNormalizedOccurrenceRelationshipKey(candidate);
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
  return classifyOccurrenceRelationshipInvariant({
    ...options,
    candidate: adaptLegacyApprovalOccurrence(options.candidate),
    existing: adaptLegacyApprovalOccurrence(options.existing),
  });
}
