import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DomainError } from "../lib/domain/errors.ts";
import {
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
  hasCompleteSourceGroundedAutoApproval,
  hasEventEvidenceV2AutoApproval,
  hasTrustedSourceEventAnnouncementAutoApproval,
} from "../lib/events/event-update-precondition.ts";
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
assert.ok(!missingEvidence.pendingReasons.includes("missing_confidence"));
assert.ok(!missingEvidence.pendingReasons.includes("below_auto_approve_threshold"));
assert.ok(missingEvidence.pendingReasons.includes("low_date_confidence"));
assert.ok(missingEvidence.signals.includes("time_tbd"));

// Exercise the real preparation output at the service create/update boundary:
// a low aggregate score is information, not a second publication veto.
const confidenceValues = [null, 0, 0.2, 0.59, 0.64, 0.79, 0.8, 1];
const futureDate = new Date();
futureDate.setUTCDate(futureDate.getUTCDate() + 7);
const eventDate = futureDate.toISOString().slice(0, 10);
const dateEvidenceText = eventDate.split("-").reverse().join(".");
const sourceCaption =
  `Koncert Open Air Festival ${dateEvidenceText} at 20:00 at QA Trusted Venue`;
const instagramPostId = "QaModerationParity";
const instagramPostUrl = `https://www.instagram.com/p/${instagramPostId}/`;
const publicEvent = {
  title: "Open Air Festival",
  date: eventDate,
  time: "20:00",
  venue: "QA Trusted Venue",
  venueInstagramHandle: "qa_trusted_venue",
  artists: [],
  imageUrl: "https://example.com/qa-event.jpg",
  sourceCaption,
  instagramPostId,
  instagramPostUrl,
  timeSource: "caption",
  timeEvidenceText: "20:00",
  timeConfidence: "high",
  timeStatus: "confirmed",
  timeEvidenceKind: "start_time_stated",
  dateEvidenceText,
  dateEvidenceSource: "caption",
  dateEvidenceIsRelative: false,
  dateEvidenceResolvedDate: eventDate,
  sourceConflictFields: [],
};
const sourceFields = {
  ...publicEvent,
  normalizedDate: eventDate,
  normalizedVenue: publicEvent.venue,
  normalizedIsValid: true,
  titleUsedFallback: false,
  dateSuspiciousYear: false,
  dateConfidence: "high",
  missingImage: false,
  approvalTitleSensible: true,
  approvalCaptionSourceCoherent: true,
  sourceGroundingVersion: 4,
  sourceGroundingEvidence: "instagram_caption",
  sourceGroundingSourceKind: "caption",
  sourceGroundingVerified: true,
  sourceGroundingTitleVerified: true,
  sourceGroundingDateVerified: true,
  sourceGroundingIdentityVerified: true,
  sourceGroundingIdentityContextVerified: true,
  sourceGroundingRowVerified: true,
  sourceGroundingTimeVerified: true,
  sourceGroundingArtistsVerified: null,
  sourceGroundingInstagramHandle: "qa_trusted_venue",
  sourceGroundingSourceCaption: sourceCaption,
  sourceGroundingInstagramPostId: instagramPostId,
  sourceGroundingInstagramPostUrl: instagramPostUrl,
};
const automaticPaths = [
  {
    rule: "event_evidence_v2",
    preparation: { structuredEvidenceVerified: true },
    accepts: hasEventEvidenceV2AutoApproval,
    fields: {
      extractionContractVersion: "event_evidence_v2",
      extractionIsEvent: true,
      extractionNonEventReason: null,
      extractionMode: "caption_only",
      extractionSourceConflicts: [],
      extractionSourceConflictCount: 0,
      sourceGroundingVersion: 5,
      sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
      structuredEvidenceVerified: true,
      dateEvidenceVerified: true,
      timeEvidenceVerified: true,
      identityEvidenceVerified: true,
      venueEvidenceVerified: true,
    },
  },
  {
    rule: "source_grounded_core_event_fields",
    preparation: { sourceGroundingVerified: true },
    accepts: hasCompleteSourceGroundedAutoApproval,
    fields: {},
  },
  {
    rule: "trusted_source_event_announcement",
    preparation: {
      trustedVenueSource: true,
      autoApprovalBlockers: [
        "unverified_core_event_source",
        "unverified_occurrence_plan",
      ],
    },
    accepts: hasTrustedSourceEventAnnouncementAutoApproval,
    fields: { trustedVenueSource: true },
  },
];
let scoreIndependentApprovals = 0;
let blockedEventChecks = 0;
for (const path of automaticPaths) {
  for (const baseConfidenceScore of confidenceValues) {
    const label = `${path.rule}, confidence=${baseConfidenceScore}`;
    const decision = automated({ ...path.preparation, baseConfidenceScore });
    assert.equal(decision.targetStatus, "approved", label);
    assert.equal(decision.autoApproved, true, label);
    assert.equal(decision.autoApproveRule, path.rule, label);
    assert.deepEqual(decision.pendingReasons, [], label);
    assert.equal(decision.confidenceScore, baseConfidenceScore, label);
    assert.equal(
      decision.signals.includes("low_confidence"),
      baseConfidenceScore !== null && baseConfidenceScore < 0.7,
      `${label}: retain the score as informational evidence`,
    );
    const normalizedFieldsJson = JSON.stringify({
      ...sourceFields,
      ...path.fields,
      moderationAutoApproved: decision.autoApproved,
      moderationAutoApproveRule: decision.autoApproveRule,
      moderationConfidenceScore: decision.confidenceScore,
      moderationPendingReasons: decision.pendingReasons,
      moderationSignals: decision.signals,
      moderationAllowMissingImage: decision.allowMissingImage,
    });
    assert.equal(path.accepts(normalizedFieldsJson, publicEvent), true, label);
    assert.doesNotThrow(
      () => assertServiceCreateEventPolicy("approved", normalizedFieldsJson, publicEvent),
      `${label}: service create must accept the policy approval`,
    );
    assert.doesNotThrow(
      () => assertServiceUpdateEventPolicy(
        "pending", { status: "approved", normalizedFieldsJson }, publicEvent,
      ),
      `${label}: service update must accept the policy approval`,
    );
    assert.equal(
      path.accepts(normalizedFieldsJson, { ...publicEvent, title: "Invented Concert" }),
      false,
      `${label}: the public fields must still match the reviewed source`,
    );
    scoreIndependentApprovals += 1;
  }
  for (const blocker of [
    "non_event_closure_notice",
    "ambiguous_duplicate",
    "material_source_conflict",
  ]) {
    const decision = automated({
      ...path.preparation,
      baseConfidenceScore: 1,
      autoApprovalBlockers: [blocker],
    });
    assert.equal(decision.targetStatus, "pending", `${path.rule}: ${blocker}`);
    assert.equal(decision.autoApproved, false);
    assert.ok(decision.pendingReasons.includes(blocker));
    blockedEventChecks += 1;
  }
}
assert.equal(automated({ baseConfidenceScore: 1 }).targetStatus, "pending");
assert.equal(
  automated({
    baseConfidenceScore: 1,
    trustedVenueSource: true,
    sourceGroundingIdentityContextVerified: false,
  }).targetStatus,
  "pending",
  "Even a maximum score cannot replace evidence that this source names this event.",
);

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
  `QA passed: shared human moderation; ${scoreIndependentApprovals} score-independent approvals across all three automatic paths and service write boundaries; ${blockedEventChecks} non-event, duplicate, and material-conflict holds.`,
);
