export const PUBLICATION_POLICY_VERSION = 1 as const;

export type PublicationState =
  | "publishable"
  | "hidden"
  | "pending_verification";

type PreviousPublication = {
  status: string;
  publicationState?: PublicationState;
  firstPublishableAt?: number | null;
};

/** Retain the pre-moderation state when the publication evaluator will run after the status write. */
export function beforeModerationStatusChange(previous: PreviousPublication, nextStatus: string):
  { publicationState?: "hidden"; firstPublishableAt?: null } {
  if (previous.status === nextStatus || previous.publicationState !== undefined ||
    previous.firstPublishableAt !== undefined) return {};
  if (previous.status === "approved") return { firstPublishableAt: null };
  return nextStatus === "approved" ? { publicationState: "hidden" } : {};
}

/** Keep an unknown historical publication time unknown across revocation and republication. */
export function firstPublicationPatch(
  previous: PreviousPublication,
  nextState: PublicationState,
  evaluatedAt: number,
): { firstPublishableAt?: number | null } {
  if (previous.firstPublishableAt !== undefined) return {};
  // Older approved rows could already be visible through the legacy public reader.
  const previouslyPublic = previous.publicationState === "publishable" ||
    (previous.publicationState === undefined && previous.status === "approved");
  if (previouslyPublic) {
    return nextState === "publishable" ? {} : { firstPublishableAt: null };
  }
  return nextState === "publishable" ? { firstPublishableAt: evaluatedAt } : {};
}

export type PublicationDecision = {
  policyVersion: typeof PUBLICATION_POLICY_VERSION;
  reason:
    | "moderation_not_approved"
    | "canonical_source_grounding_verified"
    | "canonical_source_grounding_missing"
    | "occurrence_incomplete"
    | "reconciliation_ambiguous"
    | "venue_ambiguous"
    | "venue_unresolved"
    | "venue_unavailable";
  state: PublicationState;
};

export type PublicationEligibilityInput = {
  canonicalSourceGroundingVerified: boolean;
  moderationStatus: "pending" | "approved" | "rejected";
  occurrenceComplete?: boolean;
  reconciliationAmbiguous?: boolean;
  venuePublic?: boolean;
  venueResolutionStatus?: "resolved" | "ambiguous" | "unresolved";
};

/** One side-effect-free policy for materialized public eligibility. */
export function evaluatePublicationEligibility(
  input: PublicationEligibilityInput,
): PublicationDecision {
  if (input.moderationStatus !== "approved") {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "moderation_not_approved",
      state: "hidden",
    };
  }
  if (input.venueResolutionStatus === "ambiguous") {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "venue_ambiguous",
      state: "pending_verification",
    };
  }
  if (input.venueResolutionStatus === "unresolved") {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "venue_unresolved",
      state: "pending_verification",
    };
  }
  if (input.venuePublic === false) {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "venue_unavailable",
      state: "pending_verification",
    };
  }
  if (input.reconciliationAmbiguous) {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "reconciliation_ambiguous",
      state: "pending_verification",
    };
  }
  if (input.occurrenceComplete === false) {
    return {
      policyVersion: PUBLICATION_POLICY_VERSION,
      reason: "occurrence_incomplete",
      state: "pending_verification",
    };
  }
  return input.canonicalSourceGroundingVerified
    ? {
        policyVersion: PUBLICATION_POLICY_VERSION,
        reason: "canonical_source_grounding_verified",
        state: "publishable",
      }
    : {
        policyVersion: PUBLICATION_POLICY_VERSION,
        reason: "canonical_source_grounding_missing",
        state: "pending_verification",
      };
}
