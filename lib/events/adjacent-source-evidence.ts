const DATE_ANCHOR_PATTERN =
  /\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{2}|\d{4}))?|\d{1,2}(?:st|nd|rd|th|\.)?\s+(?:jan(?:uary|uar|uara)?|feb(?:ruary|ruar|ruara)?|mar(?:ch|t|ta)?|apr(?:il|ila)?|may|maj(?:a)?|jun(?:e|a)?|jul(?:y|a)?|aug(?:ust)?|avgust(?:a)?|sep(?:t(?:ember)?|tembar|tembra)?|oct(?:ober)?|oktobar|oktobra|nov(?:ember|embar|embra)?|dec(?:ember)?|decembar|decembra)|(?:jan(?:uary|uar|uara)?|feb(?:ruary|ruar|ruara)?|mar(?:ch|t|ta)?|apr(?:il|ila)?|may|maj(?:a)?|jun(?:e|a)?|jul(?:y|a)?|aug(?:ust)?|avgust(?:a)?|sep(?:t(?:ember)?|tembar|tembra)?|oct(?:ober)?|oktobar|oktobra|nov(?:ember|embar|embra)?|dec(?:ember)?|decembar|decembra)\s+\d{1,2}(?:st|nd|rd|th)?)\b/giu;

const DOOR_CLOCK_PATTERN =
  /\b(?:vrata(?:\s+se)?\s+otvaraju|doors?\s+open(?:s)?)[^\n.!?]{0,40}?(?:u|at)?\s*(?:[01]?\d|2[0-3])(?:[:.]?[0-5]\d)?\s*h?\b/giu;
const EVENT_CLOCK_PATTERN =
  /(?:^|\D)(?:[01]?\d|2[0-3])(?::|\.)[0-5]\d(?:\s*h)?(?:\D|$)|(?:^|\D)(?:[01]?\d|2[0-3])\s*h(?:[0-5]\d)?(?:\D|$)/giu;
const BILLED_MENTION_PATTERN =
  /^(?:(?:let\s+the\s+music\s+begin)\s+)?(?:w\/|with|uz|sa|feat(?:uring)?|ft\.?)\s+(@[\p{L}\p{N}_.-]+)\s*[.!]?$/iu;
const QUOTED_WORK_WITH_YEAR_PATTERN =
  /^["“”„'][^"“”„'\n]{2,100}["“”„']\s*\(?(?:19|20)\d{2}\)?\s*[.!]?$/u;
const METADATA_ONLY_TOKENS = new Set([
  "at",
  "h",
  "na",
  "od",
  "on",
  "open",
  "otvorenom",
  "pocetak",
  "starts",
  "start",
  "u",
]);
function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function toIdentityTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function getDatedLineIdentityTokens(value: string): string[] {
  return toIdentityTokens(
    value
      .replace(DATE_ANCHOR_PATTERN, " ")
      .replace(DOOR_CLOCK_PATTERN, " ")
      .replace(EVENT_CLOCK_PATTERN, " "),
  ).filter((token) => !METADATA_ONLY_TOKENS.has(token));
}

function billedHandleMatchesDatedIdentity(datedLine: string, handle: string): boolean {
  const identityTokens = getDatedLineIdentityTokens(datedLine);
  if (identityTokens.length === 0) return false;
  const normalizedHandle = toIdentityTokens(handle).join("");
  const forwardIdentity = identityTokens.join("");
  const reverseIdentity = [...identityTokens].reverse().join("");
  return normalizedHandle === forwardIdentity || normalizedHandle === reverseIdentity;
}

/**
 * Recover two bounded single-event caption layouts that were safely accepted
 * before the July regression. The date/start row may borrow identity only from
 * its immediately adjacent row when that row is an explicit billing cue or a
 * quoted cultural work with a year. No date or second start clock may be joined.
 */
export function buildAdjacentSingleEventEvidenceSegments(value: string): string[] {
  const lines = value
    .normalize("NFKC")
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (lines.length < 2 || countMatches(lines.join("\n"), DATE_ANCHOR_PATTERN) !== 1) {
    return [];
  }

  const datedLineIndex = lines.findIndex(
    (line) => countMatches(line, DATE_ANCHOR_PATTERN) === 1,
  );
  if (datedLineIndex < 0 || datedLineIndex + 1 >= lines.length) {
    return [];
  }
  const datedLine = lines[datedLineIndex] ?? "";
  const adjacentIdentityLine = lines[datedLineIndex + 1] ?? "";
  if (!adjacentIdentityLine) return [];
  const datedLineWithoutDoorClock = datedLine
    .replace(DATE_ANCHOR_PATTERN, " ")
    .replace(DOOR_CLOCK_PATTERN, " ");
  const adjacentWithoutDoorClock = adjacentIdentityLine.replace(DOOR_CLOCK_PATTERN, " ");
  if (
    countMatches(datedLineWithoutDoorClock, EVENT_CLOCK_PATTERN) > 1 ||
    countMatches(adjacentIdentityLine, DATE_ANCHOR_PATTERN) > 0 ||
    countMatches(adjacentWithoutDoorClock, EVENT_CLOCK_PATTERN) > 0
  ) {
    return [];
  }
  const billedMention = adjacentIdentityLine.match(BILLED_MENTION_PATTERN);
  const isBilledLayout = Boolean(
    billedMention?.[1] && billedHandleMatchesDatedIdentity(datedLine, billedMention[1]),
  );
  const isQuotedWorkLayout =
    QUOTED_WORK_WITH_YEAR_PATTERN.test(adjacentIdentityLine) &&
    getDatedLineIdentityTokens(datedLine).length === 0;
  if (!isBilledLayout && !isQuotedWorkLayout) {
    return [];
  }

  const unrelatedStructuredRows = lines.filter((line, index) => {
    if (index === datedLineIndex || index === datedLineIndex + 1) return false;
    if (!line) return false;
    const withoutDoorClock = line.replace(DOOR_CLOCK_PATTERN, " ");
    const isDoorLogisticsOnly =
      withoutDoorClock !== line &&
      !withoutDoorClock.replace(/[\s.!,:;|/\\—–-]+/gu, "");
    return !isDoorLogisticsOnly;
  });
  return unrelatedStructuredRows.length === 0
    ? [`${datedLine} ${adjacentIdentityLine}`]
    : [];
}
