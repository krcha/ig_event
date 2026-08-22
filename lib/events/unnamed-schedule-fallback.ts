import { toSearchableText } from "../pipeline/venue-normalization.ts";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const GENERIC_SHARED_VENUE_TOKENS = new Set([
  "bar",
  "cafe",
  "centar",
  "center",
  "cinema",
  "club",
  "hall",
  "hotel",
  "kafic",
  "klub",
  "new",
  "nova",
  "novi",
  "pub",
  "restaurant",
  "restoran",
  "venue",
]);

function normalizeDisplayText(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function weekdayNameForIsoDate(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return "";
  }
  return WEEKDAY_NAMES[parsed.getUTCDay()] ?? "";
}

export function buildUnnamedScheduleFallbackTitle(options: {
  eventType: string;
  venue: string | null;
  isoDate: string | null;
}): string {
  const weekday = weekdayNameForIsoDate(options.isoDate);
  const eventType = toSearchableText(options.eventType);
  const eventLabel =
    eventType === "nightlife" || eventType === "club"
      ? "Night"
      : eventType === "live music"
        ? "Live music"
        : eventType === "arts culture"
          ? "Program"
          : "Event";
  const venue = normalizeDisplayText(options.venue);
  return [weekday, eventLabel, venue ? `at ${venue}` : ""]
    .filter(Boolean)
    .join(" ");
}

export function venueValueAppearsInEventEvidence(
  value: string,
  evidence: string,
): boolean {
  const normalizedValue = toSearchableText(value);
  const normalizedEvidence = toSearchableText(evidence);
  if (!normalizedValue || !normalizedEvidence) return false;

  const valueTokens = normalizedValue.split(/\s+/u).filter(Boolean);
  const evidenceTokens = normalizedEvidence.split(/\s+/u).filter(Boolean);
  const containsExactTokenPhrase = evidenceTokens.some((_, startIndex) =>
    valueTokens.every(
      (token, offset) => evidenceTokens[startIndex + offset] === token,
    ),
  );
  if (containsExactTokenPhrase) return true;

  const expectedTokens = valueTokens.filter(
    (token) => token.length >= 4 && !GENERIC_SHARED_VENUE_TOKENS.has(token),
  );
  if (expectedTokens.length === 0) return false;
  const tokensMatch = (expected: string, observed: string): boolean => {
    if (expected === observed) return true;
    if (expected.endsWith("a")) {
      const stem = expected.slice(0, -1);
      if (
        observed === `${stem}i` ||
        observed === `${stem}oj` ||
        observed === `${stem}e` ||
        observed === `${stem}u`
      ) {
        return true;
      }
    }
    return (
      expected.length >= 6 &&
      observed.length === expected.length &&
      expected.slice(0, -1) === observed.slice(0, -1)
    );
  };
  return expectedTokens.every((expected) =>
    evidenceTokens.some((observed) => tokensMatch(expected, observed)),
  );
}

export function specificVenueValueAppearsInUnnamedEventEvidence(
  value: string,
  evidence: string,
): boolean {
  const valueTokens = toSearchableText(value).split(/\s+/u).filter(Boolean);
  const hasSpecificNameToken = valueTokens.some(
    (token) =>
      token.length >= 3 &&
      /^[a-z]/u.test(token) &&
      !GENERIC_SHARED_VENUE_TOKENS.has(token),
  );
  const hasNumericIdentifier =
    valueTokens.filter((token) => /^\d+$/u.test(token)).join("").length >= 2;
  return (
    (hasSpecificNameToken || hasNumericIdentifier) &&
    venueValueAppearsInEventEvidence(value, evidence)
  );
}

export function sourceEvidenceNamesSupportedUnnamedEventKind(
  evidence: string,
): boolean {
  return /\b(?:concert|exhibition|izlo[zž]b[aeiu]?|jam\s+session|live\s+(?:music|show)|matin[eé]e?|opening|otvaranj[aeu]?|performance|performans[aeu]?|projekcij[aeu]?|screening|show|svirk[aeu]?|workshop|radionic[aeu]?)\b/iu.test(
    evidence,
  );
}
