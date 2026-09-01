import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DomainError } from "../lib/domain/errors.ts";
import {
  MODERATION_POLICY_VERSION,
  applyModerationDecision,
  isHumanApprovalIneligibleError,
  isSkippableApprovalConflict,
  prepareModerationDecision,
  unwrapModerationResult,
  validateModerationDecision,
} from "../lib/domain/moderation/index.ts";
import { readIngestionArchitectureSource } from "./qa-support/ingestion-architecture-source.mjs";

function prepareHuman(entryPoint, targetStatus, options = {}) {
  return unwrapModerationResult(
    prepareModerationDecision({
      kind: "human",
      entryPoint,
      targetStatus,
      ...options,
    }),
  );
}

const single = prepareHuman("single", "rejected", {
  moderationNote: "Keep original whitespace. ",
});
assert.deepEqual(single, {
  kind: "human",
  entryPoint: "single",
  action: "reject",
  targetStatus: "rejected",
  moderationNote: "Keep original whitespace. ",
  policyVersion: MODERATION_POLICY_VERSION,
});

const singleValidated = unwrapModerationResult(
  validateModerationDecision(single, {
    currentStatus: "pending",
    currentUpdatedAt: 100,
    expectedUpdatedAt: 100,
  }),
);
const singleApplied = unwrapModerationResult(
  applyModerationDecision(singleValidated, {
    currentUpdatedAt: 100,
    now: 90,
    reviewedBy: "qa-admin",
  }),
);
assert.deepEqual(singleApplied.eventPatch, {
  status: "rejected",
  reviewedAt: 90,
  reviewedBy: "qa-admin",
  moderationNote: "Keep original whitespace. ",
  updatedAt: 101,
});
assert.deepEqual(singleApplied.audit, {
  policyVersion: MODERATION_POLICY_VERSION,
  entryPoint: "single",
});

const noteClearingPatch = unwrapModerationResult(
  applyModerationDecision(prepareHuman("single", "rejected"), {
    currentUpdatedAt: 100,
    now: 101,
    reviewedBy: "qa-admin",
  }),
).eventPatch;
assert.equal(Object.hasOwn(noteClearingPatch, "moderationNote"), true);
assert.equal(noteClearingPatch.moderationNote, undefined);

const batch = prepareHuman("batch", "approved", {
  moderationNote: "Reviewed exact persisted evidence.",
});
const unique = prepareHuman("unique", "approved", {
  moderationNote: "  Reviewed exact persisted evidence.  ",
  trimModerationNote: true,
  noteConstraint: {
    minLength: 20,
    maxLength: 1_000,
    errorMessage:
      "Unique pending approval requires a moderation note of 20-1000 characters.",
  },
});
assert.equal(batch.action, unique.action);
assert.equal(batch.targetStatus, unique.targetStatus);
assert.equal(unique.moderationNote, "Reviewed exact persisted evidence.");

const shortUniqueNote = prepareModerationDecision({
  kind: "human",
  entryPoint: "unique",
  targetStatus: "approved",
  moderationNote: "too short",
  trimModerationNote: true,
  noteConstraint: {
    minLength: 20,
    maxLength: 1_000,
    errorMessage:
      "Unique pending approval requires a moderation note of 20-1000 characters.",
  },
});
assert.equal(shortUniqueNote.ok, false);
assert.equal(shortUniqueNote.error.code, "MODERATION_INVALID_REQUEST");
assert.match(shortUniqueNote.error.message, /20-1000 characters/u);

const stale = validateModerationDecision(batch, {
  currentStatus: "pending",
  currentUpdatedAt: 101,
  expectedUpdatedAt: 100,
});
assert.equal(stale.ok, false);
assert.equal(stale.error.code, "STALE_EVENT_VERSION");
assert.match(stale.error.message, /reviewed version/u);

const alreadyModerated = validateModerationDecision(batch, {
  currentStatus: "approved",
  currentUpdatedAt: 100,
});
assert.equal(alreadyModerated.ok, false);
assert.equal(alreadyModerated.error.code, "MODERATION_INVALID_TRANSITION");

const automatedBase = {
  kind: "automated",
  entryPoint: "automated",
  baseConfidenceScore: 0.9,
  missingImage: false,
  allowMissingImage: false,
  titleUsedFallback: false,
  missingTime: false,
  suspiciousYear: false,
  dateConfidence: "high",
  hasDate: true,
  hasVenue: true,
  sourceGroundingVerified: false,
  sourceGroundingTitleVerified: true,
  sourceGroundingDateVerified: true,
  sourceGroundingIdentityContextVerified: true,
  approvalCaptionSourceCoherent: true,
  trustedVenueSource: false,
  structuredEvidenceVerified: false,
  autoApprovalBlockers: [],
};

function automated(overrides = {}) {
  return unwrapModerationResult(
    prepareModerationDecision({ ...automatedBase, ...overrides }),
  );
}

const structured = automated({
  baseConfidenceScore: 0.6,
  structuredEvidenceVerified: true,
});
assert.equal(structured.targetStatus, "approved");
assert.equal(structured.autoApproveRule, "event_evidence_v2");
assert.equal(structured.policyVersion, MODERATION_POLICY_VERSION);

const sourceGrounded = automated({ sourceGroundingVerified: true });
assert.equal(sourceGrounded.targetStatus, "approved");
assert.equal(
  sourceGrounded.autoApproveRule,
  "source_grounded_core_event_fields",
);

const trustedSource = automated({
  baseConfidenceScore: 0.65,
  trustedVenueSource: true,
  autoApprovalBlockers: [
    "unverified_core_event_source",
    "unverified_occurrence_plan",
  ],
});
assert.equal(trustedSource.targetStatus, "approved");
assert.equal(
  trustedSource.autoApproveRule,
  "trusted_source_event_announcement",
);

const ambiguous = automated({
  sourceGroundingVerified: true,
  autoApprovalBlockers: ["ambiguous_duplicate"],
});
assert.equal(ambiguous.targetStatus, "pending");
assert.equal(ambiguous.autoApproved, false);
assert.equal(ambiguous.autoApproveRule, null);
assert.deepEqual(ambiguous.pendingReasons, [
  "requires_human_approval",
  "ambiguous_duplicate",
]);

const missingEvidence = automated({
  baseConfidenceScore: null,
  missingTime: true,
  dateConfidence: "low",
});
assert.equal(missingEvidence.targetStatus, "pending");
assert.ok(missingEvidence.pendingReasons.includes("missing_confidence"));
assert.ok(missingEvidence.pendingReasons.includes("low_date_confidence"));
assert.ok(missingEvidence.signals.includes("time_tbd"));

assert.equal(
  isSkippableApprovalConflict(
    new DomainError("EVENT_DUPLICATE", "compatible human message"),
  ),
  true,
);
assert.equal(
  isSkippableApprovalConflict(
    new Error("An approved event already exists for this canonical occurrence."),
  ),
  true,
);
assert.equal(
  isHumanApprovalIneligibleError(
    new Error(
      "Human approval requires complete canonical Instagram source grounding for the final public fields.",
    ),
  ),
  true,
);

const moderationCommandsSource = readFileSync(
  "convex/eventDomain/moderationCommands.ts",
  "utf8",
);
const pipelineSource = readIngestionArchitectureSource();
for (const entryPoint of ["single", "batch", "unique"]) {
  assert.match(
    moderationCommandsSource,
    new RegExp(`entryPoint: ["']${entryPoint}["']`, "u"),
    `${entryPoint} moderation must enter the shared policy`,
  );
}
assert.match(moderationCommandsSource, /validateModerationDecision\(/u);
assert.match(moderationCommandsSource, /applyModerationDecision\(/u);
assert.doesNotMatch(
  moderationCommandsSource,
  /\^\(\?:Event title is not suitable for approval\|An approved event already exists/u,
  "Batch behavior must not parse human-facing approval messages.",
);
assert.match(pipelineSource, /entryPoint: ["']automated["']/u);
assert.match(pipelineSource, /prepareModerationDecision\(/u);
assert.doesNotMatch(pipelineSource, /function buildModerationDecision\(/u);

console.log(
  "QA passed: single, batch, unique, and automated moderation share one typed policy while preserving fail-closed approval behavior.",
);
