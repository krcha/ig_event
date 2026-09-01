import type {
  EvidenceReference,
  EvidenceSource,
  StructuredFacts,
} from "./types";

export const MAX_STRUCTURED_FACTS_JSON_LENGTH = 65_536;
export const MAX_STRUCTURED_FACTS_ARRAY_LENGTH = 64;
export const MAX_STRUCTURED_FACTS_STRING_LENGTH = 4_096;

const EVIDENCE_SOURCES = new Set<EvidenceSource>([
  "caption",
  "poster",
  "alt_text",
  "location_tag",
  "source_account",
  "model",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_STRUCTURED_FACTS_STRING_LENGTH &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isOptionalBoundedString(value: unknown, allowEmpty = false): boolean {
  return value === undefined || isBoundedString(value, allowEmpty);
}

function isBoundedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STRUCTURED_FACTS_ARRAY_LENGTH &&
    value.every((entry) => isBoundedString(entry))
  );
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isBoundedString(value.field) &&
    typeof value.source === "string" &&
    EVIDENCE_SOURCES.has(value.source as EvidenceSource) &&
    isOptionalBoundedString(value.exactText)
  );
}

/** Runtime fence for the exact fact payload written beside an occurrence. */
export function isStructuredFacts(value: unknown): value is StructuredFacts {
  if (!isRecord(value) || !isRecord(value.policy)) {
    return false;
  }
  const policy = value.policy;
  const relation = value.timeRelation;
  const hasValidRelation =
    relation === undefined ||
    relation === "exact" ||
    relation === "range" ||
    relation === "unknown";
  const dateRange = value.dateRange;
  const hasValidDateRange =
    dateRange === undefined ||
    (isRecord(dateRange) &&
      isBoundedString(dateRange.from) &&
      isBoundedString(dateRange.through));
  return (
    isBoundedStringArray(value.artistClaims) &&
    isBoundedString(value.localDate) &&
    isBoundedString(value.titleClaim) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= MAX_STRUCTURED_FACTS_ARRAY_LENGTH &&
    value.evidence.every(isEvidenceReference) &&
    hasValidDateRange &&
    isOptionalBoundedString(value.eventTypeClaim, true) &&
    isOptionalBoundedString(value.recurrenceRule) &&
    (value.relativeDayOffset === undefined ||
      (Number.isSafeInteger(value.relativeDayOffset) &&
        Math.abs(value.relativeDayOffset as number) <= 366)) &&
    isOptionalBoundedString(value.scheduleGroupId) &&
    (value.scheduleRole === undefined ||
      value.scheduleRole === "primary" ||
      value.scheduleRole === "continuation" ||
      value.scheduleRole === "row" ||
      value.scheduleRole === "shared_context") &&
    (value.sharedTime === undefined || typeof value.sharedTime === "boolean") &&
    (value.sharedVenue === undefined || typeof value.sharedVenue === "boolean") &&
    isOptionalBoundedString(value.sourceRowIdentity) &&
    isOptionalBoundedString(value.startTime) &&
    hasValidRelation &&
    !(relation === "unknown" && value.startTime !== undefined) &&
    !(
      relation === "exact" &&
      (!isBoundedString(value.startTime) ||
        value.startTime.trim().toUpperCase() === "TBD")
    ) &&
    isOptionalBoundedString(value.venueClaim, true) &&
    isOptionalBoundedString(value.venueHandleClaim) &&
    (policy.approvalDisposition === "approved" ||
      policy.approvalDisposition === "pending") &&
    isOptionalBoundedString(policy.autoApproveRule) &&
    isBoundedStringArray(policy.pendingReasons) &&
    isBoundedStringArray(policy.signals) &&
    typeof policy.structuredEvidenceVerified === "boolean"
  );
}

export function parseStructuredFactsJson(value: unknown): StructuredFacts | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRUCTURED_FACTS_JSON_LENGTH
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isStructuredFacts(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeStructuredFacts(facts: StructuredFacts): string {
  if (!isStructuredFacts(facts)) {
    throw new Error("Structured facts do not satisfy the durable fact contract.");
  }
  const encoded = JSON.stringify(facts);
  if (encoded.length > MAX_STRUCTURED_FACTS_JSON_LENGTH) {
    throw new Error("Structured facts exceed the durable fact payload bound.");
  }
  return encoded;
}

/** Stable compatibility value used only at the occurrence/persistence edge. */
export function getStructuredFactsOccurrenceTime(
  facts: StructuredFacts,
): string {
  return facts.timeRelation === "exact" && facts.startTime
    ? facts.startTime
    : "TBD";
}

export function projectStructuredFactsToOccurrenceBinding(
  facts: StructuredFacts,
): {
  artists: string[];
  date: string;
  time: string;
  title: string;
  venue: string;
} {
  return {
    artists: [...facts.artistClaims],
    date: facts.localDate,
    time: getStructuredFactsOccurrenceTime(facts),
    title: facts.titleClaim,
    venue: facts.venueClaim ?? "",
  };
}

export function structuredFactsMatchOccurrenceBinding(
  facts: StructuredFacts,
  occurrence: {
    artists: readonly string[];
    date: string;
    time?: string;
    title: string;
    venue: string;
  },
): boolean {
  const projected = projectStructuredFactsToOccurrenceBinding(facts);
  return (
    occurrence.date === projected.date &&
    occurrence.time === projected.time &&
    occurrence.title === projected.title &&
    occurrence.venue === projected.venue &&
    JSON.stringify(occurrence.artists) === JSON.stringify(projected.artists)
  );
}
