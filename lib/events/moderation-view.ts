export const MODERATION_QUEUE_FETCH_LIMIT = 200;
export const DEFAULT_MODERATION_VISIBLE_LIMIT = 50;

export const VERIFIED_APPROVAL_NOTE =
  "Approved after server verification of source evidence, event date, venue identity, and same-date uniqueness.";

export function buildVerifiedApprovalNote(customNote: string): string {
  const note = customNote.trim();
  return note ? `${VERIFIED_APPROVAL_NOTE} Operator note: ${note}` : VERIFIED_APPROVAL_NOTE;
}

export function getModerationReviewDecision(event: {
  id: string;
  updatedAt: number;
  moderation: { status: string };
  pendingUniqueness: {
    id: string;
    expectedUpdatedAt: number;
    disposition: string;
    reason: string;
  } | null;
}): { group: "ready" | "needs_review" | "duplicates"; label: string; reason: string } {
  const review = event.pendingUniqueness;
  if (
    event.moderation.status !== "pending" || !review || review.id !== event.id ||
    review.expectedUpdatedAt !== event.updatedAt || !Number.isSafeInteger(event.updatedAt)
  ) {
    return { group: "needs_review", label: "Needs review", reason: "Refresh to check the current event details." };
  }
  if (review.disposition === "unique") {
    return { group: "ready", label: "Ready to approve", reason: "Source confirmed; no duplicate found." };
  }
  if (review.disposition === "duplicate") {
    return { group: "duplicates", label: "Duplicate", reason: "Another listing already represents this event." };
  }
  const reasons: Record<string, string> = {
    ambiguous_same_date_occurrence: "Compare the similar listings before deciding.",
    ineligible_title: "Check the event title against its source.",
    ineligible_invalid_date: "Confirm the event date from its source.",
    ineligible_expired_event: "This event has already passed.",
    ineligible_source_policy: "The source details need review.",
    ineligible_source_conflict: "The poster and caption disagree on an event fact. Resolve the source conflict first.",
  };
  return {
    group: "needs_review",
    label: "Needs review",
    reason: reasons[review.reason] ?? "Verification is incomplete. Review the evidence or refresh to try again.",
  };
}

export function selectVisibleModerationEvents<T>(
  events: readonly T[],
  requestedLimit: string | number,
): T[] {
  const parsedLimit =
    typeof requestedLimit === "number" ? requestedLimit : Number(requestedLimit);
  const safeVisibleLimit = Number.isSafeInteger(parsedLimit)
    ? Math.max(1, Math.min(MODERATION_QUEUE_FETCH_LIMIT, parsedLimit))
    : DEFAULT_MODERATION_VISIBLE_LIMIT;

  return events.slice(0, safeVisibleLimit);
}
