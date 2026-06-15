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

export type NormalizedEventTime = {
  allDay: boolean;
  description?: string;
  endLabel?: string;
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

function formatTimeLabel(hours: number, minutes: number): string | undefined {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseTimeToken(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, ":")
    .replace(/^([0-9]{1,2})h([0-9]{2})$/, "$1:$2")
    .replace(/^([0-9]{1,2})h$/, "$1")
    .replace(/h$/g, "");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return undefined;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  return formatTimeLabel(hours, minutes);
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

export function normalizeEventTime(value: string | null | undefined): NormalizedEventTime {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { allDay: true };
  }

  const normalizedPlaceholder = normalizeEventTimePlaceholder(trimmed);
  if (MISSING_EVENT_TIME_LABELS.has(normalizedPlaceholder)) {
    return { allDay: true };
  }

  const cleanTimeRange = parseCleanTimeRange(trimmed);
  if (cleanTimeRange) {
    return {
      allDay: false,
      ...cleanTimeRange,
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
