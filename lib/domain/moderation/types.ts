export const MODERATION_POLICY_VERSION = 1 as const;

export type ModerationStatus = "pending" | "approved" | "rejected";

export type ModerationEntryPoint =
  | "single"
  | "batch"
  | "unique"
  | "automated";

export type HumanModerationEntryPoint = Exclude<
  ModerationEntryPoint,
  "automated"
>;

export type ModerationAutoApproveRule =
  | "confidence_threshold"
  | "caption_only_video_core_fields"
  | "core_event_fields"
  | "source_grounded_core_event_fields"
  | "trusted_source_event_announcement"
  | "event_evidence_v2";

export type HumanModerationPreparation = {
  kind: "human";
  entryPoint: HumanModerationEntryPoint;
  targetStatus: Exclude<ModerationStatus, "pending">;
  moderationNote?: string;
  trimModerationNote?: boolean;
  noteConstraint?: {
    minLength: number;
    maxLength: number;
    errorMessage: string;
  };
};

export type AutomatedModerationPreparation = {
  kind: "automated";
  entryPoint: "automated";
  baseConfidenceScore: number | null;
  missingImage: boolean;
  allowMissingImage: boolean;
  titleUsedFallback: boolean;
  missingTime: boolean;
  suspiciousYear: boolean;
  dateConfidence: "high" | "medium" | "low" | null;
  hasDate: boolean;
  hasVenue: boolean;
  sourceGroundingVerified: boolean;
  sourceGroundingTitleVerified: boolean;
  sourceGroundingDateVerified: boolean;
  sourceGroundingIdentityContextVerified: boolean;
  approvalCaptionSourceCoherent: boolean;
  trustedVenueSource: boolean;
  structuredEvidenceVerified: boolean;
  autoApprovalBlockers?: string[];
};

export type ModerationPreparation =
  | HumanModerationPreparation
  | AutomatedModerationPreparation;

export type HumanModerationDecision = {
  kind: "human";
  entryPoint: HumanModerationEntryPoint;
  action: "approve" | "reject";
  targetStatus: "approved" | "rejected";
  moderationNote?: string;
  policyVersion: typeof MODERATION_POLICY_VERSION;
};

export type AutomatedModerationDecision = {
  kind: "automated";
  entryPoint: "automated";
  action: "approve" | "hold";
  targetStatus: "approved" | "pending";
  confidenceScore: number | null;
  autoApproved: boolean;
  autoApproveRule: ModerationAutoApproveRule | null;
  pendingReasons: string[];
  signals: string[];
  allowMissingImage: boolean;
  policyVersion: typeof MODERATION_POLICY_VERSION;
};

export type ModerationDecision =
  | HumanModerationDecision
  | AutomatedModerationDecision;

export type ModerationValidationContext = {
  currentStatus: ModerationStatus;
  currentUpdatedAt: number;
  expectedUpdatedAt?: number;
};

export type AppliedHumanModerationDecision = {
  eventPatch: {
    status: "approved" | "rejected";
    reviewedAt: number;
    reviewedBy: string;
    moderationNote?: string;
    updatedAt: number;
  };
  audit: {
    policyVersion: typeof MODERATION_POLICY_VERSION;
    entryPoint: HumanModerationEntryPoint;
  };
};
