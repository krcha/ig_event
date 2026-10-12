import { findNamedWeekdays, weekdayOfIsoDate } from "@/lib/events/event-validation";
import {
  buildDateWithPossibleYearInference,
  collectDateCandidates,
  escapeRegExp,
  expandNormalizedDateRange,
  getMonthNumber,
  MONTH_ALIASES,
  normalizeEventDate,
  normalizeYear,
} from "@/lib/pipeline/ingestion/parsing-date";
import { parsePostedAt } from "@/lib/pipeline/ingestion/source-documents";

type NumericSourceDate = {
  raw: string;
  index: number;
  first: number;
  second: number;
  year?: string;
};

function numericDates(text: string): NumericSourceDate[] {
  return [...text.matchAll(/(?<![\d./-])(\d{1,2})[ \t]*[./-][ \t]*(\d{1,2})(?:[ \t]*[./-][ \t]*(\d{4}|\d{2}))?\b/gu)]
    .map((match) => ({
      raw: match[0], index: match.index, first: Number(match[1]),
      second: Number(match[2]), year: match[3],
    }));
}

function headingMonths(text: string, postDate: Date | null): Set<number> {
  // A heading such as OCTOBER26 establishes a calendar month. A dated phrase
  // such as "18 October 2026" is a row, not a poster-wide month heading.
  const words = Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length)
    .map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${words})(?:\\s*['\u2019]?\\s*(20\\d{2}|\\d{2}))?(?=$|[^\\p{L}\\p{N}])`, "giu");
  const result = new Set<number>();
  for (const line of text.split(/\r?\n/u)) {
    for (const match of line.matchAll(pattern)) {
      const prefix = line.slice(0, match.index);
      if (/\d/u.test(prefix)) continue;
      const year = match[2] ? normalizeYear(match[2]) : null;
      if (year && postDate && Math.abs(year - postDate.getUTCFullYear()) > 1) continue;
      if (!year && line.trim().toLowerCase() !== match[1].toLowerCase()) continue;
      const month = getMonthNumber(match[1]);
      if (month) result.add(month);
    }
  }
  return result;
}

/** A calendar heading is independent context, never another dated row. */
export function standaloneSourceMonthHeading(text: string): { month: number; year?: string } | null {
  const words = Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length)
    .map(escapeRegExp).join("|");
  const match = text.trim().match(new RegExp(`^(${words})(?:\\s*['\u2019]?\\s*(20\\d{2}|\\d{2}))?$`, "iu"));
  const month = match ? getMonthNumber(match[1]) : null;
  return month ? { month, ...(match?.[2] ? { year: match[2] } : {}) } : null;
}

function attachedWeekdays(text: string, rawDate: string): Set<number> {
  const weekdays = new Set<number>();
  for (const match of text.matchAll(new RegExp(escapeRegExp(rawDate), "gu"))) {
    const before = text.slice(Math.max(0, match.index - 45), match.index);
    const after = text.slice(match.index + rawDate.length, match.index + rawDate.length + 35);
    // Only a directly adjacent label describes this date. A DJ called Sunday,
    // another schedule row, or a weekday elsewhere in the caption does not.
    const prefixLabel = before.match(/([\p{L}]+)[\s,.:|\u2022\u00b7()\-/\u2013\u2014]*$/u)?.[1];
    const suffixLabel = after.match(/^[ \t,.:|\u2022\u00b7()\-/\u2013\u2014]*([\p{L}]+)/u)?.[1];
    for (const label of [prefixLabel, suffixLabel]) {
      for (const weekday of findNamedWeekdays(label)) weekdays.add(weekday);
    }
  }
  return weekdays;
}

/** Validate a source quote without trusting a model's normalized ISO date.
 * This policy applies only to new quality-version analyses; cached v2 records
 * keep their original interpretation and approval receipts.
 */
export function sourceCalendarSupportsDate(options: {
  exactText: string;
  context?: string | null;
  postedAt: string | null;
  resolvedDate: string;
  allowBareDayWithMonthHeading?: boolean;
}): boolean {
  const postDate = parsePostedAt(options.postedAt);
  const context = [options.exactText, options.context].filter(Boolean).join("\n");
  const dates = numericDates(options.exactText);
  const contextDates = numericDates(context);
  const months = headingMonths(context, postDate);
  const unambiguousMonthFirst = contextDates.some((date) => date.first <= 12 && date.second > 12);
  const unambiguousDayFirst = contextDates.some((date) => date.first > 12 && date.second <= 12);

  // A carousel row may quote only its printed day while the same retained
  // poster has a separate month heading. Do not infer a month from siblings,
  // prose, another dated row, or a model's normalized date.
  if (options.allowBareDayWithMonthHeading && /^\d{1,2}\.?$/u.test(options.exactText.trim())) {
    const headings = context.split(/\r?\n/u).map(standaloneSourceMonthHeading)
      .filter((heading): heading is NonNullable<typeof heading> => heading !== null);
    const headingYears = new Set(headings.map((heading) => heading.year ? normalizeYear(heading.year) : null)
      .filter((year): year is number => year !== null));
    if (months.size !== 1 || headingYears.size > 1 || (!postDate && headingYears.size === 0) ||
      (postDate && [...headingYears].some((year) => Math.abs(year - postDate.getUTCFullYear()) > 1))) return false;
    const candidate = buildDateWithPossibleYearInference(Number.parseInt(options.exactText, 10),
      [...months][0]!, headingYears.size ? String([...headingYears][0]) : undefined,
      postDate, false, "model", options.exactText);
    if (!candidate || candidate.isoDate !== options.resolvedDate) return false;
    const weekdays = attachedWeekdays(context, options.exactText.trim());
    return weekdays.size === 0 || (weekdays.size === 1 && weekdays.has(weekdayOfIsoDate(candidate.isoDate)!));
  }

  const range = expandNormalizedDateRange(options.exactText, options.postedAt);
  if (range?.includes(options.resolvedDate)) {
    for (const endpoint of [range[0], range[range.length - 1]]) {
      const day = Number(endpoint.slice(8, 10));
      const dayPattern = new RegExp(`(?<!\\d)0?${day}(?!\\d|:)`, "gu");
      for (const match of options.exactText.matchAll(dayPattern)) {
        const weekdays = attachedWeekdays(options.exactText, match[0]);
        if (weekdays.size > 1 || (weekdays.size === 1 && !weekdays.has(weekdayOfIsoDate(endpoint)!))) return false;
      }
    }
    return true;
  }

  if (dates.length > 0) {
    for (const date of dates) {
      const dayFirst = buildDateWithPossibleYearInference(date.first, date.second, date.year, postDate, false, "model", date.raw);
      const monthFirst = buildDateWithPossibleYearInference(date.second, date.first, date.year, postDate, false, "model", date.raw);
      const headingSupportsDayFirst = months.size === 1 && months.has(date.second);
      const headingSupportsMonthFirst = months.size === 1 && months.has(date.first);
      const monthFirstFormat = (!dayFirst && Boolean(monthFirst)) ||
        (unambiguousMonthFirst && !unambiguousDayFirst) ||
        (headingSupportsMonthFirst && !headingSupportsDayFirst);
      const dayFirstFormat = (!monthFirst && Boolean(dayFirst)) ||
        (unambiguousDayFirst && !unambiguousMonthFirst) ||
        (headingSupportsDayFirst && !headingSupportsMonthFirst);
      if ((unambiguousMonthFirst && unambiguousDayFirst) || (monthFirstFormat && dayFirstFormat)) continue;
      const candidate = monthFirstFormat ? monthFirst : dayFirst;
      if (!candidate || candidate.isoDate !== options.resolvedDate) continue;
      if (months.size === 1 && !months.has(Number(candidate.isoDate.slice(5, 7)))) continue;
      const weekdays = attachedWeekdays(context, date.raw);
      if (weekdays.size > 1) continue;
      if (weekdays.size === 1 && !weekdays.has(weekdayOfIsoDate(candidate.isoDate)!)) continue;
      return true;
    }
    return false;
  }

  // ISO, named-month and relative dates retain the established parser. Check
  // any weekday immediately attached to the actual source date fragment too.
  const matching = collectDateCandidates(options.exactText, "model", postDate)
    .filter((candidate) => candidate.isoDate === options.resolvedDate);
  for (const candidate of matching) {
    const weekdays = attachedWeekdays(context, candidate.raw);
    if (weekdays.size > 1) continue;
    if (weekdays.size === 1 && !weekdays.has(weekdayOfIsoDate(candidate.isoDate)!)) continue;
    return true;
  }
  return matching.length === 0 &&
    normalizeEventDate(options.exactText, null, options.postedAt).isoDate === options.resolvedDate;
}
