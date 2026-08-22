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
  venueEvidenceVerified: boolean;
};

const MINOR_TITLE_CONNECTOR_TOKENS = new Set([
  "a",
  "an",
  "i",
  "je",
  "koja",
  "koje",
  "koji",
  "the",
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

// These are reviewed billing aliases, not a fuzzy-name heuristic. Prefix
// matching is unsafe here because unrelated artists commonly extend short
// names by one or two characters (for example ABBA/@abbath).
const REVIEWED_ARTIST_HANDLE_ALIAS_KEYS = new Set(["neni\u0000nenije"]);

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
  return REVIEWED_ARTIST_HANDLE_ALIAS_KEYS.has(
    `${displayComparable}\u0000${handleComparable}`,
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
  return [...matches];
}

function textNamesResolvedDate(value: string, resolvedDate: string): boolean {
  if (!resolvedDate) return false;
  if (explicitDatesMentioned(value, resolvedDate).includes(resolvedDate)) return true;
  const weekday = weekdayForIsoDate(resolvedDate);
  return weekday !== null && weekdaysMentioned(value).includes(weekday);
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
    textNamesResolvedDate(context.sourceCaption, context.resolvedDate)
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
