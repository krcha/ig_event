export const UNVERIFIED_CORE_EVENT_SOURCE_REASON = "unverified_core_event_source";

/**
 * Maintenance scripts may update pending-event metadata, but they must never
 * promote a record unless ingestion persisted an independently verified raw
 * caption/alt-text grounding result.
 */
export function hasVerifiedSourceGrounding(normalizedFields) {
  return normalizedFields?.sourceGroundingVerified === true;
}
