import { TBD_EVENT_TIME } from "./event-time.ts";
import { isSensibleEventTitleForApproval } from "./event-title-approval.ts";
import { isCaptionSourceCoherentWithEvent } from "./event-source-approval.ts";
import { CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD } from "../utils/confidence.ts";

export type EventStatusPrecondition = "pending" | "approved" | "rejected";

type EventApprovalFields = Record<string, unknown> & {
  title?: unknown;
  date?: unknown;
  time?: unknown;
  venue?: unknown;
  artists?: unknown;
  imageUrl?: unknown;
  sourceCaption?: unknown;
  instagramPostId?: unknown;
  instagramPostUrl?: unknown;
  venueInstagramHandle?: unknown;
};

type EventWritePatch = EventApprovalFields & {
  status?: EventStatusPrecondition;
  normalizedFieldsJson?: string;
};

const SOURCE_GROUNDED_AUTO_APPROVE_RULE = "source_grounded_core_event_fields";
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
  const normalizedDate = fields.normalizedDate;
  const normalizedVenue = fields.normalizedVenue;
  const signalValues = Array.isArray(moderationSignals)
    ? moderationSignals.map((signal) => String(signal))
    : null;
  const timeGroundingVerified = fields.sourceGroundingTimeVerified;
  const missingImage = fields.missingImage;

  return (
    fields.sourceGroundingVersion === 3 &&
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
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD &&
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

export function assertServiceCreateEventPolicy(
  requestedStatus: EventStatusPrecondition | undefined,
  normalizedFieldsJson?: string,
  eventFields?: EventApprovalFields,
): void {
  if (
    requestedStatus === "approved" &&
    !hasCompleteSourceGroundedAutoApproval(normalizedFieldsJson, eventFields)
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
      !hasCompleteSourceGroundedAutoApproval(patch.normalizedFieldsJson, effectiveEvent))
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
