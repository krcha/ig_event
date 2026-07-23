import { isSensibleEventTitleForApproval } from "../lib/events/event-title-approval.ts";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval.ts";

export const UNVERIFIED_CORE_EVENT_SOURCE_REASON = "unverified_core_event_source";
export const HUMAN_REVIEW_REQUIRED_REASON = "requires_human_approval";
const RECOMPUTABLE_PENDING_REASONS = new Set([
  "missing_confidence",
  "below_auto_approve_threshold",
  "missing_image",
  "suspicious_year",
  "low_date_confidence",
]);

function uniqueStrings(values) {
  const strings = (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === "string" && value,
  );
  return [...new Set(strings)];
}

export function getHardPendingReasons(normalizedFields) {
  const pendingReasons = Array.isArray(normalizedFields?.moderationPendingReasons)
    ? normalizedFields.moderationPendingReasons
    : [];
  return uniqueStrings(pendingReasons).filter(
    (reason) => !RECOMPUTABLE_PENDING_REASONS.has(reason),
  );
}

/**
 * Model-derived maintenance repairs may correct stored metadata, but they do
 * not create independent source evidence. Force them back through moderation
 * and invalidate every stale grounding/auto-approval flag.
 */
export function markModelDerivedRepairPending(normalizedFields, script) {
  const current = normalizedFields && typeof normalizedFields === "object"
    ? normalizedFields
    : {};
  return {
    ...current,
    sourceGroundingVersion: 4,
    sourceGroundingEvidence: "instagram_caption",
    sourceGroundingVerified: false,
    sourceGroundingTitleVerified: false,
    sourceGroundingDateVerified: false,
    sourceGroundingIdentityVerified: false,
    sourceGroundingIdentityContextVerified: false,
    sourceGroundingTimeVerified: false,
    sourceGroundingArtistsVerified: false,
    sourceGroundingRowVerified: false,
    sourceGroundingInvalidatedBy: script,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: uniqueStrings([
      ...(Array.isArray(current.moderationPendingReasons)
        ? current.moderationPendingReasons
        : []),
      UNVERIFIED_CORE_EVENT_SOURCE_REASON,
    ]),
    moderationSignals: uniqueStrings([
      ...(Array.isArray(current.moderationSignals) ? current.moderationSignals : []),
      UNVERIFIED_CORE_EVENT_SOURCE_REASON,
    ]),
  };
}

/**
 * Maintenance scripts may update pending-event metadata, but they must never
 * promote a record unless ingestion persisted an independently verified raw
 * caption result bound to the exact source post and event payload.
 */
function normalizeComparableText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
}

export function hasVerifiedSourceGrounding(normalizedFields, event) {
  const sourceCaption = normalizeComparableText(event?.sourceCaption);
  const instagramPostId = normalizeComparableText(event?.instagramPostId);
  const instagramPostUrl = normalizeComparableText(event?.instagramPostUrl);
  return (
    normalizedFields?.sourceGroundingVersion === 4 &&
    normalizedFields?.sourceGroundingEvidence === "instagram_caption" &&
    normalizedFields?.sourceGroundingSourceKind === "caption" &&
    normalizeComparableText(normalizedFields?.sourceGroundingSourceCaption) === sourceCaption &&
    normalizeComparableText(normalizedFields?.sourceGroundingInstagramPostId) === instagramPostId &&
    normalizeComparableText(normalizedFields?.sourceGroundingInstagramPostUrl) === instagramPostUrl &&
    Boolean(sourceCaption && instagramPostId && instagramPostUrl) &&
    normalizedFields?.approvalTitleSensible === true &&
    normalizedFields?.approvalCaptionSourceCoherent === true &&
    isSensibleEventTitleForApproval({ title: event?.title, venue: event?.venue }) &&
    isCaptionSourceCoherentWithEvent({
      title: event?.title,
      date: event?.date,
      time: event?.time,
      venue: event?.venue,
      artists: event?.artists,
      sourceCaption: event?.sourceCaption,
      instagramPostId: event?.instagramPostId,
      instagramPostUrl: event?.instagramPostUrl,
      sourceInstagramHandle: normalizedFields?.sourceGroundingInstagramHandle,
      venueInstagramHandle: event?.venueInstagramHandle,
    }) &&
    normalizedFields?.sourceGroundingVerified === true &&
    normalizedFields?.sourceGroundingTitleVerified === true &&
    normalizedFields?.sourceGroundingDateVerified === true &&
    normalizedFields?.sourceGroundingIdentityVerified === true &&
    normalizedFields?.sourceGroundingIdentityContextVerified === true &&
    normalizedFields?.sourceGroundingRowVerified === true &&
    (normalizedFields?.sourceGroundingTimeVerified === true ||
      normalizedFields?.sourceGroundingTimeVerified === null) &&
    (normalizedFields?.sourceGroundingArtistsVerified === true ||
      normalizedFields?.sourceGroundingArtistsVerified === null)
  );
}
