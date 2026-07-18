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

function hasTextIdentity(caption: string, identity: unknown): boolean {
  const normalizedIdentity = normalizeText(identity);
  if (!normalizedIdentity) {
    return false;
  }
  if (caption.includes(normalizedIdentity)) {
    return true;
  }
  const tokens = normalizedIdentity.split(" ").filter((token) => token.length >= 2);
  return tokens.length > 0 && tokens.every((token) => caption.includes(token));
}

function hasExplicitDate(caption: string, isoDate: unknown): boolean {
  if (typeof isoDate !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const numeric = new RegExp(
    `(?:^|\\D)0?${day}[./-]0?${month}(?:[./-](?:${year}|${String(year).slice(2)}))?(?:\\D|$)`,
    "u",
  );
  if (numeric.test(caption)) {
    return true;
  }
  return (MONTH_NAMES[month] ?? []).some((name) => {
    const dayFirst = new RegExp(`(?:^|\\s)0?${day}\\.?\\s+${name}(?:a)?(?:\\s|$)`, "u");
    const monthFirst = new RegExp(`(?:^|\\s)${name}\\s+0?${day}(?:st|nd|rd|th)?(?:\\s|$)`, "u");
    return dayFirst.test(caption) || monthFirst.test(caption);
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
    const match = /^\/(?:p|reel|tv)\/([^/]+)/iu.exec(parsed.pathname);
    return match?.[1] === postId.trim();
  } catch {
    return false;
  }
}

export function isCaptionSourceCoherentWithEvent(options: {
  title: unknown;
  date: unknown;
  venue: unknown;
  artists: unknown;
  sourceCaption: unknown;
  instagramPostId: unknown;
  instagramPostUrl: unknown;
  sourceInstagramHandle: unknown;
  venueInstagramHandle: unknown;
}): boolean {
  const caption = normalizeText(options.sourceCaption);
  const dateCaption =
    typeof options.sourceCaption === "string"
      ? options.sourceCaption
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const sourceHandle = normalizeText(options.sourceInstagramHandle).replace(/\s+/g, "");
  const venueHandle = normalizeText(options.venueInstagramHandle).replace(/\s+/g, "");
  const artists = Array.isArray(options.artists) ? options.artists : [];

  return (
    Boolean(caption) &&
    isSensibleEventTitleForApproval({ title: options.title, venue: options.venue }) &&
    hasTextIdentity(caption, options.title) &&
    hasExplicitDate(dateCaption, options.date) &&
    artists.every((artist) => hasTextIdentity(caption, artist)) &&
    postUrlMatchesId(options.instagramPostUrl, options.instagramPostId) &&
    Boolean(sourceHandle) &&
    sourceHandle === venueHandle
  );
}
