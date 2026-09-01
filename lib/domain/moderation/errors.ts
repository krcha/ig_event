import {
  DomainError,
  type DomainErrorCode,
  isDomainError,
} from "../errors";

const HUMAN_APPROVAL_INELIGIBLE_MESSAGES = new Set([
  "Human approval requires complete canonical Instagram source grounding for the final public fields.",
  "Human approval requires a substantive moderation note.",
  "Service approval requires a persisted Instagram source post.",
  "Service approval source does not match the persisted Instagram post.",
  "Service approval requires current persisted GPT-5 mini event evidence bound to the exact source revision.",
  "Service approval source does not independently ground the final public event fields.",
]);

const APPROVAL_CONFLICT_MESSAGES = new Map<string, DomainErrorCode>([
  ["Event title is not suitable for approval.", "MODERATION_INELIGIBLE"],
  [
    "An approved event already exists for this canonical occurrence.",
    "EVENT_DUPLICATE",
  ],
  [
    "This same-day occurrence is ambiguous against an approved event and cannot be auto-approved.",
    "EVENT_AMBIGUOUS",
  ],
]);

/**
 * Temporary compatibility adapter for old helpers that still throw Error.
 * Callers branch on the stable code returned here; the exact-message mapping
 * remains isolated until those helpers are migrated.
 */
export function toModerationDomainError(error: unknown): DomainError {
  if (isDomainError(error)) return error;
  if (!(error instanceof Error)) {
    return new DomainError(
      "MODERATION_INVALID_REQUEST",
      "Moderation policy failed with an unknown error.",
      { details: { originalError: String(error) } },
    );
  }
  if (HUMAN_APPROVAL_INELIGIBLE_MESSAGES.has(error.message)) {
    return new DomainError("SOURCE_NOT_GROUNDED", error.message, { cause: error });
  }
  const conflictCode = APPROVAL_CONFLICT_MESSAGES.get(error.message);
  if (conflictCode) {
    return new DomainError(conflictCode, error.message, { cause: error });
  }
  return new DomainError("MODERATION_INVALID_REQUEST", error.message, {
    cause: error,
  });
}

export function isHumanApprovalIneligibleError(error: unknown): boolean {
  const code = toModerationDomainError(error).code;
  return code === "SOURCE_NOT_GROUNDED" || code === "MODERATION_INELIGIBLE";
}

export function isSkippableApprovalConflict(error: unknown): boolean {
  const code = toModerationDomainError(error).code;
  return (
    code === "MODERATION_INELIGIBLE" ||
    code === "EVENT_DUPLICATE" ||
    code === "EVENT_AMBIGUOUS"
  );
}
