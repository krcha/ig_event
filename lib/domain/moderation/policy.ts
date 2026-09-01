import {
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  EVENT_EVIDENCE_V2_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
} from "../../utils/confidence";
import {
  DomainError,
  type DomainResult,
  domainFailure,
  domainSuccess,
} from "../errors";
import {
  MODERATION_POLICY_VERSION,
  type AppliedHumanModerationDecision,
  type AutomatedModerationDecision,
  type AutomatedModerationPreparation,
  type HumanModerationDecision,
  type HumanModerationPreparation,
  type ModerationDecision,
  type ModerationPreparation,
  type ModerationValidationContext,
} from "./types";

export const TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE = 0.65;
export const UNVERIFIED_CORE_EVENT_SOURCE_REASON = "unverified_core_event_source";
export const HUMAN_REVIEW_REQUIRED_REASON = "requires_human_approval";
export const NON_EVENT_CLOSURE_NOTICE_REASON = "non_event_closure_notice";

function prepareHumanModerationDecision(
  request: HumanModerationPreparation,
): DomainResult<HumanModerationDecision> {
  const moderationNote = request.trimModerationNote
    ? request.moderationNote?.trim()
    : request.moderationNote;
  const noteLength = moderationNote?.trim().length ?? 0;
  if (
    request.noteConstraint &&
    (noteLength < request.noteConstraint.minLength ||
      noteLength > request.noteConstraint.maxLength)
  ) {
    return domainFailure(
      new DomainError(
        "MODERATION_INVALID_REQUEST",
        request.noteConstraint.errorMessage,
        {
          details: {
            entryPoint: request.entryPoint,
            maxLength: request.noteConstraint.maxLength,
            minLength: request.noteConstraint.minLength,
          },
        },
      ),
    );
  }
  return domainSuccess({
    kind: "human",
    entryPoint: request.entryPoint,
    action: request.targetStatus === "approved" ? "approve" : "reject",
    targetStatus: request.targetStatus,
    ...(moderationNote === undefined ? {} : { moderationNote }),
    policyVersion: MODERATION_POLICY_VERSION,
  });
}

function prepareAutomatedModerationDecision(
  options: AutomatedModerationPreparation,
): DomainResult<AutomatedModerationDecision> {
  const confidenceScore = calculateModerationConfidenceScore(
    options.baseConfidenceScore,
    {
      hasSuspectedDuplicates: false,
      missingImage: options.missingImage,
      allowMissingImage: options.allowMissingImage,
    },
  );
  const autoApprovalBlockers = [...new Set(options.autoApprovalBlockers ?? [])];
  const timeTbdApplies = options.missingTime && options.hasDate;
  const structuredEvidenceApproval =
    options.structuredEvidenceVerified &&
    autoApprovalBlockers.length === 0 &&
    options.hasDate &&
    !options.suspiciousYear &&
    confidenceScore !== null &&
    confidenceScore >= EVENT_EVIDENCE_V2_AUTO_APPROVE_CONFIDENCE_THRESHOLD;
  const strictSourceGroundedApproval =
    options.sourceGroundingVerified &&
    autoApprovalBlockers.length === 0 &&
    options.hasDate &&
    options.hasVenue &&
    !options.titleUsedFallback &&
    !options.suspiciousYear &&
    (options.dateConfidence === "high" || options.dateConfidence === "medium") &&
    confidenceScore !== null &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD &&
    (!options.missingImage || options.allowMissingImage);
  const trustedSourceOnlyBlockers = new Set([
    UNVERIFIED_CORE_EVENT_SOURCE_REASON,
    "unverified_occurrence_plan",
  ]);
  const trustedSourceAnnouncementApproval =
    options.trustedVenueSource &&
    autoApprovalBlockers.every((blocker) =>
      trustedSourceOnlyBlockers.has(blocker)
    ) &&
    options.hasDate &&
    options.hasVenue &&
    !options.titleUsedFallback &&
    !options.suspiciousYear &&
    options.sourceGroundingTitleVerified &&
    options.sourceGroundingDateVerified &&
    options.sourceGroundingIdentityContextVerified &&
    options.approvalCaptionSourceCoherent &&
    (options.dateConfidence === "high" || options.dateConfidence === "medium") &&
    confidenceScore !== null &&
    confidenceScore >= TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE;
  const autoApproved =
    structuredEvidenceApproval ||
    strictSourceGroundedApproval ||
    trustedSourceAnnouncementApproval;
  const autoApproveRule = structuredEvidenceApproval
    ? "event_evidence_v2"
    : strictSourceGroundedApproval
      ? "source_grounded_core_event_fields"
      : trustedSourceAnnouncementApproval
        ? "trusted_source_event_announcement"
        : null;
  const signals = [
    ...(!autoApproved ? [HUMAN_REVIEW_REQUIRED_REASON] : []),
    ...(options.missingImage ? ["missing_image"] : []),
    ...(options.allowMissingImage ? ["missing_image_allowed"] : []),
    ...(options.titleUsedFallback ? ["fallback_title"] : []),
    ...(timeTbdApplies ? ["time_tbd"] : []),
    ...(options.suspiciousYear ? ["suspicious_year"] : []),
    ...(confidenceScore !== null && confidenceScore < 0.7
      ? ["low_confidence"]
      : []),
    ...autoApprovalBlockers,
  ];
  const pendingReasons = autoApproved
    ? []
    : [
        HUMAN_REVIEW_REQUIRED_REASON,
        ...autoApprovalBlockers,
        ...(confidenceScore === null ? ["missing_confidence"] : []),
        ...(confidenceScore !== null &&
        confidenceScore < CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD
          ? ["below_auto_approve_threshold"]
          : []),
        ...(options.missingImage && !options.allowMissingImage
          ? ["missing_image"]
          : []),
        ...(options.suspiciousYear ? ["suspicious_year"] : []),
        ...(options.dateConfidence === "low" ? ["low_date_confidence"] : []),
      ];

  return domainSuccess({
    kind: "automated",
    entryPoint: "automated",
    action: autoApproved ? "approve" : "hold",
    targetStatus: autoApproved ? "approved" : "pending",
    confidenceScore,
    autoApproved,
    autoApproveRule,
    pendingReasons,
    signals,
    allowMissingImage: options.allowMissingImage,
    policyVersion: MODERATION_POLICY_VERSION,
  });
}

export function prepareModerationDecision(
  request: HumanModerationPreparation,
): DomainResult<HumanModerationDecision>;
export function prepareModerationDecision(
  request: AutomatedModerationPreparation,
): DomainResult<AutomatedModerationDecision>;
export function prepareModerationDecision(
  request: ModerationPreparation,
): DomainResult<ModerationDecision> {
  return request.kind === "human"
    ? prepareHumanModerationDecision(request)
    : prepareAutomatedModerationDecision(request);
}

export function validateModerationDecision(
  decision: HumanModerationDecision,
  context: ModerationValidationContext,
): DomainResult<HumanModerationDecision> {
  if (context.currentStatus !== "pending") {
    return domainFailure(
      new DomainError(
        "MODERATION_INVALID_TRANSITION",
        "Only pending events can be moderated.",
        {
          details: {
            currentStatus: context.currentStatus,
            entryPoint: decision.entryPoint,
            targetStatus: decision.targetStatus,
          },
        },
      ),
    );
  }
  if (
    context.expectedUpdatedAt !== undefined &&
    !Number.isSafeInteger(context.expectedUpdatedAt)
  ) {
    return domainFailure(
      new DomainError(
        "STALE_EVENT_VERSION",
        "expectedUpdatedAt must be a safe integer.",
      ),
    );
  }
  if (
    context.expectedUpdatedAt !== undefined &&
    context.currentUpdatedAt !== context.expectedUpdatedAt
  ) {
    return domainFailure(
      new DomainError(
        "STALE_EVENT_VERSION",
        `Event changed since the reviewed version (expected updatedAt ${context.expectedUpdatedAt}, found ${context.currentUpdatedAt}).`,
        {
          details: {
            currentUpdatedAt: context.currentUpdatedAt,
            expectedUpdatedAt: context.expectedUpdatedAt,
          },
        },
      ),
    );
  }
  return domainSuccess(decision);
}

export function applyModerationDecision(
  decision: HumanModerationDecision,
  options: {
    currentUpdatedAt: number;
    now: number;
    reviewedBy: string;
  },
): DomainResult<AppliedHumanModerationDecision> {
  if (
    !Number.isSafeInteger(options.currentUpdatedAt) ||
    !Number.isSafeInteger(options.now) ||
    options.currentUpdatedAt >= Number.MAX_SAFE_INTEGER
  ) {
    return domainFailure(
      new DomainError(
        "MODERATION_INVALID_REQUEST",
        "The moderation event revision cannot be advanced safely.",
      ),
    );
  }
  return domainSuccess({
    eventPatch: {
      status: decision.targetStatus,
      reviewedAt: options.now,
      reviewedBy: options.reviewedBy,
      // Keep an explicit undefined so Convex preserves the legacy behavior of
      // clearing an old optional note when a later decision supplies none.
      moderationNote: decision.moderationNote,
      updatedAt: Math.max(options.now, options.currentUpdatedAt + 1),
    },
    audit: {
      policyVersion: MODERATION_POLICY_VERSION,
      entryPoint: decision.entryPoint,
    },
  });
}

export function unwrapModerationResult<T>(result: DomainResult<T>): T {
  if (result.ok === false) throw result.error;
  return result.value;
}
