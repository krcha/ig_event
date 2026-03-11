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

const GENERIC_TITLE_TOKENS = new Set([
  "party",
  "zurka",
  "zurke",
  "zurci",
  "night",
  "club",
  "klub",
  "event",
  "live",
  "show",
  "festival",
  "bg",
  "official",
  "present",
  "presents",
]);

const GENERIC_TITLE_SUFFIXES = [
  "party",
  "zurka",
  "zurke",
  "zurci",
  "night",
  "event",
  "show",
  "live",
  "festival",
  "bg",
];

const DIGIT_WORDS: Record<string, string> = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
};

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
  duplicateTitleText: string;
  duplicateArtistText: string;
  duplicateDescriptionText: string;
  duplicateTitleFamilySlug: string;
  normalizedInstagramUrl: string;
  titleUsedFallback: boolean;
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

function normalizeInstagramUrl(value: string | null): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function replaceDigitsWithWords(value: string): string {
  return value.replace(/\d/g, (digit) => DIGIT_WORDS[digit] ?? digit);
}

function stripGenericTitleSuffixes(value: string): string {
  let current = value;

  while (current.length > 4) {
    const next = GENERIC_TITLE_SUFFIXES.find(
      (suffix) => current.endsWith(suffix) && current.length - suffix.length >= 4,
    );
    if (!next) {
      break;
    }
    current = current.slice(0, -next.length);
  }

  return current;
}

function buildTitleFamilySlug(value: string): string {
  const normalized = normalizeComparisonText(replaceDigitsWithWords(value));
  const meaningfulTokens = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_TITLE_TOKENS.has(token));

  const compact =
    meaningfulTokens.length > 0 ? meaningfulTokens.join("") : normalized.replace(/\s+/g, "");

  return stripGenericTitleSuffixes(compact);
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

function areCompatibleTitleFamilySlugs(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength >= 5 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  return false;
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
    duplicateTitleText: normalizeComparisonText(
      [event.title, event.artists.join(" ")].join(" "),
    ),
    duplicateArtistText: normalizeComparisonText(event.artists.join(" ")),
    duplicateDescriptionText: normalizeComparisonText(
      [event.description ?? "", event.sourceCaption ?? ""].join(" "),
    ),
    duplicateTitleFamilySlug: buildTitleFamilySlug(event.title),
    normalizedInstagramUrl: normalizeInstagramUrl(event.instagramPostUrl),
    titleUsedFallback,
    qualityScore: scoreApprovedEventQuality(event, normalizedFields, titleUsedFallback),
  };
}

function buildDuplicateMatchReasons(
  left: DecoratedDuplicateEvent,
  right: DecoratedDuplicateEvent,
): string[] {
  const reasons: string[] = [];

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
  if (
    areCompatibleTitleFamilySlugs(
      left.duplicateTitleFamilySlug,
      right.duplicateTitleFamilySlug,
    )
  ) {
    reasons.push("matching title family");
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
  if (!areSimilarVenues(left.duplicateVenueText, right.duplicateVenueText)) {
    return false;
  }

  const matchReasons = buildDuplicateMatchReasons(left, right);
  if (matchReasons.includes("same Instagram post")) {
    return true;
  }
  if (matchReasons.includes("matching title family")) {
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
