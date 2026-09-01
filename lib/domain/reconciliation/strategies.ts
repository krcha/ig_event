import { toSearchableText } from "../venues/normalization";
import { classifyOccurrenceRelationshipInvariant } from "./occurrence-relation";
import type {
  ReconciliationContext,
  ReconciliationDecision,
  ReconciliationOccurrence,
  ReconciliationStrategy,
} from "./types";

function sameKnownVenue(
  left: ReconciliationOccurrence,
  right: ReconciliationOccurrence,
): boolean {
  if (left.venueId && right.venueId) return left.venueId === right.venueId;
  const leftAccount = normalizeAccountIdentity(left.venueAccountIdentity);
  const rightAccount = normalizeAccountIdentity(right.venueAccountIdentity);
  if (leftAccount && rightAccount) return leftAccount === rightAccount;
  const leftIdentity = toSearchableText(
    left.normalizedVenueIdentity ?? left.venue ?? "",
  );
  const rightIdentity = toSearchableText(
    right.normalizedVenueIdentity ?? right.venue ?? "",
  );
  return Boolean(
    leftIdentity && rightIdentity && leftIdentity === rightIdentity,
  );
}

function normalizeAccountIdentity(value: string | null | undefined): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^@+/u, "")
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/u.test(normalized) ? normalized : "";
}

function hasKnownVenue(value: ReconciliationOccurrence): boolean {
  return Boolean(
    value.venueId ||
    normalizeAccountIdentity(value.venueAccountIdentity) ||
    toSearchableText(value.normalizedVenueIdentity ?? value.venue ?? ""),
  );
}

function sameSource(
  left: ReconciliationOccurrence,
  right: ReconciliationOccurrence,
): boolean {
  if (left.sourceIdentity && right.sourceIdentity) {
    return left.sourceIdentity === right.sourceIdentity;
  }
  return Boolean(
    left.canonicalSourceUrl &&
    right.canonicalSourceUrl &&
    left.canonicalSourceUrl === right.canonicalSourceUrl,
  );
}

function decision(
  strategy: string,
  relation: ReconciliationDecision["relation"],
  confidence: ReconciliationDecision["confidence"],
  candidate: ReconciliationOccurrence,
  reasons: readonly string[],
): ReconciliationDecision {
  return {
    ...(candidate.eventId ? { candidateEventId: candidate.eventId } : {}),
    candidateOccurrenceId: candidate.id,
    confidence,
    evidence: [],
    reasons,
    relation,
    strategy,
  };
}

export const exactSourceOccurrenceStrategy: ReconciliationStrategy = {
  name: "exact_source_occurrence",
  evaluate(context, candidate) {
    const incoming = context.incoming;
    if (
      incoming.sourceIdentity &&
      candidate.sourceIdentity === incoming.sourceIdentity &&
      incoming.sourceOccurrenceKey &&
      candidate.sourceOccurrenceKey === incoming.sourceOccurrenceKey
    ) {
      if (candidate.status === "rejected") {
        return decision(this.name, "ambiguous", "ambiguous", candidate, [
          "exact_source_occurrence_points_to_rejected_event",
        ]);
      }
      return decision(
        this.name,
        "exact_source_occurrence",
        "proven",
        candidate,
        ["source_identity_and_occurrence_key_match"],
      );
    }
    return null;
  },
};

export const semanticOccurrenceStrategy: ReconciliationStrategy = {
  name: "canonical_occurrence_relation",
  evaluate(context, candidate) {
    const incoming = context.incoming;
    if (incoming.date !== candidate.date) {
      return decision(this.name, "independent", "proven", candidate, [
        "local_dates_are_distinct",
      ]);
    }
    const sameVenue = sameKnownVenue(incoming, candidate);
    const sourceMatches = sameSource(incoming, candidate);
    const relation = classifyOccurrenceRelationshipInvariant({
      candidate: {
        artists: [...incoming.artists],
        normalizedFieldsJson: incoming.normalizedFieldsJson ?? undefined,
        sourceAccountHandle: incoming.sourceAccountHandle ?? undefined,
        sourceOccurrenceKey: incoming.sourceOccurrenceKey ?? undefined,
        time: incoming.time ?? undefined,
        title: incoming.title,
      },
      existing: {
        artists: [...candidate.artists],
        normalizedFieldsJson: candidate.normalizedFieldsJson ?? undefined,
        sourceAccountHandle: candidate.sourceAccountHandle ?? undefined,
        sourceOccurrenceKey: candidate.sourceOccurrenceKey ?? undefined,
        time: candidate.time ?? undefined,
        title: candidate.title,
      },
      sameSource: sourceMatches,
      sameVenue,
      unknownVenue: !hasKnownVenue(incoming) || !hasKnownVenue(candidate),
    });

    if (relation === "proven_duplicate") {
      if (candidate.status === "rejected") {
        return decision(this.name, "ambiguous", "ambiguous", candidate, [
          "matching_candidate_is_rejected",
        ]);
      }
      return decision(
        this.name,
        sourceMatches ? "same_occurrence" : "cross_post",
        "proven",
        candidate,
        [
          sourceMatches
            ? "semantic_match_same_source"
            : "semantic_match_cross_source",
        ],
      );
    }
    if (relation === "proven_distinct") {
      return decision(this.name, "independent", "proven", candidate, [
        "semantic_evidence_proves_distinct_occurrences",
      ]);
    }
    if (relation === "ambiguous") {
      return decision(this.name, "ambiguous", "ambiguous", candidate, [
        "semantic_evidence_does_not_prove_same_or_distinct",
      ]);
    }
    return decision(this.name, "unrelated", "strong", candidate, [
      "candidate_has_no_supported_occurrence_relationship",
    ]);
  },
};

export const DEFAULT_RECONCILIATION_STRATEGIES: readonly ReconciliationStrategy[] =
  [exactSourceOccurrenceStrategy, semanticOccurrenceStrategy];
