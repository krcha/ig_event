import {
  areCompatibleTitleFamilySlugs,
  buildTitleFamilySlug,
  collectComparableTextValues,
  collectComparableIdentityValues,
  collectInstagramHandles,
  countSharedValues,
  hasContextCandidateSupport,
  hasVenueContextSupport,
  normalizeInstagramUrl,
} from "./deduplication-shared.ts";

const SERBIAN_CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "dj",
  е: "e",
  ж: "z",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "c",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "c",
  џ: "dz",
  ш: "s",
};

const SERBIAN_LATIN_TO_ASCII: Record<string, string> = {
  đ: "dj",
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
};

const DUPLICATE_VENUE_STOP_WORDS = new Set([
  "beograd",
  "belgrade",
  "club",
  "klub",
  "dom",
  "kulture",
  "serbia",
  "srbija",
]);

const DUPLICATE_TEXT_STOP_WORDS = new Set([
  "belgrade",
  "beograd",
  "serbia",
  "srbija",
  "event",
  "party",
  "concert",
  "live",
  "music",
  "night",
  "official",
  "ulaz",
  "slobodan",
  "free",
  "entry",
]);

export type ApprovedEventDuplicateRecord = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  venue: string;
  artists: string[];
  description: string | null;
  imageUrl: string | null;
  instagramPostUrl: string | null;
  instagramPostId: string | null;
  ticketPrice: string | null;
  eventType: string;
  sourceCaption: string | null;
  sourcePostedAt: string | null;
  normalizedFieldsJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ApprovedEventAutoCleanupGroup = {
  groupId: string;
  primaryEventId: string;
  duplicateEventIds: string[];
  primaryEvent: ApprovedEventDuplicateRecord;
  duplicateEvents: ApprovedEventDuplicateRecord[];
  matchReasonsByEventId: Record<string, string[]>;
};

function parseNormalizedEventDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function getStartOfLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

type DecoratedDuplicateEvent = ApprovedEventDuplicateRecord & {
  normalizedFields: Record<string, unknown> | null;
  duplicateDateKey: string | null;
  duplicateVenueText: string;
  duplicateVenueCandidates: string[];
  duplicateContextTexts: string[];
  duplicateTitleText: string;
  duplicateArtistText: string;
  duplicateDescriptionText: string;
  duplicateTitleFamilySlug: string;
  duplicateEntityCandidates: string[];
  duplicateMentionHandles: string[];
  normalizedInstagramUrl: string;
  titleUsedFallback: boolean;
  titleDerivedFromContext: boolean;
  qualityScore: number;
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBooleanField(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true;
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[đčćžš]/g, (character) => SERBIAN_LATIN_TO_ASCII[character] ?? character)
    .replace(/[\u0400-\u04ff]/g, (character) => {
      return SERBIAN_CYRILLIC_TO_LATIN[character] ?? character;
    })
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractComparableTimeParts(value: string | null | undefined): string[] {
  const matches = (value ?? "").match(/\d{1,2}(?::\d{2})?/g) ?? [];
  return matches.map((match) => {
    const [hours, minutes = "00"] = match.split(":");
    return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  });
}

function areDuplicateTimesCompatible(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const leftParts = extractComparableTimeParts(left);
  const rightParts = extractComparableTimeParts(right);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return false;
  }

  return JSON.stringify(leftParts) === JSON.stringify(rightParts);
}

function getSimilarityRatio(left: string, right: string, stopWords: Set<string>): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = [
    ...new Set(
      left.split(" ").filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];
  const rightTokens = [
    ...new Set(
      right.split(" ").filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  let sharedCount = 0;
  for (const token of leftTokens) {
    if (rightTokenSet.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount / Math.min(leftTokens.length, rightTokens.length);
}

function areSimilarVenues(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.includes(right) || right.includes(left)) {
    return true;
  }
  return getSimilarityRatio(left, right, DUPLICATE_VENUE_STOP_WORDS) >= 0.72;
}

function areSimilarDuplicateTexts(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength >= 24 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  return getSimilarityRatio(left, right, DUPLICATE_TEXT_STOP_WORDS) >= 0.6;
}

function scoreApprovedEventQuality(
  event: ApprovedEventDuplicateRecord,
  normalizedFields: Record<string, unknown> | null,
  titleUsedFallback: boolean,
): number {
  let score = 0;

  if (event.imageUrl) score += 30;
  if (event.instagramPostUrl) score += 18;
  if (event.time) score += 14;
  if (event.ticketPrice) score += 10;
  if (event.description) score += 18;
  if (event.sourceCaption) score += 12;
  if (event.normalizedFieldsJson) score += 8;
  if (event.eventType.trim().toLowerCase() !== "event") score += 6;

  score += Math.min(event.artists.length, 5) * 3;
  score += Math.min(event.title.trim().length, 96) / 12;
  score += Math.min((event.description ?? "").trim().length, 320) / 32;

  if (readStringField(normalizedFields, "normalizedVenue")) score += 4;
  if (readStringField(normalizedFields, "normalizedDate")) score += 4;
  if (titleUsedFallback) score -= 12;

  return score;
}

function decorateEventForDuplicateCleanup(
  event: ApprovedEventDuplicateRecord,
): DecoratedDuplicateEvent {
  const normalizedFields = parseJsonObject(event.normalizedFieldsJson);
  const titleUsedFallback = readBooleanField(normalizedFields, "titleUsedFallback");
  const titleDerivedFromContext = readBooleanField(normalizedFields, "titleDerivedFromContext");
  const duplicateVenueCandidates = collectComparableTextValues([
    event.venue,
    readStringField(normalizedFields, "normalizedVenue"),
    readStringField(normalizedFields, "locationName"),
    readStringField(normalizedFields, "rawVenue"),
  ]);
  const duplicateMentionHandles = collectInstagramHandles([
    event.sourceCaption,
    event.description,
    ...event.artists,
    readStringField(normalizedFields, "sourceCaptionFromModel"),
    readStringField(normalizedFields, "description"),
    readStringField(normalizedFields, "reasoningNotes"),
  ]);
  const duplicateContextTexts = collectComparableTextValues([
    event.title,
    event.venue,
    event.description,
    event.sourceCaption,
    ...event.artists,
    readStringField(normalizedFields, "rawTitle"),
    readStringField(normalizedFields, "titleContextCandidate"),
    readStringField(normalizedFields, "normalizedVenue"),
    readStringField(normalizedFields, "locationName"),
    readStringField(normalizedFields, "rawVenue"),
    readStringField(normalizedFields, "description"),
    readStringField(normalizedFields, "sourceCaptionFromModel"),
    readStringField(normalizedFields, "postAltText"),
    readStringField(normalizedFields, "splitSourceLine"),
    readStringField(normalizedFields, "reasoningNotes"),
  ]);
  const duplicateEntityCandidates = collectComparableIdentityValues(
    [
      event.title,
      ...event.artists,
      readStringField(normalizedFields, "rawTitle"),
      readStringField(normalizedFields, "titleContextCandidate"),
    ],
    { ignoredValues: duplicateVenueCandidates },
  );

  return {
    ...event,
    normalizedFields,
    duplicateDateKey: readStringField(normalizedFields, "normalizedDate") ?? event.date,
    duplicateVenueText: normalizeComparisonText(
      [
        event.venue,
        readStringField(normalizedFields, "normalizedVenue") ?? "",
        readStringField(normalizedFields, "locationName") ?? "",
      ].join(" "),
    ),
    duplicateVenueCandidates,
    duplicateContextTexts,
    duplicateTitleText: normalizeComparisonText(
      [event.title, event.artists.join(" ")].join(" "),
    ),
    duplicateArtistText: normalizeComparisonText(event.artists.join(" ")),
    duplicateDescriptionText: normalizeComparisonText(
      [event.description ?? "", event.sourceCaption ?? ""].join(" "),
    ),
    duplicateTitleFamilySlug: buildTitleFamilySlug(event.title),
    duplicateEntityCandidates,
    duplicateMentionHandles,
    normalizedInstagramUrl: normalizeInstagramUrl(event.instagramPostUrl),
    titleUsedFallback,
    titleDerivedFromContext,
    qualityScore: scoreApprovedEventQuality(
      event,
      normalizedFields,
      titleUsedFallback || titleDerivedFromContext,
    ),
  };
}

function buildDuplicateMatchReasons(
  left: DecoratedDuplicateEvent,
  right: DecoratedDuplicateEvent,
): string[] {
  const reasons: string[] = [];
  const titleFamilyMatches = areCompatibleTitleFamilySlugs(
    left.duplicateTitleFamilySlug,
    right.duplicateTitleFamilySlug,
  );
  const sharedMentionHandleCount = countSharedValues(
    left.duplicateMentionHandles,
    right.duplicateMentionHandles,
  );
  const contextualVenueMatch =
    titleFamilyMatches &&
    (hasVenueContextSupport(left.duplicateContextTexts, right.duplicateVenueCandidates) ||
      hasVenueContextSupport(right.duplicateContextTexts, left.duplicateVenueCandidates));
  const contextualEntityMatch =
    hasContextCandidateSupport(left.duplicateContextTexts, right.duplicateEntityCandidates) ||
    hasContextCandidateSupport(right.duplicateContextTexts, left.duplicateEntityCandidates);

  if (
    left.instagramPostId &&
    right.instagramPostId &&
    left.instagramPostId === right.instagramPostId
  ) {
    reasons.push("same Instagram post");
  } else if (
    left.normalizedInstagramUrl &&
    right.normalizedInstagramUrl &&
    left.normalizedInstagramUrl === right.normalizedInstagramUrl
  ) {
    reasons.push("same Instagram post");
  }

  if (areSimilarDuplicateTexts(left.duplicateTitleText, right.duplicateTitleText)) {
    reasons.push("similar title");
  }
  if (areSimilarDuplicateTexts(left.duplicateArtistText, right.duplicateArtistText)) {
    reasons.push("similar artists");
  }
  if (areSimilarDuplicateTexts(left.duplicateDescriptionText, right.duplicateDescriptionText)) {
    reasons.push("similar description");
  }
  if (titleFamilyMatches) {
    reasons.push("matching title family");
  }
  if (sharedMentionHandleCount > 0) {
    reasons.push("shared Instagram handles");
  }
  if (contextualVenueMatch) {
    reasons.push("venue referenced in event text");
  }
  if (contextualEntityMatch) {
    reasons.push("event identity referenced in event text");
  }

  return reasons;
}

function areAutoCleanupDuplicateEvents(
  left: DecoratedDuplicateEvent,
  right: DecoratedDuplicateEvent,
): boolean {
  if (!left.duplicateDateKey || left.duplicateDateKey !== right.duplicateDateKey) {
    return false;
  }
  const directVenueMatch = areSimilarVenues(left.duplicateVenueText, right.duplicateVenueText);
  const contextualVenueMatch =
    areCompatibleTitleFamilySlugs(
      left.duplicateTitleFamilySlug,
      right.duplicateTitleFamilySlug,
    ) &&
    (hasVenueContextSupport(left.duplicateContextTexts, right.duplicateVenueCandidates) ||
      hasVenueContextSupport(right.duplicateContextTexts, left.duplicateVenueCandidates));
  const sharedMentionHandleCount = countSharedValues(
    left.duplicateMentionHandles,
    right.duplicateMentionHandles,
  );
  const contextualEntityMatch =
    hasContextCandidateSupport(left.duplicateContextTexts, right.duplicateEntityCandidates) ||
    hasContextCandidateSupport(right.duplicateContextTexts, left.duplicateEntityCandidates);
  const timeMatches = areDuplicateTimesCompatible(left.time, right.time);
  const hasUnreliableTitle =
    left.titleUsedFallback ||
    right.titleUsedFallback ||
    left.titleDerivedFromContext ||
    right.titleDerivedFromContext;

  if (!directVenueMatch && !contextualVenueMatch) {
    return false;
  }

  const matchReasons = buildDuplicateMatchReasons(left, right);
  if (matchReasons.includes("same Instagram post")) {
    return true;
  }
  if (matchReasons.includes("matching title family")) {
    return true;
  }
  if (sharedMentionHandleCount >= 2) {
    return true;
  }
  if (
    matchReasons.includes("similar title") &&
    !left.titleUsedFallback &&
    !right.titleUsedFallback
  ) {
    return true;
  }
  if (matchReasons.includes("similar description")) {
    return true;
  }
  if (
    matchReasons.includes("similar title") &&
    matchReasons.includes("similar artists")
  ) {
    return true;
  }
  if (
    matchReasons.includes("shared Instagram handles") &&
    (matchReasons.includes("similar description") || matchReasons.includes("similar artists"))
  ) {
    return true;
  }
  if (contextualEntityMatch && (timeMatches || hasUnreliableTitle)) {
    return true;
  }

  return false;
}

function toApprovedEventRecord(event: DecoratedDuplicateEvent): ApprovedEventDuplicateRecord {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    venue: event.venue,
    artists: event.artists,
    description: event.description,
    imageUrl: event.imageUrl,
    instagramPostUrl: event.instagramPostUrl,
    instagramPostId: event.instagramPostId,
    ticketPrice: event.ticketPrice,
    eventType: event.eventType,
    sourceCaption: event.sourceCaption,
    sourcePostedAt: event.sourcePostedAt,
    normalizedFieldsJson: event.normalizedFieldsJson,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function filterUpcomingApprovedEventsForDuplicateCleanup(
  events: ApprovedEventDuplicateRecord[],
): ApprovedEventDuplicateRecord[] {
  const startOfToday = getStartOfLocalToday();
  return events
    .filter((event) => {
      const parsedDate = parseNormalizedEventDate(event.date);
      return Boolean(parsedDate && parsedDate >= startOfToday);
    })
    .sort((left, right) => left.date.localeCompare(right.date) || right.updatedAt - left.updatedAt);
}

export function buildApprovedEventAutoCleanupGroups(
  events: ApprovedEventDuplicateRecord[],
): ApprovedEventAutoCleanupGroup[] {
  const decoratedEvents = events
    .map((event) => decorateEventForDuplicateCleanup(event))
    .sort((left, right) => {
      return (
        left.date.localeCompare(right.date) ||
        left.duplicateVenueText.localeCompare(right.duplicateVenueText) ||
        right.qualityScore - left.qualityScore ||
        right.updatedAt - left.updatedAt
      );
    });

  const remainingIds = new Set(decoratedEvents.map((event) => event.id));
  const groups: ApprovedEventAutoCleanupGroup[] = [];

  for (const primary of decoratedEvents) {
    if (!remainingIds.has(primary.id)) {
      continue;
    }

    const duplicates: DecoratedDuplicateEvent[] = [];
    const matchReasonsByEventId: Record<string, string[]> = {};

    for (const candidate of decoratedEvents) {
      if (candidate.id === primary.id || !remainingIds.has(candidate.id)) {
        continue;
      }
      if (!areAutoCleanupDuplicateEvents(primary, candidate)) {
        continue;
      }

      duplicates.push(candidate);
      matchReasonsByEventId[candidate.id] = buildDuplicateMatchReasons(primary, candidate);
    }

    remainingIds.delete(primary.id);

    if (duplicates.length === 0) {
      continue;
    }

    for (const duplicate of duplicates) {
      remainingIds.delete(duplicate.id);
    }

    groups.push({
      groupId: `auto_cleanup_${groups.length + 1}`,
      primaryEventId: primary.id,
      duplicateEventIds: duplicates.map((event) => event.id),
      primaryEvent: toApprovedEventRecord(primary),
      duplicateEvents: duplicates.map((event) => toApprovedEventRecord(event)),
      matchReasonsByEventId,
    });
  }

  return groups;
}
