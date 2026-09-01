import { normalizeEventTime } from "./event-time.ts";

export type EventEvidenceSourceConflict = {
  field: string;
  poster_value: string;
  caption_value: string;
  reason: string;
};

export type EventEvidenceConflictContext = {
  artists: string[];
  dateEvidenceVerified: boolean;
  resolvedDate: string;
  selectedTitle: string;
  selectedVenue: string;
  singleOccurrenceSource: boolean;
  sourceAccountName: string;
  sourceAccountRole: "venue" | "promoter" | "unknown" | undefined;
  sourceCaption: string;
  sourcePostedAt?: string;
  venueEvidenceVerified: boolean;
};

const MINOR_TITLE_CONNECTOR_TOKENS = new Set([
  "a",
  "an",
  "and",
  "i",
  "je",
  "koja",
  "koje",
  "koji",
  "the",
]);

const MONTH_NUMBER_BY_NAME = new Map<string, number>([
  ["januar", 1], ["januara", 1], ["january", 1],
  ["februar", 2], ["februara", 2], ["february", 2],
  ["mart", 3], ["marta", 3], ["march", 3],
  ["april", 4], ["aprila", 4],
  ["maj", 5], ["maja", 5], ["may", 5],
  ["jun", 6], ["juna", 6], ["june", 6],
  ["jul", 7], ["jula", 7], ["july", 7],
  ["avgust", 8], ["avgusta", 8], ["august", 8],
  ["septembar", 9], ["septembra", 9], ["september", 9],
  ["oktobar", 10], ["oktobra", 10], ["october", 10],
  ["novembar", 11], ["novembra", 11], ["november", 11],
  ["decembar", 12], ["decembra", 12], ["december", 12],
]);

const WEEKDAY_TOKENS = [
  ["nedelja", "nedelju", "nedeljom", "nedjelja", "nedjelju", "недеља", "недељу", "sunday"],
  ["ponedeljak", "ponedjeljak", "понедељак", "monday"],
  ["utorak", "utorka", "уторак", "уторка", "tuesday"],
  ["sreda", "sredu", "srijeda", "srijedu", "среда", "среду", "wednesday"],
  ["cetvrtak", "cetvrtka", "четвртак", "четвртка", "thursday"],
  ["petak", "petka", "петак", "петка", "friday"],
  ["subota", "subotu", "subote", "субота", "суботу", "суботе", "saturday"],
] as const;

function comparableText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[đĐ]/gu, "dj")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLocaleLowerCase("sr-Latn")
    .replace(/[^\p{L}\p{N}@]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function compactIdentity(value: unknown): string {
  return comparableText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function artistHandleSegments(value: string): string[] {
  return value
    .trim()
    .replace(/^@/u, "")
    .split(/[._-]+/u)
    .map(compactIdentity)
    .filter(Boolean);
}

function isConcatenatedHandleSegmentPrefix(
  display: string,
  segments: readonly string[],
  segmentIndex = 0,
  displayOffset = 0,
): boolean {
  if (segmentIndex >= segments.length) return displayOffset === display.length;
  const segment = segments[segmentIndex];
  const minimumLength = Math.min(2, segment.length);
  const minimumRemainingLength = segments
    .slice(segmentIndex + 1)
    .reduce((total, value) => total + Math.min(2, value.length), 0);
  const maximumLength = Math.min(
    segment.length,
    display.length - displayOffset - minimumRemainingLength,
  );
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    if (
      display.startsWith(segment.slice(0, length), displayOffset) &&
      isConcatenatedHandleSegmentPrefix(
        display,
        segments,
        segmentIndex + 1,
        displayOffset + length,
      )
    ) {
      return true;
    }
  }
  return false;
}

function comparableTitleTokens(value: unknown): string[] {
  return comparableText(value)
    .split(/\s+/u)
    .filter((token) => token && !MINOR_TITLE_CONNECTOR_TOKENS.has(token));
}

export function eventTitlesDifferOnlyByMinorConnectors(left: string, right: string): boolean {
  const leftTokens = comparableTitleTokens(left);
  const rightTokens = comparableTitleTokens(right);
  return (
    leftTokens.length >= 3 &&
    leftTokens.length === rightTokens.length &&
    leftTokens.every((token, index) => token === rightTokens[index])
  );
}

export function eventArtistHandleAliasMatches(left: string, right: string): boolean {
  const leftIsHandle = /^@[\p{L}\p{N}._-]+$/u.test(left.trim());
  const rightIsHandle = /^@[\p{L}\p{N}._-]+$/u.test(right.trim());
  if (leftIsHandle === rightIsHandle) return false;
  const handleComparable = compactIdentity(leftIsHandle ? left : right);
  const displayComparable = compactIdentity(leftIsHandle ? right : left);
  if (!handleComparable || !displayComparable) return false;
  if (handleComparable === displayComparable) return true;
  const handleSegments = artistHandleSegments(leftIsHandle ? left : right);
  return (
    displayComparable.length >= 4 &&
    handleSegments.length >= 2 &&
    isConcatenatedHandleSegmentPrefix(displayComparable, handleSegments)
  );
}

export function conflictExplicitlyIdentifiesArtistHandleAlias(
  conflict: EventEvidenceSourceConflict,
): boolean {
  return (
    conflict.field === "artists" &&
    eventArtistHandleAliasMatches(conflict.poster_value, conflict.caption_value) &&
    /\b(?:alias|handle|instagram|tag|tagged|tags)\b/iu.test(conflict.reason)
  );
}

function textContainsIdentity(text: string, identity: string): boolean {
  const textComparable = comparableText(text);
  const identityComparable = comparableText(identity);
  return Boolean(
    textComparable &&
      identityComparable &&
      ` ${textComparable} `.includes(` ${identityComparable} `),
  );
}

function artistConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  artists: string[],
): boolean {
  if (comparableText(conflict.poster_value) === comparableText(conflict.caption_value)) {
    return true;
  }
  if (!conflictExplicitlyIdentifiesArtistHandleAlias(conflict)) return false;
  const handle = /^@[\p{L}\p{N}._-]+$/u.test(conflict.poster_value.trim())
    ? conflict.poster_value.trim()
    : conflict.caption_value.trim();
  return artists.some(
    (artist) =>
      comparableText(artist) === comparableText(handle) ||
      eventArtistHandleAliasMatches(handle, artist),
  );
}

function extractComparableTimeParts(value: string): string[] {
  const matches = String(value ?? "").match(/\d{1,2}(?::\d{2})?/gu) ?? [];
  return matches.map((match) => {
    const [hours, minutes = "00"] = match.split(":");
    return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  });
}

function timesAreCompatible(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return false;
  if (comparableText(left) === comparableText(right)) return true;
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
  return leftParts.length > 0 && JSON.stringify(leftParts) === JSON.stringify(rightParts);
}

function weekdayForIsoDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function weekdaysMentioned(value: string): number[] {
  const normalized = comparableText(value);
  const matches: number[] = [];
  for (const [weekday, tokens] of WEEKDAY_TOKENS.entries()) {
    if (tokens.some((token) => ` ${normalized} `.includes(` ${token} `))) {
      matches.push(weekday);
    }
  }
  return matches;
}

function explicitDatesMentioned(value: string, resolvedDate: string): string[] {
  const matches = new Set<string>();
  for (const match of String(value ?? "").matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    matches.add(`${match[1]}-${match[2]}-${match[3]}`);
  }
  const resolvedYear = /^\d{4}/u.exec(resolvedDate)?.[0];
  for (const match of String(value ?? "").matchAll(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\s*[./-]\s*(\d{2,4}))?\.?/gu)) {
    let year = match[3] ?? resolvedYear;
    if (!year) continue;
    if (year.length === 2) year = `20${year}`;
    matches.add(`${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`);
  }
  const comparable = comparableText(value);
  for (const match of comparable.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\.?\s+([\p{L}]+)(?:\s+(\d{2,4}))?\b/gu,
  )) {
    const month = MONTH_NUMBER_BY_NAME.get(match[2]);
    let year = match[3] ?? resolvedYear;
    if (!month || !year) continue;
    if (year.length === 2) year = `20${year}`;
    const day = Number.parseInt(match[1], 10);
    const candidate = new Date(Date.UTC(Number.parseInt(year, 10), month - 1, day));
    if (
      candidate.getUTCFullYear() === Number.parseInt(year, 10) &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    ) {
      matches.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return [...matches];
}

function textNamesResolvedDate(value: string, resolvedDate: string): boolean {
  if (!resolvedDate) return false;
  if (explicitDatesMentioned(value, resolvedDate).includes(resolvedDate)) return true;
  const weekday = weekdayForIsoDate(resolvedDate);
  return weekday !== null && weekdaysMentioned(value).includes(weekday);
}

function sourceWasPostedOnResolvedBelgradeDate(
  sourcePostedAt: string | undefined,
  resolvedDate: string,
): boolean {
  if (!sourcePostedAt || !/^\d{4}-\d{2}-\d{2}$/u.test(resolvedDate)) {
    return false;
  }
  const timestamp = Date.parse(sourcePostedAt);
  if (!Number.isFinite(timestamp)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Belgrade",
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get("year");
  const month = byType.get("month");
  const day = byType.get("day");
  return Boolean(year && month && day && `${year}-${month}-${day}` === resolvedDate);
}

function dateConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (!context.dateEvidenceVerified || !context.resolvedDate) return false;
  if (
    textNamesResolvedDate(conflict.poster_value, context.resolvedDate) &&
    textNamesResolvedDate(conflict.caption_value, context.resolvedDate)
  ) {
    return true;
  }
  const genericRelativeDayPattern =
    /\b(?:today|tonight|danas|veceras|данас|вечерас)\b/iu;
  const values = [conflict.poster_value, conflict.caption_value];
  const genericIndex = values.findIndex((value) => genericRelativeDayPattern.test(comparableText(value)));
  if (genericIndex < 0 || !context.singleOccurrenceSource) return false;
  const specificValue = values[genericIndex === 0 ? 1 : 0];
  return (
    textNamesResolvedDate(specificValue, context.resolvedDate) &&
    (textNamesResolvedDate(context.sourceCaption, context.resolvedDate) ||
      (genericRelativeDayPattern.test(comparableText(context.sourceCaption)) &&
        sourceWasPostedOnResolvedBelgradeDate(
          context.sourcePostedAt,
          context.resolvedDate,
        )))
  );
}

function venueConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  const poster = comparableText(conflict.poster_value.replace(/\([^)]*\)/gu, " "));
  const caption = comparableText(conflict.caption_value.replace(/\([^)]*\)/gu, " "));
  if (poster && poster === caption) return true;
  if (
    context.sourceAccountRole !== "promoter" ||
    !context.venueEvidenceVerified ||
    !context.selectedVenue.trim() ||
    !context.sourceAccountName.trim()
  ) {
    return false;
  }
  const selectedVenue = comparableText(context.selectedVenue);
  const sourceName = comparableText(context.sourceAccountName);
  return (
    [poster, caption].some((value) => value === selectedVenue) &&
    [poster, caption].some((value) => value === sourceName) &&
    /\b(?:account|canonical|hint|organizer|promoter)\b/iu.test(conflict.reason)
  );
}

export function eventEvidenceConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (conflict.field === "date") return dateConflictIsBenign(conflict, context);
  if (conflict.field === "time") {
    return timesAreCompatible(conflict.poster_value, conflict.caption_value);
  }
  if (conflict.field === "title") {
    return (
      eventTitlesDifferOnlyByMinorConnectors(conflict.poster_value, conflict.caption_value) &&
      (eventTitlesDifferOnlyByMinorConnectors(context.selectedTitle, conflict.poster_value) ||
        eventTitlesDifferOnlyByMinorConnectors(context.selectedTitle, conflict.caption_value) ||
        comparableText(context.selectedTitle) === comparableText(conflict.poster_value) ||
        comparableText(context.selectedTitle) === comparableText(conflict.caption_value))
    );
  }
  if (conflict.field === "artists") {
    return artistConflictIsBenign(conflict, context.artists);
  }
  if (conflict.field === "venue") return venueConflictIsBenign(conflict, context);
  return false;
}

export function partitionEventEvidenceSourceConflicts(
  conflicts: EventEvidenceSourceConflict[],
  context: EventEvidenceConflictContext,
): { material: EventEvidenceSourceConflict[]; benign: EventEvidenceSourceConflict[] } {
  const material: EventEvidenceSourceConflict[] = [];
  const benign: EventEvidenceSourceConflict[] = [];
  for (const conflict of conflicts) {
    (eventEvidenceConflictIsBenign(conflict, context) ? benign : material).push(conflict);
  }
  return { material, benign };
}

export function eventEvidenceTextContainsIdentity(text: string, identity: string): boolean {
  return textContainsIdentity(text, identity);
}
