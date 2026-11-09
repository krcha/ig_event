import { normalizeEventTime } from "./event-time.ts";

export type EventEvidenceSourceConflict = {
  field: string;
  poster_value: string;
  caption_value: string;
  reason: string;
};

export type EventEvidenceConflictContext = {
  artists: string[];
  selectedTime?: string;
  timeEvidenceVerified?: boolean;
  occurrenceSourceText?: string;
  sourcePosterTexts?: string[];
  sourceScheduleRows?: string[];
  sourceWideScheduleConflicts?: boolean;
  dateEvidenceVerified: boolean;
  identityEvidenceVerified?: boolean;
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

const ARTIST_HANDLE = /^@[\p{L}\p{N}._-]+$/u;
const ARTIST_HANDLE_PAIR = /^(.+?)\s*\((@[\p{L}\p{N}._-]+)\)$/u;

function textContainsIdentity(text: string, identity: string): boolean {
  const textComparable = comparableText(text);
  const identityComparable = comparableText(identity);
  return Boolean(
    textComparable &&
      identityComparable &&
      ` ${textComparable} `.includes(` ${identityComparable} `),
  );
}

function verifiedArtistAlias(
  name: string,
  handle: string,
  context: EventEvidenceConflictContext,
): boolean {
  if (!name || name.includes("@") || !ARTIST_HANDLE.test(handle) ||
      !context.dateEvidenceVerified || context.identityEvidenceVerified !== true) return false;
  const sources = scopedConflictSources(context);
  if (!sources) return false;
  const display = comparableText(name);
  const tag = comparableText(handle);
  return sources.some((source) => source.split(/\n/u).some((line) => {
    return [...line.matchAll(/\(\s*(@[\p{L}\p{N}._-]+)\s*\)/gu)].some((match) =>
      comparableText(match[1]) === tag && ` ${comparableText(line.slice(0, match.index))} `.endsWith(` ${display} `));
  })) || (eventArtistHandleAliasMatches(name, handle) &&
    ((textContainsIdentity(sources[0], name) && textContainsIdentity(sources[1], handle)) ||
      (textContainsIdentity(sources[1], name) && textContainsIdentity(sources[0], handle))));
}

export function combineEventArtistHandleAliases(
  artists: string[],
  conflicts: EventEvidenceSourceConflict[],
  context: EventEvidenceConflictContext,
): string[] {
  const pairs = artists.flatMap((artist) => {
    const pair = ARTIST_HANDLE_PAIR.exec(artist);
    return pair ? [{ name: pair[1], handle: pair[2] }] : [];
  });
  const handles = artists.filter((artist) => ARTIST_HANDLE.test(artist));
  for (const name of artists.filter((artist) => !artist.includes("@"))) {
    for (const handle of handles) pairs.push({ name, handle });
  }
  for (const conflict of conflicts) {
    if (conflict.field !== "artists") continue;
    const poster = conflict.poster_value.trim();
    const caption = conflict.caption_value.trim();
    const [name, handle] = ARTIST_HANDLE.test(poster) ? [caption, poster] : [poster, caption];
    if (artists.some((artist) => [name, handle].some((part) => comparableText(part) === comparableText(artist)))) {
      pairs.push({ name, handle });
    }
  }
  const result = artists.slice();
  for (const { name, handle } of pairs) {
    if (!verifiedArtistAlias(name, handle, context)) continue;
    const aliases = [name, handle, `${name} (${handle})`].map(comparableText);
    const index = result.findIndex((artist) => aliases.includes(comparableText(artist)));
    if (index < 0) continue;
    result.splice(index, 1, `${name} (${handle})`);
    for (let position = result.length - 1; position > index; position -= 1) {
      if (aliases.includes(comparableText(result[position]))) result.splice(position, 1);
    }
  }
  return result;
}

function artistConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (comparableText(conflict.poster_value) === comparableText(conflict.caption_value)) {
    return true;
  }
  const poster = conflict.poster_value.trim();
  const caption = conflict.caption_value.trim();
  const [name, handle] = ARTIST_HANDLE.test(poster) ? [caption, poster] : [poster, caption];
  if (verifiedArtistAlias(name, handle, context)) {
    return context.artists.some((artist) =>
      [name, handle, `${name} (${handle})`].some((alias) => comparableText(artist) === comparableText(alias)));
  }
  if (!conflictExplicitlyIdentifiesArtistHandleAlias(conflict)) return false;
  return context.artists.some(
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
  for (const match of String(value ?? "").replace(/\b\d{4}-\d{2}-\d{2}\b/gu, " ").matchAll(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\s*[./-]\s*(\d{2,4}))?\.?/gu)) {
    let year = match[3] ?? resolvedYear;
    if (!year) continue;
    if (year.length === 2) year = `20${year}`;
    const parsed = new Date(Date.UTC(Number(year), Number(match[2]) - 1, Number(match[1])));
    if (parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() === Number(match[2]) - 1 && parsed.getUTCDate() === Number(match[1])) {
      matches.add(`${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`);
    }
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
    } else {
      matches.add("invalid_explicit_date");
    }
  }
  return [...matches];
}

function textNamesResolvedDate(value: string, resolvedDate: string): boolean {
  if (!resolvedDate) return false;
  const dates = explicitDatesMentioned(value, resolvedDate);
  if (dates.length > 0) return dates.every((date) => date === resolvedDate);
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

export function cinemaReleaseDateIsSeparateFromProgramDate(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (
    !context.dateEvidenceVerified ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(context.resolvedDate) ||
    !/\b(?:u bioskopima|in cinemas|cinema release|theatrical release)\b/iu.test(
      comparableText(conflict.reason),
    ) ||
    (context.identityEvidenceVerified !== false &&
      !textContainsIdentity(context.sourceCaption, context.selectedTitle))
  ) {
    return false;
  }

  const releaseDates = explicitDatesMentioned(
    conflict.poster_value,
    context.resolvedDate,
  );
  if (
    releaseDates.length !== 1 ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDates[0] ?? "") ||
    releaseDates[0] === context.resolvedDate ||
    !textContainsIdentity(conflict.reason, conflict.poster_value)
  ) {
    return false;
  }

  const caption = comparableText(context.sourceCaption);
  const captionClaim = comparableText(conflict.caption_value);
  if (
    !captionClaim ||
    !` ${caption} `.includes(` ${captionClaim} `) ||
    !/\b(?:filmski program|film program|cinema program|cinema schedule|screening schedule|repertoar)\b/u.test(caption)
  ) {
    return false;
  }

  const range = /\b(\d{1,2})\s*[–—-]\s*(\d{1,2})\.?\s+([\p{L}]+)\b/iu.exec(
    conflict.caption_value,
  );
  if (!range) return false;
  const month = MONTH_NUMBER_BY_NAME.get(comparableText(range[3]));
  const startDay = Number(range[1]);
  const endDay = Number(range[2]);
  const selectedMonth = Number(context.resolvedDate.slice(5, 7));
  const selectedDay = Number(context.resolvedDate.slice(8, 10));
  return Boolean(
    month &&
    month === selectedMonth &&
    startDay >= 1 &&
    startDay <= selectedDay &&
    selectedDay <= endDay &&
    endDay <= 31,
  );
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
  if (cinemaReleaseDateIsSeparateFromProgramDate(conflict, context)) {
    return true;
  }
  if (sourceDateConflictBelongsToSiblingRow(conflict, context) ||
      exhibitionOpeningAndViewingDatesAreSeparate(conflict, context)) return true;
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

/** A program-month caption is context for a sibling's malformed row, not a competing date for this row. */
export function sourceDateConflictBelongsToSiblingRow(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  const row = context.occurrenceSourceText?.trim() ?? "";
  const rows = context.sourceScheduleRows ?? [];
  if (conflict.field !== "date" || context.singleOccurrenceSource || !context.sourceWideScheduleConflicts ||
      !context.dateEvidenceVerified || context.identityEvidenceVerified !== true ||
      !row || !rows.includes(row) || !textContainsIdentity(row, context.selectedTitle)) return false;
  const month = MONTH_NUMBER_BY_NAME.get(comparableText(conflict.caption_value));
  const claimedDates = explicitDatesMentioned(conflict.poster_value, context.resolvedDate);
  const rowDates = explicitDatesMentioned(row, context.resolvedDate);
  return month === Number(context.resolvedDate.slice(5, 7)) &&
    textContainsIdentity(context.sourceCaption, conflict.caption_value) &&
    claimedDates.length === 1 && claimedDates[0] !== context.resolvedDate &&
    rowDates.length === 1 && rowDates[0] === context.resolvedDate &&
    rows.some((sibling) => sibling !== row &&
      explicitDatesMentioned(sibling, context.resolvedDate).includes(claimedDates[0]));
}

function exhibitionRange(value: string, resolvedDate: string): { start: string; end: string } | null {
  const range = /\b(\d{1,2})\.?\s*(?:[–—-]|do|to)\s*(\d{1,2})\.?\s+([\p{L}]+)(?:\s+(\d{4}))?/iu.exec(value);
  if (!range) return null;
  const month = MONTH_NUMBER_BY_NAME.get(comparableText(range[3]));
  const year = range[4] ?? resolvedDate.slice(0, 4);
  if (!month || !/^\d{4}$/u.test(year)) return null;
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const start = `${prefix}-${range[1].padStart(2, "0")}`;
  const end = `${prefix}-${range[2].padStart(2, "0")}`;
  if (start > end || [start, end].some((value) => {
    const date = new Date(`${value}T12:00Z`);
    return !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value;
  })) return null;
  return { start, end };
}

function exhibitionOpeningAndViewingDatesAreSeparate(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (context.identityEvidenceVerified !== true || !context.venueEvidenceVerified ||
      !textContainsIdentity(context.sourceCaption, context.selectedTitle)) return false;
  const posterRange = exhibitionRange(conflict.poster_value, context.resolvedDate);
  const captionRange = exhibitionRange(conflict.caption_value, context.resolvedDate);
  if (!posterRange || !captionRange || posterRange.end !== captionRange.end ||
      Date.parse(posterRange.start) - Date.parse(captionRange.start) !== 86_400_000) return false;
  const viewing = /\b(?:izlozba traje|trajanje izlozbe|exhibition dates|exhibition runs|open to visitors|on view)\b/u;
  const opening = /\b(?:svecano otvaranje|otvaranje izlozbe|vernissage|exhibition opening|opening reception)\b/u;
  const captionLines = context.sourceCaption.split(/\n/u).filter((line) => line.trim());
  const openingIndex = captionLines.findIndex((line) => opening.test(comparableText(line)));
  if (openingIndex < 0 || !explicitDatesMentioned(
    captionLines.slice(openingIndex, openingIndex + 2).join("\n"), context.resolvedDate,
  ).includes(captionRange.start)) return false;
  const matchesViewing = (text: string, expected: typeof posterRange) => {
    const range = exhibitionRange(text, context.resolvedDate);
    return viewing.test(comparableText(text)) && range?.start === expected.start && range.end === expected.end;
  };
  const posterTexts = [...(context.sourcePosterTexts ?? []), ...(context.sourceScheduleRows ?? [])];
  if (!captionLines.some((line) => matchesViewing(line, captionRange)) ||
      !posterTexts.some((line) => matchesViewing(line, posterRange))) return false;
  const row = context.occurrenceSourceText ?? "";
  if (context.resolvedDate === captionRange.start) {
    return textContainsIdentity(row, context.selectedTitle) && textNamesResolvedDate(row, context.resolvedDate);
  }
  return context.resolvedDate >= posterRange.start && context.resolvedDate <= posterRange.end &&
    matchesViewing(row, posterRange) && /\b(?:svakog dana|every day|daily)\b/u.test(comparableText(row));
}

function venueConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  const poster = comparableText(conflict.poster_value.replace(/\([^)]*\)/gu, " "));
  const caption = comparableText(conflict.caption_value.replace(/\([^)]*\)/gu, " "));
  if (poster && poster === caption) return true;
  if (ticketOutletIsSeparateFromVenue(conflict, context)) return true;
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

export function scopedConflictSources(context: EventEvidenceConflictContext): [string, string] | null {
  const poster = context.sourcePosterTexts?.join("\n") ?? "";
  if (!poster) return null;
  if (context.singleOccurrenceSource) return [poster, context.sourceCaption];
  const row = context.occurrenceSourceText?.trim() ?? "";
  if (!row || !context.sourceCaption.includes(row) ||
      !textContainsIdentity(row, context.selectedTitle) || !textNamesResolvedDate(row, context.resolvedDate) ||
      !textContainsIdentity(poster, context.selectedTitle) || !textNamesResolvedDate(poster, context.resolvedDate)) return null;
  return [poster, row];
}

function ticketOutletIsSeparateFromVenue(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (!context.dateEvidenceVerified || context.identityEvidenceVerified !== true || !context.venueEvidenceVerified) return false;
  const sources = scopedConflictSources(context);
  if (!sources) return false;
  const values = [conflict.poster_value, conflict.caption_value];
  return values.some((venue, index) => {
    const outlet = values[1 - index];
    if (comparableText(venue) !== comparableText(context.selectedVenue) ||
        !textContainsIdentity(sources[index], venue) || !outlet.trim()) return false;
    const outletName = comparableText(outlet);
    const outletClauses = sources[1 - index].split(/[\n;|!?]|\.(?=\s)/u)
      .filter((clause) => textContainsIdentity(clause, outlet) ||
        (/^[a-z]{3,}$/u.test(outletName) && ["u", "a", "om", "em"].some((suffix) =>
          textContainsIdentity(clause, `u ${outletName}${suffix}`))));
    return outletClauses.length > 0 && outletClauses.every((clause) => {
      const normalized = comparableText(clause);
      return /\b(?:ulaznic\p{L}*|karte|karata|tickets?|box office|biletarnic\p{L}*)\b/u.test(normalized) &&
        /\b(?:prodaj\p{L}*|kup\p{L}*|preuz\p{L}*|dostupn\p{L}*|rezerv\p{L}*|sold|buy|purchase|pick up|available|at|u|kod)\b/u.test(normalized) &&
        !/\b(?:odrzava|lokacija|venue|takes place|perform\p{L}*)\b/u.test(normalized);
    });
  });
}

type ClockRole = "doors" | "performance" | "arrival" | "other" | "unlabelled";
type SourceClock = { clock: string; role: ClockRole; quote: string };

function clockRole(text: string): ClockRole {
  const normalized = comparableText(text);
  if (/(?:^| )(?:doors?|vrata|ulaz od|двери|врата)(?= |$)/u.test(normalized)) return "doors";
  if (/(?:^| )(?:ends?|closing|curfew|until|soundcheck|setup|kraj|zavrsetak|do|zatvaranje|tonska proba|до)(?= |$)/u.test(normalized)) return "other";
  if (/(?:^| )(?:starts?|begins?|pocetak|pocinje|pocinju|krece|krecu|startuje|почетак|почиње|почињу|креће|крећу)(?= |$)/u.test(normalized)) return "performance";
  if (/(?:^| )(?:od|from|arrival|okupljanje|од)(?= |$)/u.test(normalized)) return "arrival";
  return "unlabelled";
}

function sourceClocks(text: string, allowBareDottedTime = false): SourceClock[] {
  return text.split(/[\n;|/,]|\.(?=\s)/u).flatMap((clause) => {
    const matches = [...clause.matchAll(/\b([01]?\d|2[0-3])(?:(?:([:.])([0-5]\d)(?![\d.:])|(?=\s*(?:am|pm)\b))\s*(am|pm)?|\s*(?:h(?:ours?|rs?)?\b|ч(?=\P{L}|$)))/giu)];
    return matches.flatMap((match, index) => {
      const start = index === 0 ? 0 : matches[index - 1]!.index + matches[index - 1]![0].length;
      const roleText = clause.slice(start, index === 0 && matches.length === 1 ? undefined : match.index);
      const role = clockRole(roleText);
      if (match[2] === "." && !allowBareDottedTime && role === "unlabelled" &&
          !/(?:^|\s)(?:u|at|в|у)\s*$/iu.test(clause.slice(start, match.index))) return [];
      const suffix = match[4]?.toLowerCase();
      const hours = Number(match[1]);
      if (suffix && (hours === 0 || hours > 12)) return [];
      const normalizedHours = suffix ? hours % 12 + (suffix === "pm" ? 12 : 0) : hours;
      const clock = `${String(normalizedHours).padStart(2, "0")}:${match[3] ?? "00"}`;
      return [{ clock, role, quote: match[0].trim() }];
    });
  });
}

function singleConflictClock(value: string): string | null {
  const clocks = sourceClocks(value, true);
  return clocks.length === 1 ? clocks[0]!.clock : null;
}

function scopedClocksDescribeDistinctSessions(sources: [string, string]): boolean {
  const separatelyBilledSession = /(?:^| )(first|second|third|early|late|prvi|prva|drugi|druga|treci|treca|први|прва|други|друга|трећи|трећа) (?:screening|show(?:time)?|performance|session|projekcij\p{L}*|predstav\p{L}*|izvodjenj\p{L}*|termin\p{L}*|пројекциј\p{L}*|представ\p{L}*|извођењ\p{L}*|термин\p{L}*)(?= |$)/gu;
  const roomPattern = /(?<![\p{L}\p{N}])((?:main|black|red|blue|small|large)\s+(?:room|hall|stage)|(?:mala|velika)\s+sala|(?:мала|велика)\s+сала|(?:room|hall|stage|sala|bina|сала|бина)\s+(?:(?:broj|number|број)\s+)?\d+(?![\d:.]))(?![\p{L}\p{N}])/giu;
  const [posterSessions, captionSessions] = sources.map((source) =>
    [...new Set([...comparableText(source).matchAll(separatelyBilledSession)].map((match) => match[1]))]);
  if (posterSessions.length + captionSessions.length > 0 &&
      (posterSessions.length !== 1 || captionSessions.length !== 1 || posterSessions[0] !== captionSessions[0])) return true;
  const [posterRooms, captionRooms] = sources.map((source) =>
    [...new Set([...source.matchAll(roomPattern)].map((match) => comparableText(match[1])))]);
  return posterRooms.length === 1 && captionRooms.length === 1 && posterRooms[0] !== captionRooms[0];
}

export function doorsAndPerformanceTimesAreSeparate(conflict: EventEvidenceSourceConflict, context: EventEvidenceConflictContext): boolean {
  if (conflict.field !== "time" || !context.timeEvidenceVerified || context.identityEvidenceVerified !== true ||
      !context.dateEvidenceVerified || !context.venueEvidenceVerified || !context.selectedTime) return false;
  const sources = scopedConflictSources(context);
  if (!sources) return false;
  const selected = normalizeEventTime(context.selectedTime);
  if (!selected.startLabel || selected.endLabel) return false;
  const start = selected.startLabel;
  const claims = [conflict.poster_value, conflict.caption_value];
  return claims.some((value, index) => {
    if (singleConflictClock(value) !== start) return false;
    const doorsClaims = sourceClocks(claims[1 - index], true);
    const alternate = doorsClaims.filter((fact) => fact.clock !== start);
    if (alternate.length !== 1 || alternate[0]!.clock >= start ||
        doorsClaims.some((fact) => fact.clock === start && fact.role !== "performance")) return false;
    const doors = alternate[0]!.clock;
    const startSource = sourceClocks(sources[index]);
    const doorsSource = sourceClocks(sources[1 - index]);
    const statesPerformance = (clocks: typeof startSource) => clocks.some((fact) => fact.clock === start && fact.role === "performance");
    const explicitStart = statesPerformance(startSource);
    const corroboratedStart = statesPerformance(doorsSource) && startSource.some((fact) => fact.clock === start && fact.role === "unlabelled");
    const doorsFacts = doorsSource.filter((fact) => fact.clock === doors);
    return (explicitStart || corroboratedStart) && doorsFacts.length > 0 && doorsFacts.every((fact) =>
      fact.role === "doors" || (fact.role === "arrival" && statesPerformance(doorsSource)));
  });
}

export function selectEarlierConflictingStartTime(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): { time: string; source: "poster" | "caption"; evidenceText: string } | null {
  if (conflict.field !== "time" || !context.dateEvidenceVerified ||
      context.identityEvidenceVerified !== true || !context.venueEvidenceVerified) return null;
  const sources = scopedConflictSources(context);
  if (!sources || scopedClocksDescribeDistinctSessions(sources)) return null;
  const poster = singleConflictClock(conflict.poster_value);
  const caption = singleConflictClock(conflict.caption_value);
  if (!poster || !caption) return null;
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const distance = Math.abs(minutes(poster) - minutes(caption));
  if (distance === 0 || distance > 180) return null;
  const claims = [conflict.poster_value, conflict.caption_value];
  const comparableClocks = sources.every((source, index) => {
    if (/\b(?:UTC|GMT|CEST|CET|time zone|sledeceg dana|next day|posle ponoci|after midnight)\b/iu.test(comparableText(source))) return false;
    const clock = index === 0 ? poster : caption;
    const clocks = sourceClocks(source);
    const isStart = (role: ClockRole) => role === "performance" || role === "arrival" || role === "unlabelled";
    const candidate = clocks.filter((fact) => fact.clock === clock);
    return isStart(clockRole(claims[index])) && candidate.length > 0 &&
      candidate.every((fact) => isStart(fact.role)) &&
      !clocks.some((fact) => fact.clock !== clock && isStart(fact.role));
  });
  if (!comparableClocks) return null;
  const index = poster < caption ? 0 : 1;
  const time = index === 0 ? poster : caption;
  const earlier = sourceClocks(sources[index]).find((fact) => fact.clock === time);
  return earlier ? { time, source: index === 0 ? "poster" : "caption", evidenceText: earlier.quote } : null;
}

export function eventEvidenceConflictIsBenign(
  conflict: EventEvidenceSourceConflict,
  context: EventEvidenceConflictContext,
): boolean {
  if (conflict.field === "date") return dateConflictIsBenign(conflict, context);
  if (conflict.field === "time") {
    return timesAreCompatible(conflict.poster_value, conflict.caption_value) || doorsAndPerformanceTimesAreSeparate(conflict, context);
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
    return artistConflictIsBenign(conflict, context);
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
