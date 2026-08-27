import { normalizeEventTime, TBD_EVENT_TIME } from "./event-time.ts";
import { toSearchableText } from "../pipeline/venue-normalization.ts";

export const NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION = 2;

export type NightlifeLineupSource = "caption" | "poster" | "alt_text" | "unknown";

export type NightlifeLineupCandidate = {
  id: string;
  title: string;
  date: string;
  time?: string | null;
  venue: string;
  artists: string[];
  sourceText: string;
  source: NightlifeLineupSource;
  sourcePostIdentity?: string;
  timeEvidenceText: string;
  timeEvidenceVerified: boolean;
  timeEvidenceKind?:
    | "start_time_stated"
    | "not_stated"
    | "unreadable"
    | "doors_open_only";
};

export type NightlifeLineupSlot = {
  title: string;
  time: string;
  artists: string[];
  sourceText: string;
  source: NightlifeLineupSource;
};

export type NightlifeLineupCoalescingPlan = {
  candidateIds: string[];
  title: string;
  date: string;
  time: string;
  venue: string;
  artists: string[];
  description: string;
  sourceTexts: string[];
  slots: NightlifeLineupSlot[];
  timingMode:
    | "shared_identical"
    | "shared_timetable"
    | "untimed_lineup"
    | "after_midnight_continuation";
};

type TimelineRange = {
  start: number;
  end: number;
  value: string;
};

const LINEUP_CONNECTOR_TOKENS = new Set([
  "and",
  "b2b",
  "dj",
  "i",
  "vs",
  "x",
]);

function uniqueDisplayValues(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const value = rawValue.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const key = toSearchableText(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function comparableIdentityTokens(value: string): string[] {
  return toSearchableText(value)
    .split(/\s+/u)
    .filter(Boolean)
    .filter((token) => !LINEUP_CONNECTOR_TOKENS.has(token));
}

export function titleContainsOnlyBilledArtists(
  title: string,
  artists: string[],
): boolean {
  if (artists.length === 0) return false;
  const titleTokens = comparableIdentityTokens(title);
  const artistTokens = artists.flatMap(comparableIdentityTokens);
  return (
    titleTokens.length > 0 &&
    titleTokens.length === artistTokens.length &&
    titleTokens.every((token, index) => token === artistTokens[index])
  );
}

function formatDisplayList(values: string[]): string {
  const unique = uniqueDisplayValues(values);
  if (unique.length <= 2) return unique.join(" & ");
  return `${unique.slice(0, -1).join(", ")} & ${unique.at(-1)}`;
}

function timeLabelToMinutes(value: string | undefined): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value ?? "");
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function readTimelineRange(
  value: string | null | undefined,
  anchorStart: number,
): TimelineRange | null {
  const normalized = normalizeEventTime(value);
  const rawStart = timeLabelToMinutes(normalized.startLabel);
  const rawEnd = timeLabelToMinutes(normalized.endLabel);
  if (rawStart === null || rawEnd === null) return null;
  const start = rawStart < anchorStart ? rawStart + 24 * 60 : rawStart;
  let end = rawEnd <= rawStart ? rawEnd + 24 * 60 : rawEnd;
  if (end <= start) end += 24 * 60;
  return {
    start,
    end,
    value: `${normalized.startLabel}-${normalized.endLabel}`,
  };
}

function sourceTextContainsTimeRange(time: string | null | undefined, sourceText: string): boolean {
  const normalized = normalizeEventTime(time);
  if (!normalized.startLabel || !normalized.endLabel) return false;
  const comparableRange = toSearchableText(
    `${normalized.startLabel} ${normalized.endLabel}`,
  );
  return Boolean(comparableRange && toSearchableText(sourceText).includes(comparableRange));
}

function sourceTextContainsStartTime(
  time: string | null | undefined,
  sourceText: string,
): boolean {
  const startLabel = normalizeEventTime(time).startLabel;
  if (!startLabel) return false;
  const [rawHours, rawMinutes] = startLabel.split(":");
  const hours = Number.parseInt(rawHours ?? "", 10);
  const minutes = Number.parseInt(rawMinutes ?? "", 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return false;
  const minuteText = String(minutes).padStart(2, "0");
  const normalizedSource = sourceText.normalize("NFKC").toLocaleLowerCase("sr-Latn");
  const hourSuffixPattern =
    minutes === 0 ? "\\s*h(?:\\s*00)?" : `\\s*h\\s*${minuteText}`;
  const clockPattern = new RegExp(
    `(?:^|\\D)${hours}(?:\\s*[:.]\\s*${minuteText}|${hourSuffixPattern})(?:\\D|$)`,
    "u",
  );
  if (clockPattern.test(normalizedSource)) return true;
  const twelveHour = hours % 12 || 12;
  const meridiem = hours >= 12 ? "p" : "a";
  const twelveHourMinutes =
    minutes === 0 ? `(?:\\s*[:.]\\s*${minuteText})?` : `\\s*[:.]\\s*${minuteText}`;
  const twelveHourPattern = new RegExp(
    `(?:^|\\D)${twelveHour}${twelveHourMinutes}\\s*${meridiem}\\.?\\s*m\\.?(?:\\D|$)`,
    "u",
  );
  return twelveHourPattern.test(normalizedSource);
}

function sourceTextContainsIdentity(sourceText: string, identity: string): boolean {
  const sourceTokens = comparableIdentityTokens(sourceText);
  const identityTokens = comparableIdentityTokens(identity);
  if (identityTokens.length === 0 || identityTokens.length > sourceTokens.length) {
    return false;
  }
  return sourceTokens.some((_, startIndex) =>
    identityTokens.every(
      (token, offset) => sourceTokens[startIndex + offset] === token,
    ),
  );
}

/**
 * This is intentionally a phrase-level proof, not a loose "midnight" hint.
 * The row must state both the after-midnight boundary and a takeover verb.
 */
export function explicitlyStatesAfterMidnightTakeover(sourceText: string): boolean {
  const normalized = toSearchableText(sourceText);
  if (!normalized) return false;
  const englishContinuation =
    /\bafter midnight(?:\s+\S+){0,12}\s+(?:take over|takes over|taking over)\b/u;
  const serbianContinuation =
    /\b(?:posle|nakon|iza|od) ponoci(?:\s+\S+){0,12}\s+preuzim(?:a|aju)\b/u;
  return (
    englishContinuation.test(normalized) || serbianContinuation.test(normalized)
  );
}

function buildAfterMidnightContinuationPlan(options: {
  candidates: NightlifeLineupCandidate[];
  normalizedTimes: string[];
}): {
  orderedCandidates: NightlifeLineupCandidate[];
  time: string;
} | null {
  if (options.candidates.length !== 2) return null;
  const timedCandidates = options.candidates.filter(
    (candidate, index) =>
      Boolean(options.normalizedTimes[index]) &&
      candidate.timeEvidenceKind === "start_time_stated" &&
      candidate.timeEvidenceVerified,
  );
  const untimedCandidates = options.candidates.filter(
    (candidate, index) =>
      !options.normalizedTimes[index] &&
      (candidate.timeEvidenceKind === "not_stated" ||
        candidate.timeEvidenceKind === "unreadable"),
  );
  if (timedCandidates.length !== 1 || untimedCandidates.length !== 1) return null;

  const primary = timedCandidates[0]!;
  const continuation = untimedCandidates[0]!;
  const primaryTime = options.normalizedTimes[options.candidates.indexOf(primary)]!;
  const primaryPostIdentity = primary.sourcePostIdentity?.normalize("NFKC").trim() ?? "";
  const continuationPostIdentity =
    continuation.sourcePostIdentity?.normalize("NFKC").trim() ?? "";
  if (
    !primaryPostIdentity ||
    continuationPostIdentity !== primaryPostIdentity ||
    primary.source === "unknown" ||
    continuation.source !== primary.source ||
    primary.artists.length === 0 ||
    continuation.artists.length === 0 ||
    !primary.title.trim() ||
    !titleContainsOnlyBilledArtists(continuation.title, continuation.artists) ||
    !sourceTextContainsStartTime(primary.time, primary.sourceText) ||
    !sourceTextContainsStartTime(primary.time, primary.timeEvidenceText) ||
    !sourceTextContainsIdentity(primary.sourceText, primary.title) ||
    primary.artists.some(
      (artist) => !sourceTextContainsIdentity(primary.sourceText, artist),
    ) ||
    !explicitlyStatesAfterMidnightTakeover(continuation.sourceText) ||
    continuation.artists.some(
      (artist) => !sourceTextContainsIdentity(continuation.sourceText, artist),
    )
  ) {
    return null;
  }
  return {
    orderedCandidates: [primary, continuation],
    time: primaryTime,
  };
}

function formatLineupDescription(
  slots: NightlifeLineupSlot[],
  artists: string[],
  timingMode: NightlifeLineupCoalescingPlan["timingMode"],
): string {
  if (timingMode === "shared_timetable") {
    const timetable = slots
      .map((slot) => `${slot.time.replace("-", "–")} ${slot.title}`)
      .join("; ");
    if (timetable.length <= 240) return `${timetable}.`;
  }
  const lineup = `Lineup: ${formatDisplayList(artists)}.`;
  if (timingMode === "after_midnight_continuation") {
    const continuationArtists = slots.at(-1)?.artists ?? [];
    const continuationName = formatDisplayList(continuationArtists);
    const takeover = continuationName
      ? `${continuationName} ${continuationArtists.length === 1 ? "takes" : "take"} over after midnight.`
      : "After-midnight continuation.";
    const runningOrder = `${lineup.slice(0, -1)}; ${takeover}`;
    return runningOrder.length <= 240 ? runningOrder : takeover;
  }
  return lineup.length <= 240 ? lineup : "Nightlife lineup event.";
}

/**
 * Recognize performer rows that are a running order inside one nightlife
 * occurrence. This deliberately does not merge independently named shows.
 */
export function buildNightlifeLineupCoalescingPlan(options: {
  eventType: string;
  candidates: NightlifeLineupCandidate[];
  sourceConflictCount: number;
  sharedTime?: {
    value: string;
    verified: boolean;
  };
}): NightlifeLineupCoalescingPlan | null {
  if (
    toSearchableText(options.eventType) !== "nightlife" ||
    options.sourceConflictCount !== 0 ||
    options.candidates.length < 2
  ) {
    return null;
  }

  const date = options.candidates[0]?.date.trim() ?? "";
  const venue = options.candidates[0]?.venue.trim() ?? "";
  const venueKey = toSearchableText(venue);
  if (
    !date ||
    !venueKey ||
    options.candidates.some(
      (candidate) =>
        candidate.date.trim() !== date ||
        toSearchableText(candidate.venue) !== venueKey ||
        !candidate.sourceText.trim() ||
        candidate.source === "unknown",
    )
  ) {
    return null;
  }

  const normalizedTimes = options.candidates.map((candidate) => {
    const raw = candidate.time?.trim() ?? "";
    if (!raw || raw === TBD_EVENT_TIME) return "";
    const normalized = normalizeEventTime(raw);
    return normalized.startLabel
      ? `${normalized.startLabel}${normalized.endLabel ? `-${normalized.endLabel}` : ""}`
      : "";
  });
  let timingMode: NightlifeLineupCoalescingPlan["timingMode"];
  let eventTime = "";
  let orderedCandidates = [...options.candidates];

  // Only a source-bound running order inside one verified overall window is
  // safe to consolidate deterministically. Untimed artist rows and rows that
  // merely repeat one start time can also be independent same-night shows, so
  // leave those shapes to the model or moderation queue.
  if (
    options.candidates.every((candidate) =>
      titleContainsOnlyBilledArtists(candidate.title, candidate.artists),
    ) &&
    normalizedTimes.every(Boolean) &&
    new Set(normalizedTimes).size > 1 &&
    options.candidates.every(
      (candidate) =>
        candidate.timeEvidenceVerified &&
        sourceTextContainsTimeRange(candidate.time, candidate.sourceText) &&
        sourceTextContainsTimeRange(candidate.time, candidate.timeEvidenceText),
    )
  ) {
    const sharedNormalized = normalizeEventTime(options.sharedTime?.value);
    const sharedStart = timeLabelToMinutes(sharedNormalized.startLabel);
    const sharedEnd = timeLabelToMinutes(sharedNormalized.endLabel);
    if (
      options.sharedTime?.verified !== true ||
      sharedStart === null ||
      sharedEnd === null
    ) {
      return null;
    }
    const sharedRange = readTimelineRange(options.sharedTime.value, sharedStart);
    const candidateRanges = options.candidates.map((candidate) =>
      readTimelineRange(candidate.time, sharedStart),
    );
    if (!sharedRange || candidateRanges.some((range) => range === null)) return null;
    const ordered = options.candidates
      .map((candidate, index) => ({ candidate, range: candidateRanges[index]! }))
      .sort((left, right) => left.range.start - right.range.start);
    if (
      ordered[0]?.range.start !== sharedRange.start ||
      ordered.at(-1)?.range.end !== sharedRange.end ||
      ordered.some(
        (item, index) =>
          index > 0 && item.range.start !== ordered[index - 1]?.range.end,
      )
    ) {
      return null;
    }
    timingMode = "shared_timetable";
    eventTime = sharedRange.value;
    orderedCandidates = ordered.map((item) => item.candidate);
  } else {
    const continuationPlan = buildAfterMidnightContinuationPlan({
      candidates: options.candidates,
      normalizedTimes,
    });
    if (!continuationPlan) return null;
    timingMode = "after_midnight_continuation";
    eventTime = continuationPlan.time;
    orderedCandidates = continuationPlan.orderedCandidates;
  }

  const artists = uniqueDisplayValues(
    orderedCandidates.flatMap((candidate) => candidate.artists),
  );
  const slots = orderedCandidates.map((candidate) => ({
    title: candidate.title.trim(),
    time: normalizedTimes[options.candidates.indexOf(candidate)] ?? "",
    artists: uniqueDisplayValues(candidate.artists),
    sourceText: candidate.sourceText.trim(),
    source: candidate.source,
  }));
  const title = timingMode === "after_midnight_continuation"
    ? orderedCandidates[0]!.title.trim()
    : formatDisplayList(orderedCandidates.map((candidate) => candidate.title));
  if (
    timingMode !== "after_midnight_continuation" &&
    !titleContainsOnlyBilledArtists(title, artists)
  ) {
    return null;
  }

  return {
    candidateIds: orderedCandidates.map((candidate) => candidate.id),
    title,
    date,
    time: eventTime,
    venue,
    artists,
    description: formatLineupDescription(slots, artists, timingMode),
    sourceTexts: slots.map((slot) => slot.sourceText),
    slots,
    timingMode,
  };
}
