const BELGRADE_TIME_ZONE = "Europe/Belgrade";

/**
 * Calendar-day ownership for the autonomous ingestion timer. Formatting from
 * parts avoids relying on locale-specific date ordering while retaining the
 * IANA timezone's daylight-saving rules.
 */
export function getBelgradeDayKey(timestampMs = Date.now()): string {
  if (!Number.isFinite(timestampMs)) {
    throw new Error("A finite timestamp is required for the Belgrade day key.");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BELGRADE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get("year");
  const month = byType.get("month");
  const day = byType.get("day");
  if (!year || !month || !day) {
    throw new Error("Could not resolve the Europe/Belgrade calendar day.");
  }
  return `${year}-${month}-${day}`;
}
