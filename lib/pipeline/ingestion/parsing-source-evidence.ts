import { NON_EVENT_CLOSURE_NOTICE_REASON, UNVERIFIED_CORE_EVENT_SOURCE_REASON } from "@/lib/domain/moderation/index";
import { buildAdjacentSingleEventEvidenceSegments } from "@/lib/events/adjacent-source-evidence";
import { type EventEvidenceSourceConflict } from "@/lib/events/event-evidence-conflict-policy";
import { extractEventTimeFromText, isTbdEventTime } from "@/lib/events/event-time";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import type { CoreEventSourceGrounding, SplitEventCandidate } from "@/lib/pipeline/ingestion/contracts";
import { MONTH_ALIASES, collectDateCandidates, normalizeEventDate } from "@/lib/pipeline/ingestion/parsing-date";
import { dedupeArtistDisplayNames, extractPostAltTextEvidence, extractQuotedCulturalWorkTitleCandidate, formatArtistTitleList, normalizeArtistDisplayName, titleContainsAlphanumeric } from "@/lib/pipeline/ingestion/parsing-event-text";
import { parsePostedAt } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString } from "@/lib/pipeline/ingestion/values";


export const DATE_MONTH_WORD_PATTERN = "[A-Za-zČĆŠĐŽčćšđžА-Яа-яЈј]{3,14}";


export const SOURCE_GROUNDING_MONTH_PATTERN = Object.keys(MONTH_ALIASES)
  .sort((left, right) => right.length - left.length)
  .join("|");

export function containsNormalizedTokenSequence(value: string, expected: string): boolean {
  const valueTokens = toSearchableText(value).split(/\s+/).filter(Boolean);
  const expectedTokens = toSearchableText(expected).split(/\s+/).filter(Boolean);
  if (expectedTokens.length === 0 || expectedTokens.length > valueTokens.length) {
    return false;
  }

  return valueTokens.some((_, startIndex) =>
    expectedTokens.every(
      (token, tokenIndex) => valueTokens[startIndex + tokenIndex] === token,
    ),
  );
}

export function stripHashtagIdentityTokens(value: string): string {
  return value.replace(/#[\p{L}\p{N}._-]+/gu, " ");
}

export const LOCAL_BILLED_MENTION_PATTERN_SOURCE =
  String.raw`(?:^|[\s|,;])(?:w\/|with|uz|sa|feat(?:uring)?|ft\.?)\s*@([\p{L}\p{N}_.-]+)`;

export function containsNonHashtagIdentity(value: string, expected: string): boolean {
  return containsNormalizedTokenSequence(stripHashtagIdentityTokens(value), expected);
}

export function splitSourceLineAtDateAnchors(value: string): string[] {
  const line = normalizeString(value);
  if (!line) {
    return [];
  }

  const dateAnchorPattern = new RegExp(
    String.raw`\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?|\d{1,2}(?:st|nd|rd|th|\.)?\s+(?:${SOURCE_GROUNDING_MONTH_PATTERN})|(?:${SOURCE_GROUNDING_MONTH_PATTERN})\s+\d{1,2}(?:st|nd|rd|th)?)\b`,
    "giu",
  );
  const matches = [...line.matchAll(dateAnchorPattern)];
  if (matches.length <= 1) {
    return [line];
  }

  return matches
    .map((match, index) => {
      const start = index === 0 ? 0 : match.index;
      const end = matches[index + 1]?.index ?? line.length;
      return line.slice(start, end).trim();
    })
    .filter(Boolean);
}

export function hasAmbiguousDelimitedEventIdentityClause(value: string): boolean {
  const clauses = value.split(/\s*(?:\||\/)\s*/u);
  if (clauses.length <= 1) {
    return false;
  }

  const nonIdentityMetadataPattern =
    /^(?:\d{1,3}\s*(?:['’′]|m|min(?:ute)?s?|minut(?:a|e))|(?:[01]?\d|2[0-3])[:.][0-5]\d\s*h?|\d{1,2}\+)$/iu;
  return clauses.slice(1).some((clause) => {
    const normalizedClause = normalizeString(clause.replace(/[🎬🎤🎭🎨🖼]/gu, " "));
    return Boolean(normalizedClause && !nonIdentityMetadataPattern.test(normalizedClause));
  });
}

export function buildDateHeaderEventRowSegments(value: string | null | undefined): string[] {
  const lines = normalizeString(value).split(/\r?\n/u).map((line) => line.trim());
  const dateAnchorPattern = new RegExp(
    String.raw`\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?|\d{1,2}(?:st|nd|rd|th|\.)?\s+(?:${SOURCE_GROUNDING_MONTH_PATTERN})|(?:${SOURCE_GROUNDING_MONTH_PATTERN})\s+\d{1,2}(?:st|nd|rd|th)?)\b`,
    "iu",
  );
  const explicitEventRowPattern = /^(?:🎬|🎤|🎭|🎨|🖼️?)\s*\S/u;
  const eventMarkerPattern = /[🎬🎤🎭🎨🖼]/u;
  const dateAnchorGlobalPattern = new RegExp(dateAnchorPattern.source, "giu");
  const headerClockPattern = new RegExp(String.raw`\b${SOURCE_GROUNDING_CLOCK_PATTERN}\b`, "giu");
  const segments: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const dateLine = lines[index] ?? "";
    if (!dateLine || !dateAnchorPattern.test(dateLine)) {
      continue;
    }
    const headerRemainder = dateLine
      .replace(dateAnchorGlobalPattern, " ")
      .replace(headerClockPattern, " ");
    if (eventMarkerPattern.test(dateLine) || /[\p{L}\p{N}]/u.test(headerRemainder)) {
      continue;
    }
    const blockRows: string[] = [];
    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex] ?? "";
      if (!row || dateAnchorPattern.test(row)) {
        break;
      }
      blockRows.push(row);
    }
    if (blockRows.length === 1) {
      const eventRow = blockRows[0] ?? "";
      const eventMarkerCount = eventRow.match(/[🎬🎤🎭🎨🖼]/gu)?.length ?? 0;
      if (
        explicitEventRowPattern.test(eventRow) &&
        eventMarkerCount === 1 &&
        !hasAmbiguousDelimitedEventIdentityClause(eventRow)
      ) {
        segments.push(`${dateLine} ${eventRow}`);
      }
    }
  }
  return segments;
}

export function buildSourceGroundingSegments(value: string | null | undefined): string[] {
  const datePeriodPlaceholder = "\uE000";
  const protectedText = normalizeString(value)
    .replace(
      /\b(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\.(?=\s|$)/gu,
      `$1${datePeriodPlaceholder}`,
    )
    .replace(
      new RegExp(
        String.raw`\b(\d{1,2})\.(?=\s+(?:${SOURCE_GROUNDING_MONTH_PATTERN})\b)`,
        "giu",
      ),
      `$1${datePeriodPlaceholder}`,
    );
  const atomicSegments = protectedText
    .split(
      /\r?\n|[;•·●▪◦]+|\s+\|\s+|\s+\/\s+|\s+[—–-]\s+|(?<=[.!?])\s+/u,
    )
    .map((segment) => segment.replaceAll(datePeriodPlaceholder, "."))
    .flatMap(splitSourceLineAtDateAnchors)
    .filter(Boolean);
  const structuredLineAnchors = protectedText
    .split(/\r?\n/u)
    .map((line) => line.split(/(?<=[.!?])\s+/u, 1)[0] ?? "")
    .filter((line) => /\s\|\s/u.test(line))
    .map((line) => line.replaceAll(datePeriodPlaceholder, ".").trim())
    .filter(Boolean);
  return [...new Set([
    ...atomicSegments,
    ...structuredLineAnchors,
    ...buildDateHeaderEventRowSegments(value),
    ...buildAdjacentSingleEventEvidenceSegments(normalizeString(value)),
  ])];
}

export function buildSharedScheduleIdentitySegments(
  value: string | null | undefined,
): string[] {
  const datePeriodPlaceholder = "\uE001";
  return normalizeString(value)
    .replace(
      /\b(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\.(?=\s|$)/gu,
      `$1${datePeriodPlaceholder}`,
    )
    .replace(
      new RegExp(
        String.raw`\b(\d{1,2})\.(?=\s+(?:${SOURCE_GROUNDING_MONTH_PATTERN})\b)`,
        "giu",
      ),
      `$1${datePeriodPlaceholder}`,
    )
    .split(
      /\r?\n|[;•·●▪◦]+|\|+|(?<!\d)\/|\/(?!\d)|[—–]+|\s+-\s+|,(?=\s*\p{L})|(?<=[!?])\s+|(?<=\.)\s+(?=[\p{Lu}])/u,
    )
    .map((segment) => segment.replaceAll(datePeriodPlaceholder, ".").trim())
    .filter(Boolean);
}

export const SOURCE_GROUNDING_CLOCK_PATTERN =
  String.raw`(?:[01]?\d|2[0-3])(?:[:.][0-5]\d\s*h?|\s*h(?:[0-5]\d)?)`;


export const SOURCE_GROUNDING_LABELED_CLOCK_PATTERN =
  String.raw`(?:${SOURCE_GROUNDING_CLOCK_PATTERN}|(?:[01]?\d|2[0-3]))`;

export function stripDoorOpeningClockValues(value: string): string {
  return value.replace(
    new RegExp(
      String.raw`\b(?:vrata(?:\s+se)?\s+otvaraju|doors?(?:\s+open(?:s)?)?)\s*(?::|[-–—])?[^\n.!?]{0,24}?(?:u|at)?\s*${SOURCE_GROUNDING_LABELED_CLOCK_PATTERN}\b`,
      "giu",
    ),
    " ",
  );
}

export function countSourceClockValues(value: string): number {
  const withoutDates = value.replace(
    /\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?)\b/gu,
    " ",
  );
  const clockValues = withoutDates.match(
    new RegExp(String.raw`\b${SOURCE_GROUNDING_CLOCK_PATTERN}\b`, "giu"),
  ) ?? [];
  return clockValues.length;
}

export function collectSupportedDates(
  value: string,
  postedAt: string | null | undefined,
): string[] {
  const postDate = parsePostedAt(postedAt ?? null);
  const withoutExplicitClocks = value.replace(
    /\b(?:[01]?\d|2[0-3])(?:[:.][0-5]\d)?\s*h(?:[0-5]\d)?\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/giu,
    " ",
  );
  const candidates = collectDateCandidates(withoutExplicitClocks, "caption", postDate);
  const dayFirstNumericAnchors = [
    ...withoutExplicitClocks.matchAll(
      /\b(\d{1,2})[./-](\d{1,2})(?:[./-](?:\d{2}|\d{4}))?\b/gu,
    ),
  ]
    .map((match) => ({
      day: Number.parseInt(match[1] ?? "", 10),
      month: Number.parseInt(match[2] ?? "", 10),
    }))
    .filter(({ day, month }) => day >= 1 && day <= 31 && month >= 1 && month <= 12);
  if (dayFirstNumericAnchors.length > 0) {
    return [...new Set(
      candidates
        .filter((candidate) => {
          const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(candidate.isoDate);
          if (!match) {
            return false;
          }
          const month = Number.parseInt(match[1], 10);
          const day = Number.parseInt(match[2], 10);
          return dayFirstNumericAnchors.some(
            (anchor) => anchor.day === day && anchor.month === month,
          );
        })
        .map((candidate) => candidate.isoDate),
    )];
  }
  return [...new Set(candidates.map((candidate) => candidate.isoDate))];
}

export function collectSharedMonthDateListDates(
  value: string,
  postedAt: string | null | undefined,
): string[] {
  const dates: string[] = [];
  const pattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])((?:\d{1,2}\.?\s*(?:,|i|and|&)\s*)+\d{1,2}\.?)\s+(${DATE_MONTH_WORD_PATTERN})(?:\s*,?\s*(\d{2,4}))?`,
    "giu",
  );
  for (const match of normalizeString(value).matchAll(pattern)) {
    const days = [...(match[1] ?? "").matchAll(/\d{1,2}/gu)]
      .map((dayMatch) => Number.parseInt(dayMatch[0], 10))
      .filter((day) => day >= 1 && day <= 31);
    if (days.length < 2 || new Set(days).size !== days.length) continue;
    for (const day of days) {
      const normalized = normalizeEventDate(
        `${day}. ${match[2] ?? ""}${match[3] ? ` ${match[3]}` : ""}`,
        null,
        postedAt ?? null,
      ).isoDate;
      if (normalized) dates.push(normalized);
    }
  }
  return [...new Set(dates)];
}

export function prefixSupportsNormalizedEventDate(
  prefixTokens: string[],
  normalizedDate: string,
  postedAt: string | null | undefined,
): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalizedDate);
  if (!match || prefixTokens.length === 0 || prefixTokens.length > 4) {
    return false;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const weekdayTokens = new Set([
    "pon", "ponedeljak", "uto", "utorak", "sre", "sreda",
    "cet", "cetvrtak", "pet", "petak", "sub", "subota",
    "ned", "nedelja", "mon", "monday", "tue", "tuesday",
    "wed", "wednesday", "thu", "thursday", "fri", "friday",
    "sat", "saturday", "sun", "sunday",
  ]);
  if (
    !prefixTokens.every(
      (token) =>
        /^\d{1,4}$/u.test(token) ||
        MONTH_ALIASES[token] !== undefined ||
        weekdayTokens.has(token),
    )
  ) {
    return false;
  }
  const numericValues = prefixTokens
    .filter((token) => /^\d{1,4}$/u.test(token))
    .map((token) => Number.parseInt(token, 10));
  if (numericValues.some((value) => ![day, month, year].includes(value))) {
    return false;
  }
  if (collectSupportedDates(prefixTokens.join(" "), postedAt).includes(normalizedDate)) {
    return true;
  }
  for (let index = 0; index < prefixTokens.length - 1; index += 1) {
    const first = Number.parseInt(prefixTokens[index], 10);
    const second = Number.parseInt(prefixTokens[index + 1], 10);
    if (first === day && second === month) {
      return true;
    }
    if (MONTH_ALIASES[prefixTokens[index]] === month && second === day) {
      return true;
    }
    if (first === day && MONTH_ALIASES[prefixTokens[index + 1]] === month) {
      return true;
    }
  }
  return false;
}

export function hasExplicitBilledEventContext(
  segment: string,
  title: string,
  artists: string[],
  normalizedDate: string,
  postedAt: string | null | undefined,
): boolean {
  const searchableSegment = toSearchableText(stripHashtagIdentityTokens(segment));
  const searchableTitle = toSearchableText(title);
  if (!searchableTitle) {
    return false;
  }
  const quotedWorkTitle = extractQuotedCulturalWorkTitleCandidate(segment, undefined);
  const hasQuotedYearQualifiedTitle =
    toSearchableText(quotedWorkTitle ?? "") === searchableTitle;
  const quotedCulturalWorkTitle = extractQuotedCulturalWorkTitleCandidate(segment, "film");
  const hasQuotedCulturalWorkInTitle = Boolean(
    quotedCulturalWorkTitle &&
      containsNormalizedTokenSequence(searchableTitle, quotedCulturalWorkTitle),
  );
  const titleIsBilledArtist = artists.some(
    (artist) => toSearchableText(artist) === searchableTitle,
  );
  const titleArtistTokens = searchableTitle
    .split(/\s+/u)
    .filter((token) => token.length >= 2);
  const titleArtistKeys = [
    titleArtistTokens.join(""),
    [...titleArtistTokens].reverse().join(""),
  ];
  const hasSourceMentionForTitleArtist =
    titleIsBilledArtist &&
    titleArtistTokens.length >= 2 &&
    [...segment.matchAll(
      new RegExp(LOCAL_BILLED_MENTION_PATTERN_SOURCE, "giu"),
    )].some((match) => {
      const searchableMention = toSearchableText(match[1] ?? "").replace(/\s+/gu, "");
      return titleArtistKeys.includes(searchableMention);
    });
  const titleHasDirectEventFormatLabel =
    /^(?:projekcija filma|filmska projekcija|pozorisna predstava|pozori[sš]na predstava|izlozba|izlo[zž]ba|radionica|kviz|koncert|jam session)\b/iu.test(
      searchableTitle,
    ) && /\s[|•·●▪◦]\s/u.test(segment);
  const hasExplicitEventRowMarker = [...segment.matchAll(/[🎬🎤🎭🎨🖼]/gu)].some(
    (match) =>
      toSearchableText(segment.slice((match.index ?? 0) + match[0].length)).startsWith(
        searchableTitle,
      ),
  );

  if (
    /^(?:vidimo se|see you|save the date|dodjite(?: svi)?|dođite(?: svi)?|join us|come through|pridruzite se|pridružite se|ne propustite|dont miss|rezervisite|rezervišite|book now|saznajte vise|saznajte više|dress code|doors? open|vrata|ulaz|entry|tickets?|karte|reservations?|rezervacije|summer memories|party people|dj mix|album drops?|new album|new single|music video|photo dump|throwback album|good vibes|tonight|today|sutra|veceras|lineup|raspored|program|schedule|this week|ove nedelje|weekend)(?:\s|$)/iu.test(
      searchableTitle,
    )
  ) {
    return false;
  }

  if (
    /\b(?:sponsor(?:ed)? by|presented by|powered by|photo(?:s)?|album|archive|recap|memories|drop(?:s)?|song|single|video|release|out now|please|kindly|join us|you are invited)\b/iu.test(
      `${searchableTitle} ${searchableSegment}`,
    )
  ) {
    return false;
  }

  const hasExplicitArtistCue = artists.some((artist) => {
    const searchableArtist = toSearchableText(artist);
    if (!searchableArtist) {
      return false;
    }
    return [
      `dj ${searchableArtist}`,
      `live ${searchableArtist}`,
      `with ${searchableArtist}`,
      `uz ${searchableArtist}`,
      `svira ${searchableArtist}`,
      `${searchableArtist} svira`,
      `nastupa ${searchableArtist}`,
      `${searchableArtist} nastupa`,
      `gostuje ${searchableArtist}`,
      `${searchableArtist} gostuje`,
      `${searchableArtist} live`,
      `${searchableArtist} b2b`,
    ].some((pattern) => containsNormalizedTokenSequence(searchableSegment, pattern));
  });
  const hasExplicitEventCue = [
    `svira ${searchableTitle}`,
    `${searchableTitle} svira`,
    `nastupa ${searchableTitle}`,
    `${searchableTitle} nastupa`,
    `gostuje ${searchableTitle}`,
    `${searchableTitle} gostuje`,
    `live ${searchableTitle}`,
    `${searchableTitle} live`,
    `projekcija ${searchableTitle}`,
    `prikazujemo ${searchableTitle}`,
    `film ${searchableTitle}`,
    `predstava ${searchableTitle}`,
    `izlozba ${searchableTitle}`,
    `radionica ${searchableTitle}`,
    `kviz ${searchableTitle}`,
    `koncert ${searchableTitle}`,
    `jam session ${searchableTitle}`,
  ].some((pattern) => containsNormalizedTokenSequence(searchableSegment, pattern));
  const hasEventLogisticsCue =
    /\b(?:vrata(?:\s+se)?\s+otvaraju|doors?\s+open(?:s)?)\b/iu.test(searchableSegment);

  const segmentTokens = searchableSegment.split(/\s+/u).filter(Boolean);
  const titleTokens = searchableTitle.split(/\s+/u).filter(Boolean);
  const titleStart = segmentTokens.findIndex((_, index) =>
    titleTokens.every((token, offset) => segmentTokens[index + offset] === token),
  );
  if (titleStart < 0) {
    return false;
  }
  const prefixTokens = segmentTokens.slice(0, titleStart);
  if (["dj", "live"].includes(prefixTokens.at(-1) ?? "")) {
    prefixTokens.pop();
  }
  const hasStructuredDatePrefix = prefixSupportsNormalizedEventDate(
    prefixTokens,
    normalizedDate,
    postedAt,
  );
  return (
    hasStructuredDatePrefix ||
    hasExplicitArtistCue ||
    hasExplicitEventCue ||
    hasQuotedCulturalWorkInTitle ||
    titleHasDirectEventFormatLabel ||
    hasExplicitEventRowMarker ||
    (titleStart === 0 && hasSourceMentionForTitleArtist) ||
    (hasEventLogisticsCue && hasQuotedYearQualifiedTitle)
  );
}

export function hasCoherentBilledArtists(
  segment: string,
  artists: string[],
  title: string,
): boolean {
  if (artists.length === 0) {
    return true;
  }

  const searchableSegment = toSearchableText(stripHashtagIdentityTokens(segment));
  const searchableTitle = toSearchableText(title);

  return artists.every((artist) => {
    const searchableArtist = toSearchableText(artist);
    if (!searchableArtist || !containsNormalizedTokenSequence(searchableSegment, searchableArtist)) {
      return false;
    }
    if (searchableArtist === searchableTitle) {
      return true;
    }
    return [
      `dj ${searchableArtist}`,
      `live ${searchableArtist}`,
      `with ${searchableArtist}`,
      `uz ${searchableArtist}`,
      `svira ${searchableArtist}`,
      `${searchableArtist} svira`,
      `nastupa ${searchableArtist}`,
      `${searchableArtist} nastupa`,
      `gostuje ${searchableArtist}`,
      `${searchableArtist} gostuje`,
      `${searchableArtist} live`,
      `${searchableArtist} b2b`,
    ].some((pattern) => containsNormalizedTokenSequence(searchableSegment, pattern));
  });
}

/**
 * Fail closed for automatic publication: model confidence and model-authored
 * evidence are not source evidence. The final title, date, billed artists, and
 * any explicit published time must be recoverable from one deterministic raw
 * Instagram caption/alt-text segment. Image-only candidates remain pending for
 * owner review rather than becoming public automatically.
 */
export function evaluateCoreEventSourceGrounding(options: {
  independentTextEvidence: string | null | undefined;
  title: string | null | undefined;
  normalizedDate: string | null | undefined;
  postedAt: string | null | undefined;
  splitSource: string | null | undefined;
  titleUsedFallback: boolean;
  time?: string | null;
  artists?: string[] | null;
  venue?: string | null;
  instagramHandle?: string | null;
}): CoreEventSourceGrounding {
  const sourceText = normalizeString(options.independentTextEvidence);
  const baseSegments = buildSourceGroundingSegments(sourceText);
  const segments = [...baseSegments];
  const title = normalizeString(options.title);
  const normalizedDate = normalizeString(options.normalizedDate);
  const expectedTime = isTbdEventTime(options.time)
    ? ""
    : normalizeString(options.time);
  const artists = [...new Set(
    (options.artists ?? []).map(normalizeString).filter(Boolean),
  )];
  const titleMatchesVenue =
    Boolean(title) &&
    Boolean(normalizeString(options.venue)) &&
    toSearchableText(title) === toSearchableText(normalizeString(options.venue));
  const titleMatchesHandle =
    Boolean(title) &&
    Boolean(normalizeString(options.instagramHandle)) &&
    toSearchableText(title) ===
      toSearchableText(normalizeString(options.instagramHandle).replace(/^@/, ""));
  const identityAllowed =
    !options.titleUsedFallback && !titleMatchesVenue && !titleMatchesHandle;
  const titleVerified =
    identityAllowed && segments.some((segment) => containsNonHashtagIdentity(segment, title));
  const dateVerified =
    Boolean(normalizedDate) &&
    segments.some((segment) => collectSupportedDates(segment, options.postedAt).includes(normalizedDate));
  const identityContextVerified = segments.some(
    (segment) =>
      containsNonHashtagIdentity(segment, title) &&
      hasExplicitBilledEventContext(
        segment,
        title,
        artists,
        normalizedDate,
        options.postedAt,
      ),
  );
  const identityVerified = titleVerified && identityContextVerified;
  const timeVerified = expectedTime
    ? segments.some(
        (segment) =>
          extractEventTimeFromText(stripDoorOpeningClockValues(segment)) === expectedTime,
      )
    : null;
  const artistsVerified = artists.length > 0
    ? artists.every((artist) =>
        segments.some((segment) => containsNonHashtagIdentity(segment, artist)),
      )
    : null;
  const rowVerified =
    identityAllowed &&
    Boolean(normalizedDate) &&
    segments.some((segment) => {
      const supportedDates = collectSupportedDates(segment, options.postedAt);
      if (
        !supportedDates.includes(normalizedDate) ||
        countSourceClockValues(stripDoorOpeningClockValues(segment)) > 1 ||
        !containsNonHashtagIdentity(segment, title) ||
        !hasExplicitBilledEventContext(
          segment,
          title,
          artists,
          normalizedDate,
          options.postedAt,
        ) ||
        !hasCoherentBilledArtists(segment, artists, title)
      ) {
        return false;
      }
      if (
        artists.length > 0 &&
        !artists.every((artist) => containsNonHashtagIdentity(segment, artist))
      ) {
        return false;
      }
      if (
        expectedTime &&
        extractEventTimeFromText(stripDoorOpeningClockValues(segment)) !== expectedTime
      ) {
        return false;
      }
      return true;
    });
  const verified = rowVerified;

  return {
    titleVerified,
    dateVerified,
    identityVerified,
    identityContextVerified,
    timeVerified,
    artistsVerified,
    rowVerified,
    verified,
    blockers: verified ? [] : [UNVERIFIED_CORE_EVENT_SOURCE_REASON],
  };
}

export function getPosterScheduleAutoApprovalBlockers(options: {
  splitSource: string | null | undefined;
  independentTextEvidence: string | null | undefined;
  title?: string | null;
  normalizedDate?: string | null;
  postedAt?: string | null;
  titleUsedFallback?: boolean;
  time?: string | null;
  artists?: string[] | null;
  venue?: string | null;
  instagramHandle?: string | null;
}): string[] {
  if (options.splitSource !== "poster_schedule") {
    return [];
  }
  return evaluateCoreEventSourceGrounding({
    independentTextEvidence: options.independentTextEvidence,
    title: options.title,
    normalizedDate: options.normalizedDate,
    postedAt: options.postedAt,
    splitSource: options.splitSource,
    titleUsedFallback: options.titleUsedFallback ?? false,
    time: options.time,
    artists: options.artists,
    venue: options.venue,
    instagramHandle: options.instagramHandle,
  }).blockers;
}

export function isNonEventClosureNotice(value: string | null | undefined): boolean {
  const text = normalizeString(value);
  if (!text) {
    return false;
  }

  return /\bclosed\s+for\s+vacation\b|\bcollective\s+vacation\b|\bkolektivni\s+godi[sš]nji\s+odmor\b|\bgodi[sš]nji\s+odmor\b|\bzatvoreno\s+(?:zbog|radi|od)\b/iu.test(
    text,
  );
}

export function getNonEventAutoApprovalBlockers(value: string | null | undefined): string[] {
  return isNonEventClosureNotice(value) ? [NON_EVENT_CLOSURE_NOTICE_REASON] : [];
}

export function normalizeSplitArtistSegment(value: string): string {
  const hashtags = [...value.matchAll(/#([\p{L}\p{N}_.-]+)/gu)]
    .map((match) => normalizeString(match[1]))
    .filter(Boolean);
  if (hashtags.length === 0) {
    return normalizeArtistDisplayName(value);
  }
  const withoutHashtags = stripHashtagTokens(value);
  if (!withoutHashtags) {
    return "";
  }
  const artist = normalizeArtistDisplayName(withoutHashtags);
  const hasExplicitBillingCue =
    /^(?:dj|live|nastupa|gostuje|feat(?:uring)?|ft)\b|\b(?:music|set)\s+by\b/iu.test(
      withoutHashtags,
    );
  const repeatsHashtagIdentity = hashtags.some((hashtag) =>
    identityVariantsOverlap(artist, hashtag),
  );
  return hasExplicitBillingCue || repeatsHashtagIdentity ? artist : "";
}

export function parseSplitCaptionEntryArtists(value: string): string[] {
  const normalizedDelimiters = value.replace(/\s+x\s+/gu, " & ");
  return [...new Set(
    normalizedDelimiters
      .split(/\s*(?:,|&|\+|\bb2b\b|\band\b|[|•·●▪‣∙◦‧⁃◆◇■□▸►▶])\s*/iu)
      .map((item) => normalizeSplitArtistSegment(item))
      .filter((item) => titleContainsAlphanumeric(item)),
  )];
}

export function hasMultipleResolvedSplitDates(entries: SplitEventCandidate[]): boolean {
  const uniqueResolvedDates = new Set(
    entries
      .map((entry) => entry.normalizedDate.isoDate)
      .filter((value): value is string => Boolean(value)),
  );

  return uniqueResolvedDates.size >= 2;
}

export function buildSplitEventSourceLine(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => normalizeString(part))
    .filter((part) => part.length > 0)
    .join(" | ");
}

export function stripHashtagTokens(value: string): string {
  return normalizeString(normalizeString(value).replace(/#[\p{L}\p{N}_.-]+/gu, " "));
}

export const HASHTAG_IDENTITY_DECORATION_TOKENS = new Set([
  "by",
  "concert",
  "dj",
  "event",
  "feat",
  "featuring",
  "ft",
  "gostuje",
  "guest",
  "live",
  "music",
  "nastupa",
  "night",
  "party",
  "performance",
  "performing",
  "presenting",
  "presents",
  "set",
  "show",
]);


export const BILLING_CUE_BEFORE_TOKENS = new Set([
  "b2b",
  "dj",
  "feat",
  "featuring",
  "ft",
  "gostuje",
  "gostuju",
  "guest",
  "lineup",
  "live",
  "muzika",
  "nastup",
  "nastupa",
  "nastupaju",
  "svira",
  "sviraju",
  "uz",
  "with",
]);


export const BILLING_CUE_AFTER_TOKENS = new Set(["b2b", "dj", "live", "set"]);


export const NON_BILLING_CONTEXT_TOKENS = new Set([
  "credit",
  "credits",
  "design",
  "foto",
  "fotografija",
  "hvala",
  "photo",
  "photos",
  "photography",
  "podrsci",
  "podršci",
  "powered",
  "produced",
  "production",
  "produkcija",
  "recap",
  "sponsor",
  "sponsored",
  "thank",
  "thanks",
  "video",
  "visuals",
  "zahvaljujemo",
]);


export const STRICT_SCHEDULE_ROW_TOKENS = new Set([
  ...HASHTAG_IDENTITY_DECORATION_TOKENS,
  ...BILLING_CUE_BEFORE_TOKENS,
  ...BILLING_CUE_AFTER_TOKENS,
  "am",
  "at",
  "by",
  "doors",
  "h",
  "music",
  "od",
  "open",
  "pm",
  "pocetak",
  "početak",
  "start",
  "u",
  "za",
]);


export const SCHEDULE_WEEKDAY_TOKENS = new Set([
  "cet",
  "cetvrtak",
  "čet",
  "četvrtak",
  "fri",
  "friday",
  "mon",
  "monday",
  "ned",
  "nedelja",
  "nedjelja",
  "pet",
  "petak",
  "pon",
  "ponedeljak",
  "sat",
  "saturday",
  "sre",
  "sreda",
  "sub",
  "subota",
  "sun",
  "sunday",
  "thu",
  "thursday",
  "tue",
  "tuesday",
  "uto",
  "utorak",
  "wed",
  "wednesday",
]);

export function getSearchableTokens(value: string): string[] {
  return toSearchableText(value).split(/\s+/u).filter(Boolean);
}

export function getHashtagComparableIdentityVariants(value: string): string[] {
  const normalized = toSearchableText(value);
  if (!normalized) {
    return [];
  }

  const core = getSearchableTokens(value)
    .filter((token) => !HASHTAG_IDENTITY_DECORATION_TOKENS.has(token))
    .join(" ");
  return [...new Set([
    normalized,
    normalized.replace(/\s+/gu, ""),
    core,
    core.replace(/\s+/gu, ""),
  ].filter(Boolean))];
}

export function identityVariantsOverlap(left: string, right: string): boolean {
  const rightVariants = new Set(getHashtagComparableIdentityVariants(right));
  return getHashtagComparableIdentityVariants(left).some((variant) => rightVariants.has(variant));
}

export function findIdentityTokenMatch(
  segmentTokens: string[],
  value: string,
): { start: number; end: number } | null {
  const candidateSequences = getHashtagComparableIdentityVariants(value)
    .map((variant) => variant.split(/\s+/u).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
  const uniqueSequences = [...new Map(
    candidateSequences.map((tokens) => [tokens.join("\u0000"), tokens]),
  ).values()].sort((left, right) => left.length - right.length);

  for (const candidateTokens of uniqueSequences) {
    for (let start = 0; start <= segmentTokens.length - candidateTokens.length; start += 1) {
      if (candidateTokens.every((token, index) => segmentTokens[start + index] === token)) {
        return { start, end: start + candidateTokens.length };
      }
    }
  }
  return null;
}

export function hasBoundBillingCue(
  segmentTokens: string[],
  identityMatch: { start: number; end: number },
): boolean {
  const before = segmentTokens[identityMatch.start - 1] ?? "";
  const beforeTwo = segmentTokens.slice(Math.max(0, identityMatch.start - 2), identityMatch.start).join(" ");
  const after = segmentTokens[identityMatch.end] ?? "";
  if (segmentTokens.some((token) => NON_BILLING_CONTEXT_TOKENS.has(token))) {
    return false;
  }
  return BILLING_CUE_BEFORE_TOKENS.has(before) ||
    beforeTwo === "music by" ||
    beforeTwo === "performance by" ||
    beforeTwo === "set by" ||
    beforeTwo === "za muziku" ||
    BILLING_CUE_AFTER_TOKENS.has(after);
}

export function isStrictScheduleIdentityRow(
  segment: string,
  segmentTokens: string[],
  identityMatch: { start: number; end: number },
): boolean {
  const remainingTokens = segmentTokens.filter(
    (_token, index) => index < identityMatch.start || index >= identityMatch.end,
  );
  const unknownTokens = remainingTokens.filter((token) =>
    !/^\d{1,4}h?$/u.test(token) &&
    !STRICT_SCHEDULE_ROW_TOKENS.has(token) &&
    !SCHEDULE_WEEKDAY_TOKENS.has(token),
  );
  if (remainingTokens.length === 0) {
    return false;
  }
  if (unknownTokens.length === 0) {
    return true;
  }
  const hasArtistListDelimiter = /[,+&/]|\bb2b\b/iu.test(segment);
  return hasArtistListDelimiter &&
    unknownTokens.length <= 6 &&
    !unknownTokens.some((token) => NON_BILLING_CONTEXT_TOKENS.has(token));
}

export function splitLogicalEvidenceClauses(value: string): string[] {
  return value.split(/[|•·●▪‣∙◦‧⁃◆◇■□▸►▶]+/u);
}

export function isNonBillingEvidenceClause(value: string): boolean {
  const tokens = getSearchableTokens(value);
  if (tokens.some((token) => ["hvala", "thank", "thanks", "zahvaljujemo"].includes(token))) {
    return true;
  }
  return /\b(?:credit|credits|design|foto|fotografija|photo|photos|photography|powered|produced|production|produkcija|sponsor|sponsored|video|visuals)\s*(?::|by\b)/iu.test(
    value,
  );
}

export function stripNonBillingIdentityClauses(value: string): string {
  return splitLogicalEvidenceClauses(value)
    .map((clause) => normalizeString(clause))
    .filter((clause) => clause && !isNonBillingEvidenceClause(clause))
    .join(" | ");
}

export function hasScheduleAnchor(segment: string, segmentTokens: string[]): boolean {
  return /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/u.test(segment) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:h|am|pm)\b|\b\d{1,2}:\d{2}\b/iu.test(segment) ||
    [...SCHEDULE_WEEKDAY_TOKENS].some((weekday) => segmentTokens.includes(weekday));
}

export function hasExplicitBilledIdentityEvidence(value: string, evidence: string): boolean {
  const text = stripHashtagTokens(evidence);
  if (!text) {
    return false;
  }

  for (const rawLine of text.split(/[\r\n!?;]+/u)) {
    const line = normalizeString(rawLine);
    const lineTokens = getSearchableTokens(line);
    const lineHasScheduleAnchor = hasScheduleAnchor(line, lineTokens);
    for (const rawSegment of splitLogicalEvidenceClauses(line)) {
      const segment = normalizeString(rawSegment);
      const segmentTokens = getSearchableTokens(segment);
      if (segmentTokens.length === 0) {
        continue;
      }
      const identityMatch = findIdentityTokenMatch(segmentTokens, value);
      if (!identityMatch) {
        continue;
      }

      if (hasBoundBillingCue(segmentTokens, identityMatch)) {
        return true;
      }
      if (
        (lineHasScheduleAnchor || hasScheduleAnchor(segment, segmentTokens)) &&
        isStrictScheduleIdentityRow(segment, segmentTokens, identityMatch)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function isHashtagOnlySourceIdentity(
  value: string,
  post: InstagramScrapedPost,
  additionalEvidence: string[] = [],
  billingScope: "post" | "additional" = "post",
): boolean {
  const postEvidence = [
    normalizeString(post.caption),
    extractPostAltTextEvidence(post.altText),
  ].filter(Boolean);
  const normalizedAdditionalEvidence = additionalEvidence
    .map((item) => normalizeString(item))
    .filter(Boolean);
  const hashtagEvidence = [...postEvidence, ...normalizedAdditionalEvidence];
  const hashtags = hashtagEvidence.flatMap((item) =>
    [...item.matchAll(/#([\p{L}\p{N}_.-]+)/gu)]
      .map((match) => normalizeString(match[1]))
      .filter(Boolean),
  );
  if (!hashtags.some((hashtag) => identityVariantsOverlap(value, hashtag))) {
    return false;
  }

  const billingEvidence =
    billingScope === "additional" ? normalizedAdditionalEvidence : hashtagEvidence;
  return !billingEvidence.some((item) => hasExplicitBilledIdentityEvidence(value, item));
}

export function sanitizeSplitEventIdentity(options: {
  rawTitle: string;
  rawArtists: string[];
  post: InstagramScrapedPost;
  additionalEvidence?: string[];
  artistAliasConflicts?: EventEvidenceSourceConflict[];
}): { title: string; artists: string[]; artistsWereSanitized: boolean } {
  const billableRawTitle = stripNonBillingIdentityClauses(options.rawTitle);
  const titleClausesWereSanitized =
    normalizeString(billableRawTitle) !== normalizeString(options.rawTitle);
  const groundedRawTitle = normalizeString(
    stripHashtagTokens(billableRawTitle).replace(
      /^(?:\s*(?:,|&|\+|\bb2b\b|\band\b|\bx\b)\s*)+|(?:\s*(?:,|&|\+|\bb2b\b|\band\b|\bx\b)\s*)+$/gu,
      "",
    ),
  );
  const artistCandidates = dedupeArtistDisplayNames(
    options.rawArtists,
    options.artistAliasConflicts,
  );
  const originalArtists = titleClausesWereSanitized
    ? artistCandidates.filter((artist) => containsNormalizedTokenSequence(billableRawTitle, artist))
    : artistCandidates;
  const validArtists = originalArtists.filter((artist) =>
    !isHashtagOnlySourceIdentity(
      artist,
      options.post,
      options.additionalEvidence ?? [],
      "additional",
    ),
  );
  const guardedTitle = !groundedRawTitle || isHashtagOnlySourceIdentity(
    groundedRawTitle,
    options.post,
    options.additionalEvidence ?? [],
    "additional",
  )
    ? ""
    : groundedRawTitle;
  const artistsWereSanitized =
    titleClausesWereSanitized ||
    originalArtists.length < artistCandidates.length ||
    validArtists.length < originalArtists.length;
  const titleListsEveryExtractedArtist =
    artistCandidates.length > 0 &&
    artistCandidates.every((artist) => containsNormalizedTokenSequence(guardedTitle, artist));
  return {
    title:
      artistsWereSanitized && titleListsEveryExtractedArtist
        ? formatArtistTitleList(validArtists)
        : guardedTitle,
    artists: validArtists,
    artistsWereSanitized,
  };
}

export function extractSplitEntryTime(value: string): string | undefined {
  return extractEventTimeFromText(value);
}

export function stripSplitEntryTime(value: string): string {
  return value
    .replace(/\b\d{1,2}\s*[-–—]\s*\d{1,2}\s*h\b/giu, " ")
    .replace(/\b\d{1,2}\s*h\b/giu, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
