import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { extractEventTimeFromText } from "@/lib/events/event-time";
import { checkEventConsistency, findNamedWeekdays, sanitizeTimeAgainstDate, weekdayOfIsoDate } from "@/lib/events/event-validation";
import { buildUnnamedScheduleFallbackTitle } from "@/lib/events/unnamed-schedule-fallback";
import { normalizeExtractedArtists, normalizeExtractedDescription, toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import type { RecurringModelScheduleContext, RecurringScheduleLane, RepeatedAnnouncementContextKind, RepeatedSingleEventCaptionDisposition, SplitEventCandidate } from "@/lib/pipeline/ingestion/contracts";
import { MAX_EVENT_DAYS_AHEAD, addDaysToIsoDate, collectDateCandidates, escapeRegExp, normalizeEventDate } from "@/lib/pipeline/ingestion/parsing-date";
import { cleanSplitCaptionEntryText, extractPostAltTextEvidence, isLikelyCaptionContextTitle, stripSplitEntryDateText } from "@/lib/pipeline/ingestion/parsing-event-text";
import { buildSplitEventSourceLine, containsNonHashtagIdentity, containsNormalizedTokenSequence, extractSplitEntryTime, getSearchableTokens, hasMultipleResolvedSplitDates, identityVariantsOverlap, isHashtagOnlySourceIdentity, parseSplitCaptionEntryArtists, sanitizeSplitEventIdentity, stripSplitEntryTime } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { resolveEventTimeFromExtractionAndEvidence } from "@/lib/pipeline/ingestion/parsing-time";
import { parsePostedAt } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export const RECURRING_SCHEDULE_START_PATTERN =
  /(?:weekly|every\s+week|svake\s+(?:nedelje|sedmice)|svakog\s+tjedna|nedeljno|tjedno|недељно|еженедельно)\s*[\p{P}\p{S}]{0,3}\s*(?:(?:starting|beginning|starts?|begins?)\s*[\p{P}\p{S}]{0,3}\s*(?:(?:from|on)\s*[\p{P}\p{S}]{0,3}\s*)?|(?:from|on|od|с)\s*[\p{P}\p{S}]{0,3}\s*)((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:\d{2}|\d{4}))/iu;


export const RECURRING_SCHEDULE_START_SUSPICION_PATTERN =
  /(?:weekly|every\s+week|svake\s+(?:nedelje|sedmice)|svakog\s+tjedna|nedeljno|tjedno|недељно|еженедельно)[\s\S]{0,120}?((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:\d{2}|\d{4}))/iu;

export function hasRecurringScheduleStartSuspicion(value: string): boolean {
  return RECURRING_SCHEDULE_START_SUSPICION_PATTERN.test(normalizeString(value));
}

export function extractRecurringScheduleStartDate(value: string): string | null {
  return normalizeString(value.match(RECURRING_SCHEDULE_START_PATTERN)?.[1]) || null;
}

export function extractRecurringSegmentTimes(value: string): string[] {
  const tokens =
    value.match(
      /(?:^|[^\p{L}\p{N}_])((?:[01]?\d|2[0-3])(?::|\.)[0-5]\d|(?:[01]?\d|2[0-3])\s*(?:h|ч))(?=$|[^\p{L}\p{N}_])/giu,
    ) ?? [];
  return Array.from(
    new Set(
      tokens
        .map((token) => extractEventTimeFromText(token))
        .filter((time): time is string => Boolean(time)),
    ),
  ).sort();
}

export function extractPreservedRecurringLanes(value: string): {
  ambiguous: boolean;
  lanes: RecurringScheduleLane[];
} {
  const lanes = new Map<string, RecurringScheduleLane>();
  let ambiguous = false;
  for (const segment of value.split(/\r?\n|[;,]/u).map((item) => normalizeString(item))) {
    if (!segment) continue;
    const weekdays = findNamedWeekdays(segment);
    const times = extractRecurringSegmentTimes(segment);
    if (weekdays.length === 0 && times.length === 0) continue;
    if (weekdays.length !== 1 || times.length !== 1) {
      if (weekdays.length > 0) ambiguous = true;
      continue;
    }
    const lane = { weekday: weekdays[0]!, time: times[0]! };
    lanes.set(`${lane.weekday}|${lane.time}`, lane);
  }
  return { ambiguous, lanes: Array.from(lanes.values()) };
}

export function recurringLaneKey(lane: RecurringScheduleLane): string {
  return `${lane.weekday}|${lane.time}`;
}

export function getRecurringModelScheduleContext(
  post: InstagramScrapedPost,
  scheduleEntries: ExtractedEventData["schedule_entries"],
): RecurringModelScheduleContext | null {
  if (scheduleEntries.length === 0) {
    return null;
  }

  const sourceText = scheduleEntries
    .map((entry) => normalizeString(entry.source_text))
    .filter(Boolean)
    .join("\n");
  const rawStartDate = extractRecurringScheduleStartDate(sourceText);
  if (!rawStartDate) {
    return null;
  }

  const startIsoDate = normalizeEventDate(
    rawStartDate,
    sourceText || rawStartDate,
    post.postedAt,
  ).isoDate;
  const endIsoDate = startIsoDate
    ? addDaysToIsoDate(startIsoDate, MAX_EVENT_DAYS_AHEAD)
    : null;
  const modelLanes = scheduleEntries.map((entry) => {
    const weekdays = findNamedWeekdays(normalizeString(entry.source_text));
    const time = extractEventTimeFromText(normalizeString(entry.time));
    return weekdays.length === 1 && time
      ? { weekday: weekdays[0]!, time }
      : null;
  });
  if (!startIsoDate || !endIsoDate || modelLanes.some((lane) => lane === null)) {
    return null;
  }

  const concreteModelLanes = modelLanes as RecurringScheduleLane[];
  const modelLaneKeys = concreteModelLanes.map(recurringLaneKey);
  if (new Set(modelLaneKeys).size !== modelLaneKeys.length) {
    return null;
  }

  const independentSourceText = [post.caption, post.altText]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join("\n");
  const independentRawStartDate = extractRecurringScheduleStartDate(independentSourceText);
  const independentStartIsoDate = independentRawStartDate
    ? normalizeEventDate(
        independentRawStartDate,
        independentSourceText,
        post.postedAt,
      ).isoDate
    : null;
  const preservedPlan = extractPreservedRecurringLanes(independentSourceText);
  const preservedLaneKeys = new Set(preservedPlan.lanes.map(recurringLaneKey));
  const sourceRecurrenceSuspected = hasRecurringScheduleStartSuspicion(independentSourceText);
  const sourceStartMatches = independentStartIsoDate === startIsoDate;
  const sourcePlanCoverageRejected =
    sourceRecurrenceSuspected &&
    (!sourceStartMatches ||
      preservedPlan.ambiguous ||
      preservedLaneKeys.size !== modelLaneKeys.length);
  const sourceGroundingVerified =
    sourceStartMatches &&
    !sourcePlanCoverageRejected &&
    modelLaneKeys.every((key) => preservedLaneKeys.has(key));

  return {
    startIsoDate,
    endIsoDate,
    weekdaysByEntry: concreteModelLanes.map((lane) => lane.weekday),
    sourceGroundingVerified,
    sourcePlanCoverageRejected,
  };
}

export function listRecurringScheduleDates(
  context: RecurringModelScheduleContext,
  weekday: number,
): string[] {
  const dates: string[] = [];
  let cursor: string | null = context.startIsoDate;
  while (cursor && cursor <= context.endIsoDate) {
    if (weekdayOfIsoDate(cursor) === weekday) {
      dates.push(cursor);
    }
    cursor = addDaysToIsoDate(cursor, 1);
  }
  return dates;
}

export function extractModelSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  eventType: string,
  venue: string | null,
): SplitEventCandidate[] {
  if (extracted.schedule_entries.length === 0) {
    return [];
  }

  const entries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();
  const recurringContext = getRecurringModelScheduleContext(post, extracted.schedule_entries);
  const modelRecurringSourceText = extracted.schedule_entries
    .map((entry) => normalizeString(entry.source_text))
    .filter(Boolean)
    .join("\n");
  const recurringScheduleEvidenceText = [
    modelRecurringSourceText,
    post.caption,
    extractPostAltTextEvidence(post.altText),
  ]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join("\n");
  if (
    hasRecurringScheduleStartSuspicion(recurringScheduleEvidenceText) &&
    (!recurringContext || recurringContext.sourcePlanCoverageRejected)
  ) {
    return [];
  }

  const usesStructuredEvidence =
    normalizeString(extracted.extraction_contract_version) === "event_evidence_v2";
  for (const [scheduleEntryIndex, scheduleEntry] of extracted.schedule_entries.entries()) {
    const rawDate = normalizeString(scheduleEntry.date);
    const description = normalizeExtractedDescription(scheduleEntry.description);
    const sharedTime = !usesStructuredEvidence && extracted.shared_schedule_context.time.applies_to_all
      ? normalizeString(extracted.shared_schedule_context.time.value)
      : "";
    const rawScheduleTime = normalizeString(scheduleEntry.time) || sharedTime;
    const sharedVenue = !usesStructuredEvidence && extracted.shared_schedule_context.venue.applies_to_all
      ? normalizeString(extracted.shared_schedule_context.venue.value)
      : "";
    const scheduleVenue = normalizeString(scheduleEntry.venue) || sharedVenue;
    const rawModelTitle = cleanSplitCaptionEntryText(
      stripSplitEntryTime(scheduleEntry.title),
    );
    const explicitSourceLine = normalizeString(scheduleEntry.source_text);
    if (usesStructuredEvidence && !explicitSourceLine) {
      continue;
    }
    const sourceLine =
      explicitSourceLine ||
      buildSplitEventSourceLine([
        rawDate,
        rawModelTitle,
        rawScheduleTime,
        scheduleVenue,
        description,
      ]);
    const sourceBillingEvidence = explicitSourceLine ? [explicitSourceLine] : [];
    const identity = sanitizeSplitEventIdentity({
      rawTitle: rawModelTitle,
      rawArtists: normalizeExtractedArtists(scheduleEntry.artists),
      post,
      additionalEvidence: sourceBillingEvidence,
      artistAliasConflicts: extracted.source_conflicts,
    });
    const rawTitle = identity.title;
    const normalizedArtists = identity.artists;
    if (!rawDate) {
      continue;
    }

    const timeResolution = resolveEventTimeFromExtractionAndEvidence({
      rawDate,
      rawTime: rawScheduleTime,
      textEvidence: [
        { source: "description", text: description },
        { source: "source_caption", text: sourceLine },
      ],
    });
    const rawTime = timeResolution.rawTime;
    const baseNormalizedDate = normalizeEventDate(rawDate, sourceLine || rawDate, post.postedAt);
    const occurrenceDates = recurringContext
      ? listRecurringScheduleDates(
          recurringContext,
          recurringContext.weekdaysByEntry[scheduleEntryIndex] ?? -1,
        )
      : baseNormalizedDate.isoDate
        ? [baseNormalizedDate.isoDate]
        : [];
    const titleUsedFallback = !rawTitle && normalizedArtists.length === 0;

    for (const occurrenceDate of occurrenceDates) {
      const normalizedDate = recurringContext
        ? normalizeEventDate(occurrenceDate, occurrenceDate, post.postedAt)
        : baseNormalizedDate;
      const lineTitle =
        rawTitle ||
        normalizedArtists.join(", ") ||
        buildUnnamedScheduleFallbackTitle({
          eventType,
          venue: scheduleVenue || venue,
          isoDate: normalizedDate.isoDate,
        });
      if (!lineTitle) {
        continue;
      }
      const consistency = checkEventConsistency({
        isoDate: normalizedDate.isoDate,
        rawDateText: occurrenceDate,
        time: timeResolution.time,
        weekdayEvidence: sourceLine,
      });
      const time = consistency.sanitizedTime;
      const dedupeKey = `${normalizedDate.isoDate ?? occurrenceDate}:${toSearchableText(lineTitle)}:${time ?? ""}`;
      if (seenEntries.has(dedupeKey)) {
        continue;
      }
      seenEntries.add(dedupeKey);

      entries.push({
        rawDate: occurrenceDate,
        normalizedDate,
        lineTitle,
        artists: normalizedArtists,
        artistsWereSanitized: identity.artistsWereSanitized,
        ...(time ? { time } : {}),
        rawTime,
        venue: scheduleVenue,
        dateEvidence: scheduleEntry.date_evidence,
        timeEvidence: scheduleEntry.time_evidence,
        consistencyIssues: consistency.issues,
        ...(description ? { description } : {}),
        sourceLine,
        source: "poster_schedule",
        ...(recurringContext && !recurringContext.sourceGroundingVerified
          ? { occurrencePlanUnverified: true }
          : {}),
        ...(titleUsedFallback
          ? {
              titleSource: "unnamed_schedule_fallback" as const,
              titleUsedFallback: true,
            }
          : {}),
      });
    }
  }

  return entries;
}

export const COMBINED_SCHEDULE_WEEKDAY_TOKEN =
  "(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|ponedeljak|pon|utorak|uto|sreda|sre|cetvrtak|četvrtak|cet|čet|petak|pet|subota|sub|nedelja|nedjelja|ned)";


export const COMBINED_SCHEDULE_DATE_TOKEN =
  "(?:0?[1-9]|[12]\\d|3[01])[./-](?:0?[1-9]|1[0-2])(?:[./-](?:\\d{2}|\\d{4}))?\\.?";

export function getCombinedWeekdayDateMatches(value: string): RegExpMatchArray[] {
  const pattern = new RegExp(
    `\\b(${COMBINED_SCHEDULE_WEEKDAY_TOKEN})\\s+(${COMBINED_SCHEDULE_DATE_TOKEN})`,
    "giu",
  );
  return [...value.matchAll(pattern)];
}

export function countNumericDateAnchors(value: string): number {
  return [...value.matchAll(
    /\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])(?:[./-](?:\d{2}|\d{4}))?\.?/gu,
  )].length;
}

export function hasMalformedCombinedWeekdayDateSchedule(value: string): boolean {
  return value.split(/\r?\n/u).some((rawLine) => {
    const line = normalizeString(rawLine);
    const pairCount = getCombinedWeekdayDateMatches(line).length;
    const numericDateCount = countNumericDateAnchors(line);
    return numericDateCount >= 2 && pairCount > 0 && numericDateCount !== pairCount;
  });
}

export function extractCombinedWeekdayDateSplitEventCandidates(options: {
  post: InstagramScrapedPost;
  captionText: string;
  eventType: string;
  venue: string | null;
  source: "caption_schedule" | "alt_text_schedule";
}): SplitEventCandidate[] {
  const combinedEntries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();

  for (const rawLine of options.captionText.split(/\r?\n/u)) {
    const line = normalizeString(rawLine);
    const pairMatches = getCombinedWeekdayDateMatches(line);
    if (pairMatches.length < 2 || countNumericDateAnchors(line) !== pairMatches.length) {
      continue;
    }

    const lastMatch = pairMatches.at(-1);
    const tailStart = (lastMatch?.index ?? 0) + (lastMatch?.[0].length ?? 0);
    const sharedRawTime = extractSplitEntryTime(line.slice(tailStart));
    const lineEntries = pairMatches.map((match) => {
      const weekday = normalizeString(match[1]);
      const rawDate = normalizeString(match[2]).replace(/\.$/u, "");
      const time = sanitizeTimeAgainstDate(sharedRawTime, rawDate);
      const sourceLine = buildSplitEventSourceLine([weekday, rawDate, time]);
      const normalizedDate = normalizeEventDate(rawDate, sourceLine, options.post.postedAt);
      const consistency = checkEventConsistency({
        isoDate: normalizedDate.isoDate,
        rawDateText: rawDate,
        time,
        weekdayEvidence: sourceLine,
      });
      return {
        rawDate,
        normalizedDate,
        lineTitle: buildUnnamedScheduleFallbackTitle({
          eventType: options.eventType,
          venue: options.venue,
          isoDate: normalizedDate.isoDate,
        }),
        artists: [],
        ...(consistency.sanitizedTime ? { time: consistency.sanitizedTime } : {}),
        rawTime: sharedRawTime,
        consistencyIssues: consistency.issues,
        sourceLine,
        source: options.source,
        titleSource: "unnamed_schedule_fallback" as const,
        titleUsedFallback: true,
      };
    });
    if (!hasMultipleResolvedSplitDates(lineEntries)) {
      continue;
    }
    for (const entry of lineEntries) {
      const dedupeKey = `${entry.normalizedDate.isoDate ?? entry.rawDate}:${toSearchableText(entry.lineTitle)}:${entry.time ?? ""}`;
      if (!seenEntries.has(dedupeKey)) {
        seenEntries.add(dedupeKey);
        combinedEntries.push(entry);
      }
    }
  }

  return hasMultipleResolvedSplitDates(combinedEntries) ? combinedEntries : [];
}

export function extractCaptionSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  eventType: string,
  venue: string | null,
): SplitEventCandidate[] {
  const captionText = normalizeString(post.caption || extracted.source_caption);
  if (!captionText) {
    return [];
  }

  const combinedWeekdayEntries = extractCombinedWeekdayDateSplitEventCandidates({
    post,
    captionText,
    eventType,
    venue,
    source: "caption_schedule",
  });

  const entries: SplitEventCandidate[] = [...combinedWeekdayEntries];
  const seenEntries = new Set(
    combinedWeekdayEntries.map(
      (entry) => `${entry.normalizedDate.isoDate ?? entry.rawDate}:${toSearchableText(entry.lineTitle)}:${entry.time ?? ""}`,
    ),
  );
  const postDate = parsePostedAt(post.postedAt);
  let previousContextTitle = "";

  for (const rawLine of captionText.split(/\r?\n/)) {
    const line = normalizeString(rawLine);
    if (!line) {
      continue;
    }
    if (countNumericDateAnchors(line) >= 2) {
      continue;
    }

    const explicitScheduleMatch = line.match(
      /^(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\s*[•·|:\-–—]+\s*(.+)$/u,
    );

    const normalizedDate = explicitScheduleMatch
      ? normalizeEventDate(normalizeString(explicitScheduleMatch[1]), line, post.postedAt)
      : normalizeEventDate(line, line, post.postedAt);
    const rawDate = explicitScheduleMatch
      ? normalizeString(explicitScheduleMatch[1])
      : normalizeString(
          collectDateCandidates(line, "caption", postDate)[0]?.raw ??
            normalizedDate.rawDateText,
        );

    if (!normalizedDate.isoDate || !rawDate) {
      if (isLikelyCaptionContextTitle(line)) {
        const contextTitle = cleanSplitCaptionEntryText(line);
        if (!isHashtagOnlySourceIdentity(contextTitle, post, [line], "additional")) {
          previousContextTitle = contextTitle;
        }
      }
      continue;
    }

    const rawTime = extractSplitEntryTime(line);
    const time = sanitizeTimeAgainstDate(rawTime, rawDate);
    const rawTitle = explicitScheduleMatch
      ? explicitScheduleMatch[2] ?? ""
      : stripSplitEntryTime(stripSplitEntryDateText(line, rawDate));
    const sourceTitle = cleanSplitCaptionEntryText(stripSplitEntryTime(rawTitle));
    const sourceIdentity = sanitizeSplitEventIdentity({
      rawTitle: sourceTitle,
      rawArtists: parseSplitCaptionEntryArtists(sourceTitle),
      post,
      additionalEvidence: [line],
    });
    const guardedSourceTitle = sourceIdentity.title;
    const titleUsedFallback = !guardedSourceTitle && !previousContextTitle;
    const lineTitle =
      guardedSourceTitle ||
      previousContextTitle ||
      buildUnnamedScheduleFallbackTitle({
        eventType,
        venue,
        isoDate: normalizedDate.isoDate,
      });
    if (
      !lineTitle ||
      isScheduleHelperIdentity(lineTitle) ||
      isLikelyNarrativeScheduleIdentity(lineTitle)
    ) {
      continue;
    }

    const consistency = checkEventConsistency({
      isoDate: normalizedDate.isoDate,
      rawDateText: rawDate,
      time,
      weekdayEvidence: line,
    });

    const dedupeKey = `${normalizedDate.isoDate}:${toSearchableText(lineTitle)}:${time ?? ""}`;
    if (seenEntries.has(dedupeKey)) {
      continue;
    }
    seenEntries.add(dedupeKey);

    entries.push({
      rawDate,
      normalizedDate,
      lineTitle,
      artists: titleUsedFallback
        ? []
        : guardedSourceTitle
          ? sourceIdentity.artists
          : parseSplitCaptionEntryArtists(lineTitle),
      artistsWereSanitized: sourceIdentity.artistsWereSanitized,
      ...(consistency.sanitizedTime ? { time: consistency.sanitizedTime } : {}),
      rawTime,
      consistencyIssues: consistency.issues,
      sourceLine: line,
      source: "caption_schedule",
      ...(titleUsedFallback
        ? {
            titleSource: "unnamed_schedule_fallback" as const,
            titleUsedFallback: true,
          }
        : {}),
    });
  }

  return entries;
}

export function extractAltTextSplitEventCandidates(
  post: InstagramScrapedPost,
  eventType: string,
  venue: string | null,
): SplitEventCandidate[] {
  const altText = extractPostAltTextEvidence(post.altText);
  if (!altText) {
    return [];
  }

  const combinedWeekdayEntries = extractCombinedWeekdayDateSplitEventCandidates({
    post,
    captionText: altText,
    eventType,
    venue,
    source: "alt_text_schedule",
  });
  if (combinedWeekdayEntries.length > 1) {
    return combinedWeekdayEntries;
  }

  const compactText = altText.replace(/\s+/g, " ").trim();
  const dateMatches = [...compactText.matchAll(
    /\b(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\b/gu,
  )];
  if (dateMatches.length < 2) {
    return [];
  }

  const entries: SplitEventCandidate[] = [];
  const seenEntries = new Set<string>();

  for (const [index, match] of dateMatches.entries()) {
    const rawDate = normalizeString(match[1]);
    const startIndex = (match.index ?? 0) + match[0].length;
    const endIndex = dateMatches[index + 1]?.index ?? compactText.length;
    const rawSegment = compactText
      .slice(startIndex, endIndex)
      .replace(/^[\s•·|:\-–—]+/u, "")
      .replace(/\b\d{6,}\b.*$/u, "")
      .trim();
    const rawTime = extractSplitEntryTime(rawSegment);
    const time = sanitizeTimeAgainstDate(rawTime, rawDate);
    const rawTitle = cleanSplitCaptionEntryText(stripSplitEntryTime(rawSegment));
    if (!rawDate) {
      continue;
    }

    const sourceLine = buildSplitEventSourceLine([rawDate, rawTitle, time]);
    const normalizedDate = normalizeEventDate(rawDate, sourceLine || rawSegment, post.postedAt);
    const sourceIdentity = sanitizeSplitEventIdentity({
      rawTitle,
      rawArtists: parseSplitCaptionEntryArtists(rawTitle),
      post,
      additionalEvidence: [sourceLine],
    });
    const guardedTitle = sourceIdentity.title;
    const titleUsedFallback = !guardedTitle;
    const lineTitle =
      guardedTitle ||
      buildUnnamedScheduleFallbackTitle({
        eventType,
        venue,
        isoDate: normalizedDate.isoDate,
      });
    if (!lineTitle) {
      continue;
    }
    const consistency = checkEventConsistency({
      isoDate: normalizedDate.isoDate,
      rawDateText: rawDate,
      time,
      weekdayEvidence: sourceLine,
    });
    const dedupeKey = `${normalizedDate.isoDate ?? rawDate}:${toSearchableText(lineTitle)}:${time ?? ""}`;
    if (seenEntries.has(dedupeKey)) {
      continue;
    }
    seenEntries.add(dedupeKey);

    entries.push({
      rawDate,
      normalizedDate,
      lineTitle,
      artists: titleUsedFallback ? [] : sourceIdentity.artists,
      artistsWereSanitized: sourceIdentity.artistsWereSanitized,
      ...(consistency.sanitizedTime ? { time: consistency.sanitizedTime } : {}),
      rawTime,
      consistencyIssues: consistency.issues,
      sourceLine,
      source: "alt_text_schedule",
      ...(titleUsedFallback
        ? {
            titleSource: "unnamed_schedule_fallback" as const,
            titleUsedFallback: true,
          }
        : {}),
    });
  }

  return hasMultipleResolvedSplitDates(entries) ? entries : [];
}

export function getSplitCandidateDateKey(candidate: SplitEventCandidate): string {
  return candidate.normalizedDate.isoDate ?? toSearchableText(candidate.rawDate);
}

export function sortSplitCandidatesByDate(candidates: SplitEventCandidate[]): SplitEventCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftKey = left.candidate.normalizedDate.isoDate ?? "9999-99-99";
      const rightKey = right.candidate.normalizedDate.isoDate ?? "9999-99-99";
      const dateOrder = leftKey.localeCompare(rightKey);
      if (dateOrder !== 0) {
        return dateOrder;
      }
      const leftTime = left.candidate.time ?? "";
      const rightTime = right.candidate.time ?? "";
      return leftTime.localeCompare(rightTime) || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

export function identityAppearsAsBySuffix(longer: string, shorter: string): boolean {
  const longerTokens = getSearchableTokens(longer);
  const shorterTokens = getSearchableTokens(shorter);
  if (shorterTokens.length === 0 || longerTokens.length <= shorterTokens.length) {
    return false;
  }
  const start = longerTokens.length - shorterTokens.length;
  return longerTokens[start - 1] === "by" &&
    shorterTokens.every((token, index) => longerTokens[start + index] === token);
}

export function isHandleLikeIdentity(value: string): boolean {
  return /[@._]/u.test(value) && !/\s/u.test(value.trim());
}

export function splitIdentityValuesMatch(left: string, right: string): boolean {
  if (identityVariantsOverlap(left, right)) {
    return true;
  }
  if (
    (isHandleLikeIdentity(left) && containsNormalizedTokenSequence(right, left)) ||
    (isHandleLikeIdentity(right) && containsNormalizedTokenSequence(left, right))
  ) {
    return true;
  }
  return identityAppearsAsBySuffix(left, right) || identityAppearsAsBySuffix(right, left);
}

export function splitCandidatesShareIdentity(
  left: SplitEventCandidate,
  right: SplitEventCandidate,
): boolean {
  if (left.titleUsedFallback && right.titleUsedFallback) {
    return true;
  }
  if (left.time && right.time && left.time !== right.time) {
    return false;
  }
  if (splitIdentityValuesMatch(left.lineTitle, right.lineTitle)) {
    return true;
  }
  return left.artists.some((leftArtist) =>
    right.artists.some((rightArtist) => splitIdentityValuesMatch(leftArtist, rightArtist)),
  );
}

export function mergeEquivalentSplitCandidates(
  existing: SplitEventCandidate,
  supplemental: SplitEventCandidate,
): SplitEventCandidate {
  const artists = [...existing.artists];
  for (const artist of supplemental.artists) {
    if (!artists.some((current) => splitIdentityValuesMatch(current, artist))) {
      artists.push(artist);
    }
  }
  const artistsAdded = artists.length > existing.artists.length;
  const fillsTime = !existing.time && Boolean(supplemental.time);
  const useSupplementalEvidence = artistsAdded || fillsTime;

  return {
    ...existing,
    artists,
    artistsWereSanitized: Boolean(
      existing.artistsWereSanitized || supplemental.artistsWereSanitized,
    ),
    ...(!existing.time && supplemental.time ? { time: supplemental.time } : {}),
    rawTime:
      existing.rawTime ||
      (fillsTime ? supplemental.rawTime || supplemental.time : existing.time) ||
      "",
    consistencyIssues: [
      ...new Set([...existing.consistencyIssues, ...supplemental.consistencyIssues]),
    ],
    description: existing.description ?? supplemental.description,
    ...(useSupplementalEvidence
      ? {
          source: supplemental.source,
          sourceLine: supplemental.sourceLine,
          titleSource: existing.titleSource ?? existing.source,
        }
      : {}),
  };
}

export function isScheduleHelperIdentity(value: string): boolean {
  const normalized = toSearchableText(value);
  if (!normalized) {
    return true;
  }
  if (
    /^(?:date|datum|when|kada|day|dan|time|vreme|vrijeme|location|lokacija|venue)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/^(?:premijera|premiere|naredna igranja|next performances?)\b/iu.test(normalized)) {
    return true;
  }
  return /^(?:\d{1,2}\s*)+(?:i|and)?$/iu.test(normalized);
}

export function isLikelyNarrativeScheduleIdentity(value: string): boolean {
  const tokens = getSearchableTokens(value);
  return tokens.length >= 10 && /[.!?]/u.test(value);
}

export function reconcileSplitCandidateCoverage(
  primary: SplitEventCandidate[],
  supplemental: SplitEventCandidate[],
): SplitEventCandidate[] {
  const reconciled = [...primary];
  const fallbackTimesByDate = new Map<string, Set<string>>();
  for (const candidate of [...primary, ...supplemental]) {
    if (!candidate.titleUsedFallback || !candidate.time) {
      continue;
    }
    const dateKey = getSplitCandidateDateKey(candidate);
    if (!dateKey) {
      continue;
    }
    const times = fallbackTimesByDate.get(dateKey) ?? new Set<string>();
    times.add(candidate.time);
    fallbackTimesByDate.set(dateKey, times);
  }

  for (const candidate of supplemental) {
    const dateKey = getSplitCandidateDateKey(candidate);
    if (!dateKey) {
      continue;
    }
    const sameDateIndexes = reconciled
      .map((existing, index) => ({ existing, index }))
      .filter(({ existing }) => getSplitCandidateDateKey(existing) === dateKey)
      .map(({ index }) => index);
    if (sameDateIndexes.length > 0 && isScheduleHelperIdentity(candidate.lineTitle)) {
      continue;
    }
    if (sameDateIndexes.length === 0) {
      reconciled.push(candidate);
      continue;
    }
    if (candidate.titleUsedFallback) {
      const matchingTimeIndex = candidate.time
        ? sameDateIndexes.find((index) => reconciled[index]?.time === candidate.time)
        : undefined;
      if (matchingTimeIndex !== undefined) {
        continue;
      }
      const uniqueFallbackTimes = fallbackTimesByDate.get(dateKey) ?? new Set<string>();
      const untimedIndexes = sameDateIndexes.filter((index) => !reconciled[index]?.time);
      if (uniqueFallbackTimes.size === 1 && untimedIndexes.length === 1 && candidate.time) {
        const existingIndex = untimedIndexes[0];
        const existing = reconciled[existingIndex];
        if (existing) {
          reconciled[existingIndex] = mergeEquivalentSplitCandidates(existing, candidate);
          continue;
        }
      }
      if (candidate.time) {
        reconciled.push(candidate);
      }
      continue;
    }
    const equivalentIndex = sameDateIndexes.find((index) => {
      const existing = reconciled[index];
      return existing ? splitCandidatesShareIdentity(existing, candidate) : false;
    });
    if (equivalentIndex !== undefined) {
      const existing = reconciled[equivalentIndex];
      if (existing) {
        reconciled[equivalentIndex] = mergeEquivalentSplitCandidates(existing, candidate);
      }
      continue;
    }
    const matchingFallbackIndex = sameDateIndexes.find((index) => {
      const existing = reconciled[index];
      return Boolean(
        existing?.titleUsedFallback &&
        existing.time &&
        candidate.time &&
        existing.time === candidate.time,
      );
    });
    if (matchingFallbackIndex !== undefined) {
      const fallback = reconciled[matchingFallbackIndex];
      if (fallback) {
        reconciled[matchingFallbackIndex] = mergeEquivalentSplitCandidates(candidate, fallback);
      }
      continue;
    }
    reconciled.push(candidate);
  }

  return sortSplitCandidatesByDate(reconciled);
}

export function hasCompetingLocalBillingIdentity(
  value: string,
  canonicalIdentities: string[],
): boolean {
  const withoutClockValues = value.replace(
    /\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/gu,
    " ",
  );
  if (
    /\s(?:\||\/|[-–—])\s|:\s*\p{L}/u.test(withoutClockValues) ||
    /(?:\s(?:&|\+|×)\s|\bb2b\b|\s[xX]\s)/u.test(value)
  ) {
    return true;
  }

  const canonicalKeys = new Set(
    canonicalIdentities.map((identity) => toSearchableText(identity)).filter(Boolean),
  );
  const localBillingPattern =
    /\b(?:w\/|with|uz|sa|feat(?:uring)?|ft\.?|b2b)\s+([^,;|.!?\n]+)/giu;
  return [...value.matchAll(localBillingPattern)].some((match) => {
    const billedIdentityKey = toSearchableText(match[1] ?? "");
    return Boolean(billedIdentityKey && !canonicalKeys.has(billedIdentityKey));
  });
}

export const SAME_EVENT_ANNOUNCEMENT_PREFIXES = new Set([
  "",
  "i beogradski koncert",
  "beogradski koncert",
  "beogradski koncert britanske zvezde",
]);

export const SAME_EVENT_ANNOUNCEMENT_VENUE_FORMS: Record<
  string,
  { relocation: string; scheduledHeld: string }
> = {
  lozionica: {
    relocation: "lozionicu",
    scheduledHeld: "lozionice",
  },
};

export function classifyRepeatedAnnouncementContext(
  value: string,
  canonicalIdentities: string[],
  canonicalVenue: string,
): RepeatedAnnouncementContextKind | null {
  const searchableValue = toSearchableText(value);
  const searchableTitle = toSearchableText(canonicalIdentities[0] ?? "");
  if (!searchableTitle) {
    return null;
  }
  const paddedValue = ` ${searchableValue} `;
  const paddedTitle = ` ${searchableTitle} `;
  const titleStart = paddedValue.indexOf(paddedTitle);
  if (titleStart < 0) {
    return null;
  }
  let prefix = paddedValue.slice(0, titleStart).trim();
  let suffix = paddedValue.slice(titleStart + paddedTitle.length).trim();

  for (const identity of canonicalIdentities) {
    const searchableIdentity = toSearchableText(identity);
    if (!searchableIdentity) {
      continue;
    }
    const pattern = escapeRegExp(searchableIdentity).replace(/\s+/gu, "\\s+");
    const identityPattern = new RegExp(`\\b${pattern}\\b`, "gu");
    prefix = prefix.replace(identityPattern, " ").replace(/\s+/gu, " ").trim();
    suffix = suffix.replace(identityPattern, " ").replace(/\s+/gu, " ").trim();
  }
  if (!SAME_EVENT_ANNOUNCEMENT_PREFIXES.has(prefix)) {
    return null;
  }

  const venueForms =
    SAME_EVENT_ANNOUNCEMENT_VENUE_FORMS[toSearchableText(canonicalVenue)];
  if (!venueForms) {
    return null;
  }
  const serbianMonth =
    "(?:januara|februara|marta|aprila|maja|juna|jula|avgusta|septembra|oktobra|novembra|decembra)";
  const serbianWeekday =
    "(?:ponedeljak|ponedeljka|utorak|utorka|sreda|sredu|cetvrtak|cetvrtka|petak|petka|subota|subotu|nedelja|nedelju)";
  const dateClause = `\\d{1,2} ${serbianMonth}`;
  const relocationPattern = new RegExp(
    `^${dateClause} (?:seli se|premesta se|prebacuje se) u ${escapeRegExp(venueForms.relocation)}$`,
    "u",
  );
  if (relocationPattern.test(suffix)) {
    return "relocation";
  }
  const scheduledHeldPattern = new RegExp(
    `^(?:prvobitno )?zakazan(?:a|o)? za (?:${serbianWeekday} )?${dateClause} (?:bice odrzan(?:a|o)?|odrzace se) u prostoru ${escapeRegExp(venueForms.scheduledHeld)}$`,
    "u",
  );
  return scheduledHeldPattern.test(suffix) ? "scheduled_held" : null;
}

export function classifyRepeatedSingleEventCaptionCandidates(options: {
  post: InstagramScrapedPost;
  extracted: ExtractedEventData;
  candidates: SplitEventCandidate[];
  persistedVenue: string | null;
}): RepeatedSingleEventCaptionDisposition {
  if (options.extracted.schedule_entries.length !== 1 || options.candidates.length < 2) {
    return "none";
  }

  const modelEntry = options.extracted.schedule_entries[0];
  if (!modelEntry) {
    return "none";
  }
  const canonicalTitle = normalizeString(modelEntry.title || options.extracted.title);
  const canonicalArtists = normalizeExtractedArtists(
    modelEntry.artists.length > 0 ? modelEntry.artists : options.extracted.artists,
  );
  const modelVenue = normalizeString(options.extracted.venue);
  const canonicalVenue = normalizeString(options.persistedVenue);
  if (
    !modelVenue ||
    !canonicalVenue ||
    toSearchableText(modelVenue) !== toSearchableText(canonicalVenue)
  ) {
    return "preserve";
  }
  const canonicalRawDate = normalizeString(modelEntry.date || options.extracted.date);
  if (!canonicalTitle || !canonicalRawDate) {
    return "none";
  }

  const canonicalDate = normalizeEventDate(
    canonicalRawDate,
    normalizeString(modelEntry.source_text) || canonicalRawDate,
    options.post.postedAt,
  ).isoDate;
  if (!canonicalDate) {
    return "none";
  }

  const candidateDates = new Set(
    options.candidates
      .map((candidate) => candidate.normalizedDate.isoDate)
      .filter((value): value is string => Boolean(value)),
  );
  if (candidateDates.size !== 1 || !candidateDates.has(canonicalDate)) {
    return "none";
  }
  if (options.candidates.some((candidate) => candidate.source !== "caption_schedule")) {
    return "none";
  }
  if (
    options.candidates.some(
      (candidate) =>
        !containsNonHashtagIdentity(candidate.sourceLine, canonicalTitle) ||
        canonicalArtists.some(
          (artist) => !containsNonHashtagIdentity(candidate.sourceLine, artist),
        ),
    )
  ) {
    return "none";
  }
  const canonicalIdentities = [canonicalTitle, ...canonicalArtists];
  if (
    options.candidates.some((candidate) =>
      hasCompetingLocalBillingIdentity(candidate.sourceLine, canonicalIdentities),
    )
  ) {
    return "preserve";
  }
  if (extractPostAltTextEvidence(options.post.altText)) {
    return "preserve";
  }
  const announcementContexts = options.candidates.map((candidate) =>
    classifyRepeatedAnnouncementContext(
      candidate.sourceLine,
      canonicalIdentities,
      canonicalVenue,
    ),
  );
  const announcementContextKinds = new Set(announcementContexts.filter(Boolean));
  if (
    announcementContexts.some((context) => !context) ||
    !announcementContextKinds.has("relocation") ||
    !announcementContextKinds.has("scheduled_held")
  ) {
    return "preserve";
  }

  const candidateTimeValues = options.candidates.map((candidate) => candidate.time);
  const candidateTimes = new Set(candidateTimeValues.filter(Boolean));
  if (
    candidateTimes.size > 1 ||
    (candidateTimes.size === 1 && candidateTimeValues.some((candidateTime) => !candidateTime))
  ) {
    return "preserve";
  }
  const modelTime = sanitizeTimeAgainstDate(
    normalizeString(modelEntry.time || options.extracted.time),
    canonicalRawDate,
  );
  if (!modelTime && candidateTimes.size === 0) {
    return "collapse";
  }
  return modelTime && candidateTimeValues.every((candidateTime) => candidateTime === modelTime)
    ? "collapse"
    : "preserve";
}

export function isRecurringScheduleBoundaryCandidate(
  candidate: SplitEventCandidate,
  recurringStartIsoDate: string | null,
): boolean {
  return (
    extractRecurringScheduleStartDate(normalizeString(candidate.sourceLine)) !== null ||
    Boolean(
      recurringStartIsoDate && candidate.normalizedDate.isoDate === recurringStartIsoDate,
    )
  );
}

export function extractSplitEventCandidates(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  eventType: string,
  venue: string | null,
): SplitEventCandidate[] {
  const recurringSourceEvidence = [post.caption, extractPostAltTextEvidence(post.altText)]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join("\n");
  const recurringStartRawDate = extractRecurringScheduleStartDate(recurringSourceEvidence);
  const recurringStartIsoDate = recurringStartRawDate
    ? normalizeEventDate(recurringStartRawDate, recurringSourceEvidence, post.postedAt).isoDate
    : null;
  const modelCandidates = extractModelSplitEventCandidates(
    post,
    extracted,
    eventType,
    venue,
  );
  // Evidence-v2 rows are the versioned, source-cited schedule contract. Do not
  // merge heuristic caption rows back into them: doing so can silently turn a
  // row title into an artist or inject a clock that the structured row marked
  // absent. Legacy payloads retain the deterministic reconciliation below.
  if (normalizeString(extracted.extraction_contract_version) === "event_evidence_v2") {
    return sortSplitCandidatesByDate(modelCandidates);
  }
  const captionCandidates = extractCaptionSplitEventCandidates(
    post,
    extracted,
    eventType,
    venue,
  ).filter((candidate) =>
    !isRecurringScheduleBoundaryCandidate(candidate, recurringStartIsoDate)
  );
  const altTextCandidates = extractAltTextSplitEventCandidates(post, eventType, venue).filter(
    (candidate) => !isRecurringScheduleBoundaryCandidate(candidate, recurringStartIsoDate),
  );
  const deterministicUnion = reconcileSplitCandidateCoverage(
    captionCandidates,
    altTextCandidates,
  );
  const repeatedCaptionDisposition = classifyRepeatedSingleEventCaptionCandidates({
    post,
    extracted,
    candidates: captionCandidates,
    persistedVenue: venue,
  });
  if (repeatedCaptionDisposition === "collapse" && altTextCandidates.length === 0) {
    return sortSplitCandidatesByDate(modelCandidates);
  }
  if (repeatedCaptionDisposition === "preserve") {
    return sortSplitCandidatesByDate(deterministicUnion);
  }

  const deterministicCandidates = reconcileSplitCandidateCoverage([], deterministicUnion);
  if (modelCandidates.length > 0) {
    return reconcileSplitCandidateCoverage(modelCandidates, deterministicCandidates);
  }
  return deterministicCandidates.length > 1 ? deterministicCandidates : [];
}

export function buildSplitEventDescription(
  eventType: string,
  venue: string | null,
  artists: string[],
): string | undefined {
  const normalizedArtists = artists.map((artist) => normalizeString(artist)).filter(Boolean);
  if (normalizedArtists.length === 0) {
    return undefined;
  }

  const normalizedEventType = normalizeString(eventType);
  const humanizedEventType = normalizedEventType
    ? `${normalizedEventType.charAt(0).toUpperCase()}${normalizedEventType.slice(1)}`
    : "Event";
  const eventLabel =
    humanizedEventType === "Event" || /\bevent\b/i.test(humanizedEventType)
      ? humanizedEventType
      : `${humanizedEventType} event`;
  const venueSuffix = venue ? ` at ${venue}` : "";
  return `${eventLabel} with ${normalizedArtists.join(", ")}${venueSuffix}.`;
}
