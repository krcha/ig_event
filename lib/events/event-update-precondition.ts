import { TBD_EVENT_TIME } from "./event-time.ts";
import { isSensibleEventTitleForApproval } from "./event-title-approval.ts";
import { isCaptionSourceCoherentWithEvent } from "./event-source-approval.ts";
import {
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  EVENT_EVIDENCE_V2_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
} from "../utils/confidence.ts";
import {
  partitionEventEvidenceSourceConflicts,
  type EventEvidenceSourceConflict,
} from "./event-evidence-conflict-policy.ts";
import {
  buildUnnamedScheduleFallbackTitle,
  sourceEvidenceNamesSupportedUnnamedEventKind,
  specificVenueValueAppearsInUnnamedEventEvidence,
} from "./unnamed-schedule-fallback.ts";

export type EventStatusPrecondition = "pending" | "approved" | "rejected";

type EventApprovalFields = Record<string, unknown> & {
  title?: unknown;
  date?: unknown;
  time?: unknown;
  venue?: unknown;
  artists?: unknown;
  imageUrl?: unknown;
  sourceCaption?: unknown;
  sourcePostedAt?: unknown;
  instagramPostId?: unknown;
  instagramPostUrl?: unknown;
  venueInstagramHandle?: unknown;
  rawExtractionJson?: unknown;
  timeSource?: unknown;
  timeEvidenceText?: unknown;
  timeConfidence?: unknown;
  timeStatus?: unknown;
  timeEvidenceKind?: unknown;
  dateEvidenceText?: unknown;
  dateEvidenceSource?: unknown;
  dateEvidenceIsRelative?: unknown;
  dateEvidenceResolvedDate?: unknown;
  sourceConflictFields?: unknown;
  humanReviewedLegacySourcePolicyVersion?: unknown;
};

type EventWritePatch = EventApprovalFields & {
  status?: EventStatusPrecondition;
  normalizedFieldsJson?: string;
};

const SOURCE_GROUNDED_AUTO_APPROVE_RULE = "source_grounded_core_event_fields";
const TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_RULE = "trusted_source_event_announcement";
const EVENT_EVIDENCE_V2_AUTO_APPROVE_RULE = "event_evidence_v2";
export const HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION = 1;
const TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE = 0.65;
const APPROVED_MODERATION_SIGNALS = new Set([
  "missing_image",
  "missing_image_allowed",
  "time_tbd",
]);

function parseNormalizedFields(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function arraysContainSameJsonValues(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  const leftValues = left.map((value) => JSON.stringify(value)).sort();
  const rightValues = right.map((value) => JSON.stringify(value)).sort();
  return leftValues.every((value, index) => value === rightValues[index]);
}

function isEventEvidenceSourceConflict(value: unknown): value is EventEvidenceSourceConflict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conflict = value as Record<string, unknown>;
  return (
    typeof conflict.field === "string" &&
    typeof conflict.poster_value === "string" &&
    typeof conflict.caption_value === "string" &&
    typeof conflict.reason === "string"
  );
}

function getEffectiveEventEvidenceV2Conflicts(
  fields: Record<string, unknown>,
  eventFields: EventApprovalFields,
): unknown[] | null {
  const reported = fields.extractionSourceConflicts;
  if (!Array.isArray(reported)) return null;
  if (fields.sourceConflictResolutionVersion !== 1) {
    return fields.extractionSourceConflictCount === reported.length ? reported : null;
  }

  const material = fields.materialSourceConflicts;
  const benign = fields.benignSourceConflicts;
  if (
    !Array.isArray(material) ||
    !Array.isArray(benign) ||
    fields.extractionSourceConflictCount !== reported.length ||
    fields.materialSourceConflictCount !== material.length ||
    fields.benignSourceConflictCount !== benign.length ||
    !arraysContainSameJsonValues(reported, [...material, ...benign])
  ) {
    return null;
  }

  if (!reported.every(isEventEvidenceSourceConflict)) return null;

  const sourceAccountRole = fields.sourceAccountRole;
  if (
    sourceAccountRole !== "venue" &&
    sourceAccountRole !== "promoter" &&
    sourceAccountRole !== "unknown"
  ) {
    return null;
  }
  const artists = Array.isArray(eventFields.artists)
    ? eventFields.artists.filter((artist): artist is string => typeof artist === "string")
    : [];
  if (artists.length !== (Array.isArray(eventFields.artists) ? eventFields.artists.length : 0)) {
    return null;
  }
  const recomputed = partitionEventEvidenceSourceConflicts(reported, {
    artists,
    dateEvidenceVerified: fields.dateEvidenceVerified === true,
    resolvedDate: typeof eventFields.date === "string" ? eventFields.date : "",
    selectedTitle: typeof eventFields.title === "string" ? eventFields.title : "",
    selectedVenue: typeof eventFields.venue === "string" ? eventFields.venue : "",
    singleOccurrenceSource:
      fields.splitEventTotal === 1 && fields.multiEventSplitDetected === false,
    sourceAccountName:
      typeof fields.sourceAccountName === "string" ? fields.sourceAccountName : "",
    sourceAccountRole,
    sourceCaption:
      typeof eventFields.sourceCaption === "string" ? eventFields.sourceCaption : "",
    venueEvidenceVerified: fields.venueEvidenceVerified === true,
  });
  if (
    !arraysContainSameJsonValues(material, recomputed.material) ||
    !arraysContainSameJsonValues(benign, recomputed.benign)
  ) {
    return null;
  }

  try {
    const rawExtraction = JSON.parse(
      typeof eventFields.rawExtractionJson === "string" ? eventFields.rawExtractionJson : "null",
    ) as unknown;
    if (
      !rawExtraction ||
      typeof rawExtraction !== "object" ||
      Array.isArray(rawExtraction) ||
      !Array.isArray((rawExtraction as Record<string, unknown>).source_conflicts) ||
      !arraysContainSameJsonValues(
        reported,
        (rawExtraction as Record<string, unknown>).source_conflicts as unknown[],
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return recomputed.material;
}

function isTrueOrNull(value: unknown): boolean {
  return value === true || value === null;
}

function normalizeComparableText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized || null;
}

function normalizeComparableHandle(value: unknown): string | null {
  const normalized = normalizeComparableText(value);
  return normalized ? normalized.replace(/^@/, "").toLowerCase() : null;
}

function isFutureIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
  return value >= today;
}

function normalizeComparableArtists(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const artists: string[] = [];
  for (const artist of value) {
    const normalized = normalizeComparableText(artist);
    if (!normalized) {
      return null;
    }
    artists.push(normalized);
  }
  return artists;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasVerifiedFallbackIdentityAttestation(
  fields: Record<string, unknown>,
  eventFields: EventApprovalFields,
): boolean {
  if (
    fields.titleUsedFallback !== true ||
    fields.titleSource !== "unnamed_schedule_fallback" ||
    fields.fallbackIdentityPolicyVersion !== 1
  ) {
    return false;
  }
  const publicArtists = normalizeComparableArtists(eventFields.artists ?? []);
  const sourceLine = normalizeComparableText(fields.splitSourceLine);
  const publicTitle = normalizeComparableText(eventFields.title);
  const publicDate = normalizeComparableText(eventFields.date);
  const publicEventType = normalizeComparableText(eventFields.eventType);
  const publicVenue = normalizeComparableText(eventFields.venue) ?? "";
  if (
    !publicArtists ||
    publicArtists.length !== 0 ||
    !sourceLine ||
    !publicTitle ||
    !publicDate ||
    !publicEventType
  ) {
    return false;
  }
  const expectedTitle = buildUnnamedScheduleFallbackTitle({
    eventType: publicEventType,
    venue: publicVenue,
    isoDate: publicDate,
  });
  if (normalizeComparableText(expectedTitle) !== publicTitle) return false;

  try {
    const rawExtraction = JSON.parse(
      typeof eventFields.rawExtractionJson === "string"
        ? eventFields.rawExtractionJson
        : "null",
    ) as Record<string, unknown> | null;
    const entries = rawExtraction?.schedule_entries;
    if (!Array.isArray(entries)) return false;
    const sourceEntry = entries.find((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const entry = value as Record<string, unknown>;
      const dateEvidence =
        entry.date_evidence &&
        typeof entry.date_evidence === "object" &&
        !Array.isArray(entry.date_evidence)
          ? (entry.date_evidence as Record<string, unknown>)
          : null;
      return (
        normalizeComparableText(entry.source_text) === sourceLine &&
        normalizeComparableText(entry.title) === null &&
        Array.isArray(entry.artists) &&
        entry.artists.length === 0 &&
        dateEvidence !== null &&
        normalizeComparableText(dateEvidence.exact_text) ===
          normalizeComparableText(eventFields.dateEvidenceText) &&
        dateEvidence.source === eventFields.dateEvidenceSource
      );
    }) as Record<string, unknown> | undefined;
    if (!sourceEntry) return false;

    const rawVenue = normalizeComparableText(sourceEntry.venue) ?? "";
    const rowNamesVenue = Boolean(
      (publicVenue &&
        specificVenueValueAppearsInUnnamedEventEvidence(publicVenue, sourceLine)) ||
        (rawVenue &&
          specificVenueValueAppearsInUnnamedEventEvidence(rawVenue, sourceLine)),
    );
    const rowNamesEventKind =
      sourceEvidenceNamesSupportedUnnamedEventKind(sourceLine);
    return rowNamesVenue || rowNamesEventKind;
  } catch {
    return false;
  }
}

function normalizeComparableOptionalText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    : "";
}

function hasBoundEventEvidenceV2PublicFields(
  fields: Record<string, unknown>,
  eventFields: EventApprovalFields | undefined,
): boolean {
  if (!eventFields) return false;
  const attestedArtists = normalizeComparableArtists(fields.artists);
  const publicArtists = normalizeComparableArtists(eventFields.artists ?? []);
  const publicTime = normalizeComparableOptionalText(eventFields.time);
  const timeEvidenceKind = fields.timeEvidenceKind;
  const sourceConflictFields = Array.isArray(eventFields.sourceConflictFields)
    ? eventFields.sourceConflictFields
    : null;
  const attestedSourceConflictFields = Array.isArray(fields.sourceConflictFields)
    ? fields.sourceConflictFields
    : null;
  return (
    normalizeComparableOptionalText(fields.title) ===
      normalizeComparableOptionalText(eventFields.title) &&
    normalizeComparableOptionalText(fields.normalizedDate) ===
      normalizeComparableOptionalText(eventFields.date) &&
    normalizeComparableOptionalText(fields.normalizedVenue) ===
      normalizeComparableOptionalText(eventFields.venue) &&
    normalizeComparableOptionalText(fields.time) === publicTime &&
    fields.timeSource === eventFields.timeSource &&
    normalizeComparableOptionalText(fields.timeEvidenceText) ===
      normalizeComparableOptionalText(eventFields.timeEvidenceText) &&
    fields.timeConfidence === eventFields.timeConfidence &&
    fields.timeStatus === eventFields.timeStatus &&
    attestedArtists !== null &&
    publicArtists !== null &&
    arraysEqual(attestedArtists, publicArtists) &&
    normalizeComparableOptionalText(fields.sourceGroundingSourceCaption) ===
      normalizeComparableOptionalText(eventFields.sourceCaption) &&
    normalizeComparableOptionalText(fields.sourceGroundingInstagramPostId) ===
      normalizeComparableOptionalText(eventFields.instagramPostId) &&
    normalizeComparableOptionalText(fields.sourceGroundingInstagramPostUrl) ===
      normalizeComparableOptionalText(eventFields.instagramPostUrl) &&
    normalizeComparableOptionalText(fields.dateEvidenceText) ===
      normalizeComparableOptionalText(eventFields.dateEvidenceText) &&
    fields.dateEvidenceSource === eventFields.dateEvidenceSource &&
    fields.dateEvidenceIsRelative === eventFields.dateEvidenceIsRelative &&
    normalizeComparableOptionalText(fields.dateEvidenceResolvedDate) ===
      normalizeComparableOptionalText(eventFields.dateEvidenceResolvedDate) &&
    timeEvidenceKind === eventFields.timeEvidenceKind &&
    sourceConflictFields !== null &&
    attestedSourceConflictFields !== null &&
    sourceConflictFields.length === 0 &&
    attestedSourceConflictFields.length === 0 &&
    (timeEvidenceKind === "start_time_stated"
      ? Boolean(publicTime && publicTime !== TBD_EVENT_TIME)
      : publicTime === TBD_EVENT_TIME)
  );
}

export function hasEventEvidenceV2AutoApproval(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields || !eventFields) return false;
  const pendingReasons = fields.moderationPendingReasons;
  const conflicts = getEffectiveEventEvidenceV2Conflicts(fields, eventFields);
  const confidence = fields.moderationConfidenceScore;
  const date = normalizeComparableOptionalText(eventFields.date);
  return (
    fields.extractionContractVersion === "event_evidence_v2" &&
    fields.extractionIsEvent === true &&
    normalizeComparableOptionalText(fields.extractionNonEventReason) === "" &&
    fields.sourceGroundingVersion === 5 &&
    fields.sourceGroundingEvidence === "persisted_openai_event_evidence_v2" &&
    (fields.extractionMode === "poster" || fields.extractionMode === "caption_only") &&
    fields.dateEvidenceVerified === true &&
    fields.timeEvidenceVerified === true &&
    fields.identityEvidenceVerified === true &&
    fields.venueEvidenceVerified === true &&
    fields.structuredEvidenceVerified === true &&
    fields.dateEvidenceSource !== "unknown" &&
    normalizeComparableOptionalText(fields.dateEvidenceText).length > 0 &&
    normalizeComparableOptionalText(fields.dateEvidenceResolvedDate) === date &&
    conflicts !== null &&
    conflicts.length === 0 &&
    fields.approvalTitleSensible === true &&
    fields.normalizedIsValid === true &&
    (fields.titleUsedFallback === false ||
      hasVerifiedFallbackIdentityAttestation(fields, eventFields)) &&
    fields.dateSuspiciousYear === false &&
    fields.moderationAutoApproved === true &&
    fields.moderationAutoApproveRule === EVENT_EVIDENCE_V2_AUTO_APPROVE_RULE &&
    Array.isArray(pendingReasons) &&
    pendingReasons.length === 0 &&
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= EVENT_EVIDENCE_V2_AUTO_APPROVE_CONFIDENCE_THRESHOLD &&
    isFutureIsoDate(date) &&
    isSensibleEventTitleForApproval({
      title: normalizeComparableOptionalText(eventFields.title),
      venue: normalizeComparableOptionalText(eventFields.venue),
    }) &&
    hasBoundEventEvidenceV2PublicFields(fields, eventFields)
  );
}

function hasBoundPublicFields(
  fields: Record<string, unknown>,
  eventFields: EventApprovalFields | undefined,
): boolean {
  if (!eventFields) {
    return false;
  }

  const attestedTitle = normalizeComparableText(fields.title);
  const attestedDate = normalizeComparableText(fields.normalizedDate);
  const attestedTime = normalizeComparableText(fields.time);
  const attestedVenue = normalizeComparableText(fields.normalizedVenue);
  const attestedArtists = normalizeComparableArtists(fields.artists);
  const publicTitle = normalizeComparableText(eventFields.title);
  const publicDate = normalizeComparableText(eventFields.date);
  const publicTime = normalizeComparableText(eventFields.time);
  const publicVenue = normalizeComparableText(eventFields.venue);
  const publicArtists = normalizeComparableArtists(eventFields.artists ?? []);
  const publicImageUrl = normalizeComparableText(eventFields.imageUrl);
  const publicSourceCaption = normalizeComparableText(eventFields.sourceCaption);
  const publicPostId = normalizeComparableText(eventFields.instagramPostId);
  const publicPostUrl = normalizeComparableText(eventFields.instagramPostUrl);
  const attestedSourceCaption = normalizeComparableText(fields.sourceGroundingSourceCaption);
  const attestedPostId = normalizeComparableText(fields.sourceGroundingInstagramPostId);
  const attestedPostUrl = normalizeComparableText(fields.sourceGroundingInstagramPostUrl);

  if (
    !attestedTitle ||
    !attestedDate ||
    !attestedVenue ||
    !attestedArtists ||
    !publicTitle ||
    !publicDate ||
    !publicVenue ||
    !publicArtists ||
    attestedTitle !== publicTitle ||
    attestedDate !== publicDate ||
    attestedVenue !== publicVenue ||
    !arraysEqual(attestedArtists, publicArtists) ||
    fields.sourceGroundingSourceKind !== "caption" ||
    !attestedSourceCaption ||
    !attestedPostId ||
    !attestedPostUrl ||
    !publicSourceCaption ||
    !publicPostId ||
    !publicPostUrl ||
    attestedSourceCaption !== publicSourceCaption ||
    attestedPostId !== publicPostId ||
    attestedPostUrl !== publicPostUrl ||
    fields.approvalTitleSensible !== true ||
    !isSensibleEventTitleForApproval({ title: publicTitle, venue: publicVenue }) ||
    !isCaptionSourceCoherentWithEvent({
      title: publicTitle,
      date: publicDate,
      time: publicTime,
      venue: publicVenue,
      artists: publicArtists,
      sourceCaption: publicSourceCaption,
      sourcePostedAt: eventFields.sourcePostedAt,
      instagramPostId: publicPostId,
      instagramPostUrl: publicPostUrl,
      sourceInstagramHandle: fields.sourceGroundingInstagramHandle,
      venueInstagramHandle:
        eventFields.venueInstagramHandle ?? fields.sourceGroundingInstagramHandle,
    })
  ) {
    return false;
  }

  if (fields.sourceGroundingTimeVerified === null) {
    if (attestedTime !== TBD_EVENT_TIME || publicTime !== TBD_EVENT_TIME) {
      return false;
    }
  } else if (
    fields.sourceGroundingTimeVerified === true &&
    (!attestedTime || attestedTime === TBD_EVENT_TIME || attestedTime !== publicTime)
  ) {
    return false;
  }

  if (fields.sourceGroundingArtistsVerified === null) {
    if (attestedArtists.length !== 0 || publicArtists.length !== 0) {
      return false;
    }
  } else if (fields.sourceGroundingArtistsVerified === true && attestedArtists.length === 0) {
    return false;
  }

  if (fields.missingImage === true) {
    if (publicImageUrl || fields.moderationAllowMissingImage !== true) {
      return false;
    }
  } else if (fields.missingImage === false && !publicImageUrl) {
    return false;
  }

  return true;
}

export function hasCompleteSourceGroundingAttestation(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields) {
    return false;
  }

  const normalizedDate = fields.normalizedDate;
  const normalizedVenue = fields.normalizedVenue;
  const timeGroundingVerified = fields.sourceGroundingTimeVerified;
  const missingImage = fields.missingImage;

  return (
    fields.sourceGroundingVersion === 4 &&
    fields.sourceGroundingEvidence === "instagram_caption" &&
    fields.approvalTitleSensible === true &&
    fields.approvalCaptionSourceCoherent === true &&
    fields.sourceGroundingVerified === true &&
    fields.sourceGroundingTitleVerified === true &&
    fields.sourceGroundingDateVerified === true &&
    fields.sourceGroundingIdentityVerified === true &&
    fields.sourceGroundingIdentityContextVerified === true &&
    fields.sourceGroundingRowVerified === true &&
    isTrueOrNull(timeGroundingVerified) &&
    isTrueOrNull(fields.sourceGroundingArtistsVerified) &&
    typeof normalizedDate === "string" &&
    normalizedDate.length > 0 &&
    typeof normalizedVenue === "string" &&
    normalizedVenue.length > 0 &&
    fields.normalizedIsValid === true &&
    fields.titleUsedFallback === false &&
    fields.dateSuspiciousYear === false &&
    (fields.dateConfidence === "high" || fields.dateConfidence === "medium") &&
    (missingImage === false ||
      (missingImage === true && fields.moderationAllowMissingImage === true)) &&
    hasBoundPublicFields(fields, eventFields)
  );
}

/**
 * A human moderator may confirm a legacy extraction even when the historical
 * deterministic caption parser could not produce a complete v4 attestation.
 * This is deliberately limited to pre-v2 rows and binds the public
 * title/date/time plus the immutable Instagram source fields. The Convex
 * mutation and public query separately re-read the persisted source row and
 * enforce duplicate/ambiguity policy.
 */
export function hasHumanReviewableLegacySourceAttestation(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  return hasLegacyHumanSourceAttestation(normalizedFieldsJson, eventFields, true);
}

function hasLegacyHumanSourceAttestation(
  normalizedFieldsJson: string | undefined,
  eventFields: EventApprovalFields | undefined,
  requireFutureDate: boolean,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields || !eventFields) return false;
  const sourceGroundingVersion = fields.sourceGroundingVersion;
  const pendingReasons = fields.moderationPendingReasons;
  const conflicts = Array.isArray(eventFields.sourceConflictFields)
    ? eventFields.sourceConflictFields
    : [];
  const publicTitle = normalizeComparableOptionalText(eventFields.title);
  const publicDate = normalizeComparableOptionalText(eventFields.date);
  const publicTime = normalizeComparableOptionalText(eventFields.time);
  const publicVenue = normalizeComparableOptionalText(eventFields.venue);
  const rawExtraction = parseNormalizedFields(
    typeof eventFields.rawExtractionJson === "string" ? eventFields.rawExtractionJson : undefined,
  );
  return (
    (sourceGroundingVersion === 3 || sourceGroundingVersion === 4) &&
    fields.sourceGroundingEvidence === "instagram_caption" &&
    fields.extractionContractVersion !== "event_evidence_v2" &&
    rawExtraction?.extraction_contract_version !== "event_evidence_v2" &&
    fields.sourceGroundingSourceKind === "caption" &&
    fields.normalizedIsValid === true &&
    fields.titleUsedFallback === false &&
    fields.dateSuspiciousYear === false &&
    Array.isArray(pendingReasons) &&
    pendingReasons.includes("requires_human_approval") &&
    conflicts.length === 0 &&
    publicTitle.length > 0 &&
    publicDate.length > 0 &&
    (!requireFutureDate || isFutureIsoDate(publicDate)) &&
    isSensibleEventTitleForApproval({ title: publicTitle, venue: publicVenue }) &&
    normalizeComparableOptionalText(fields.title) === publicTitle &&
    normalizeComparableOptionalText(fields.normalizedDate) === publicDate &&
    normalizeComparableOptionalText(fields.time) === publicTime &&
    normalizeComparableOptionalText(fields.sourceGroundingSourceCaption) ===
      normalizeComparableOptionalText(eventFields.sourceCaption) &&
    normalizeComparableOptionalText(fields.sourceGroundingInstagramPostId) ===
      normalizeComparableOptionalText(eventFields.instagramPostId) &&
    normalizeComparableOptionalText(fields.sourceGroundingInstagramPostUrl) ===
      normalizeComparableOptionalText(eventFields.instagramPostUrl) &&
    normalizeComparableHandle(fields.sourceGroundingInstagramHandle) !== null
  );
}

export function hasHumanReviewedLegacySourceAttestation(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  return (
    eventFields?.humanReviewedLegacySourcePolicyVersion ===
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION &&
    fields?.humanReviewedLegacySourcePolicyVersion ===
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION &&
    hasLegacyHumanSourceAttestation(normalizedFieldsJson, eventFields, false)
  );
}

export function hasHumanReviewedLegacySourcePolicyMarker(
  normalizedFieldsJson: string | undefined,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  return (
    fields?.humanReviewedLegacySourcePolicyVersion ===
    HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION
  );
}

export function hasCompleteSourceGroundedAutoApproval(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields) {
    return false;
  }

  const pendingReasons = fields.moderationPendingReasons;
  const moderationSignals = fields.moderationSignals;
  const confidenceScore = fields.moderationConfidenceScore;
  const signalValues = Array.isArray(moderationSignals)
    ? moderationSignals.map((signal) => String(signal))
    : null;
  const timeGroundingVerified = fields.sourceGroundingTimeVerified;
  const missingImage = fields.missingImage;

  return (
    hasCompleteSourceGroundingAttestation(normalizedFieldsJson, eventFields) &&
    fields.moderationAutoApproved === true &&
    fields.moderationAutoApproveRule === SOURCE_GROUNDED_AUTO_APPROVE_RULE &&
    Array.isArray(pendingReasons) &&
    pendingReasons.length === 0 &&
    signalValues !== null &&
    signalValues.every((signal) => APPROVED_MODERATION_SIGNALS.has(signal)) &&
    (timeGroundingVerified === null
      ? signalValues.includes("time_tbd")
      : !signalValues.includes("time_tbd")) &&
    (missingImage === true
      ? signalValues.includes("missing_image") &&
        signalValues.includes("missing_image_allowed")
      : missingImage === false &&
        !signalValues.includes("missing_image") &&
        !signalValues.includes("missing_image_allowed")) &&
    typeof confidenceScore === "number" &&
    Number.isFinite(confidenceScore) &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD
  );
}

/**
 * Practical publication path for announcements posted by a configured venue
 * account. It deliberately relaxes exhaustive caption coherence, but only
 * after the pipeline has bound the public event to that exact trusted source,
 * an explicit future date, and a sensible non-fallback title. The Convex
 * duplicate/ambiguity policy still runs separately at every write.
 */
export function hasTrustedSourceEventAnnouncementAutoApproval(
  normalizedFieldsJson: string | undefined,
  eventFields?: EventApprovalFields,
): boolean {
  const fields = parseNormalizedFields(normalizedFieldsJson);
  if (!fields || !eventFields) return false;

  const pendingReasons = Array.isArray(fields.moderationPendingReasons)
    ? fields.moderationPendingReasons.map(String)
    : null;
  const signals = Array.isArray(fields.moderationSignals)
    ? fields.moderationSignals.map(String)
    : null;
  const sourceHandle = normalizeComparableHandle(fields.sourceGroundingInstagramHandle);
  const venueHandle = normalizeComparableHandle(eventFields.venueInstagramHandle);
  const title = normalizeComparableText(eventFields.title);
  const date = normalizeComparableText(eventFields.date);
  const venue = normalizeComparableText(eventFields.venue);
  const attestedTitle = normalizeComparableText(fields.title);
  const attestedDate = normalizeComparableText(fields.normalizedDate);
  const normalizedVenue = normalizeComparableText(fields.normalizedVenue);
  const sourceCaption = normalizeComparableText(eventFields.sourceCaption);
  const postId = normalizeComparableText(eventFields.instagramPostId);
  const postUrl = normalizeComparableText(eventFields.instagramPostUrl);
  const attestedCaption = normalizeComparableText(fields.sourceGroundingSourceCaption);
  const attestedPostId = normalizeComparableText(fields.sourceGroundingInstagramPostId);
  const attestedPostUrl = normalizeComparableText(fields.sourceGroundingInstagramPostUrl);
  const confidence = fields.moderationConfidenceScore;
  const permittedSignals = new Set([
    "missing_image",
    "missing_image_allowed",
    "time_tbd",
    "unverified_core_event_source",
    "caption_source_event_mismatch",
    "unverified_occurrence_plan",
  ]);

  return (
    fields.moderationAutoApproved === true &&
    fields.moderationAutoApproveRule === TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_RULE &&
    fields.trustedVenueSource === true &&
    fields.normalizedIsValid === true &&
    fields.titleUsedFallback === false &&
    fields.dateSuspiciousYear === false &&
    fields.sourceGroundingTitleVerified === true &&
    fields.sourceGroundingDateVerified === true &&
    fields.sourceGroundingIdentityContextVerified === true &&
    (fields.dateConfidence === "high" || fields.dateConfidence === "medium") &&
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= TRUSTED_SOURCE_EVENT_ANNOUNCEMENT_MIN_CONFIDENCE &&
    pendingReasons !== null &&
    pendingReasons.length === 0 &&
    signals !== null &&
    signals.every((signal) => permittedSignals.has(signal)) &&
    Boolean(sourceHandle && venueHandle && sourceHandle === venueHandle) &&
    Boolean(
      title &&
        date &&
        venue &&
        normalizedVenue &&
        attestedTitle === title &&
        attestedDate === date &&
        venue === normalizedVenue,
    ) &&
    isFutureIsoDate(date ?? "") &&
    isSensibleEventTitleForApproval({ title, venue }) &&
    isCaptionSourceCoherentWithEvent({
      title: title ?? "",
      date: date ?? "",
      time: normalizeComparableText(eventFields.time) ?? undefined,
      venue: venue ?? "",
      artists: normalizeComparableArtists(eventFields.artists ?? []) ?? [],
      sourceCaption: sourceCaption ?? "",
      sourcePostedAt: eventFields.sourcePostedAt,
      instagramPostId: postId ?? "",
      instagramPostUrl: postUrl ?? "",
      sourceInstagramHandle: sourceHandle ?? "",
      venueInstagramHandle: venueHandle ?? "",
    }) &&
    Boolean(
      sourceCaption &&
        postId &&
        postUrl &&
        attestedCaption === sourceCaption &&
        attestedPostId === postId &&
        attestedPostUrl === postUrl,
    )
  );
}

export function assertExpectedEventStatus(
  currentStatus: EventStatusPrecondition,
  expectedStatus: EventStatusPrecondition | undefined,
): void {
  if (expectedStatus !== undefined && currentStatus !== expectedStatus) {
    throw new Error(
      `Event status changed during update (expected ${expectedStatus}, found ${currentStatus}).`,
    );
  }
}

export function nextEventUpdatedAt(currentUpdatedAt: number, now = Date.now()): number {
  if (!Number.isSafeInteger(currentUpdatedAt)) {
    throw new Error("The current event updatedAt is invalid.");
  }
  if (!Number.isSafeInteger(now)) {
    throw new Error("The event update clock is invalid.");
  }
  if (currentUpdatedAt >= Number.MAX_SAFE_INTEGER) {
    throw new Error("The event updatedAt revision cannot be advanced safely.");
  }
  return Math.max(now, currentUpdatedAt + 1);
}

export function assertExpectedEventUpdatedAt(
  currentUpdatedAt: number,
  expectedUpdatedAt: number | undefined,
): void {
  if (expectedUpdatedAt === undefined) {
    return;
  }
  if (!Number.isSafeInteger(expectedUpdatedAt)) {
    throw new Error("expectedUpdatedAt must be a safe integer.");
  }
  if (currentUpdatedAt !== expectedUpdatedAt) {
    throw new Error(
      `Event changed since the reviewed version (expected updatedAt ${expectedUpdatedAt}, found ${currentUpdatedAt}).`,
    );
  }
}

export function assertServiceCreateEventPolicy(
  requestedStatus: EventStatusPrecondition | undefined,
  normalizedFieldsJson?: string,
  eventFields?: EventApprovalFields,
): void {
  if (
    requestedStatus === "approved" &&
    !hasCompleteSourceGroundedAutoApproval(normalizedFieldsJson, eventFields) &&
    !hasTrustedSourceEventAnnouncementAutoApproval(normalizedFieldsJson, eventFields) &&
    !hasEventEvidenceV2AutoApproval(normalizedFieldsJson, eventFields)
  ) {
    throw new Error(
      "Service-authenticated event creation cannot approve an event without complete source-grounded evidence bound to the public fields.",
    );
  }
}

export function assertServiceUpdateEventPolicy(
  currentStatus: EventStatusPrecondition,
  patch: EventWritePatch,
  currentEvent?: EventApprovalFields,
): void {
  const effectiveEvent = currentEvent ? { ...currentEvent, ...patch } : undefined;
  if (
    patch.status === "approved" &&
    (currentStatus !== "pending" ||
      !hasCompleteSourceGroundedAutoApproval(patch.normalizedFieldsJson, effectiveEvent) &&
      !hasTrustedSourceEventAnnouncementAutoApproval(patch.normalizedFieldsJson, effectiveEvent) &&
      !hasEventEvidenceV2AutoApproval(patch.normalizedFieldsJson, effectiveEvent))
  ) {
    throw new Error(
      "Service-authenticated event updates cannot approve an event without complete source-grounded evidence bound to the public fields.",
    );
  }

  const keepsEventApproved = currentStatus === "approved" && patch.status === undefined;
  if (keepsEventApproved) {
    throw new Error(
      "Service-authenticated updates must demote an approved event before updating it.",
    );
  }
}
