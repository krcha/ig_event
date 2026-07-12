import type { VenueHoursCacheFields } from "../venues/venue-hours-cache.ts";
import { looksLikeBareDate } from "./event-validation.ts";

const MISSING_EVENT_TIME_LABELS = new Set([
  "tba",
  "time tba",
  "tbd",
  "time tbd",
  "tbc",
  "time tbc",
  "n/a",
  "na",
  "none",
  "unknown",
]);
const TBD_EVENT_TIME_LABELS = new Set(["tbd", "time tbd"]);

export const TBD_EVENT_TIME = "TBD";
export const UNKNOWN_EVENT_TIME_LABEL = "Time not announced";

export type EventTimeSource =
  | "alt_text"
  | "caption"
  | "description"
  | "model"
  | "poster"
  | "schedule_entry"
  | "unknown";
export type EventTimeStatus = "confirmed" | "inferred" | "unknown";

export type EventTimeProvenance = {
  confidence: number;
  evidenceText: string | null;
  source: EventTimeSource;
  status: EventTimeStatus;
};

export type EventTimeProvenanceFields = {
  timeConfidence?: number | null;
  timeEvidenceText?: string | null;
  timeSource?: EventTimeSource | null;
  timeStatus?: EventTimeStatus | null;
};

export type ExtractedEventTimeEvidence = {
  evidence: string;
  time: string;
};

export type NormalizedEventTime = {
  allDay: boolean;
  description?: string;
  endLabel?: string;
  startLabel?: string;
};

export type EventDayPeriod = "day" | "night" | "unknown";
export type EventTimeDisplaySource = "event" | "unknown";

export type ResolvedEventTimeDisplay = {
  dayPeriod: EventDayPeriod;
  endLabel?: string;
  label: string;
  source: EventTimeDisplaySource;
  startLabel?: string;
};

function normalizeEventTimePlaceholder(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTbdEventTime(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && TBD_EVENT_TIME_LABELS.has(normalizeEventTimePlaceholder(trimmed)));
}

function formatTimeLabel(hours: number, minutes: number): string | undefined {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseTimeToken(
  value: string,
  options: { allowBareHour?: boolean } = {},
): string | undefined {
  const lower = value.trim().toLocaleLowerCase();
  const hasAm = /a\.?m\.?/i.test(lower);
  const hasPm = /p\.?m\.?/i.test(lower);
  const hasExplicitTimeMarker =
    /[:.,h]/i.test(lower) ||
    /(?:časova|casova|čas|cas|sati|sata|sat|hours?|hrs?|a\.?m\.?|p\.?m\.?)\b/iu.test(
      lower,
    );
  if (!hasExplicitTimeMarker && !options.allowBareHour) {
    return undefined;
  }

  const normalized = lower
    .replace(/(?:časova|casova|čas|cas|sati|sata|sat|hours?|hrs?)/giu, "h")
    .replace(/(?:a\.?m\.?|p\.?m\.?)\b/gi, "")
    .replace(/\s+/g, "")
    .replace(/,/g, ":")
    .replace(/\./g, ":")
    .replace(/^([0-9]{1,2})h([0-9]{2})$/, "$1:$2")
    .replace(/^([0-9]{1,2})h$/, "$1")
    .replace(/h$/g, "");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return undefined;
  }

  let hours = Number.parseInt(match[1], 10);
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (hasPm && hours >= 1 && hours < 12) {
    hours += 12;
  } else if (hasAm && hours === 12) {
    hours = 0;
  }
  return formatTimeLabel(hours, minutes);
}

function timeTokenHasExplicitMarker(value: string): boolean {
  const lower = value.trim().toLocaleLowerCase();
  return (
    /[:.,h]/i.test(lower) ||
    /(?:časova|casova|čas|cas|sati|sata|sat|hours?|hrs?|a\.?m\.?|p\.?m\.?)\b/iu.test(
      lower,
    )
  );
}

function parseCleanTimeRange(value: string): Pick<NormalizedEventTime, "endLabel" | "startLabel"> | null {
  const compactValue = value.replace(/\s+/g, " ").trim();
  const timeTokenPattern = String.raw`\d{1,2}(?:(?::|\.|h)\s*\d{2})?\s*h?`;
  const rangePattern = new RegExp(
    String.raw`^(?:at\s+|from\s+|od\s+)?(${timeTokenPattern})(?:\s*(?:-|–|—|/|to|do)\s*(${timeTokenPattern}))?$`,
    "i",
  );
  const match = compactValue.match(rangePattern);
  if (!match) {
    return null;
  }

  const startLabel = parseTimeToken(match[1]);
  const endLabel = match[2] ? parseTimeToken(match[2]) : undefined;
  if (!startLabel || (match[2] && !endLabel)) {
    return null;
  }

  return { startLabel, endLabel };
}

const EVENT_TIME_WORD_SUFFIX = String.raw`(?:h|časova|casova|čas|cas|sati|sata|sat|hrs?|hours?|a\.?m\.?|p\.?m\.?)`;
const EVENT_TIME_TOKEN_PATTERN = String.raw`(?:[01]?\d|2[0-3])(?:\s*(?:[:.,h])\s*[0-5]\d)?\s*${EVENT_TIME_WORD_SUFFIX}?`;
const EVENT_TIME_RANGE_CONNECTOR_PATTERN = String.raw`(?:-|–|—|/|\bto\b|\bdo\b)`;
const EVENT_TIME_CONTEXT_PATTERN = String.raw`(?:početak|pocetak|počinje|pocinje|kreće|krece|start(?:s|ing)?|begin(?:s|ning)?|doors(?:\s+open)?|vrata|kapije|program|nastup|svirka|show|from|od|at|u)`;
const DATE_MONTH_WORD_AFTER_TIME_RE = /^\s*\.\s*(?:do\b|jan(?:uar)?\b|januar[au]?\b|feb(?:ruar)?\b|februar[au]?\b|mar(?:t|ch)?\b|marta\b|apr(?:il)?\b|aprila\b|maj(?:a)?\b|jun(?:e|a|i)?\b|jul(?:y|a|i)?\b|avg(?:ust)?(?:a)?\b|aug(?:ust)?\b|sep(?:t|tember)?(?:a)?\b|okt(?:obar|obra)?\b|oct(?:ober)?\b|nov(?:embar|embra|ember)?\b|dec(?:embar|embra|ember)?\b|\d)/iu;
const PRICE_OR_AGE_WORD_NEAR_TIME_RE = /(?:\bulaz\b|\bkarte?\b|\btickets?\b|\bprice\b|\bcena\b|\bcijena\b|\brsd\b|\bdin(?:ara)?\b|\beur\b|€|\bkapacitet\b|\bage\b|\bages\b)/iu;

type ExtractedEventTimeCandidate = {
  endLabel?: string;
  evidence: string;
  index: number;
  rawEndToken?: string;
  rawStartToken: string;
  score: number;
  startLabel: string;
};

function hasDateLikeDotTimeToken(value: string): boolean {
  const match = value.trim().match(/^(\d{1,2})\s*\.\s*(\d{2})\b/u);
  if (!match) {
    return false;
  }

  const second = Number.parseInt(match[2], 10);
  return second >= 1 && second <= 12;
}

function getLocalTimeTokenContext(
  sourceText: string,
  tokenStart: number,
  tokenEnd: number,
): string {
  const windowStart = Math.max(0, tokenStart - 80);
  const windowEnd = Math.min(sourceText.length, tokenEnd + 80);
  const beforeWindow = sourceText.slice(windowStart, tokenStart);
  const afterWindow = sourceText.slice(tokenEnd, windowEnd);
  const priorBoundary = Math.max(
    beforeWindow.lastIndexOf("\n"),
    beforeWindow.lastIndexOf("."),
    beforeWindow.lastIndexOf("!"),
    beforeWindow.lastIndexOf("?"),
    beforeWindow.lastIndexOf(";"),
  );
  const nextBoundaryMatch = afterWindow.match(/[\n.!?;]/u);
  const before = beforeWindow.slice(priorBoundary + 1);
  const after = nextBoundaryMatch ? afterWindow.slice(0, nextBoundaryMatch.index) : afterWindow;
  return `${before} ${sourceText.slice(tokenStart, tokenEnd)} ${after}`.trim();
}

function hasRejectedTimeTokenContext(sourceText: string, tokenStart: number, tokenEnd: number): boolean {
  const before = sourceText.slice(Math.max(0, tokenStart - 64), tokenStart);
  const after = sourceText.slice(tokenEnd, Math.min(sourceText.length, tokenEnd + 64));
  if (/^\s*\+/.test(after)) {
    return true;
  }

  if (DATE_MONTH_WORD_AFTER_TIME_RE.test(after)) {
    return true;
  }

  const nearbyText = `${before} ${after}`;
  const localContext = getLocalTimeTokenContext(sourceText, tokenStart, tokenEnd);
  if (
    /(?:\bkapacitet\b|\bcapacity\b|\buzrast\b|\bage(?:s)?\b|\badresa\b|\baddress\b|\bulica\b|\bstreet\b|\bbroj(?:evi)?\b|\bnumber(?:s)?\b)[^.!?\n]{0,18}$/iu.test(before) ||
    /^\s*(?:ljudi|osoba|učesnika|ucesnika|people|persons?|guests?|mesta|places?)\b/iu.test(after)
  ) {
    return true;
  }
  if (
    /^\s*(?:godin(?:a|e|u|om|ama)?|years?\b)/iu.test(after) ||
    (/(?:\bulaz\b|\bentry\b|\buzrast\b|\bage(?:s)?\b)/iu.test(localContext) &&
      /\b(?:godin(?:a|e|u|om|ama)?|years?)\b/iu.test(localContext))
  ) {
    return true;
  }
  if (/\b(?:raspon|range)\b/iu.test(localContext)) {
    return true;
  }
  if (/\b(?:popust|discount)\b|%/iu.test(localContext)) {
    return true;
  }
  if (
    /\b(?:radno\s+(?:vreme|vrijeme)|working\s+hours?|opening\s+hours?|business\s+hours?|venue\s+hours?|hours?\s+of\s+operation)\b/iu.test(
      localContext,
    )
  ) {
    return true;
  }
  if (/^\s*(?:rsd|din(?:ara)?|eur|€|din\b)/iu.test(after) && PRICE_OR_AGE_WORD_NEAR_TIME_RE.test(nearbyText)) {
    return true;
  }

  if (/\b(?:od|from)\s*$/iu.test(before) && /^\s*(?:rsd|din(?:ara)?|eur|€|\+)/iu.test(after)) {
    return true;
  }

  return false;
}

function buildEventTimeCandidate(options: {
  allowBareEnd?: boolean;
  allowBareStart: boolean;
  endToken?: string;
  evidence: string;
  index: number;
  rawMatch: string;
  score: number;
  sourceText: string;
  startToken: string;
}): ExtractedEventTimeCandidate | null {
  const startTokenOffset = options.rawMatch.indexOf(options.startToken);
  const tokenStart = options.index + Math.max(0, startTokenOffset);
  const tokenEnd = tokenStart + options.startToken.length;
  if (
    hasDateLikeDotTimeToken(options.startToken) ||
    hasRejectedTimeTokenContext(options.sourceText, tokenStart, tokenEnd)
  ) {
    return null;
  }

  const startLabel = parseTimeToken(options.startToken, {
    allowBareHour: options.allowBareStart,
  });
  if (!startLabel) {
    return null;
  }

  let endLabel: string | undefined;
  if (options.endToken) {
    const endTokenOffset = options.rawMatch.lastIndexOf(options.endToken);
    const endTokenStart = options.index + Math.max(0, endTokenOffset);
    const endTokenEnd = endTokenStart + options.endToken.length;
    if (
      hasDateLikeDotTimeToken(options.endToken) ||
      hasRejectedTimeTokenContext(options.sourceText, endTokenStart, endTokenEnd)
    ) {
      return null;
    }
    endLabel = parseTimeToken(options.endToken, {
      allowBareHour: options.allowBareEnd ?? true,
    });
    if (!endLabel) {
      return null;
    }
  }

  return {
    ...(endLabel ? { endLabel, rawEndToken: options.endToken } : {}),
    evidence: options.evidence,
    index: tokenStart,
    rawStartToken: options.startToken,
    score: options.score,
    startLabel,
  };
}

function formatExtractedTimeCandidate(candidate: ExtractedEventTimeCandidate): string {
  return candidate.endLabel ? `${candidate.startLabel}-${candidate.endLabel}` : candidate.startLabel;
}

/**
 * Extract a clock start time from free-form event text. This intentionally accepts
 * Balkan/English caption phrasing ("od 9", "početak 21h", "u 20.30",
 * bare "22:30") while rejecting common dates, prices, and age limits.
 */
export function extractEventTimeFromText(value: string | null | undefined): string | undefined {
  return extractEventTimeEvidenceFromText(value)?.time;
}

/** Return a normalized clock value together with the exact matched source snippet. */
export function extractEventTimeEvidenceFromText(
  value: string | null | undefined,
): ExtractedEventTimeEvidence | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  const candidates: ExtractedEventTimeCandidate[] = [];
  const contextPattern = new RegExp(
    String.raw`(^|[^\p{L}\d])${EVENT_TIME_CONTEXT_PATTERN}\s*(?:je|su|se|u|at|from|od|starts?|begins?|open|opens|:|-)?\s*(${EVENT_TIME_TOKEN_PATTERN})(?:\s*${EVENT_TIME_RANGE_CONNECTOR_PATTERN}\s*(${EVENT_TIME_TOKEN_PATTERN}))?(?=$|[^\d])`,
    "giu",
  );
  for (const match of text.matchAll(contextPattern)) {
    const rawMatch = match[0] ?? "";
    const startToken = match[2];
    if (!startToken) {
      continue;
    }
    const candidate = buildEventTimeCandidate({
      allowBareStart: true,
      endToken: match[3],
      evidence: rawMatch.slice((match[1] ?? "").length).trim(),
      index: match.index ?? 0,
      rawMatch,
      score: match[3] ? 120 : 110,
      sourceText: text,
      startToken,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const explicitPattern = new RegExp(
    String.raw`(^|[^\d])(${EVENT_TIME_TOKEN_PATTERN})(?:\s*${EVENT_TIME_RANGE_CONNECTOR_PATTERN}\s*(${EVENT_TIME_TOKEN_PATTERN}))?(?=$|[^\d])`,
    "giu",
  );
  for (const match of text.matchAll(explicitPattern)) {
    const rawMatch = match[0] ?? "";
    const startToken = match[2];
    if (!startToken) {
      continue;
    }
    const endToken = match[3];
    const startHasMarker = timeTokenHasExplicitMarker(startToken);
    const endHasMarker = endToken ? timeTokenHasExplicitMarker(endToken) : false;
    if (!startHasMarker && !endHasMarker) {
      continue;
    }
    const candidate = buildEventTimeCandidate({
      allowBareEnd: startHasMarker,
      allowBareStart: Boolean(endToken && endHasMarker),
      endToken,
      evidence: rawMatch.slice((match[1] ?? "").length).trim(),
      index: match.index ?? 0,
      rawMatch,
      score: endToken ? 90 : 80,
      sourceText: text,
      startToken,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0]
    ? {
        evidence: candidates[0].evidence,
        time: formatExtractedTimeCandidate(candidates[0]),
      }
    : undefined;
}

export function getEventTimeProvenanceLabel(
  provenance: EventTimeProvenance | null | undefined,
): string {
  if (!provenance || provenance.status === "unknown") {
    return "No confirmed start-time source";
  }

  const sourceLabel: Record<EventTimeSource, string> = {
    alt_text: "poster OCR",
    caption: "caption",
    description: "description",
    model: "AI extraction",
    poster: "poster",
    schedule_entry: "schedule row",
    unknown: "unknown source",
  };
  return `${provenance.status === "confirmed" ? "Confirmed" : "Inferred"} from ${sourceLabel[provenance.source]}`;
}

export function resolveEventTimeProvenance(
  fields: EventTimeProvenanceFields | null | undefined,
): EventTimeProvenance {
  const confidence = fields?.timeConfidence;
  const evidenceText = fields?.timeEvidenceText?.trim() || null;
  const source = fields?.timeSource ?? "unknown";
  const status = fields?.timeStatus ?? "unknown";

  if (status === "unknown" || source === "unknown") {
    return {
      confidence: 0,
      evidenceText: null,
      source: "unknown",
      status: "unknown",
    };
  }

  return {
    confidence:
      typeof confidence === "number" && Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : 0,
    evidenceText,
    source,
    status,
  };
}

function shouldExtractTextTimeForTimeField(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length > 72 || /[;\n\r]/u.test(trimmed)) {
    return false;
  }

  const searchable = normalizeEventTimePlaceholder(trimmed);
  const startsWithTimeCue = /^(?:at|from|od|u|pocetak|pocinje|krece|start|starts|starting|begin|begins|beginning|doors|vrata|kapije|program|nastup|svirka|show)\b/u.test(
    searchable,
  );
  if (startsWithTimeCue) {
    return true;
  }

  const nonCueWords = searchable
    .split(/\s+/u)
    .filter((token) => /[a-z]/iu.test(token))
    .filter(
      (token) =>
        !/^(?:at|from|od|u|pocetak|pocinje|krece|start|starts|starting|begin|begins|beginning|doors|open|opens|vrata|kapije|program|nastup|svirka|show|am|pm|h|cas|casova|sati|sata|sat)$/u.test(
          token,
        ),
    );
  return nonCueWords.length <= 1;
}

export function normalizeEventTime(value: string | null | undefined): NormalizedEventTime {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { allDay: true };
  }

  const normalizedPlaceholder = normalizeEventTimePlaceholder(trimmed);
  if (MISSING_EVENT_TIME_LABELS.has(normalizedPlaceholder)) {
    return { allDay: true };
  }

  if (looksLikeBareDate(trimmed)) {
    return { allDay: true };
  }

  const cleanTimeRange = parseCleanTimeRange(trimmed);
  if (cleanTimeRange) {
    return {
      allDay: false,
      ...cleanTimeRange,
    };
  }

  const extractedTextTime = shouldExtractTextTimeForTimeField(trimmed)
    ? extractEventTimeFromText(trimmed)
    : undefined;
  const extractedCleanTimeRange = extractedTextTime ? parseCleanTimeRange(extractedTextTime) : null;
  if (extractedCleanTimeRange) {
    return {
      allDay: false,
      ...extractedCleanTimeRange,
      description: trimmed,
    };
  }

  return {
    allDay: true,
    description: trimmed,
  };
}

export function getDisplayEventTime(value: string | null | undefined): string | undefined {
  const normalized = normalizeEventTime(value);
  if (!normalized.startLabel) {
    return undefined;
  }

  return normalized.endLabel
    ? `${normalized.startLabel}–${normalized.endLabel}`
    : normalized.startLabel;
}

export function getEventTimeSortMinutes(value: string | null | undefined): number | null {
  const normalized = normalizeEventTime(value);
  if (!normalized.startLabel) {
    return null;
  }

  const [hours, minutes] = normalized.startLabel.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

export function getDayPeriodForStartTime(value: string | null | undefined): EventDayPeriod {
  const minutes = getEventTimeSortMinutes(value);
  if (minutes === null) {
    return "unknown";
  }

  return minutes >= 8 * 60 && minutes < 18 * 60 ? "day" : "night";
}

export function resolveEventTimeDisplay(options: {
  date: string;
  time?: string | null;
  venueHours?: VenueHoursCacheFields | null;
}): ResolvedEventTimeDisplay {
  // Venue opening hours are separate venue context, never event start-time evidence.
  const eventTime = normalizeEventTime(options.time);
  if (eventTime.startLabel) {
    return {
      dayPeriod: getDayPeriodForStartTime(eventTime.startLabel),
      ...(eventTime.endLabel ? { endLabel: eventTime.endLabel } : {}),
      label: eventTime.endLabel
        ? `${eventTime.startLabel}–${eventTime.endLabel}`
        : eventTime.startLabel,
      source: "event",
      startLabel: eventTime.startLabel,
    };
  }

  return {
    dayPeriod: "unknown",
    label: UNKNOWN_EVENT_TIME_LABEL,
    source: "unknown",
  };
}
