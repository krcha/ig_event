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

function normalizeEventTimePlaceholder(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getDisplayEventTime(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeEventTimePlaceholder(trimmed);
  return MISSING_EVENT_TIME_LABELS.has(normalized) ? undefined : trimmed;
}
