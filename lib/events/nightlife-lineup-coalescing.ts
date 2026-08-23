import { normalizeEventTime, TBD_EVENT_TIME } from "./event-time.ts";
import { toSearchableText } from "../pipeline/venue-normalization.ts";

export const NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION = 1;

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
  timeEvidenceText: string;
  timeEvidenceVerified: boolean;
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
  timingMode: "shared_identical" | "shared_timetable" | "untimed_lineup";
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
        !titleContainsOnlyBilledArtists(candidate.title, candidate.artists) ||
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
    return null;
  }

  const artists = uniqueDisplayValues(
    orderedCandidates.flatMap((candidate) => candidate.artists),
  );
  const slots = orderedCandidates.map((candidate, index) => ({
    title: candidate.title.trim(),
    time: normalizedTimes[options.candidates.indexOf(candidate)] ?? "",
    artists: uniqueDisplayValues(candidate.artists),
    sourceText: candidate.sourceText.trim(),
    source: candidate.source,
  }));
  const title = formatDisplayList(orderedCandidates.map((candidate) => candidate.title));
  if (!titleContainsOnlyBilledArtists(title, artists)) return null;

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
