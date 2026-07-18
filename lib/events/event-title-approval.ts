const DATE_OR_TIME_FRAGMENT = /^(?:\p{L}+\s+)?\d{1,2}(?:[./-]\d{1,2})?(?:[./-]\d{2,4})?(?:\s*(?:h|č|casova|hours?))?$/iu;
const ADDRESS_FRAGMENT = /^(?:[\p{L}.'’ -]+\s+)?\d{1,4}(?:\s+\d{1,2}(?:st|nd|rd|th)\s+(?:floor|sprat)|\s*(?:floor|sprat))?$/iu;
const BROKEN_SENTENCE_PREFIX = /^(?:i|a|ali|pa|te|koji|koja|koje|and|but)\s+/iu;
const GENERIC_ONLY_TITLE = /^(?:event|dogadjaj|događaj|program|schedule|raspored|premijera|premiere|naredna igranja|final|finale|party|concert|koncert|live music|muzika|subota|petak|saturday|friday)$/iu;
const GENERIC_HOURS_TITLE = /^(?:opening|working|business|venue)?\s*hours?$|^radno\s+vreme$/iu;
const MENU_PROMOTION_TITLE = /^(?:special|specials|promo|promotion|ponuda)\b.*\b(?:pizzas?|pice?|burgers?|koktels?|cocktails?|food|hrana|menu)\b/iu;

function normalizeComparableText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSensibleEventTitleForApproval(options: {
  title: unknown;
  venue?: unknown;
}): boolean {
  const title = typeof options.title === "string" ? options.title.trim() : "";
  const normalizedTitle = normalizeComparableText(title);
  const normalizedVenue = normalizeComparableText(options.venue);

  if (!normalizedTitle || normalizedTitle.length < 3) {
    return false;
  }
  if (normalizedVenue && normalizedTitle === normalizedVenue) {
    return false;
  }
  if (DATE_OR_TIME_FRAGMENT.test(title) || ADDRESS_FRAGMENT.test(title)) {
    return false;
  }
  if (BROKEN_SENTENCE_PREFIX.test(title) || GENERIC_ONLY_TITLE.test(title)) {
    return false;
  }
  if (
    GENERIC_HOURS_TITLE.test(normalizedTitle) ||
    (normalizedVenue &&
      normalizedTitle.startsWith(`${normalizedVenue} `) &&
      /\bhours?$/.test(normalizedTitle)) ||
    MENU_PROMOTION_TITLE.test(normalizedTitle)
  ) {
    return false;
  }
  if (/^(?:https?:\/\/|www\.)/iu.test(title)) {
    return false;
  }

  return /\p{L}/u.test(title);
}
