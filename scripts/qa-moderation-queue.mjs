import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareModerationQueuePriority,
  getModerationQueuePriorityScore,
} from "../lib/events/moderation-queue.ts";
import {
  VERIFIED_APPROVAL_NOTE,
  buildVerifiedApprovalNote,
  getModerationReviewDecision,
} from "../lib/events/moderation-view.ts";

function makeEvent(overrides = {}) {
  return {
    confidenceScore: 0.95,
    titleUsedFallback: false,
    missingImage: false,
    allowMissingImage: false,
    missingTime: false,
    hasSuspiciousYear: false,
    suspectedDuplicateCount: 0,
    hasResolvedDuplicate: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const clean = makeEvent();
const allowedMissingImageVideo = makeEvent({
  missingImage: true,
  allowMissingImage: true,
  titleUsedFallback: true,
  missingTime: true,
});
const unresolvedMissingImage = makeEvent({ missingImage: true });
const lowConfidence = makeEvent({ confidenceScore: 0.62 });
const duplicateConflict = makeEvent({
  confidenceScore: 0.9,
  suspectedDuplicateCount: 2,
});
const reviewedConflict = makeEvent({ hasResolvedDuplicate: true });

assert.equal(getModerationQueuePriorityScore(clean), 0);
assert.equal(
  getModerationQueuePriorityScore(makeEvent({ confidenceScore: 0.8 })),
  0,
);
assert.equal(
  getModerationQueuePriorityScore(makeEvent({ confidenceScore: 0.79 })) > 0,
  true,
);
assert.equal(getModerationQueuePriorityScore(makeEvent({ missingTime: true })), 0);
assert.equal(getModerationQueuePriorityScore(unresolvedMissingImage) > 0, true);
assert.equal(
  getModerationQueuePriorityScore(allowedMissingImageVideo) <
    getModerationQueuePriorityScore(unresolvedMissingImage),
  true,
);
assert.equal(
  getModerationQueuePriorityScore(duplicateConflict) >
    getModerationQueuePriorityScore(lowConfidence),
  true,
);
assert.equal(
  getModerationQueuePriorityScore(reviewedConflict) >
    getModerationQueuePriorityScore(duplicateConflict),
  true,
);

const ordered = [
  makeEvent({ createdAt: 1, updatedAt: 10 }),
  makeEvent({ id: "duplicate", suspectedDuplicateCount: 1, createdAt: 2, updatedAt: 2 }),
  makeEvent({ id: "low", confidenceScore: 0.4, createdAt: 3, updatedAt: 3 }),
].sort(compareModerationQueuePriority);

assert.equal(ordered[0].id, "duplicate");
assert.equal(ordered[1].id, "low");
assert.equal(ordered[2].updatedAt, 10);

const reviewedEvent = {
  id: "event-1", updatedAt: 123, moderation: { status: "pending" },
  pendingUniqueness: {
    id: "event-1", expectedUpdatedAt: 123, disposition: "unique", reason: "unique_same_date_cohort",
  },
};
// Only a fresh server decision determines the action, including when local
// diagnostics find low scores, missing optional fields, or similar wording.
for (const confidenceScore of [0, 0.2, 0.79, 0.95, null]) {
  assert.equal(getModerationReviewDecision({
    ...reviewedEvent, confidenceScore, missingImage: true, missingTime: true,
    suspectedDuplicateCount: 3, hasResolvedDuplicate: true,
  }).group, "ready");
}
for (const changed of [
  { updatedAt: 124 }, { updatedAt: Number.NaN },
  { id: "other-event" }, { pendingUniqueness: null },
  { moderation: { status: "approved" } }, { moderation: { status: "rejected" } },
]) {
  assert.equal(getModerationReviewDecision({ ...reviewedEvent, ...changed }).group, "needs_review");
}
assert.equal(getModerationReviewDecision({
  ...reviewedEvent,
  pendingUniqueness: { ...reviewedEvent.pendingUniqueness, disposition: "duplicate" },
}).group, "duplicates");
for (const [disposition, reason] of [
  ["ambiguous", "ambiguous_same_date_occurrence"],
  ["ineligible", "ineligible_title"],
  ["ineligible", "ineligible_invalid_date"],
  ["ineligible", "ineligible_expired_event"],
  ["ineligible", "ineligible_source_policy"],
  ["indeterminate", "indeterminate_approved_cohort_limit"],
]) {
  const decision = getModerationReviewDecision({
    ...reviewedEvent,
    pendingUniqueness: { ...reviewedEvent.pendingUniqueness, disposition, reason },
  });
  assert.equal(decision.group, "needs_review", "Incomplete evidence is not proof of a duplicate or non-event.");
  assert.ok(decision.reason.length > 20);
  assert.doesNotMatch(decision.reason, /_/);
}
assert.equal(buildVerifiedApprovalNote(""), VERIFIED_APPROVAL_NOTE);
assert.equal(buildVerifiedApprovalNote("   "), VERIFIED_APPROVAL_NOTE);
assert.equal(buildVerifiedApprovalNote("  Checked caption.  "), `${VERIFIED_APPROVAL_NOTE} Operator note: Checked caption.`);
assert.ok(VERIFIED_APPROVAL_NOTE.length >= 20);
assert.ok(buildVerifiedApprovalNote("x".repeat(800)).length <= 1000);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(
  packageJson.scripts["qa:moderation-queue"]?.includes("qa-moderation-queue.mjs"),
  "package.json should expose focused moderation queue QA.",
);
assert.match(
  readFileSync("scripts/release-check.mjs", "utf8"),
  /qa:moderation-queue/,
  "Release gate should include focused moderation queue QA.",
);

console.log("QA passed: moderation queue ordering, current server review decisions, score-independent readiness, and optional audit notes.");
