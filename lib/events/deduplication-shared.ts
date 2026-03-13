import {
  normalizeHandle,
  toSearchableText,
} from "../pipeline/venue-normalization.ts";

const GENERIC_TITLE_TOKENS = new Set([
  "party",
  "zurka",
  "zurke",
  "zurci",
  "night",
  "club",
  "klub",
  "event",
  "live",
  "show",
  "festival",
  "bg",
  "official",
  "present",
  "presents",
]);

const GENERIC_TITLE_SUFFIXES = [
  "party",
  "zurka",
  "zurke",
  "zurci",
  "night",
  "event",
  "show",
  "live",
  "festival",
  "bg",
];

const DIGIT_WORDS: Record<string, string> = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
};

const GENERIC_IDENTITY_TOKENS = new Set([
  ...GENERIC_TITLE_TOKENS,
  "the",
  "and",
  "with",
  "for",
  "from",
  "this",
  "week",
  "season",
  "opening",
  "after",
  "before",
  "feat",
  "featuring",
  "hosted",
  "presents",
  "presented",
  "all",
  "nighter",
  "special",
  "edition",
  "session",
]);

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function collectComparableTextValues(
  values: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const value of values) {
    const normalized = normalizeString(value);
    const searchable = toSearchableText(normalized);
    if (!searchable || seen.has(searchable)) {
      continue;
    }
    seen.add(searchable);
    collected.push(normalized);
  }

  return collected;
}

export function normalizeInstagramUrl(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function isLikelyHandleString(value: string): boolean {
  if (!value || /\s/.test(value)) {
    return false;
  }

  if (value.startsWith("@")) {
    return true;
  }

  if (/[._\d]/.test(value)) {
    return true;
  }

  return value === value.toLowerCase() && /[a-z]/.test(value);
}

export function collectInstagramHandles(
  values: Array<string | null | undefined>,
): string[] {
  const handles = new Set<string>();

  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }

    const matches = normalized.match(/@[a-z0-9._]+/gi) ?? [];
    for (const match of matches) {
      const handle = normalizeHandle(match);
      if (handle) {
        handles.add(handle);
      }
    }

    if (matches.length === 0 && isLikelyHandleString(normalized)) {
      const handle = normalizeHandle(normalized);
      if (handle) {
        handles.add(handle);
      }
    }
  }

  return [...handles];
}

export function countSharedValues(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  let sharedCount = 0;
  for (const value of left) {
    if (rightSet.has(value)) {
      sharedCount += 1;
    }
  }

  return sharedCount;
}

function replaceDigitsWithWords(value: string): string {
  return value.replace(/\d/g, (digit) => DIGIT_WORDS[digit] ?? digit);
}

function stripGenericTitleSuffixes(value: string): string {
  let current = value;

  while (current.length > 4) {
    const next = GENERIC_TITLE_SUFFIXES.find(
      (suffix) => current.endsWith(suffix) && current.length - suffix.length >= 4,
    );
    if (!next) {
      break;
    }
    current = current.slice(0, -next.length);
  }

  return current;
}

function buildComparableInitialism(value: string): string {
  const tokens = toSearchableText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_IDENTITY_TOKENS.has(token));

  if (tokens.length < 3 || tokens.length > 5) {
    return "";
  }

  const initialism = tokens.map((token) => token[0]).join("");
  return initialism.length >= 3 ? initialism : "";
}

export function buildTitleFamilySlug(value: string): string {
  const normalized = toSearchableText(replaceDigitsWithWords(value));
  const meaningfulTokens = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_TITLE_TOKENS.has(token));

  const compact =
    meaningfulTokens.length > 0 ? meaningfulTokens.join("") : normalized.replace(/\s+/g, "");

  return stripGenericTitleSuffixes(compact);
}

export function collectComparableIdentityValues(
  values: Array<string | null | undefined>,
  options?: {
    ignoredValues?: Array<string | null | undefined>;
  },
): string[] {
  const ignoredSearchables = new Set(
    (options?.ignoredValues ?? [])
      .map((value) => toSearchableText(normalizeString(value)))
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const value of values) {
    const normalized = normalizeString(value);
    const searchable = toSearchableText(normalized);
    if (!searchable || ignoredSearchables.has(searchable) || seen.has(searchable)) {
      continue;
    }

    seen.add(searchable);
    collected.push(normalized);

    const initialism = buildComparableInitialism(normalized);
    if (!initialism || ignoredSearchables.has(initialism) || seen.has(initialism)) {
      continue;
    }

    seen.add(initialism);
    collected.push(initialism);
  }

  return collected;
}

export function areCompatibleTitleFamilySlugs(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength >= 5 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  return false;
}

function doesTextMentionCandidate(text: string, candidate: string): boolean {
  const normalizedText = toSearchableText(text);
  const normalizedCandidate = toSearchableText(candidate);
  if (!normalizedText || !normalizedCandidate) {
    return false;
  }
  if (normalizedText.includes(normalizedCandidate)) {
    return true;
  }

  const compactText = normalizedText.replace(/\s+/g, "");
  const compactCandidate = normalizedCandidate.replace(/\s+/g, "");
  return compactCandidate.length >= 4 && compactText.includes(compactCandidate);
}

export function hasContextCandidateSupport(
  contextTexts: string[],
  comparableCandidates: string[],
): boolean {
  for (const contextText of contextTexts) {
    for (const comparableCandidate of comparableCandidates) {
      if (doesTextMentionCandidate(contextText, comparableCandidate)) {
        return true;
      }
    }
  }

  return false;
}

export function hasVenueContextSupport(
  contextTexts: string[],
  venueCandidates: string[],
): boolean {
  return hasContextCandidateSupport(contextTexts, venueCandidates);
}
