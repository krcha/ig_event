import type { ExtractedEventData } from "@/lib/ai/extract-event-data";
import {
  prepareModerationDecision,
  TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE,
  unwrapModerationResult,
} from "@/lib/domain/moderation/index";
import { partitionEventEvidenceSourceConflicts } from "@/lib/events/event-evidence-conflict-policy";
import { isCaptionSourceCoherentWithEvent } from "@/lib/events/event-source-approval";
import { type EventTimeProvenance, TBD_EVENT_TIME } from "@/lib/events/event-time";
import { isSensibleEventTitleForApproval } from "@/lib/events/event-title-approval";
import { checkEventConsistency } from "@/lib/events/event-validation";
import { NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION } from "@/lib/events/nightlife-lineup-coalescing";
import { getNonExpiringPublicEventImageUrl } from "@/lib/images/public-event-image";
import type {
  EventDateEvidenceSource,
  EventTimeEvidenceKind,
  EventVariant,
} from "@/lib/pipeline/ingestion/contracts";
import { buildExtractionScorecard, buildSkippedExtractionScorecard } from "@/lib/pipeline/ingestion/extraction-scorecard";
import type { getEventDateFilterContext } from "@/lib/pipeline/ingestion/parsing-date";
import { evaluateCoreEventSourceGrounding, getNonEventAutoApprovalBlockers } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import type { StructuredFactExtractionResult } from "@/lib/pipeline/ingestion/structured-fact-contracts";
import { CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE } from "@/lib/pipeline/ingestion/structured-fact-policy";
import { isVerifiedDateEvidence, isVerifiedEventIdentityEvidence, isVerifiedEventVenueEvidence, isVerifiedTimeEvidence } from "@/lib/pipeline/ingestion/structured-fact-verification";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import { normalizeVenueComparableText } from "@/lib/pipeline/venue-normalization";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
} from "@/lib/utils/confidence";

type FinalizeStructuredFactVariantsInput = {
  allowMissingImageForModeration: boolean;
  candidateDates: readonly string[];
  canonicalVenueEvidenceSource: "evidence_handle" | "evidence_name" | null;
  confidence: number | null;
  configuredSourceName: string;
  configuredVenueLocation: string;
  configuredVenueName?: string;
  description: string;
  effectiveVenueSource: string | null;
  eventDateFilter: ReturnType<typeof getEventDateFilterContext>;
  eventType: string;
  eventVariants: readonly EventVariant[];
  extracted: ExtractedEventData;
  extractionMode: "poster" | "caption_only";
  independentPostTextEvidence: string;
  missingImage: boolean;
  normalizedFieldsCommon: Record<string, unknown>;
  post: InstagramScrapedPost;
  postTextEvidence: string;
  rawModelVenue: string;
  selectedImageUrl: string | null;
  sourceRole?: "venue" | "promoter" | "unknown";
  splitEventCandidateCount: number;
  ticketPrice: string | null;
  trustedVenueSource: boolean;
  usesSplitEventCandidates: boolean;
  usesStructuredEvidence: boolean;
  verifiedSharedTime: boolean;
  verifiedSharedVenue: boolean;
};

export function finalizeStructuredFactVariants({
  allowMissingImageForModeration,
  candidateDates,
  canonicalVenueEvidenceSource,
  confidence,
  configuredSourceName,
  configuredVenueLocation,
  configuredVenueName,
  description,
  effectiveVenueSource,
  eventDateFilter,
  eventType,
  eventVariants,
  extracted,
  extractionMode,
  independentPostTextEvidence,
  missingImage,
  normalizedFieldsCommon,
  post,
  postTextEvidence,
  rawModelVenue,
  selectedImageUrl,
  sourceRole,
  splitEventCandidateCount,
  ticketPrice,
  trustedVenueSource,
  usesSplitEventCandidates,
  usesStructuredEvidence,
  verifiedSharedTime,
  verifiedSharedVenue,
}: FinalizeStructuredFactVariantsInput): StructuredFactExtractionResult[] {
  const structuredResults: StructuredFactExtractionResult[] = [];
  const exactSingleOccurrenceSource =
    eventVariants.length === 1 &&
    (!usesStructuredEvidence ||
      extracted.schedule_entries.length <= 1 ||
      eventVariants[0]?.lineupScheduleCoalesced === true);
  const publicEventImageUrl =
    usesStructuredEvidence && extractionMode === "poster"
      ? undefined
      : getNonExpiringPublicEventImageUrl(selectedImageUrl);

  for (const [index, variant] of eventVariants.entries()) {
    const date = variant.dateNormalization.isoDate;
    const variantRawVenue =
      normalizeString(variant.venueEvidenceValue) || rawModelVenue;
    const variantRawVenueMatchesConfiguredLocation = Boolean(
      variantRawVenue &&
        configuredVenueLocation &&
        normalizeVenueComparableText(variantRawVenue) ===
          normalizeVenueComparableText(configuredVenueLocation),
    );
    const variantTrustedVenueSource = Boolean(
      trustedVenueSource &&
        configuredVenueName &&
        normalizeVenueComparableText(variant.venue) ===
          normalizeVenueComparableText(configuredVenueName),
    );
    const variantUsesCanonicalVenueEvidence = Boolean(
      variant.canonicalVenueEvidenceSource && variant.venue,
    );
    const variantVenueSource = variantTrustedVenueSource
      ? "handle_map"
      : variantUsesCanonicalVenueEvidence
        ? variant.canonicalVenueEvidenceSource
        : variant.venue && variantRawVenue
          ? "model"
          : effectiveVenueSource;
    const eventConsistency = checkEventConsistency({
      isoDate: date,
      rawDateText: variant.rawDate,
      time: variant.time,
      weekdayEvidence: variant.splitSourceLine ?? normalizeString(extracted.date),
    });
    const consistencyIssues = [
      ...new Set([...variant.consistencyIssues, ...eventConsistency.issues]),
    ];
    const timeEvidenceKind: EventTimeEvidenceKind = variant.timeEvidence.status;
    const semanticTimeProvenance: EventTimeProvenance =
      timeEvidenceKind === "start_time_stated"
        ? variant.timeProvenance
        : {
            source:
              timeEvidenceKind !== "not_stated" &&
              (variant.timeEvidence.source === "caption" ||
                variant.timeEvidence.source === "poster" ||
                variant.timeEvidence.source === "alt_text")
                ? variant.timeEvidence.source
                : "unknown",
            evidenceText: normalizeString(variant.timeEvidence.exact_text) || null,
            confidence: 0,
            status: "unknown",
          };
    const timeTbdApplied = !eventConsistency.sanitizedTime && Boolean(date);
    const safeTime = eventConsistency.sanitizedTime || (timeTbdApplied ? TBD_EVENT_TIME : "");
    const timeSanitized = consistencyIssues.includes("time_is_date");
    const dateRepairReason = consistencyIssues.includes("weekday_date_mismatch")
      ? "weekday_date_mismatch_numeric_date_authoritative"
      : null;
    const sourceGrounding = evaluateCoreEventSourceGrounding({
      independentTextEvidence: independentPostTextEvidence,
      title: variant.title,
      normalizedDate: date,
      postedAt: post.postedAt,
      splitSource: variant.splitSource,
      titleUsedFallback: variant.titleUsedFallback,
      time: eventConsistency.sanitizedTime,
      artists: variant.artists,
      venue: variant.venue,
      instagramHandle: post.username,
    });
    const approvalTitleSensible = isSensibleEventTitleForApproval({
      title: variant.title,
      venue: variant.venue,
    });
    const approvalCaptionSourceCoherent = isCaptionSourceCoherentWithEvent({
      title: variant.title,
      date,
      time: safeTime,
      venue: variant.venue,
      artists: variant.artists,
      sourceCaption: post.caption ?? "",
      sourcePostedAt: post.postedAt,
      instagramPostId: post.postId,
      instagramPostUrl: post.instagramPostUrl,
      sourceInstagramHandle: post.username,
      venueInstagramHandle: post.username,
    });
    const dateEvidenceVerified = isVerifiedDateEvidence({
      evidence: variant.dateEvidence,
      resolvedDate: date,
      post,
      hasPoster: Boolean(selectedImageUrl),
    });
    const identityEvidenceVerified = isVerifiedEventIdentityEvidence({
      extracted,
      title: variant.title,
      artists: variant.artists,
      titleUsedFallback: variant.titleUsedFallback,
      venue: variant.venue,
      splitSourceLine: variant.splitSourceLine,
      singleScheduleEntrySource: exactSingleOccurrenceSource,
      splitEvidenceSource: variant.dateEvidence.source,
      post,
      hasPoster: Boolean(selectedImageUrl),
      lineupSourceEvidence: variant.lineupSourceEvidence,
      lineupTimingMode: variant.lineupScheduleTimingMode,
    });
    const venueEvidenceVerified = isVerifiedEventVenueEvidence({
      venue: variant.venue,
      rawEvidenceValue: variant.venueEvidenceValue,
      extracted,
      splitSourceLine: variant.splitSourceLine,
      splitEvidenceSource: variant.dateEvidence.source,
      post,
      hasPoster: Boolean(selectedImageUrl),
      trustedVenueSource: variantTrustedVenueSource,
      sharedVenueVerified: verifiedSharedVenue,
      canonicalHandleEvidenceVerified: variantUsesCanonicalVenueEvidence,
    });
    const sourceConflictPartition = partitionEventEvidenceSourceConflicts(
      extracted.source_conflicts,
      {
        resolvedDate: date ?? "",
        dateEvidenceVerified,
        selectedTitle: variant.title,
        artists: variant.artists,
        selectedVenue: variant.venue ?? "",
        venueEvidenceVerified,
        sourceAccountRole: sourceRole,
        sourceAccountName: configuredSourceName,
        sourceCaption: post.caption ?? "",
        sourcePostedAt: post.postedAt ?? undefined,
        singleOccurrenceSource: exactSingleOccurrenceSource,
      },
    );
    const sourceConflictFields = [
      ...new Set(
        sourceConflictPartition.material
          .map((conflict) => normalizeString(conflict.field))
          .filter(Boolean),
      ),
    ];
    const timeEvidenceVerified = isVerifiedTimeEvidence({
      evidence: variant.timeEvidence,
      resolvedStartTime: eventConsistency.sanitizedTime ?? null,
      post,
      hasPoster: Boolean(selectedImageUrl),
    });
    const structuredEvidenceVerified =
      usesStructuredEvidence &&
      extracted.is_event === true &&
      !normalizeString(extracted.non_event_reason) &&
      dateEvidenceVerified &&
      timeEvidenceVerified &&
      identityEvidenceVerified &&
      venueEvidenceVerified &&
      sourceConflictFields.length === 0;
    const autoApprovalBlockers = [
      ...(!usesStructuredEvidence ? sourceGrounding.blockers : []),
      ...(variant.occurrencePlanUnverified ? ["unverified_occurrence_plan"] : []),
      ...(!approvalTitleSensible ? ["unusable_event_title"] : []),
      ...(!usesStructuredEvidence && !approvalCaptionSourceCoherent
        ? ["caption_source_event_mismatch"]
        : []),
      ...(usesStructuredEvidence && !dateEvidenceVerified ? ["invalid_date_evidence"] : []),
      ...(usesStructuredEvidence && !identityEvidenceVerified
        ? ["invalid_identity_evidence"]
        : []),
      ...(usesStructuredEvidence && !venueEvidenceVerified
        ? ["invalid_venue_evidence"]
        : []),
      ...(usesStructuredEvidence &&
      splitEventCandidateCount > 1 &&
      canonicalVenueEvidenceSource &&
      !verifiedSharedVenue &&
      !variant.venue
        ? ["unscoped_canonical_venue_evidence"]
        : []),
      ...(usesStructuredEvidence && !timeEvidenceVerified ? ["invalid_time_evidence"] : []),
      ...(sourceConflictFields.length > 0 ? ["poster_caption_conflict"] : []),
      ...getNonEventAutoApprovalBlockers(
        [
          postTextEvidence,
          description,
          variant.description,
          variant.splitSourceLine,
        ].join("\n"),
      ),
    ];
    const moderationDecision = unwrapModerationResult(
      prepareModerationDecision({
        kind: "automated",
        entryPoint: "automated",
        baseConfidenceScore: confidence,
        missingImage,
        allowMissingImage: allowMissingImageForModeration,
        titleUsedFallback: variant.titleUsedFallback,
        missingTime: !eventConsistency.sanitizedTime,
        suspiciousYear: variant.dateNormalization.suspiciousYear,
        dateConfidence: variant.dateNormalization.confidence,
        hasDate: Boolean(date),
        hasVenue: Boolean(variant.venue),
        sourceGroundingVerified: sourceGrounding.verified,
        sourceGroundingTitleVerified: sourceGrounding.titleVerified,
        sourceGroundingDateVerified: sourceGrounding.dateVerified,
        sourceGroundingIdentityContextVerified: sourceGrounding.identityContextVerified,
        approvalCaptionSourceCoherent,
        trustedVenueSource: variantTrustedVenueSource,
        structuredEvidenceVerified,
        autoApprovalBlockers,
      }),
    );
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsCommon,
      sourceConflictResolutionVersion: 1,
      materialSourceConflicts: sourceConflictPartition.material,
      materialSourceConflictCount: sourceConflictPartition.material.length,
      benignSourceConflicts: sourceConflictPartition.benign,
      benignSourceConflictCount: sourceConflictPartition.benign.length,
      time: safeTime || null,
      timeSource: semanticTimeProvenance.source,
      timeEvidenceText: semanticTimeProvenance.evidenceText,
      timeConfidence: semanticTimeProvenance.confidence,
      timeStatus: semanticTimeProvenance.status,
      timeEvidenceKind,
      dateEvidenceText: normalizeString(variant.dateEvidence.exact_text) || null,
      dateEvidenceSource: variant.dateEvidence.source,
      dateEvidenceIsRelative: variant.dateEvidence.is_relative,
      dateEvidenceResolvedDate: normalizeString(variant.dateEvidence.resolved_date) || null,
      dateEvidenceVerified,
      timeEvidenceVerified,
      identityEvidenceVerified,
      ...(variant.titleUsedFallback && identityEvidenceVerified
        ? { fallbackIdentityPolicyVersion: 1 }
        : {}),
      venueEvidenceVerified,
      structuredEvidenceVerified,
      sourceConflictFields,
      rawVenue: variantRawVenue,
      rawVenueMatchesCanonicalLocation: variantRawVenueMatchesConfiguredLocation,
      normalizedVenue: variant.venue,
      venueSource: variantVenueSource,
      canonicalVenueEvidenceHandle: variant.canonicalVenueEvidenceHandle,
      title: variant.title,
      titleSource: variant.titleSource,
      titleUsedFallback: variant.titleUsedFallback,
      titleDerivedFromContext: variant.titleDerivedFromContext,
      titleContextCandidate: variant.titleContextCandidate,
      rawDate: variant.rawDate,
      rawExtractedDateText: variant.dateNormalization.rawDateText,
      normalizedDate: date,
      dateSource: variant.dateNormalization.source,
      dateConfidence: variant.dateNormalization.confidence,
      dateDistanceFromPostDays: variant.dateNormalization.distanceFromPostDays,
      dateInferredYear: variant.dateNormalization.inferredYear,
      dateSuspiciousYear: variant.dateNormalization.suspiciousYear,
      dateYearSelectionReason: variant.dateNormalization.yearSelectionReason,
      dateReason: variant.dateNormalization.reason ?? null,
      artists: variant.artists,
      artistsWereSanitized: variant.artistsWereSanitized,
      description: variant.description,
      dateRangeExpanded: !usesSplitEventCandidates && candidateDates.length > 1,
      dateRangeExpandedCount: !usesSplitEventCandidates ? candidateDates.length : 1,
      multiEventSplitDetected: usesSplitEventCandidates && splitEventCandidateCount > 1,
      multiEventSplitCount:
        usesSplitEventCandidates && splitEventCandidateCount > 1
          ? splitEventCandidateCount
          : 1,
      ...(variant.lineupScheduleCoalesced
        ? {
            lineupScheduleCoalesced: true,
            lineupScheduleCoalescingPolicyVersion:
              NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION,
            lineupScheduleTimingMode: variant.lineupScheduleTimingMode,
            lineupScheduleSourceRowCount: variant.lineupSlots?.length ?? 0,
            lineupScheduleSourceEvidence: variant.lineupSourceEvidence ?? [],
            lineupScheduleSlots: variant.lineupSlots ?? [],
          }
        : {}),
      sourceOccurrencePlanUnverified: variant.occurrencePlanUnverified,
      splitEventIndex: index + 1,
      splitEventTotal: eventVariants.length,
      splitSource: variant.splitSource,
      splitSourceLine: variant.splitSourceLine,
      rowSourceText: variant.splitSourceLine ?? null,
      expandedDateIndex: index + 1,
      expandedDateTotal: eventVariants.length,
      moderationConfidenceScore: moderationDecision.confidenceScore,
      moderationAutoApproveThreshold: AUTO_APPROVE_CONFIDENCE_THRESHOLD,
      moderationCoreEventAutoApproveThreshold: CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
      moderationCaptionOnlyVideoMinConfidence: CAPTION_ONLY_VIDEO_AUTO_APPROVE_MIN_CONFIDENCE,
      moderationTrustedSourceEventAnnouncementMinConfidence:
        TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE,
      sourceGroundingVersion: usesStructuredEvidence ? 5 : 4,
      sourceGroundingEvidence: usesStructuredEvidence
        ? "persisted_openai_event_evidence_v2"
        : "instagram_caption",
      approvalTitleSensible,
      approvalCaptionSourceCoherent,
      sourceGroundingVerified: sourceGrounding.verified,
      trustedVenueSource: variantTrustedVenueSource,
      sourceGroundingTitleVerified: sourceGrounding.titleVerified,
      sourceGroundingDateVerified: sourceGrounding.dateVerified,
      sourceGroundingIdentityVerified: sourceGrounding.identityVerified,
      sourceGroundingIdentityContextVerified: sourceGrounding.identityContextVerified,
      sourceGroundingTimeVerified: sourceGrounding.timeVerified,
      sourceGroundingArtistsVerified: sourceGrounding.artistsVerified,
      sourceGroundingRowVerified: sourceGrounding.rowVerified,
      moderationAutoApproved: moderationDecision.autoApproved,
      moderationAutoApproveRule: moderationDecision.autoApproveRule,
      moderationPendingReasons: moderationDecision.pendingReasons,
      moderationSignals: moderationDecision.signals,
      consistencyIssues,
      timeSanitized,
      timeTbdApplied,
      timeSanitizedFrom: timeSanitized
        ? normalizeString(variant.rawTime || variant.time) || null
        : null,
      dateRepairApplied: false,
      dateRepairReason,
      normalizedIsValid: true,
      normalizedInvalidReason: null,
      extractionScorecard: buildExtractionScorecard({
        baseConfidenceScore: confidence,
        moderationDecision,
        fieldConfirmation: extracted.field_confirmation,
        normalizedIsValid: true,
        normalizedInvalidReason: null,
      }),
    };

    if (!date) {
      structuredResults.push({
        kind: "skip",
        reason:
          variant.dateNormalization.reason === "missing_date"
            ? "missing_date"
            : "invalid_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "invalid_date",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "invalid_date",
          }),
        },
      });
      continue;
    }
    if (!variant.title) {
      structuredResults.push({
        kind: "skip",
        reason: "invalid_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "missing_required_fields",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "missing_required_fields",
          }),
        },
      });
      continue;
    }
    if (date < eventDateFilter.todayIsoDate) {
      structuredResults.push({
        kind: "skip",
        reason: "past_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "past_event",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "past_event",
          }),
        },
      });
      continue;
    }
    if (date > eventDateFilter.maxFutureIsoDate) {
      structuredResults.push({
        kind: "skip",
        reason: "far_future",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "far_future_event",
          extractionScorecard: buildSkippedExtractionScorecard({
            baseConfidenceScore: confidence,
            fieldConfirmation: extracted.field_confirmation,
            normalizedInvalidReason: "far_future_event",
          }),
        },
      });
      continue;
    }

    const sourceRowIdentity = normalizeString(
      typeof normalizedFields.rowSourceText === "string"
        ? normalizedFields.rowSourceText
        : typeof normalizedFields.splitSourceLine === "string"
          ? normalizedFields.splitSourceLine
          : "",
    );
    const hasExactStartTime = Boolean(safeTime && safeTime !== TBD_EVENT_TIME);
    structuredResults.push({
      kind: "event",
      facts: {
        artistClaims: variant.artists,
        evidence: [
          {
            exactText: normalizeString(variant.dateEvidence.exact_text) || undefined,
            field: "date",
            source: variant.dateEvidence.source,
          },
          {
            exactText: normalizeString(variant.timeEvidence.exact_text) || undefined,
            field: "start_time",
            source: variant.timeEvidence.source,
          },
          {
            exactText: variantRawVenue || undefined,
            field: "venue",
            source: variantTrustedVenueSource
              ? "source_account"
              : variantUsesCanonicalVenueEvidence
                ? "unknown"
                : "model",
          },
        ],
        eventTypeClaim: eventType,
        localDate: date,
        ...(sourceRowIdentity ? { sourceRowIdentity } : {}),
        ...(eventVariants.length > 1 ? { scheduleRole: "row" as const } : {}),
        ...(verifiedSharedTime ? { sharedTime: true } : {}),
        ...(verifiedSharedVenue ? { sharedVenue: true } : {}),
        ...(hasExactStartTime
          ? { startTime: safeTime, timeRelation: "exact" as const }
          : { timeRelation: "unknown" as const }),
        titleClaim: variant.title,
        venueClaim: variant.venue,
        ...(variant.canonicalVenueEvidenceHandle
          ? { venueHandleClaim: variant.canonicalVenueEvidenceHandle }
          : {}),
        policy: {
          approvalDisposition: moderationDecision.autoApproved
            ? "approved" as const
            : "pending" as const,
          ...(moderationDecision.autoApproveRule
            ? { autoApproveRule: moderationDecision.autoApproveRule }
            : {}),
          pendingReasons: moderationDecision.pendingReasons,
          signals: moderationDecision.signals,
          structuredEvidenceVerified,
        },
      },
      evidence: {
        timeSource: semanticTimeProvenance.source,
        ...(semanticTimeProvenance.evidenceText
          ? { timeEvidenceText: semanticTimeProvenance.evidenceText }
          : {}),
        timeConfidence: semanticTimeProvenance.confidence,
        timeStatus: semanticTimeProvenance.status,
        timeEvidenceKind,
        dateEvidenceText: normalizeString(variant.dateEvidence.exact_text) || undefined,
        dateEvidenceSource: variant.dateEvidence.source as EventDateEvidenceSource,
        dateEvidenceIsRelative: variant.dateEvidence.is_relative,
        dateEvidenceResolvedDate:
          normalizeString(variant.dateEvidence.resolved_date) || undefined,
        sourceConflictFields,
      },
      normalizedFields,
      presentation: {
        ...(variant.description ? { description: variant.description } : {}),
        ...(publicEventImageUrl ? { imageUrl: publicEventImageUrl } : {}),
        ...(ticketPrice ? { ticketPrice } : {}),
      },
      source: {
        instagramPostUrl: post.instagramPostUrl,
        instagramPostId: post.postId,
        ...(post.caption ? { caption: post.caption } : {}),
        ...(post.postedAt ? { postedAt: post.postedAt } : {}),
        rawExtractionJson: JSON.stringify(extracted),
      },
    });
  }

  return structuredResults;
}
