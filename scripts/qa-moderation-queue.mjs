import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareModerationQueuePriority,
  getModerationQueuePriorityScore,
} from "../lib/events/moderation-queue.ts";

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

console.log("QA passed: moderation queue priority ordering.");
