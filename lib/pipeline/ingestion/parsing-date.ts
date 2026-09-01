import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import type { DateCandidate, DateConfidence, DateNormalization, DateSource, RelativeDayOffsetMatch, RelativeWeekdayMatch, RelativeWeekdayQualifier } from "@/lib/pipeline/ingestion/contracts";
import { DATE_MONTH_WORD_PATTERN } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { parsePostedAt } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString } from "@/lib/pipeline/ingestion/values";


export const MAX_EVENT_DAYS_AHEAD = 90;

export const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};


export const MONTH_ALIASES: Record<string, number> = {
  ...MONTHS,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  januar: 1,
  januara: 1,
  februar: 2,
  februara: 2,
  mart: 3,
  marta: 3,
  aprila: 4,
  maj: 5,
  maja: 5,
  jun: 6,
  juna: 6,
  jul: 7,
  jula: 7,
  avg: 8,
  avgust: 8,
  avgusta: 8,
  septembar: 9,
  septembra: 9,
  okt: 10,
  oktobar: 10,
  oktobra: 10,
  novembar: 11,
  novembra: 11,
  decembar: 12,
  decembra: 12,
  јануар: 1,
  јануара: 1,
  фебруар: 2,
  фебруара: 2,
  март: 3,
  марта: 3,
  април: 4,
  априла: 4,
  мај: 5,
  маја: 5,
  јун: 6,
  јуна: 6,
  јул: 7,
  јула: 7,
  август: 8,
  августа: 8,
  септембар: 9,
  септембра: 9,
  октобар: 10,
  октобра: 10,
  новембар: 11,
  новембра: 11,
  децембар: 12,
  децембра: 12,
};

export const RELATIVE_WEEKDAY_ALIASES: Array<{ aliases: string[]; weekday: number }> = [
  {
    aliases: ["monday", "mon", "ponedeljak", "ponedeljka", "pon", "понедељак", "понедељка", "пон"],
    weekday: 1,
  },
  {
    aliases: ["tuesday", "tue", "utorak", "utorka", "uto", "уторак", "уторка", "уто"],
    weekday: 2,
  },
  {
    aliases: ["wednesday", "wed", "sreda", "sredu", "srede", "sre", "среда", "среду", "среде", "сре"],
    weekday: 3,
  },
  {
    aliases: ["thursday", "thu", "cetvrtak", "četvrtak", "cetvrtka", "četvrtka", "cet", "čet", "четвртак", "четвртка", "чет"],
    weekday: 4,
  },
  {
    aliases: ["friday", "fri", "petak", "petka", "pet", "петак", "петка", "пет"],
    weekday: 5,
  },
  {
    aliases: ["saturday", "sat", "subota", "subotu", "subote", "sub", "субота", "суботу", "суботе", "суб"],
    weekday: 6,
  },
  {
    aliases: ["sunday", "sun", "nedelja", "nedjelja", "nedelju", "nedjelju", "ned", "недеља", "недељу", "нед"],
    weekday: 0,
  },
];

export const RELATIVE_DAY_OFFSET_ALIASES: Array<{ aliases: string[]; offsetDays: number }> = [
  {
    aliases: ["today", "danas", "данас", "tonight", "veceras", "večeras", "вечерас"],
    offsetDays: 0,
  },
  {
    aliases: ["tomorrow", "sutra", "сутра"],
    offsetDays: 1,
  },
  {
    aliases: ["day after tomorrow", "prekosutra", "prekosjutra", "прекосутра"],
    offsetDays: 2,
  },
];

export const MAX_DATE_DISTANCE_DAYS = 180;


export const DEFAULT_EVENT_TIMEZONE = "Europe/Belgrade";

export function normalizeIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

export function getConfiguredEventTimezone(): string {
  const configured = normalizeString(process.env.EVENTS_TIMEZONE);
  return configured || DEFAULT_EVENT_TIMEZONE;
}

export function getIsoDateInTimeZone(timeZone: string, now = new Date(Date.now())): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return now.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

export function getEventDateFilterContext(now = new Date(Date.now())): {
  todayIsoDate: string;
  maxFutureIsoDate: string;
  maxDaysAhead: number;
  timeZone: string;
} {
  const maxFutureDate = new Date(
    now.getTime() + MAX_EVENT_DAYS_AHEAD * 24 * 60 * 60 * 1000,
  );
  const timeZone = getConfiguredEventTimezone();
  try {
    return {
      todayIsoDate: getIsoDateInTimeZone(timeZone, now),
      maxFutureIsoDate: getIsoDateInTimeZone(timeZone, maxFutureDate),
      maxDaysAhead: MAX_EVENT_DAYS_AHEAD,
      timeZone,
    };
  } catch {
    return {
      todayIsoDate: now.toISOString().slice(0, 10),
      maxFutureIsoDate: maxFutureDate.toISOString().slice(0, 10),
      maxDaysAhead: MAX_EVENT_DAYS_AHEAD,
      timeZone: "UTC",
    };
  }
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
}

export function getSuspiciousYearDifference(
  parsedYear: number,
  postDate: Date | null,
): { isSuspicious: boolean; yearDistanceFromPost: number | null } {
  if (!postDate) {
    return { isSuspicious: false, yearDistanceFromPost: null };
  }
  const yearDistanceFromPost = Math.abs(parsedYear - postDate.getUTCFullYear());
  return { isSuspicious: yearDistanceFromPost >= 2, yearDistanceFromPost };
}

export function normalizeYear(rawYear: string): number {
  if (rawYear.length === 2) {
    return 2000 + Number.parseInt(rawYear, 10);
  }
  return Number.parseInt(rawYear, 10);
}

export function buildDateWithPossibleYearInference(
  day: number,
  month: number,
  rawYear: string | undefined,
  postDate: Date | null,
  isAmbiguousNumeric: boolean,
  source: DateSource,
  raw: string,
): DateCandidate | null {
  if (rawYear) {
    const year = normalizeYear(rawYear);
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      return null;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    return {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "medium" : "high",
      distanceFromPostDays: postDate ? daysBetween(parsed, postDate) : null,
      inferredYear: false,
      year,
      rawYearProvided: true,
      raw,
    };
  }

  if (!postDate) {
    return null;
  }

  const candidateYears = [postDate.getUTCFullYear() - 1, postDate.getUTCFullYear(), postDate.getUTCFullYear() + 1];
  let bestCandidate: DateCandidate | null = null;

  for (const year of candidateYears) {
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      continue;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    const candidate: DateCandidate = {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "low" : "medium",
      distanceFromPostDays: daysBetween(parsed, postDate),
      inferredYear: true,
      year,
      rawYearProvided: false,
      raw,
    };
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    if (
      (candidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY) <
      (bestCandidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY)
    ) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

export function getMonthNumber(rawMonth: string): number | null {
  const normalizedMonth = normalizeString(rawMonth).toLowerCase();
  if (!normalizedMonth) {
    return null;
  }
  return (
    MONTH_ALIASES[normalizedMonth] ??
    MONTH_ALIASES[normalizedMonth.slice(0, 3)] ??
    null
  );
}

export function foldRelativeDateText(value: string): string {
  return normalizeString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const RELATIVE_WEEKDAY_ALIAS_PATTERN = RELATIVE_WEEKDAY_ALIASES
  .flatMap((entry) => entry.aliases)
  .map((alias) => foldRelativeDateText(alias))
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

export const RELATIVE_DAY_OFFSET_ALIAS_PATTERN = RELATIVE_DAY_OFFSET_ALIASES
  .flatMap((entry) => entry.aliases)
  .map((alias) => foldRelativeDateText(alias))
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

export const RELATIVE_TEXT_LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_])`;


export const RELATIVE_TEXT_RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_])`;

export function resolveRelativeWeekdayAlias(rawAlias: string): number | null {
  const foldedAlias = foldRelativeDateText(rawAlias);
  for (const entry of RELATIVE_WEEKDAY_ALIASES) {
    if (entry.aliases.some((alias) => foldRelativeDateText(alias) === foldedAlias)) {
      return entry.weekday;
    }
  }
  return null;
}

export function resolveRelativeDayOffsetAlias(rawAlias: string): number | null {
  const foldedAlias = foldRelativeDateText(rawAlias);
  for (const entry of RELATIVE_DAY_OFFSET_ALIASES) {
    if (entry.aliases.some((alias) => foldRelativeDateText(alias) === foldedAlias)) {
      return entry.offsetDays;
    }
  }
  return null;
}

export function dedupeRelativeWeekdayMatches(matches: RelativeWeekdayMatch[]): RelativeWeekdayMatch[] {
  const seen = new Set<string>();
  const deduped: RelativeWeekdayMatch[] = [];
  for (const match of matches) {
    const key = `${match.qualifier}:${match.weekday}:${match.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

export function dedupeRelativeDayOffsetMatches(matches: RelativeDayOffsetMatch[]): RelativeDayOffsetMatch[] {
  const seen = new Set<string>();
  const deduped: RelativeDayOffsetMatch[] = [];
  for (const match of matches) {
    const key = `${match.offsetDays}:${match.raw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

export function collectRelativeDayOffsetMatches(text: string): RelativeDayOffsetMatch[] {
  const foldedText = foldRelativeDateText(text);
  if (!foldedText) {
    return [];
  }

  const matches: RelativeDayOffsetMatch[] = [];
  const dayOffsetPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(${RELATIVE_DAY_OFFSET_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(dayOffsetPattern)) {
    const offsetDays = resolveRelativeDayOffsetAlias(match[1]);
    if (offsetDays !== null) {
      matches.push({ raw: match[0], offsetDays });
    }
  }

  return dedupeRelativeDayOffsetMatches(matches);
}

export function collectWeekdayAliasesFromText(
  foldedText: string,
  qualifier: RelativeWeekdayQualifier,
): RelativeWeekdayMatch[] {
  const matches: RelativeWeekdayMatch[] = [];
  const weekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(weekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday === null) {
      continue;
    }
    matches.push({ raw: match[0], weekday, qualifier });
  }
  return matches;
}

export function collectRelativeWeekdayMatches(text: string): RelativeWeekdayMatch[] {
  const foldedText = foldRelativeDateText(text);
  if (!foldedText) {
    return [];
  }

  const matches: RelativeWeekdayMatch[] = [];
  const thisWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:this|ovog|ovoga|ove|ovu|ovaj|овог|овога|ове|ову|овај)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(thisWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "this" });
    }
  }

  const nextWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:next|sledeci|sledece|sledeceg|sljedeci|sljedece|sljedeceg|naredne|narednog|narednu|iduce|следећи|следеће|следећег|следеце|сљедећи|сљедеће|сљедећег|сљедеце|наредне|наредног|наредну|идуће|идуце)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(nextWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "next" });
    }
  }

  const onWeekdayPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:on|u|у)\s+(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  for (const match of foldedText.matchAll(onWeekdayPattern)) {
    const weekday = resolveRelativeWeekdayAlias(match[1]);
    if (weekday !== null) {
      matches.push({ raw: match[0], weekday, qualifier: "this" });
    }
  }

  const currentWeekContextPattern = new RegExp(
    String.raw`${RELATIVE_TEXT_LEFT_BOUNDARY}(?:this\s+week|ove\s+(?:nedelje|nedjelje|sedmice)|ове\s+(?:недеље|недјеље|седмице))${RELATIVE_TEXT_RIGHT_BOUNDARY}`,
    "giu",
  );
  const textWithoutWeekContext = foldedText.replace(currentWeekContextPattern, " ");
  if (textWithoutWeekContext !== foldedText) {
    matches.push(...collectWeekdayAliasesFromText(textWithoutWeekContext, "this"));
  }

  const bareWeekdayMatches = collectWeekdayAliasesFromText(textWithoutWeekContext, "bare_list");
  if (bareWeekdayMatches.length >= 2) {
    const firstIndex = foldedText.indexOf(bareWeekdayMatches[0].raw);
    const lastIndex = foldedText.lastIndexOf(bareWeekdayMatches[bareWeekdayMatches.length - 1].raw);
    const betweenWeekdays = firstIndex >= 0 && lastIndex > firstIndex
      ? foldedText.slice(firstIndex, lastIndex)
      : "";
    const hasListSeparator = /(?:\/|,|&|\+|(?<![\p{L}\p{N}_])i(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])и(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])and(?![\p{L}\p{N}_])|\s[-–—]\s)/u.test(betweenWeekdays);
    if (hasListSeparator) {
      matches.push(...bareWeekdayMatches);
    }
  }

  const leadingBareWeekdayPattern = new RegExp(
    String.raw`^\s*(${RELATIVE_WEEKDAY_ALIAS_PATTERN})${RELATIVE_TEXT_RIGHT_BOUNDARY}\s*(?:[:|•·,;-]|$)`,
    "iu",
  );
  const leadingBareMatch = foldedText.match(leadingBareWeekdayPattern);
  if (leadingBareMatch?.[1]) {
    const weekday = resolveRelativeWeekdayAlias(leadingBareMatch[1]);
    if (weekday !== null) {
      matches.push({ raw: leadingBareMatch[0].trim(), weekday, qualifier: "bare_list" });
    }
  }

  return dedupeRelativeWeekdayMatches(matches);
}

export function parseIsoDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

export function getUtcMiddayForIsoDate(isoDate: string): Date | null {
  const parts = parseIsoDateParts(isoDate);
  if (!parts) {
    return null;
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0));
}

export function addDaysToIsoDate(isoDate: string, days: number): string | null {
  const date = getUtcMiddayForIsoDate(isoDate);
  if (!date) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDateUtc(date);
}

export function getPostIsoDateForRelativeParsing(postDate: Date): string {
  const timeZone = getConfiguredEventTimezone();
  try {
    return getIsoDateInTimeZone(timeZone, postDate);
  } catch {
    return toIsoDateUtc(postDate);
  }
}

export function buildRelativeDayOffsetCandidate(
  match: RelativeDayOffsetMatch,
  postDate: Date | null,
  source: DateSource,
): DateCandidate | null {
  if (!postDate) {
    return null;
  }

  const postIsoDate = getPostIsoDateForRelativeParsing(postDate);
  const isoDate = addDaysToIsoDate(postIsoDate, match.offsetDays);
  const parsed = isoDate ? getUtcMiddayForIsoDate(isoDate) : null;
  if (!isoDate || !parsed) {
    return null;
  }

  return {
    isoDate,
    source,
    confidence: "high",
    distanceFromPostDays: match.offsetDays,
    inferredYear: true,
    year: parsed.getUTCFullYear(),
    rawYearProvided: false,
    raw: match.raw,
    relativeDayOffset: true,
  };
}

export function buildRelativeWeekdayCandidate(
  match: RelativeWeekdayMatch,
  postDate: Date | null,
  source: DateSource,
): DateCandidate | null {
  if (!postDate) {
    return null;
  }

  const postIsoDate = getPostIsoDateForRelativeParsing(postDate);
  const postLocalDate = getUtcMiddayForIsoDate(postIsoDate);
  if (!postLocalDate) {
    return null;
  }

  let offsetDays = (match.weekday - postLocalDate.getUTCDay() + 7) % 7;
  if (match.qualifier === "next" && offsetDays === 0) {
    offsetDays = 7;
  }
  const isoDate = addDaysToIsoDate(postIsoDate, offsetDays);
  const parsed = isoDate ? getUtcMiddayForIsoDate(isoDate) : null;
  if (!isoDate || !parsed) {
    return null;
  }

  return {
    isoDate,
    source,
    confidence: match.qualifier === "bare_list" ? "medium" : "high",
    distanceFromPostDays: offsetDays,
    inferredYear: true,
    year: parsed.getUTCFullYear(),
    rawYearProvided: false,
    raw: match.raw,
    relativeWeekday: true,
  };
}

export function hasExplicitDateText(text: string): boolean {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return false;
  }
  if (/\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/u.test(normalizedText)) {
    return true;
  }
  if (/\b\d{1,2}[ \t]*[./-][ \t]*\d{1,2}(?:[ \t]*[./-][ \t]*\d{2,4})?\b/u.test(normalizedText)) {
    return true;
  }
  const dayMonthPattern = new RegExp(
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?(?:\.\s*|\s+)${DATE_MONTH_WORD_PATTERN}\b`,
    "iu",
  );
  const monthDayPattern = new RegExp(
    String.raw`\b${DATE_MONTH_WORD_PATTERN}\s+\d{1,2}(?:st|nd|rd|th)?\b`,
    "iu",
  );
  return dayMonthPattern.test(normalizedText) || monthDayPattern.test(normalizedText);
}

export function collectRelativeDates(
  text: string,
  postDate: Date | null,
  source: DateSource,
): string[] {
  const candidates = [
    ...collectRelativeDayOffsetMatches(text).map((match) =>
      buildRelativeDayOffsetCandidate(match, postDate, source),
    ),
    ...collectRelativeWeekdayMatches(text).map((match) =>
      buildRelativeWeekdayCandidate(match, postDate, source),
    ),
  ];
  const dates = candidates
    .map((candidate) => candidate?.isoDate ?? null)
    .filter((value): value is string => Boolean(value));
  return [...new Set(dates)].sort();
}

export function collectDateCandidates(
  text: string,
  source: DateSource,
  postDate: Date | null,
): DateCandidate[] {
  const candidates: DateCandidate[] = [];
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return candidates;
  }

  const appendCandidate = (candidate: DateCandidate | null) => {
    if (!candidate) {
      return;
    }
    candidates.push(candidate);
  };

  for (const match of normalizedText.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[3], 10),
        Number.parseInt(match[2], 10),
        match[1],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(
    /\b(\d{1,2})[ \t]*[./-][ \t]*(\d{1,2})(?:[ \t]*[./-][ \t]*(\d{2,4}))?\b/g,
  )) {
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    const rawYear = match[3];
    const dayMonthCandidate = buildDateWithPossibleYearInference(
      first,
      second,
      rawYear,
      postDate,
      first <= 12 && second <= 12,
      source,
      match[0],
    );
    if (!rawYear && dayMonthCandidate && first <= 12 && second <= 12) {
      // Serbian/European event captions use D.M. order. Keep a bare caption
      // like "11.7." strong enough to beat a model-generated off-by-one
      // normalized date, while still retaining the US-style M.D. alternative
      // below as low-confidence fallback only.
      dayMonthCandidate.confidence = "medium";
    }
    appendCandidate(dayMonthCandidate);

    if (first <= 12 && second <= 12) {
      const monthDayCandidate = buildDateWithPossibleYearInference(
        second,
        first,
        rawYear,
        postDate,
        true,
        source,
        match[0],
      );
      if (monthDayCandidate) {
        monthDayCandidate.confidence = "low";
      }
      appendCandidate(monthDayCandidate);
    }
  }

  for (const match of normalizedText.matchAll(
    new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\.\s*|\s+)(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{4}))?\b`,
      "giu",
    ),
  )) {
    const month = getMonthNumber(match[2]);
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[1], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(
    new RegExp(
      String.raw`\b(${DATE_MONTH_WORD_PATTERN})\s+(\d{1,2})(?!\s*[-–—]\s*\d{1,2}\s*h\b)(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b`,
      "giu",
    ),
  )) {
    const month = getMonthNumber(match[1]);
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[2], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of collectRelativeDayOffsetMatches(normalizedText)) {
    appendCandidate(buildRelativeDayOffsetCandidate(match, postDate, source));
  }

  for (const match of collectRelativeWeekdayMatches(normalizedText)) {
    appendCandidate(buildRelativeWeekdayCandidate(match, postDate, source));
  }

  return candidates;
}

export function normalizeEventDate(
  rawModelDate: string,
  caption: string | null,
  postedAt: string | null,
): DateNormalization {
  const postDate = parsePostedAt(postedAt);
  const candidates = [
    ...collectDateCandidates(rawModelDate, "model", postDate),
    ...collectDateCandidates(caption ?? "", "caption", postDate),
  ];

  if (candidates.length === 0) {
    return {
      isoDate: null,
      source: null,
      confidence: null,
      distanceFromPostDays: null,
      inferredYear: false,
      rawDateText: null,
      yearSelectionReason: "no_date_candidate",
      suspiciousYear: false,
      reason: "missing_date",
    };
  }

  candidates.sort((a, b) => {
    const relativeWeightA = a.relativeWeekday || a.relativeDayOffset ? 1 : 0;
    const relativeWeightB = b.relativeWeekday || b.relativeDayOffset ? 1 : 0;
    if (relativeWeightA !== relativeWeightB) {
      return relativeWeightA - relativeWeightB;
    }

    const confidenceOrder: Record<DateConfidence, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    const confidenceWeight = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
    if (confidenceWeight !== 0) {
      return confidenceWeight;
    }

    const distanceA = a.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    const distanceB = b.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }

    const sourceWeightA = a.source === "model" ? 0 : 1;
    const sourceWeightB = b.source === "model" ? 0 : 1;
    return sourceWeightA - sourceWeightB;
  });

  const selected = candidates[0];
  const yearSanity = getSuspiciousYearDifference(selected.year, postDate);
  const yearDistanceFromPost = yearSanity.yearDistanceFromPost;
  const suspiciousYear = yearSanity.isSuspicious;

  const yearSelectionReason = selected.rawYearProvided
    ? "explicit_year_from_text"
    : selected.relativeWeekday
      ? "relative_weekday_from_post_timestamp"
      : selected.relativeDayOffset
        ? "relative_day_from_post_timestamp"
        : "year_inferred_from_post_timestamp_nearest";

  if (selected.confidence === "low") {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "low_confidence",
    };
  }

  const allowLongDistanceForVeryHighConfidence =
    selected.confidence === "high" &&
    selected.rawYearProvided &&
    yearDistanceFromPost !== null &&
    yearDistanceFromPost <= 1;

  if (
    postDate &&
    selected.distanceFromPostDays !== null &&
    selected.distanceFromPostDays > MAX_DATE_DISTANCE_DAYS &&
    !allowLongDistanceForVeryHighConfidence
  ) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "implausible_date",
    };
  }

  if (suspiciousYear) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear: true,
      reason: "low_confidence",
    };
  }

  return {
    isoDate: selected.isoDate,
    source: selected.source,
    confidence: selected.confidence,
    distanceFromPostDays: selected.distanceFromPostDays,
    inferredYear: selected.inferredYear,
    rawDateText: selected.raw,
    yearSelectionReason,
    suspiciousYear,
  };
}

export function parseIsoDateUtc(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function toIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function expandDateRangeFromCandidates(
  startCandidate: DateCandidate | null,
  endCandidate: DateCandidate | null,
): string[] | null {
  if (!startCandidate || !endCandidate) {
    return null;
  }

  const start = parseIsoDateUtc(startCandidate.isoDate);
  const end = parseIsoDateUtc(endCandidate.isoDate);
  if (!start || !end) {
    return null;
  }

  const distanceDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (distanceDays < 1 || distanceDays > 31) {
    return null;
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= distanceDays; offset += 1) {
    dates.push(toIsoDateUtc(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}

export function buildDateRangeFromParts(options: {
  startDay: number;
  startMonth: number;
  endDay: number;
  endMonth: number;
  rawYear: string | undefined;
  postDate: Date | null;
  source: DateSource;
  raw: string;
}): string[] | null {
  const startCandidate = buildDateWithPossibleYearInference(
    options.startDay,
    options.startMonth,
    options.rawYear,
    options.postDate,
    false,
    options.source,
    options.raw,
  );
  const endCandidate = buildDateWithPossibleYearInference(
    options.endDay,
    options.endMonth,
    options.rawYear,
    options.postDate,
    false,
    options.source,
    options.raw,
  );

  return expandDateRangeFromCandidates(startCandidate, endCandidate);
}

export function collectExplicitDateRangeDates(
  text: string,
  postDate: Date | null,
  source: DateSource,
): string[] | null {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return null;
  }

  const crossMonthWordRangePattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{2,4}))?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})\.?\s*(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{2,4}))?`,
    "giu",
  );
  for (const match of normalizedText.matchAll(crossMonthWordRangePattern)) {
    const startMonth = getMonthNumber(match[2]);
    const endMonth = getMonthNumber(match[5]);
    const startYear = match[3];
    const endYear = match[6];
    if (
      !startMonth ||
      !endMonth ||
      (startYear && endYear && normalizeYear(startYear) !== normalizeYear(endYear))
    ) {
      continue;
    }
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth,
      endDay: Number.parseInt(match[4], 10),
      endMonth,
      rawYear: endYear ?? startYear,
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  const sharedMonthRangePattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})\.?\s+(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{2,4}))?`,
    "giu",
  );
  for (const match of normalizedText.matchAll(sharedMonthRangePattern)) {
    const month = getMonthNumber(match[3]);
    if (!month) {
      continue;
    }
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: month,
      endDay: Number.parseInt(match[2], 10),
      endMonth: month,
      rawYear: match[4],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  const sharedNumericMonthRangePattern =
    /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?/giu;
  for (const match of normalizedText.matchAll(sharedNumericMonthRangePattern)) {
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: Number.parseInt(match[3], 10),
      endDay: Number.parseInt(match[2], 10),
      endMonth: Number.parseInt(match[3], 10),
      rawYear: match[4],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  const numericRangePattern =
    /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})[./](\d{1,2})\.?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?/giu;
  for (const match of normalizedText.matchAll(numericRangePattern)) {
    const dates = buildDateRangeFromParts({
      startDay: Number.parseInt(match[1], 10),
      startMonth: Number.parseInt(match[2], 10),
      endDay: Number.parseInt(match[3], 10),
      endMonth: Number.parseInt(match[4], 10),
      rawYear: match[5],
      postDate,
      source,
      raw: match[0].trim(),
    });
    if (dates) {
      return dates;
    }
  }

  return null;
}

export function normalizeDateEvidenceForOccurrence(
  evidence: ExtractedEventData["date_evidence"],
  occurrenceDate: string | null,
  postedAt: string | null,
  preserveExplicitRelativeFlag = false,
): ExtractedEventData["date_evidence"] {
  const evidenceText = normalizeString(evidence.exact_text);
  if (!occurrenceDate || !evidenceText || !hasExplicitDateText(evidenceText)) {
    return evidence;
  }

  const independentlyResolved = normalizeEventDate(evidenceText, null, postedAt).isoDate;
  const independentlyExpandedRange = expandNormalizedDateRange(evidenceText, postedAt);
  const independentlySupportsOccurrence =
    independentlyResolved === occurrenceDate ||
    independentlyExpandedRange?.includes(occurrenceDate) === true;
  if (!independentlySupportsOccurrence) {
    return evidence;
  }

  // The raw extraction remains immutable in rawExtractionJson. This corrected
  // per-occurrence view prevents one cached range resolution (or an incorrect
  // is_relative bit on explicit "weekday, DD.MM" text) from poisoning every
  // independently verified occurrence derived from that evidence.
  return {
    ...evidence,
    is_relative: preserveExplicitRelativeFlag ? evidence.is_relative : false,
    resolved_date: occurrenceDate,
  };
}

export function expandNormalizedDateRange(
  rawModelDate: string,
  postedAt: string | null,
  caption: string | null = null,
): string[] | null {
  const normalizedRawDate = normalizeString(rawModelDate);
  const normalizedCaption = normalizeString(caption);
  const postDate = parsePostedAt(postedAt);
  const explicitModelRangeDates = collectExplicitDateRangeDates(
    normalizedRawDate,
    postDate,
    "model",
  );
  if (explicitModelRangeDates) {
    return explicitModelRangeDates;
  }

  const explicitCaptionRangeDates = collectExplicitDateRangeDates(
    normalizedCaption,
    postDate,
    "caption",
  );
  if (explicitCaptionRangeDates) {
    return explicitCaptionRangeDates;
  }

  if (normalizedRawDate && !hasExplicitDateText(normalizedRawDate)) {
    const relativeModelDates = collectRelativeDates(
      normalizedRawDate,
      postDate,
      "model",
    );
    if (relativeModelDates.length >= 2) {
      return relativeModelDates;
    }
  }

  if (normalizedCaption && !hasExplicitDateText(normalizedCaption)) {
    const relativeCaptionDates = collectRelativeDates(
      normalizedCaption,
      postDate,
      "caption",
    );
    const namedWeekdayDates = [
      ...new Set(
        collectRelativeWeekdayMatches(normalizedCaption)
          .map((match) => buildRelativeWeekdayCandidate(match, postDate, "caption")?.isoDate)
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
    if (namedWeekdayDates.length >= 2) {
      return namedWeekdayDates;
    }
    const explicitlyJoinedRelativeDays =
      /\b(?:today|tonight|danas|večeras|veceras|sutra|tomorrow)\b.{0,24}\b(?:and|i|plus|&)\b.{0,24}\b(?:today|tonight|danas|večeras|veceras|sutra|tomorrow)\b/iu.test(
        normalizedCaption,
      );
    if (explicitlyJoinedRelativeDays && relativeCaptionDates.length >= 2) {
      return relativeCaptionDates;
    }
  }

  if (!normalizedRawDate) {
    return null;
  }

  const hasRangeHint =
    /\b(to|through|thru|do)\b/i.test(normalizedRawDate) ||
    /[–—]/.test(normalizedRawDate) ||
    /\s-\s/.test(normalizedRawDate);
  if (!hasRangeHint) {
    return null;
  }

  const candidates = collectDateCandidates(normalizedRawDate, "model", postDate);
  const uniqueDates = [...new Set(candidates.map((candidate) => candidate.isoDate))].sort();
  if (uniqueDates.length < 2) {
    return null;
  }

  const start = parseIsoDateUtc(uniqueDates[0]);
  const end = parseIsoDateUtc(uniqueDates[uniqueDates.length - 1]);
  if (!start || !end) {
    return null;
  }

  const distanceDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (distanceDays < 1 || distanceDays > 14) {
    return null;
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= distanceDays; offset += 1) {
    dates.push(toIsoDateUtc(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}
