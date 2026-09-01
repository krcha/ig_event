import { areCompatibleTitleFamilySlugs, buildTitleFamilySlug, collectComparableIdentityValues, collectComparableTextValues, collectInstagramHandles, countSharedValues, hasContextCandidateSupport, hasVenueContextSupport } from "@/lib/events/deduplication-shared";
import { type EventTimeProvenance, type EventTimeSource, normalizeEventTime, TBD_EVENT_TIME } from "@/lib/events/event-time";
import { hasCompleteSourceGroundedAutoApproval, hasEventEvidenceV2AutoApproval } from "@/lib/events/event-update-precondition";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import type { EventDateEvidenceSource, EventStatus, EventTimeEvidenceKind, ExistingEventRecord, PreparedEvent } from "@/lib/pipeline/ingestion/contracts";
import { hasExplicitBilledIdentityEvidence } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { normalizeString, parseJsonRecord, readJsonBoolean, readJsonNumber, readJsonString } from "@/lib/pipeline/ingestion/values";


export const EXISTING_EVENT_CONFIDENCE_THRESHOLD = 0.55;


export const DUPLICATE_TEXT_TOKEN_SIMILARITY_THRESHOLD = 0.72;


export const DUPLICATE_VENUE_TOKEN_SIMILARITY_THRESHOLD = 0.72;

export function normalizeArtistsForComparison(artists: string[]): string[] {
  return artists.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0).sort();
}

export function normalizeCompactComparisonText(value: string | null | undefined): string {
  return toSearchableText(normalizeString(value)).replace(/\s+/g, "");
}

export function getTextTokenSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  const leftTokens = [...new Set(normalizedLeft.split(" ").filter((token) => token.length > 1))];
  const rightTokens = [...new Set(normalizedRight.split(" ").filter((token) => token.length > 1))];
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  let sharedTokens = 0;
  for (const token of leftTokens) {
    if (rightTokenSet.has(token)) {
      sharedTokens += 1;
    }
  }

  return sharedTokens / Math.min(leftTokens.length, rightTokens.length);
}

export function areComparableVenueTexts(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }
  return (
    getTextTokenSimilarity(normalizedLeft, normalizedRight) >=
    DUPLICATE_VENUE_TOKEN_SIMILARITY_THRESHOLD
  );
}

export function areComparableEventTexts(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = toSearchableText(normalizeString(left));
  const normalizedRight = toSearchableText(normalizeString(right));
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const compactLeft = normalizeCompactComparisonText(left);
  const compactRight = normalizeCompactComparisonText(right);
  const shorterCompactLength = Math.min(compactLeft.length, compactRight.length);
  if (
    shorterCompactLength >= 6 &&
    (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))
  ) {
    return true;
  }

  return (
    getTextTokenSimilarity(normalizedLeft, normalizedRight) >=
    DUPLICATE_TEXT_TOKEN_SIMILARITY_THRESHOLD
  );
}

export function hasComparableTextOverlap(leftValues: string[], rightValues: string[]): boolean {
  for (const left of leftValues) {
    for (const right of rightValues) {
      if (areComparableEventTexts(left, right)) {
        return true;
      }
    }
  }
  return false;
}

export function extractComparableTimeParts(value: string | undefined): string[] {
  const matches = normalizeString(value).match(/\d{1,2}(?::\d{2})?/g) ?? [];
  return matches.map((match) => {
    const [hours, minutes = "00"] = match.split(":");
    return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  });
}

export function areTimesCompatible(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeString(left);
  const normalizedRight = normalizeString(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const canonicalLeft = normalizeEventTime(left);
  const canonicalRight = normalizeEventTime(right);
  if (canonicalLeft.startLabel && canonicalRight.startLabel) {
    return (
      canonicalLeft.startLabel === canonicalRight.startLabel &&
      (!canonicalLeft.endLabel ||
        !canonicalRight.endLabel ||
        canonicalLeft.endLabel === canonicalRight.endLabel)
    );
  }

  const leftParts = extractComparableTimeParts(left);
  const rightParts = extractComparableTimeParts(right);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return false;
  }

  return JSON.stringify(leftParts) === JSON.stringify(rightParts);
}

export function areEventTimesCompatibleForTesting(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return areTimesCompatible(left, right);
}

export function getComparableVenueCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "venue">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.venue,
    readJsonString(normalizedFields, "normalizedVenue"),
    readJsonString(normalizedFields, "locationName"),
    readJsonString(normalizedFields, "rawVenue"),
  ]);
}

export function getComparableTitleCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
  ]);
}

export function getComparableArtistCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "artists">,
): string[] {
  return collectComparableIdentityValues(event.artists);
}

export function getComparableEvidenceCandidates(
  event: Pick<
    ExistingEventRecord | PreparedEvent,
    "title" | "description" | "sourceCaption"
  >,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    event.description,
    event.sourceCaption,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "postAltText"),
    readJsonString(normalizedFields, "splitSourceLine"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

export function getComparableContextCandidates(
  event: Pick<
    ExistingEventRecord | PreparedEvent,
    "title" | "description" | "sourceCaption" | "venue" | "artists"
  >,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableTextValues([
    event.title,
    event.venue,
    event.description,
    event.sourceCaption,
    ...event.artists,
    readJsonString(normalizedFields, "rawTitle"),
    readJsonString(normalizedFields, "titleContextCandidate"),
    readJsonString(normalizedFields, "normalizedVenue"),
    readJsonString(normalizedFields, "locationName"),
    readJsonString(normalizedFields, "rawVenue"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "postAltText"),
    readJsonString(normalizedFields, "splitSourceLine"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

export function getComparableTitleFamilyCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return [
    ...new Set(
      [
        event.title,
        readJsonString(normalizedFields, "rawTitle"),
        readJsonString(normalizedFields, "titleContextCandidate"),
      ]
        .map((value) => buildTitleFamilySlug(normalizeString(value)))
        .filter(Boolean),
    ),
  ];
}

export function getComparableIdentityCandidates(
  event: Pick<ExistingEventRecord | PreparedEvent, "title" | "artists" | "venue">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectComparableIdentityValues(
    [
      event.title,
      ...event.artists,
      readJsonString(normalizedFields, "rawTitle"),
      readJsonString(normalizedFields, "titleContextCandidate"),
    ],
    {
      ignoredValues: getComparableVenueCandidates(event, normalizedFields),
    },
  );
}

export function getComparableMentionHandles(
  event: Pick<ExistingEventRecord | PreparedEvent, "description" | "sourceCaption" | "artists">,
  normalizedFields: Record<string, unknown> | null,
): string[] {
  return collectInstagramHandles([
    event.description,
    event.sourceCaption,
    ...event.artists,
    readJsonString(normalizedFields, "sourceCaptionFromModel"),
    readJsonString(normalizedFields, "description"),
    readJsonString(normalizedFields, "reasoningNotes"),
  ]);
}

export function hasUnreliableComparableTitle(normalizedFields: Record<string, unknown> | null): boolean {
  return (
    readJsonBoolean(normalizedFields, "titleUsedFallback") === true ||
    readJsonBoolean(normalizedFields, "titleDerivedFromContext") === true
  );
}

export function getSemanticDuplicateMatchScore(
  existing: ExistingEventRecord,
  next: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): number {
  if (normalizeString(existing.date) !== next.date) {
    return -1;
  }

  const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const existingVenueCandidates = getComparableVenueCandidates(existing, existingNormalizedFields);
  const nextVenueCandidates = getComparableVenueCandidates(next, nextNormalizedFields);
  const venueMatches = existingVenueCandidates.some((left) =>
    nextVenueCandidates.some((right) => areComparableVenueTexts(left, right)),
  );
  const existingTitleCandidates = getComparableTitleCandidates(existing, existingNormalizedFields);
  const nextTitleCandidates = getComparableTitleCandidates(next, nextNormalizedFields);
  const existingArtistCandidates = getComparableArtistCandidates(existing);
  const nextArtistCandidates = getComparableArtistCandidates(next);
  const existingEvidenceCandidates = getComparableEvidenceCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextEvidenceCandidates = getComparableEvidenceCandidates(next, nextNormalizedFields);
  const existingTitleFamilyCandidates = getComparableTitleFamilyCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextTitleFamilyCandidates = getComparableTitleFamilyCandidates(
    next,
    nextNormalizedFields,
  );
  const existingIdentityCandidates = getComparableIdentityCandidates(
    existing,
    existingNormalizedFields,
  );
  const nextIdentityCandidates = getComparableIdentityCandidates(next, nextNormalizedFields);
  const sharedMentionHandleCount = countSharedValues(
    getComparableMentionHandles(existing, existingNormalizedFields),
    getComparableMentionHandles(next, nextNormalizedFields),
  );

  const titleMatches = hasComparableTextOverlap(existingTitleCandidates, nextTitleCandidates);
  const artistMatches = hasComparableTextOverlap(existingArtistCandidates, nextArtistCandidates);
  const crossFieldMatches =
    hasComparableTextOverlap(existingTitleCandidates, nextArtistCandidates) ||
    hasComparableTextOverlap(existingArtistCandidates, nextTitleCandidates);
  const evidenceMatches = hasComparableTextOverlap(
    existingEvidenceCandidates,
    nextEvidenceCandidates,
  );
  const timeMatches = areTimesCompatible(existing.time, next.time);
  if (
    hasReliableEventTime(existing) &&
    hasReliableEventTime(next) &&
    !areTimesCompatible(existing.time, next.time)
  ) {
    return -1;
  }
  const hasFallbackTitle =
    hasUnreliableComparableTitle(existingNormalizedFields) ||
    hasUnreliableComparableTitle(nextNormalizedFields);
  const strongTitleFamilyMatches =
    !hasFallbackTitle &&
    existingTitleFamilyCandidates.some((left) =>
      nextTitleFamilyCandidates.some((right) => areCompatibleTitleFamilySlugs(left, right)),
    );
  const contextualVenueMatches =
    strongTitleFamilyMatches &&
    (hasVenueContextSupport(
      getComparableContextCandidates(existing, existingNormalizedFields),
      nextVenueCandidates,
    ) ||
      hasVenueContextSupport(
        getComparableContextCandidates(next, nextNormalizedFields),
        existingVenueCandidates,
      ));
  const contextualIdentityMatches =
    hasContextCandidateSupport(
      getComparableContextCandidates(existing, existingNormalizedFields),
      nextIdentityCandidates,
    ) ||
    hasContextCandidateSupport(
      getComparableContextCandidates(next, nextNormalizedFields),
      existingIdentityCandidates,
    );

  if (!venueMatches && !contextualVenueMatches) {
    return -1;
  }

  if (
    !titleMatches &&
    !artistMatches &&
    !crossFieldMatches &&
    !evidenceMatches &&
    !strongTitleFamilyMatches &&
    sharedMentionHandleCount === 0 &&
    !contextualIdentityMatches
  ) {
    return -1;
  }

  let score = 0;
  if (titleMatches) score += 4;
  if (crossFieldMatches) score += 4;
  if (artistMatches) score += 3;
  if (strongTitleFamilyMatches) score += 2;
  if (sharedMentionHandleCount >= 2) score += 2;
  else if (sharedMentionHandleCount === 1) score += 1;
  if (evidenceMatches) score += 1;
  if (timeMatches) score += 1;
  if (contextualIdentityMatches) score += 1;
  if (!venueMatches && contextualVenueMatches) {
    score += 1;
  }
  if (hasFallbackTitle && (crossFieldMatches || artistMatches || evidenceMatches)) {
    score += 1;
  }
  if (contextualIdentityMatches && (hasFallbackTitle || timeMatches)) {
    score += 1;
  }

  return score;
}

export function isMultiEventNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    readJsonBoolean(normalizedFields, "multiEventSplitDetected") === true ||
    (readJsonNumber(normalizedFields, "multiEventSplitCount") ?? 0) > 1
  );
}

export function isDateRangeExpandedNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    readJsonBoolean(normalizedFields, "dateRangeExpanded") === true ||
    (readJsonNumber(normalizedFields, "dateRangeExpandedCount") ?? 0) > 1
  );
}

export function isMultiOccurrenceNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    isMultiEventNormalizedFields(normalizedFields) ||
    isDateRangeExpandedNormalizedFields(normalizedFields) ||
    (readJsonNumber(normalizedFields, "expandedDateTotal") ?? 0) > 1
  );
}

export function allowsDateOnlySourceIdentityMatch(
  existing: ExistingEventRecord,
  nextNormalizedFields: Record<string, unknown>,
): boolean {
  if (isMultiEventNormalizedFields(nextNormalizedFields)) {
    return false;
  }

  const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  return !isMultiEventNormalizedFields(existingNormalizedFields);
}

export function choosePreferredDescription(
  existing: string | undefined,
  next: string | undefined,
  nextNormalizedFieldsJson?: string,
): string | undefined {
  const normalizedExisting = normalizeString(existing);
  const normalizedNext = normalizeString(next);
  void nextNormalizedFieldsJson;

  if (!normalizedExisting) {
    return normalizedNext || undefined;
  }

  if (!normalizedNext) {
    return normalizedExisting;
  }

  if (normalizedExisting === normalizedNext) {
    return normalizedExisting;
  }

  if (normalizedNext.length >= normalizedExisting.length * 1.25) {
    return normalizedNext;
  }

  return normalizedExisting;
}

export function choosePreferredArtists(
  existing: string[],
  next: string[],
  nextNormalizedFieldsJson?: string,
): string[] {
  if (next.length > 0 || existing.length === 0) {
    return next;
  }
  const fields = parseJsonRecord(nextNormalizedFieldsJson);
  if (!readJsonBoolean(fields, "artistsWereSanitized")) {
    return existing;
  }
  const rowEvidence =
    readJsonString(fields, "rowSourceText") ?? readJsonString(fields, "splitSourceLine") ?? "";
  return existing.filter((artist) =>
    hasExplicitBilledIdentityEvidence(artist, rowEvidence),
  );
}

export function hasReliableEventTime(event: {
  time?: string;
  timeSource?: EventTimeSource;
  timeStatus?: EventTimeProvenance["status"];
}): boolean {
  const time = normalizeString(event.time);
  return (
    Boolean(time) &&
    time.toLocaleLowerCase() !== TBD_EVENT_TIME.toLocaleLowerCase() &&
    event.timeSource !== "unknown" &&
    event.timeStatus !== "unknown"
  );
}

export function shouldPreserveExistingSinglePostSource(
  existing: ExistingEventRecord,
  next: PreparedEvent,
): boolean {
  const existingFields = parseJsonRecord(existing.normalizedFieldsJson);
  const nextFields = parseJsonRecord(next.normalizedFieldsJson);
  if (
    isMultiEventNormalizedFields(existingFields) ||
    !isMultiEventNormalizedFields(nextFields) ||
    !normalizeString(existing.sourceCaption)
  ) {
    return false;
  }

  const preferredDescription = choosePreferredDescription(
    existing.description,
    next.description,
    next.normalizedFieldsJson,
  );
  const nextWouldDowngradeDescription =
    Boolean(normalizeString(existing.description)) &&
    normalizeString(preferredDescription) === normalizeString(existing.description) &&
    normalizeString(next.description) !== normalizeString(existing.description);

  return (
    (hasReliableEventTime(existing) && !hasReliableEventTime(next)) ||
    (existing.artists.length > 0 && next.artists.length === 0) ||
    nextWouldDowngradeDescription
  );
}

export function hasMaterialEventChange(
  existing: ExistingEventRecord,
  next: PreparedEvent,
  nextDescription: string | undefined = next.description,
  nextArtists: string[] = next.artists,
): boolean {
  if (normalizeString(existing.title) !== normalizeString(next.title)) return true;
  if (normalizeString(existing.date) !== normalizeString(next.date)) return true;
  if (normalizeString(existing.time) !== normalizeString(next.time)) return true;
  if (normalizeString(existing.venue) !== normalizeString(next.venue)) return true;
  if (normalizeString(existing.eventType) !== normalizeString(next.eventType)) return true;
  if (normalizeString(existing.ticketPrice) !== normalizeString(next.ticketPrice)) return true;
  if (normalizeString(existing.description) !== normalizeString(nextDescription)) return true;
  if (normalizeString(existing.imageUrl) !== normalizeString(next.imageUrl)) return true;
  if (normalizeString(existing.imageStorageId) !== normalizeString(next.imageStorageId)) return true;
  if (
    JSON.stringify(normalizeArtistsForComparison(existing.artists)) !==
    JSON.stringify(normalizeArtistsForComparison(nextArtists))
  ) {
    return true;
  }
  return false;
}

export function buildDuplicateUpdatePatch(
  existing: ExistingEventRecord,
  next: PreparedEvent,
): {
  patch: {
    title?: string;
    date?: string;
    time?: string;
    timeSource?: EventTimeSource;
    timeEvidenceText?: string | null;
    timeConfidence?: number;
    timeStatus?: EventTimeProvenance["status"];
    timeEvidenceKind?: EventTimeEvidenceKind;
    dateEvidenceText?: string;
    dateEvidenceSource?: EventDateEvidenceSource;
    dateEvidenceIsRelative?: boolean;
    dateEvidenceResolvedDate?: string;
    sourceConflictFields?: string[];
    venue?: string;
    artists?: string[];
    description?: string;
    imageUrl?: string;
    imageStorageId?: string;
    instagramPostUrl?: string;
    instagramPostId?: string;
    ticketPrice?: string;
    clearTicketPrice?: boolean;
    eventType?: string;
    sourceCaption?: string;
    sourcePostedAt?: string;
    rawExtractionJson?: string;
    normalizedFieldsJson?: string;
    status?: EventStatus;
    reviewedAt?: number;
    reviewedBy?: string;
    moderationNote?: string;
  };
  materiallyChanged: boolean;
  statusResetToPending: boolean;
  statusAutoApproved: boolean;
  protectedApprovedFromPending: boolean;
} {
  const preserveExistingSource = shouldPreserveExistingSinglePostSource(existing, next);
  const preferredDescription = preserveExistingSource
    ? existing.description
    : choosePreferredDescription(
        existing.description,
        next.description,
        next.normalizedFieldsJson,
      );
  const preferredArtists = preserveExistingSource
    ? existing.artists
    : choosePreferredArtists(
        existing.artists,
        next.artists,
        next.normalizedFieldsJson,
      );
  const preferredNext: PreparedEvent = {
    ...next,
    artists: preferredArtists,
    description: preferredDescription,
    ...(preserveExistingSource
      ? {
          time: existing.time,
          timeSource: existing.timeSource ?? "unknown",
          timeEvidenceText: existing.timeEvidenceText,
          timeConfidence: existing.timeConfidence ?? 0,
          timeStatus: existing.timeStatus ?? "unknown",
          timeEvidenceKind: existing.timeEvidenceKind,
          dateEvidenceText: existing.dateEvidenceText,
          dateEvidenceSource: existing.dateEvidenceSource,
          dateEvidenceIsRelative: existing.dateEvidenceIsRelative,
          dateEvidenceResolvedDate: existing.dateEvidenceResolvedDate,
          sourceConflictFields: existing.sourceConflictFields,
          imageUrl: existing.imageUrl,
          instagramPostUrl: existing.instagramPostUrl ?? next.instagramPostUrl,
          instagramPostId: existing.instagramPostId ?? next.instagramPostId,
          ticketPrice: existing.ticketPrice,
          eventType: existing.eventType,
          sourceCaption: existing.sourceCaption,
          sourcePostedAt: existing.sourcePostedAt,
          rawExtractionJson: existing.rawExtractionJson,
          normalizedFieldsJson: existing.normalizedFieldsJson,
        }
      : {}),
  };
  if (existing.imageStorageId && existing.imageUrl) {
    preferredNext.imageStorageId = existing.imageStorageId;
    preferredNext.imageUrl = existing.imageUrl;
  }
  const materiallyChanged = hasMaterialEventChange(
    existing,
    preferredNext,
    preferredDescription,
    preferredArtists,
  );
  const effectiveNextStatus: EventStatus = preserveExistingSource
    ? existing.status
    : next.status === "approved" &&
        (existing.status === "rejected" ||
          (!hasCompleteSourceGroundedAutoApproval(next.normalizedFieldsJson, next) &&
            !hasEventEvidenceV2AutoApproval(next.normalizedFieldsJson, next)))
      ? "pending"
      : next.status;
  const statusAutoApproved =
    effectiveNextStatus === "approved" && existing.status !== "approved";
  const protectedApprovedFromPending = existing.status === "approved";
  if (protectedApprovedFromPending) {
    return {
      patch: {},
      materiallyChanged: false,
      statusResetToPending: false,
      statusAutoApproved: false,
      protectedApprovedFromPending: true,
    };
  }
  // Rejected records can return to pending when a material, non-approved rescrape improves them.
  const statusResetToPending =
    materiallyChanged && existing.status === "rejected" && effectiveNextStatus !== "approved";
  const nextStatus: EventStatus =
    effectiveNextStatus === "approved"
      ? "approved"
      : statusResetToPending
        ? "pending"
        : existing.status;
  const descriptionChanged =
    normalizeString(existing.description) !== normalizeString(preferredDescription);
  const clearTicketPrice =
    Boolean(normalizeString(existing.ticketPrice)) &&
    !normalizeString(preferredNext.ticketPrice);

  return {
    patch: {
      title: preferredNext.title,
      date: preferredNext.date,
      ...(preferredNext.time ? { time: preferredNext.time } : {}),
      timeSource: preferredNext.timeSource,
      timeEvidenceText: preferredNext.timeEvidenceText ?? null,
      timeConfidence: preferredNext.timeConfidence,
      timeStatus: preferredNext.timeStatus,
      ...(preferredNext.timeEvidenceKind
        ? { timeEvidenceKind: preferredNext.timeEvidenceKind }
        : {}),
      ...(preferredNext.dateEvidenceText
        ? { dateEvidenceText: preferredNext.dateEvidenceText }
        : {}),
      ...(preferredNext.dateEvidenceSource
        ? { dateEvidenceSource: preferredNext.dateEvidenceSource }
        : {}),
      ...(preferredNext.dateEvidenceIsRelative !== undefined
        ? { dateEvidenceIsRelative: preferredNext.dateEvidenceIsRelative }
        : {}),
      ...(preferredNext.dateEvidenceResolvedDate
        ? { dateEvidenceResolvedDate: preferredNext.dateEvidenceResolvedDate }
        : {}),
      ...(preferredNext.sourceConflictFields
        ? { sourceConflictFields: preferredNext.sourceConflictFields }
        : {}),
      venue: preferredNext.venue,
      artists: preferredArtists,
      ...(descriptionChanged && preferredDescription
        ? { description: preferredDescription }
        : preserveExistingSource && preferredDescription
          ? { description: preferredDescription }
          : {}),
      ...(preferredNext.imageUrl && preferredNext.imageStorageId
        ? {
            imageUrl: preferredNext.imageUrl,
            imageStorageId: preferredNext.imageStorageId,
          }
        : preferredNext.imageUrl
          ? { imageUrl: preferredNext.imageUrl }
          : {}),
      instagramPostUrl: preferredNext.instagramPostUrl,
      instagramPostId: preferredNext.instagramPostId,
      ...(preferredNext.ticketPrice
        ? { ticketPrice: preferredNext.ticketPrice }
        : clearTicketPrice
          ? { clearTicketPrice: true }
          : {}),
      eventType: preferredNext.eventType,
      ...(preferredNext.sourceCaption ? { sourceCaption: preferredNext.sourceCaption } : {}),
      ...(preferredNext.sourcePostedAt ? { sourcePostedAt: preferredNext.sourcePostedAt } : {}),
      ...(preferredNext.rawExtractionJson
        ? { rawExtractionJson: preferredNext.rawExtractionJson }
        : {}),
      ...(preferredNext.normalizedFieldsJson
        ? { normalizedFieldsJson: preferredNext.normalizedFieldsJson }
        : {}),
      ...(nextStatus !== existing.status ? { status: nextStatus } : {}),
      ...(statusResetToPending || statusAutoApproved
        ? {
            reviewedAt: undefined,
            reviewedBy: undefined,
            moderationNote: undefined,
          }
        : {}),
    },
    materiallyChanged,
    statusResetToPending,
    statusAutoApproved,
    protectedApprovedFromPending: false,
  };
}
