import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { extractEventTimeFromText, normalizeEventTime } from "@/lib/events/event-time";
import { type NightlifeLineupCoalescingPlan, type NightlifeLineupSource, titleContainsOnlyBilledArtists } from "@/lib/events/nightlife-lineup-coalescing";
import { sourceEvidenceNamesSupportedUnnamedEventKind, specificVenueValueAppearsInUnnamedEventEvidence, venueValueAppearsInEventEvidence } from "@/lib/events/unnamed-schedule-fallback";
import { normalizeExtractedArtists, toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { normalizeConfidenceScore } from "@/lib/utils/confidence";
import type { EventDateEvidenceSource } from "@/lib/pipeline/ingestion/contracts";
import { expandNormalizedDateRange, hasExplicitDateText, normalizeEventDate } from "@/lib/pipeline/ingestion/parsing-date";
import { normalizeArtistDisplayName } from "@/lib/pipeline/ingestion/parsing-event-text";
import { buildSharedScheduleIdentitySegments, collectSharedMonthDateListDates, collectSupportedDates, containsNormalizedTokenSequence, stripDoorOpeningClockValues } from "@/lib/pipeline/ingestion/parsing-source-evidence";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export function extractionEvidenceAppearsInPersistedSource(options: {
  evidenceText: string;
  source: EventDateEvidenceSource;
  post: InstagramScrapedPost;
  hasPoster: boolean;
}): boolean {
  const needle = toSearchableText(options.evidenceText);
  if (!needle) return false;
  if (options.source === "poster") return options.hasPoster;
  const sourceText =
    options.source === "caption"
      ? options.post.caption
      : options.source === "alt_text"
        ? options.post.altText
        : null;
  return Boolean(sourceText && toSearchableText(sourceText).includes(needle));
}

export function isVerifiedDateEvidence(options: {
  evidence: ExtractedEventData["date_evidence"];
  resolvedDate: string | null;
  post: InstagramScrapedPost;
  hasPoster: boolean;
}): boolean {
  const evidenceText = normalizeString(options.evidence.exact_text);
  const evidenceResolvedDate = normalizeString(options.evidence.resolved_date);
  const independentlyResolved = normalizeEventDate(
    evidenceText,
    null,
    options.post.postedAt,
  );
  const independentlyRelative =
    independentlyResolved.yearSelectionReason === "relative_weekday_from_post_timestamp" ||
    independentlyResolved.yearSelectionReason === "relative_day_from_post_timestamp";
  const independentlyExpandedRange = expandNormalizedDateRange(
    evidenceText,
    options.post.postedAt,
  );
  const resolvesToExpectedDate =
    independentlyResolved.isoDate === options.resolvedDate ||
    independentlyExpandedRange?.includes(options.resolvedDate ?? "") === true;
  const relativeSemanticsCompatible =
    hasExplicitDateText(evidenceText) ||
    options.evidence.is_relative === independentlyRelative;
  return (
    Boolean(options.resolvedDate) &&
    evidenceResolvedDate === options.resolvedDate &&
    resolvesToExpectedDate &&
    relativeSemanticsCompatible &&
    options.evidence.source !== "unknown" &&
    extractionEvidenceAppearsInPersistedSource({
      evidenceText,
      source: options.evidence.source,
      post: options.post,
      hasPoster: options.hasPoster,
    })
  );
}

export function isVerifiedTimeEvidence(options: {
  evidence: ExtractedEventData["time_evidence"];
  resolvedStartTime: string | null;
  post: InstagramScrapedPost;
  hasPoster: boolean;
}): boolean {
  const evidenceText = normalizeString(options.evidence.exact_text);
  const evidenceIsBound =
    options.evidence.source !== "unknown" &&
    extractionEvidenceAppearsInPersistedSource({
      evidenceText,
      source: options.evidence.source,
      post: options.post,
      hasPoster: options.hasPoster,
    });

  if (options.evidence.status === "not_stated") {
    // Absence has no source snippet to bind. Older event_evidence_v2 caches and
    // some otherwise-valid model responses labeled that absence as caption or
    // poster. Accept the empty absence semantics without rewriting the cached
    // JSON bytes that Convex attests exactly.
    return !options.resolvedStartTime && !evidenceText;
  }
  if (options.evidence.status === "unreadable") {
    return !options.resolvedStartTime && evidenceIsBound;
  }
  if (options.evidence.status === "doors_open_only") {
    const withoutDoorClock = stripDoorOpeningClockValues(evidenceText);
    return (
      !options.resolvedStartTime &&
      evidenceIsBound &&
      withoutDoorClock !== evidenceText &&
      Boolean(extractEventTimeFromText(evidenceText))
    );
  }

  const startEvidence = stripDoorOpeningClockValues(evidenceText);
  const normalizedEvidenceTime = normalizeEventTime(startEvidence);
  const normalizedResolvedTime = normalizeEventTime(options.resolvedStartTime);
  return (
    Boolean(options.resolvedStartTime) &&
    evidenceIsBound &&
    startEvidence === evidenceText &&
    normalizedEvidenceTime.startLabel === normalizedResolvedTime.startLabel &&
    (!normalizedResolvedTime.endLabel ||
      normalizedEvidenceTime.endLabel === normalizedResolvedTime.endLabel)
  );
}

export function hasVerifiedSharedScheduleContext(
  value: ExtractedEventData["shared_schedule_context"]["venue" | "time"],
  post: InstagramScrapedPost,
  hasPoster: boolean,
  field: "venue" | "time",
): boolean {
  const normalizedValue = toSearchableText(value.value);
  const normalizedEvidence = toSearchableText(value.evidence);
  const evidenceSupportsValue =
    field === "venue"
      ? venueValueAppearsInEventEvidence(value.value, value.evidence)
      : normalizedEvidence.includes(normalizedValue);
  return (
    value.applies_to_all === true &&
    Boolean(normalizedValue) &&
    evidenceSupportsValue &&
    value.source !== "unknown" &&
    extractionEvidenceAppearsInPersistedSource({
      evidenceText: value.evidence,
      source: value.source,
      post,
      hasPoster,
    })
  );
}

export function isVerifiedEventVenueEvidence(options: {
  venue: string;
  rawEvidenceValue: string;
  extracted: ExtractedEventData;
  splitSourceLine: string | null;
  splitEvidenceSource: EventDateEvidenceSource;
  post: InstagramScrapedPost;
  hasPoster: boolean;
  trustedVenueSource: boolean;
  sharedVenueVerified: boolean;
  canonicalHandleEvidenceVerified?: boolean;
}): boolean {
  if (!normalizeString(options.venue)) return true;
  if (options.canonicalHandleEvidenceVerified) return true;
  if (options.trustedVenueSource) return true;

  const evidenceValues = [options.venue, options.rawEvidenceValue]
    .map((value) => normalizeString(value))
    .filter(Boolean);
  const supportsVenue = (text: string): boolean => {
    return Boolean(
      normalizeString(text) &&
        evidenceValues.some((value) =>
          venueValueAppearsInEventEvidence(value, text),
        ),
    );
  };
  const isBoundEvidence = (text: string, source: string): boolean => {
    if (source === "location_tag") {
      return Boolean(
        options.post.locationName &&
          toSearchableText(options.post.locationName).includes(toSearchableText(text)),
      );
    }
    if (source !== "caption" && source !== "poster" && source !== "alt_text") {
      return false;
    }
    return extractionEvidenceAppearsInPersistedSource({
      evidenceText: text,
      source,
      post: options.post,
      hasPoster: options.hasPoster,
    });
  };

  if (
    options.splitSourceLine &&
    supportsVenue(options.splitSourceLine) &&
    isBoundEvidence(options.splitSourceLine, options.splitEvidenceSource)
  ) {
    return true;
  }
  if (
    options.sharedVenueVerified &&
    supportsVenue(options.extracted.shared_schedule_context.venue.evidence) &&
    isBoundEvidence(
      options.extracted.shared_schedule_context.venue.evidence,
      options.extracted.shared_schedule_context.venue.source,
    )
  ) {
    return true;
  }
  if (
    options.post.locationName &&
    supportsVenue(options.post.locationName)
  ) {
    return true;
  }
  return [
    ...options.extracted.field_confirmation.location.evidence_snippets,
    ...options.extracted.field_confirmation.location_name.evidence_snippets,
  ].some(
    (snippet) =>
      supportsVenue(snippet.text) && isBoundEvidence(snippet.text, snippet.source),
  );
}

export function isVerifiedEventIdentityEvidence(options: {
  extracted: ExtractedEventData;
  title: string;
  artists: string[];
  titleUsedFallback: boolean;
  venue: string;
  splitSourceLine: string | null;
  singleScheduleEntrySource: boolean;
  splitEvidenceSource: EventDateEvidenceSource;
  post: InstagramScrapedPost;
  hasPoster: boolean;
  lineupSourceEvidence?: Array<{
    text: string;
    source: NightlifeLineupSource;
  }>;
  lineupTimingMode?: NightlifeLineupCoalescingPlan["timingMode"];
}): boolean {
  const supportsTitle = (text: string): boolean => {
    return titleIdentityAppearsInText(text, options.title);
  };
  const isBoundEvidence = (text: string, source: string): boolean => {
    if (source !== "caption" && source !== "poster" && source !== "alt_text") {
      return false;
    }
    return extractionEvidenceAppearsInPersistedSource({
      evidenceText: text,
      source,
      post: options.post,
      hasPoster: options.hasPoster,
    });
  };

  if (options.lineupSourceEvidence && options.lineupSourceEvidence.length >= 2) {
    const boundLineupEvidence = options.lineupSourceEvidence.filter((item) =>
      isBoundEvidence(item.text, item.source),
    );
    const afterMidnightContinuation =
      options.lineupTimingMode === "after_midnight_continuation";
    return (
      boundLineupEvidence.length === options.lineupSourceEvidence.length &&
      (afterMidnightContinuation
        ? supportsTitle(boundLineupEvidence[0]?.text ?? "")
        : titleContainsOnlyBilledArtists(options.title, options.artists)) &&
      options.artists.length > 0 &&
      options.artists.every((artist) =>
        boundLineupEvidence.some((item) =>
          artistIdentityAppearsInText(item.text, artist),
        ),
      )
    );
  }

  const titleSnippets = options.extracted.field_confirmation.title.evidence_snippets;
  const artistConfirmation = options.extracted.field_confirmation.artists;
  const artistSnippets = artistConfirmation.evidence_snippets;
  const expectedScheduleArtists = options.artists.map((artist) => toSearchableText(artist));
  const topLevelArtists = normalizeExtractedArtists(options.extracted.artists).map((artist) =>
    toSearchableText(normalizeArtistDisplayName(artist)),
  );
  const sharedDateEvidence = options.extracted.date_evidence;
  const sharedDateEvidenceBound =
    sharedDateEvidence.is_relative === false &&
    isBoundEvidence(sharedDateEvidence.exact_text, sharedDateEvidence.source);
  const sharedEvidenceDates = sharedDateEvidenceBound
    ? new Set([
        ...collectSupportedDates(sharedDateEvidence.exact_text, options.post.postedAt),
        ...collectSharedMonthDateListDates(
          sharedDateEvidence.exact_text,
          options.post.postedAt,
        ),
      ])
    : new Set<string>();
  const scheduleDates = options.extracted.schedule_entries.map((entry) =>
    normalizeEventDate(normalizeString(entry.date), null, options.post.postedAt).isoDate,
  );
  const sharedIdentitySourceText =
    sharedDateEvidence.source === "caption"
      ? options.post.caption
      : sharedDateEvidence.source === "alt_text"
        ? options.post.altText
        : null;
  const sharedIdentitySourceSegments = buildSharedScheduleIdentitySegments(
    sharedIdentitySourceText,
  );
  const scheduleDateSet = new Set(scheduleDates.filter((date): date is string => Boolean(date)));
  const segmentDates = (segment: string): Set<string> =>
    new Set([
      ...collectSupportedDates(segment, options.post.postedAt),
      ...collectSharedMonthDateListDates(segment, options.post.postedAt),
    ]);
  const dateBearingSegments = sharedIdentitySourceSegments
    .map((segment) => ({ segment, dates: segmentDates(segment) }))
    .filter(({ dates }) => [...dates].some((date) => scheduleDateSet.has(date)));
  const containsExactScheduleDateSet = (dates: Set<string>): boolean =>
    dates.size === scheduleDateSet.size &&
    [...scheduleDateSet].every((date) => dates.has(date));
  const identityAppliesToAllCue =
    /\b(?:ovog\s+vikenda|this\s+weekend|oba\s+dana|obe\s+ve[čc]eri|both\s+(?:days|nights)|svak(?:og|e)\s+(?:dana|ve[čc]eri)|every\s+(?:day|night))\b/iu;
  const sharedIdentitySegmentVerified = sharedIdentitySourceSegments.some((segment) => {
    const segmentHasIdentity =
      supportsTitle(segment) &&
      options.artists.every((artist) => artistIdentityAppearsInText(segment, artist));
    return (
      segmentHasIdentity &&
      (containsExactScheduleDateSet(segmentDates(segment)) ||
        identityAppliesToAllCue.test(segment))
    );
  });
  const sharedMultiDateIdentityVerified =
    options.extracted.schedule_entries.length > 1 &&
    toSearchableText(options.extracted.title) === toSearchableText(options.title) &&
    topLevelArtists.length === expectedScheduleArtists.length &&
    topLevelArtists.every(
      (artist, index) => artist === expectedScheduleArtists[index],
    ) &&
    scheduleDates.every((date): date is string => Boolean(date)) &&
    new Set(scheduleDates).size === scheduleDates.length &&
    sharedEvidenceDates.size === scheduleDates.length &&
    scheduleDates.every((date) => sharedEvidenceDates.has(date)) &&
    dateBearingSegments.length > 0 &&
    dateBearingSegments.every(({ dates }) => containsExactScheduleDateSet(dates)) &&
    sharedIdentitySegmentVerified &&
    options.extracted.schedule_entries.every((entry) => {
      const entryArtists = normalizeExtractedArtists(entry.artists).map((artist) =>
        toSearchableText(normalizeArtistDisplayName(artist)),
      );
      return (
        toSearchableText(entry.title) === toSearchableText(options.title) &&
        entryArtists.length === expectedScheduleArtists.length &&
        entryArtists.every(
          (artist, index) => artist === expectedScheduleArtists[index],
        )
      );
    });
  const mayUsePostLevelIdentityEvidence =
    !options.splitSourceLine ||
    options.singleScheduleEntrySource ||
    sharedMultiDateIdentityVerified;
  const boundEvidence = [
    ...(options.splitSourceLine &&
    isBoundEvidence(options.splitSourceLine, options.splitEvidenceSource)
      ? [{ text: options.splitSourceLine, source: options.splitEvidenceSource }]
      : []),
    ...(mayUsePostLevelIdentityEvidence
      ? titleSnippets.filter((snippet) => isBoundEvidence(snippet.text, snippet.source))
      : []),
    ...(mayUsePostLevelIdentityEvidence
      ? artistSnippets.filter((snippet) => isBoundEvidence(snippet.text, snippet.source))
      : []),
  ];
  if (options.titleUsedFallback) {
    const boundScheduleRow = Boolean(
      options.splitSourceLine &&
        isBoundEvidence(options.splitSourceLine, options.splitEvidenceSource),
    );
    const rowNamesVenue = Boolean(
      options.splitSourceLine &&
        options.venue &&
        specificVenueValueAppearsInUnnamedEventEvidence(
          options.venue,
          options.splitSourceLine,
        ),
    );
    const rowNamesEventKind = Boolean(
      options.splitSourceLine &&
        sourceEvidenceNamesSupportedUnnamedEventKind(options.splitSourceLine),
    );
    return (
      options.artists.length === 0 &&
      boundScheduleRow &&
      (rowNamesVenue || rowNamesEventKind)
    );
  }
  const boundTitleEvidence = boundEvidence.some((snippet) => supportsTitle(snippet.text));
  if (!boundTitleEvidence) return false;
  const artistConfirmationConfidence = normalizeConfidenceScore(artistConfirmation.confidence);
  const supplementalArtistEvidence = mayUsePostLevelIdentityEvidence ? [
    ...(artistConfirmationConfidence !== null &&
    artistConfirmationConfidence >= 0.7 &&
    artistConfirmation.found_in.some((source) => source.toLowerCase() === "caption") &&
    normalizeString(options.post.caption)
      ? [normalizeString(options.post.caption)]
      : []),
    ...(artistConfirmationConfidence !== null &&
    artistConfirmationConfidence >= 0.7 &&
    artistConfirmation.found_in.some((source) => source.toLowerCase() === "alt_text") &&
    normalizeString(options.post.altText)
      ? [normalizeString(options.post.altText)]
      : []),
  ] : [];
  return options.artists.every((artist) =>
    boundEvidence.some((snippet) => artistIdentityAppearsInText(snippet.text, artist)) ||
    supplementalArtistEvidence.some((text) => artistIdentityAppearsInText(text, artist)),
  );
}

export const MINOR_TITLE_CONNECTOR_TOKENS = new Set([
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

export function comparableTitleTokens(value: string): string[] {
  return toSearchableText(value)
    .split(/\s+/u)
    .filter((token) => token && !MINOR_TITLE_CONNECTOR_TOKENS.has(token));
}

export function titleIdentityAppearsInText(text: string, title: string): boolean {
  if (containsNormalizedTokenSequence(text, title)) return true;
  const textTokens = comparableTitleTokens(text);
  const titleTokens = comparableTitleTokens(title);
  if (titleTokens.length < 3 || titleTokens.length > textTokens.length) return false;
  return textTokens.some((_, startIndex) =>
    titleTokens.every((token, offset) => textTokens[startIndex + offset] === token),
  );
}

export function artistIdentityAppearsInText(text: string, artist: string): boolean {
  if (containsNormalizedTokenSequence(text, artist)) return true;

  const expectedTokens = toSearchableText(artist).split(/\s+/u).filter(Boolean);
  const observedTokens = toSearchableText(text).split(/\s+/u).filter(Boolean);
  if (expectedTokens.length < 2 || expectedTokens.length > observedTokens.length) {
    return false;
  }
  const tokensMatch = (expected: string, observed: string): boolean => {
    if (expected === observed || expected.length < 4) return expected === observed;
    if (expected.endsWith("a")) {
      const stem = expected.slice(0, -1);
      if ([`${stem}e`, `${stem}i`, `${stem}om`, `${stem}u`].includes(observed)) {
        return true;
      }
    }
    if (expected.endsWith("ac")) {
      const stem = expected.slice(0, -2);
      if ([`${stem}ca`, `${stem}cem`, `${stem}cu`].includes(observed)) {
        return true;
      }
    }
    return ["a", "e", "em", "i", "om", "u"].some(
      (suffix) => observed === `${expected}${suffix}`,
    );
  };
  const inflectedNameAppears = observedTokens.some((_, startIndex) =>
    expectedTokens.every((token, offset) =>
      tokensMatch(token, observedTokens[startIndex + offset] ?? ""),
    ),
  );
  if (inflectedNameAppears) return true;

  const expectedCompact = expectedTokens.join("");
  if (expectedCompact.length < 8) return false;
  return [...text.matchAll(/@([\p{L}\p{N}._-]+)/gu)].some((match) => {
    const handleCompact = toSearchableText(match[1] ?? "").replace(/\s+/gu, "");
    return (
      handleCompact === expectedCompact ||
      (handleCompact.length === expectedCompact.length + 1 &&
        handleCompact.startsWith(expectedCompact) &&
        handleCompact.at(-1) === expectedCompact.at(-1))
    );
  });
}
