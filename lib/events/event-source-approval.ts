import { isSensibleEventTitleForApproval } from "./event-title-approval.ts";

const MONTH_NAMES: Record<number, string[]> = {
  1: ["jan", "january", "januar", "januara"],
  2: ["feb", "february", "februar", "februara"],
  3: ["mar", "march", "mart", "marta"],
  4: ["apr", "april", "aprila"],
  5: ["may", "maj", "maja"],
  6: ["jun", "june", "juna"],
  7: ["jul", "july", "jula"],
  8: ["aug", "august", "avgust", "avgusta"],
  9: ["sep", "sept", "september", "septembar", "septembra"],
  10: ["oct", "october", "oktobar", "oktobra"],
  11: ["nov", "november", "novembar", "novembra"],
  12: ["dec", "december", "decembar", "decembra"],
};

function normalizeText(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function stripHashtagIdentityTokens(value: string): string {
  return value.replace(/#[\p{L}\p{N}._-]+/gu, " ");
}

function containsTokenSequence(value: string, identity: unknown): boolean {
  const valueTokens = normalizeText(value).split(/\s+/u).filter(Boolean);
  const identityTokens = normalizeText(identity).split(/\s+/u).filter(Boolean);
  if (identityTokens.length === 0 || identityTokens.length > valueTokens.length) {
    return false;
  }
  return valueTokens.some((_, index) =>
    identityTokens.every((token, offset) => valueTokens[index + offset] === token),
  );
}

function hasNonHashtagIdentity(value: string, identity: unknown): boolean {
  return containsTokenSequence(stripHashtagIdentityTokens(value), identity);
}

function normalizeHandleExact(value: unknown): string {
  return typeof value === "string" ? value.replace(/^@+/, "").trim().toLowerCase() : "";
}

const DOOR_CLOCK_PATTERN =
  /\b(?:vrata(?:\s+se)?\s+otvaraju|doors?\s+open(?:s)?)[^\n.!?]{0,40}?(?:u|at)?\s*(?:[01]?\d|2[0-3])(?:[:.]?[0-5]\d)?\s*h?\b/giu;
const EVENT_CLOCK_PATTERN =
  /(?:^|\D)(?:[01]?\d|2[0-3])(?::|\.)[0-5]\d(?:\s*h)?(?:\D|$)|(?:^|\D)(?:[01]?\d|2[0-3])\s*h(?:[0-5]\d)?(?:\D|$)/iu;

function stripDoorOpeningClocks(value: string): string {
  return value.replace(DOOR_CLOCK_PATTERN, " ");
}

function hasExplicitTime(segment: string, eventTime: unknown): boolean {
  const withoutDoorClocks = stripDoorOpeningClocks(segment);
  if (typeof eventTime !== "string" || !eventTime.trim() || eventTime.trim().toUpperCase() === "TBD") {
    return !EVENT_CLOCK_PATTERN.test(withoutDoorClocks);
  }
  const match = /^(\d{1,2}):(\d{2})/u.exec(eventTime.trim());
  if (!match) {
    return false;
  }
  const hour = Number(match[1]);
  const minute = match[2];
  const numericTime = new RegExp(
    `(?:^|\\D)0?${hour}(?::|\\.|h)${minute}(?:\\D|$)`,
    "u",
  );
  if (numericTime.test(withoutDoorClocks)) {
    return true;
  }
  return (
    minute === "00" &&
    new RegExp(`(?:^|\\D)0?${hour}\\s*(?:h|casova)(?:\\D|$)`, "u").test(
      withoutDoorClocks,
    )
  );
}

function normalizeTwoDigitYear(value: string): number {
  const parsed = Number(value);
  return value.length === 2 ? 2000 + parsed : parsed;
}

function inferredYearIsPlausible(isoDate: string, postedAt: unknown): boolean {
  if (typeof postedAt !== "string" || !postedAt.trim()) {
    return false;
  }
  const postedMs = Date.parse(postedAt);
  const expectedMs = Date.parse(`${isoDate}T12:00:00.000Z`);
  if (!Number.isFinite(postedMs) || !Number.isFinite(expectedMs)) {
    return false;
  }
  const deltaDays = (expectedMs - postedMs) / 86_400_000;
  return deltaDays >= -7 && deltaDays <= 370;
}

function hasExplicitDate(segment: string, isoDate: unknown, postedAt: unknown): boolean {
  if (typeof isoDate !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = segment
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  for (const numeric of normalized.matchAll(
    /(?:^|\D)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?(?=\D|$)/gu,
  )) {
    if (Number(numeric[1]) !== day || Number(numeric[2]) !== month) {
      continue;
    }
    const sourceYear = numeric[3];
    if (sourceYear) {
      if (normalizeTwoDigitYear(sourceYear) === year) {
        return true;
      }
      continue;
    }
    if (inferredYearIsPlausible(isoDate, postedAt)) {
      return true;
    }
  }

  return (MONTH_NAMES[month] ?? []).some((name) => {
    const dayFirst = new RegExp(
      `(?:^|\\s)0?${day}\\.?\\s+${name}(?:a)?(?:\\s+(\\d{2}|\\d{4}))?(?:\\s|$)`,
      "u",
    ).exec(normalized);
    const monthFirst = new RegExp(
      `(?:^|\\s)${name}\\s+0?${day}(?:st|nd|rd|th)?(?:\\s+(\\d{2}|\\d{4}))?(?:\\s|$)`,
      "u",
    ).exec(normalized);
    const named = dayFirst ?? monthFirst;
    if (!named) {
      return false;
    }
    const sourceYear = named[1];
    return sourceYear
      ? normalizeTwoDigitYear(sourceYear) === year
      : inferredYearIsPlausible(isoDate, postedAt);
  });
}

function postUrlMatchesId(url: unknown, postId: unknown): boolean {
  if (typeof url !== "string" || typeof postId !== "string" || !postId.trim()) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (!/(^|\.)instagram\.com$/iu.test(parsed.hostname)) {
      return false;
    }
    const match = /^\/(?:p|reel|reels|tv)\/([^/]+)/iu.exec(parsed.pathname);
    const shortcode = match?.[1];
    const normalizedPostId = postId.trim();
    if (!shortcode) {
      return false;
    }

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (!/^\d+$/u.test(normalizedPostId)) {
      return shortcode === normalizedPostId;
    }

    let decodedMediaId = BigInt(0);
    for (const character of shortcode) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) {
        return false;
      }
      decodedMediaId = decodedMediaId * BigInt(64) + BigInt(digit);
    }
    let canonicalShortcode = "";
    let remaining = decodedMediaId;
    do {
      const digit = Number(remaining % BigInt(64));
      canonicalShortcode = alphabet[digit] + canonicalShortcode;
      remaining /= BigInt(64);
    } while (remaining > BigInt(0));
    return canonicalShortcode === shortcode && decodedMediaId.toString() === normalizedPostId;
  } catch {
    return false;
  }
}

function buildCoherentSourceSegments(value: string): string[] {
  return [...new Set(
    value
      .normalize("NFKC")
      .split(/\r?\n|\s*[;•·●▪◦]+\s*/u)
      .map((segment) => segment.trim())
      .filter(Boolean),
  )];
}

function hasGlobalNonEventBlocker(value: string): boolean {
  const normalized = normalizeText(value);
  return /\b(?:giveaway|contest|nagradn[ai]|poklanjamo|sale|rasprodaja|podcast|playlist|radio show|livestream|live stream|recap|archive|throwback|memories|cancelled|canceled|otkazano|closed|zatvoreno)\b/iu.test(
    normalized,
  );
}

function hasArtistBillingContext(segment: string, artist: string, title: string): boolean {
  if (normalizeText(artist) === normalizeText(title)) {
    return true;
  }
  const searchable = normalizeText(stripHashtagIdentityTokens(segment));
  const identity = normalizeText(artist);
  return [
    `dj ${identity}`,
    `live ${identity}`,
    `with ${identity}`,
    `uz ${identity}`,
    `sa ${identity}`,
    `svira ${identity}`,
    `${identity} svira`,
    `nastupa ${identity}`,
    `${identity} nastupa`,
    `gostuje ${identity}`,
    `${identity} gostuje`,
    `${identity} live`,
    `${identity} b2b`,
  ].some((pattern) => containsTokenSequence(searchable, pattern));
}

function hasPositiveEventContext(
  segment: string,
  title: unknown,
  artists: string[],
  date: unknown,
  time: unknown,
): boolean {
  const searchable = normalizeText(stripHashtagIdentityTokens(segment));
  const identity = normalizeText(title);
  if (!identity) {
    return false;
  }
  const explicitCue = [
    `svira ${identity}`,
    `${identity} svira`,
    `nastupa ${identity}`,
    `${identity} nastupa`,
    `gostuje ${identity}`,
    `${identity} gostuje`,
    `live ${identity}`,
    `${identity} live`,
    `projekcija ${identity}`,
    `prikazujemo ${identity}`,
    `film ${identity}`,
    `predstava ${identity}`,
    `izlozba ${identity}`,
    `radionica ${identity}`,
    `kviz ${identity}`,
    `koncert ${identity}`,
    `jam session ${identity}`,
  ].some((pattern) => containsTokenSequence(searchable, pattern));
  const titleCarriesFormat =
    /^(?:projekcija filma|filmska projekcija|pozorisna predstava|pozorisna predstava|izlozba|radionica|kviz|koncert|jam session)\b/iu.test(
      identity,
    );
  const hasEventMarker = /[🎬🎤🎭🎨🖼]/u.test(segment);
  const hasBilledArtist = artists.some((artist) => hasArtistBillingContext(segment, artist, title as string));
  const dateBeforeTitle = (() => {
    if (typeof date !== "string") {
      return false;
    }
    const titleIndex = searchable.indexOf(identity);
    if (titleIndex <= 0) {
      return false;
    }
    const prefix = searchable.slice(0, titleIndex);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    if (!iso) {
      return false;
    }
    const day = String(Number(iso[3]));
    const month = String(Number(iso[2]));
    return new RegExp(`(?:^|\\s)0?${day}(?:\\s|[./-])`, "u").test(prefix) ||
      new RegExp(`(?:^|\\s)0?${month}[./-]0?${day}(?:\\s|$)`, "u").test(prefix);
  })();
  const strictScheduleRow =
    dateBeforeTitle &&
    (hasEventMarker ||
      (typeof time === "string" && time.trim() !== "" && time.trim().toUpperCase() !== "TBD"));
  return explicitCue || titleCarriesFormat || hasEventMarker || hasBilledArtist || strictScheduleRow;
}

export function isCaptionSourceCoherentWithEvent(options: {
  title: unknown;
  date: unknown;
  time?: unknown;
  venue: unknown;
  artists: unknown;
  sourceCaption: unknown;
  sourcePostedAt?: unknown;
  instagramPostId: unknown;
  instagramPostUrl: unknown;
  sourceInstagramHandle: unknown;
  venueInstagramHandle: unknown;
}): boolean {
  const rawCaption = typeof options.sourceCaption === "string" ? options.sourceCaption : "";
  const sourceHandle = normalizeHandleExact(options.sourceInstagramHandle);
  const venueHandle = normalizeHandleExact(options.venueInstagramHandle);
  const artists = Array.isArray(options.artists)
    ? options.artists.filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0)
    : [];

  if (
    !rawCaption.trim() ||
    hasGlobalNonEventBlocker(rawCaption) ||
    !isSensibleEventTitleForApproval({ title: options.title, venue: options.venue }) ||
    !postUrlMatchesId(options.instagramPostUrl, options.instagramPostId) ||
    !sourceHandle ||
    sourceHandle !== venueHandle
  ) {
    return false;
  }

  return buildCoherentSourceSegments(rawCaption).some(
    (segment) =>
      hasNonHashtagIdentity(segment, options.title) &&
      hasExplicitDate(segment, options.date, options.sourcePostedAt) &&
      hasExplicitTime(segment, options.time) &&
      artists.every(
        (artist) =>
          hasNonHashtagIdentity(segment, artist) &&
          hasArtistBillingContext(segment, artist, String(options.title ?? "")),
      ) &&
      hasPositiveEventContext(segment, options.title, artists, options.date, options.time),
  );
}
