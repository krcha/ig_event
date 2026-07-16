export const UNVERIFIED_CORE_EVENT_SOURCE_REASON = "unverified_core_event_source";

function uniqueStrings(values) {
  const strings = (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === "string" && value,
  );
  return [...new Set(strings)];
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
    sourceGroundingVersion: 2,
    sourceGroundingEvidence: "instagram_caption_or_alt_text",
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
 * caption/alt-text grounding result.
 */
export function hasVerifiedSourceGrounding(normalizedFields) {
  return (
    normalizedFields?.sourceGroundingVersion === 2 &&
    normalizedFields?.sourceGroundingEvidence === "instagram_caption_or_alt_text" &&
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
