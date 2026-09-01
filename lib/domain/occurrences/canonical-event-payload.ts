export type CanonicalEventRequestedStatus = "approved" | "pending";

export type CanonicalEventTimeSource =
  | "alt_text"
  | "caption"
  | "description"
  | "model"
  | "poster"
  | "schedule_entry"
  | "unknown";

export type CanonicalEventTimeStatus = "confirmed" | "inferred" | "unknown";

export type CanonicalEventTimeEvidenceKind =
  | "start_time_stated"
  | "not_stated"
  | "unreadable"
  | "doors_open_only";

export type CanonicalEventDateEvidenceSource =
  | "caption"
  | "poster"
  | "alt_text"
  | "unknown";

/**
 * Fact-owned presentation and moderation inputs required to materialize a
 * CanonicalEvent. Source identity and immutable extraction evidence remain on
 * SourceDocument; occurrence identity remains on SourceOccurrence.
 */
export type CanonicalEventPayload = Readonly<{
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  dateEvidenceSource?: CanonicalEventDateEvidenceSource;
  dateEvidenceText?: string;
  description?: string;
  normalizedFieldsJson: string;
  requestedStatus: CanonicalEventRequestedStatus;
  sourceConflictFields: readonly string[];
  ticketPrice?: string;
  time?: string;
  timeConfidence: number;
  timeEvidenceKind?: CanonicalEventTimeEvidenceKind;
  timeEvidenceText?: string;
  timeSource: CanonicalEventTimeSource;
  timeStatus: CanonicalEventTimeStatus;
}>;

const TIME_SOURCES = new Set<CanonicalEventTimeSource>([
  "alt_text",
  "caption",
  "description",
  "model",
  "poster",
  "schedule_entry",
  "unknown",
]);
const TIME_STATUSES = new Set<CanonicalEventTimeStatus>([
  "confirmed",
  "inferred",
  "unknown",
]);
const TIME_EVIDENCE_KINDS = new Set<CanonicalEventTimeEvidenceKind>([
  "start_time_stated",
  "not_stated",
  "unreadable",
  "doors_open_only",
]);
const DATE_EVIDENCE_SOURCES = new Set<CanonicalEventDateEvidenceSource>([
  "caption",
  "poster",
  "alt_text",
  "unknown",
]);
const REQUESTED_STATUSES = new Set<CanonicalEventRequestedStatus>([
  "approved",
  "pending",
]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedFieldsJsonIsObject(value: string): boolean {
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

export function parseCanonicalEventPayload(
  value: string | undefined,
): CanonicalEventPayload | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const sourceConflictFields = parsed.sourceConflictFields;
  if (
    typeof parsed.normalizedFieldsJson !== "string" ||
    !normalizedFieldsJsonIsObject(parsed.normalizedFieldsJson) ||
    typeof parsed.requestedStatus !== "string" ||
    !REQUESTED_STATUSES.has(
      parsed.requestedStatus as CanonicalEventRequestedStatus,
    ) ||
    !Array.isArray(sourceConflictFields) ||
    sourceConflictFields.some((field) => typeof field !== "string") ||
    typeof parsed.timeConfidence !== "number" ||
    !Number.isFinite(parsed.timeConfidence) ||
    parsed.timeConfidence < 0 ||
    parsed.timeConfidence > 1 ||
    typeof parsed.timeSource !== "string" ||
    !TIME_SOURCES.has(parsed.timeSource as CanonicalEventTimeSource) ||
    typeof parsed.timeStatus !== "string" ||
    !TIME_STATUSES.has(parsed.timeStatus as CanonicalEventTimeStatus) ||
    !isOptionalString(parsed.dateEvidenceResolvedDate) ||
    !isOptionalString(parsed.dateEvidenceText) ||
    !isOptionalString(parsed.description) ||
    !isOptionalString(parsed.ticketPrice) ||
    !isOptionalString(parsed.time) ||
    !isOptionalString(parsed.timeEvidenceText) ||
    (parsed.dateEvidenceIsRelative !== undefined &&
      typeof parsed.dateEvidenceIsRelative !== "boolean") ||
    (parsed.dateEvidenceSource !== undefined &&
      (typeof parsed.dateEvidenceSource !== "string" ||
        !DATE_EVIDENCE_SOURCES.has(
          parsed.dateEvidenceSource as CanonicalEventDateEvidenceSource,
        ))) ||
    (parsed.timeEvidenceKind !== undefined &&
      (typeof parsed.timeEvidenceKind !== "string" ||
        !TIME_EVIDENCE_KINDS.has(
          parsed.timeEvidenceKind as CanonicalEventTimeEvidenceKind,
        )))
  ) {
    return null;
  }
  return parsed as CanonicalEventPayload;
}

export function serializeCanonicalEventPayload(
  payload: CanonicalEventPayload,
): string {
  const serialized = JSON.stringify(payload);
  if (!parseCanonicalEventPayload(serialized)) {
    throw new Error("Canonical event payload is invalid.");
  }
  return serialized;
}
