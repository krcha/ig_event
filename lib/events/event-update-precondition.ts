import { CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD } from "../utils/confidence.ts";

export type EventStatusPrecondition = "pending" | "approved" | "rejected";

type EventWritePatch = Record<string, unknown> & {
  status?: EventStatusPrecondition;
  normalizedFieldsJson?: string;
};

const SOURCE_GROUNDED_AUTO_APPROVE_RULE = "source_grounded_core_event_fields";

function parseNormalizedFields(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTrueOrNull(value: unknown): boolean {
  return value === true || value === null;
}

export function hasCompleteSourceGroundedAutoApproval(
  normalizedFieldsJson: string | undefined,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields) {
    return false;
  }

  const pendingReasons = fields.moderationPendingReasons;
  const moderationSignals = fields.moderationSignals;
  const confidenceScore = fields.moderationConfidenceScore;
  const normalizedDate = fields.normalizedDate;
  const normalizedVenue = fields.normalizedVenue;

  return (
    fields.sourceGroundingVersion === 2 &&
    fields.sourceGroundingEvidence === "instagram_caption_or_alt_text" &&
    fields.sourceGroundingVerified === true &&
    fields.sourceGroundingTitleVerified === true &&
    fields.sourceGroundingDateVerified === true &&
    fields.sourceGroundingIdentityVerified === true &&
    fields.sourceGroundingIdentityContextVerified === true &&
    fields.sourceGroundingRowVerified === true &&
    isTrueOrNull(fields.sourceGroundingTimeVerified) &&
    isTrueOrNull(fields.sourceGroundingArtistsVerified) &&
    fields.moderationAutoApproved === true &&
    fields.moderationAutoApproveRule === SOURCE_GROUNDED_AUTO_APPROVE_RULE &&
    Array.isArray(pendingReasons) &&
    pendingReasons.length === 0 &&
    Array.isArray(moderationSignals) &&
    !moderationSignals.some((signal) =>
      [
        "requires_human_approval",
        "unverified_core_event_source",
        "non_event_closure_notice",
        "fallback_title",
        "suspicious_year",
        "low_confidence",
      ].includes(String(signal)),
    ) &&
    typeof confidenceScore === "number" &&
    Number.isFinite(confidenceScore) &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD &&
    typeof normalizedDate === "string" &&
    normalizedDate.length > 0 &&
    typeof normalizedVenue === "string" &&
    normalizedVenue.length > 0 &&
    fields.normalizedIsValid === true &&
    fields.titleUsedFallback === false &&
    fields.dateSuspiciousYear === false &&
    (fields.dateConfidence === "high" || fields.dateConfidence === "medium") &&
    (fields.missingImage === false ||
      (fields.missingImage === true && fields.moderationAllowMissingImage === true))
  );
}

export function assertExpectedEventStatus(
  currentStatus: EventStatusPrecondition,
  expectedStatus: EventStatusPrecondition | undefined,
): void {
  if (expectedStatus !== undefined && currentStatus !== expectedStatus) {
    throw new Error(
      `Event status changed during update (expected ${expectedStatus}, found ${currentStatus}).`,
    );
  }
}

export function assertServiceCreateEventPolicy(
  requestedStatus: EventStatusPrecondition | undefined,
  normalizedFieldsJson?: string,
): void {
  if (
    requestedStatus === "approved" &&
    !hasCompleteSourceGroundedAutoApproval(normalizedFieldsJson)
  ) {
    throw new Error(
      "Service-authenticated event creation cannot approve an event without complete source-grounded evidence.",
    );
  }
}

export function assertServiceUpdateEventPolicy(
  currentStatus: EventStatusPrecondition,
  patch: EventWritePatch,
): void {
  if (
    patch.status === "approved" &&
    (currentStatus !== "pending" ||
      !hasCompleteSourceGroundedAutoApproval(patch.normalizedFieldsJson))
  ) {
    throw new Error(
      "Service-authenticated event updates cannot approve an event without complete source-grounded evidence.",
    );
  }

  const keepsEventApproved = currentStatus === "approved" && patch.status === undefined;
  if (keepsEventApproved) {
    throw new Error(
      "Service-authenticated updates must demote an approved event before updating it.",
    );
  }
}
