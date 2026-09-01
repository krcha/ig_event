import { type ExtractedEventData } from "@/lib/ai/extract-event-data";
import { conflictExplicitlyIdentifiesArtistHandleAlias, type EventEvidenceSourceConflict } from "@/lib/events/event-evidence-conflict-policy";
import { findNamedWeekday } from "@/lib/events/event-validation";
import { canonicalizeVenueName, type CanonicalVenueAliasesByHandle, getConfiguredVenueNameForHandle, normalizeHandle, toSearchableText, type VenueNormalization } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { collectDateCandidates } from "@/lib/pipeline/ingestion/parsing-date";
import { normalizeString } from "@/lib/pipeline/ingestion/values";


export const GENERIC_EVENT_TITLE_PATTERNS = [
  /^(open\s+)?jam\s+session$/i,
  /^[a-z&/+ -]+jam\s+session$/i,
  /^(live\s+music|concert|party|event|session)$/i,
  /^(techno|house|jazz|blues|rock|metal|hip hop|hip-hop|drum and bass|dnb)(\s+(night|session|party))?$/i,
];


export const WEAK_EVENT_TITLE_SECTION_TERMS = new Set([
  "aktivnosti",
  "activities",
  "program",
  "lineup",
  "radionice",
  "workshop",
  "workshops",
  "satnica",
  "schedule",
  "raspored",
  "detalji",
  "details",
  "info",
  "informacije",
  "gosti",
  "guests",
  "predavanja",
  "projekcije",
  "screenings",
]);


export const CONTEXT_EVENT_TITLE_KEYWORDS = new Set([
  "festival",
  "fest",
  "party",
  "session",
  "night",
  "showcase",
  "weekender",
  "concert",
  "koncert",
  "afterparty",
  "after",
  "takeover",
  "opening",
  "closing",
  "premiere",
  "premijera",
  "birthday",
  "anniversary",
  "matinee",
  "matine",
]);


export const CONTEXT_TITLE_STOP_WORDS = new Set([
  "the",
  "this",
  "that",
  "our",
  "your",
  "their",
  "a",
  "an",
  "one",
  "ovaj",
  "ova",
  "ovo",
  "ovde",
  "dobrodosli",
  "dodjite",
  "dodite",
  "join",
  "us",
  "for",
  "na",
  "u",
  "uz",
]);


export const CONTEXT_EVENT_TITLE_REGEX =
  /([\p{L}\d][\p{L}\d'’.+/&-]*(?:\s+[\p{L}\d][\p{L}\d'’.+/&-]*){0,4}\s+(festival|fest|party|session|night|showcase|weekender|concert|koncert|afterparty|after|takeover|opening|closing|premiere|premijera|birthday|anniversary|matinee|matine))\b/iu;

export function humanizeHandle(
  handle: string,
  configuredVenueNamesByHandle: Record<string, string> = {},
): string {
  const normalized = normalizeHandle(handle);
  const mappedVenue = getConfiguredVenueNameForHandle(
    handle,
    configuredVenueNamesByHandle,
  );
  if (mappedVenue) {
    return mappedVenue;
  }

  const tokens = normalized
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return normalized;
  }

  return tokens
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "i" || lower === "x" || lower === "b2b") {
        return lower;
      }
      if (lower.length <= 3 && /^[a-z0-9]+$/.test(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function buildFallbackTitle(
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  canonicalVenueNamesByHandle: Record<string, string>,
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle = {},
  configuredVenueNamesByHandle: Record<string, string> = {},
): string {
  const mappedVenue = getConfiguredVenueNameForHandle(
    post.username,
    configuredVenueNamesByHandle,
  );
  if (mappedVenue) {
    return mappedVenue;
  }

  const locationName = normalizeString(post.locationName);
  if (locationName) {
    return (
      canonicalizeVenueName(locationName, canonicalVenueNamesByHandle, {
        canonicalVenueAliasesByHandle,
        preferredVenue: mappedVenue || null,
      }) ??
      locationName
    );
  }

  if (venue.source === "handle_map" && venue.venue) {
    return venue.venue;
  }

  return humanizeHandle(post.username, configuredVenueNamesByHandle);
}

export function isGenericEventTitle(value: string): boolean {
  return GENERIC_EVENT_TITLE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

export function trimTitleCandidate(value: string): string {
  return value.replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,:;!?]+$/gu, "").trim();
}

export function titleContainsAlphanumeric(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

export function humanizeArtistHandle(value: string): string {
  const handle = normalizeString(value)
    .replace(/^@+/u, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}._-]+$/gu, "")
    .trim();
  if (!handle) {
    return "";
  }

  const tokens = handle
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);

  return tokens
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower.length <= 3 && /^[a-z0-9]+$/u.test(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function normalizeArtistDisplayName(value: string): string {
  const normalizedValue = normalizeString(value).replace(/[\p{Cf}]/gu, "");
  const trimmedValue = trimTitleCandidate(normalizedValue);
  if (/^@[\p{L}\p{N}._-]+$/u.test(trimmedValue)) {
    return trimmedValue;
  }
  return trimTitleCandidate(
    normalizedValue
      .replace(/@([\p{L}\p{N}._-]+)/gu, (_match, handle: string) => humanizeArtistHandle(handle))
      .replace(/^[\s]*(?:\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|\d{1,2}\.?\s+[\p{L}]+)\s*[-–—:|•·]*/iu, "")
      .replace(/[\p{Extended_Pictographic}\uFE0F]+$/gu, "")
      .replace(/\s+/gu, " "),
  );
}

export function artistAliasPairIsSupported(
  left: string,
  right: string,
  conflicts: EventEvidenceSourceConflict[],
): boolean {
  return conflicts.some(
    (conflict) =>
      conflictExplicitlyIdentifiesArtistHandleAlias(conflict) &&
      ((toSearchableText(left) === toSearchableText(conflict.poster_value) &&
          toSearchableText(right) === toSearchableText(conflict.caption_value)) ||
        (toSearchableText(right) === toSearchableText(conflict.poster_value) &&
          toSearchableText(left) === toSearchableText(conflict.caption_value))),
  );
}

export function dedupeArtistDisplayNames(
  values: string[],
  aliasConflicts: EventEvidenceSourceConflict[] = [],
): string[] {
  const deduped: Array<{ raw: string; display: string }> = [];
  for (const value of values) {
    const artist = normalizeArtistDisplayName(value);
    if (!titleContainsAlphanumeric(artist)) continue;
    const equivalentIndex = deduped.findIndex(
      (existing) =>
        toSearchableText(existing.display) === toSearchableText(artist) ||
        artistAliasPairIsSupported(existing.raw, value, aliasConflicts),
    );
    if (equivalentIndex === -1) {
      deduped.push({ raw: value, display: artist });
      continue;
    }
    if (artistAliasPairIsSupported(deduped[equivalentIndex].raw, value, aliasConflicts)) {
      const handleValue = /^@[\p{L}\p{N}._-]+$/u.test(value.trim())
        ? value.trim()
        : deduped[equivalentIndex].raw.trim();
      deduped[equivalentIndex] = { raw: handleValue, display: handleValue };
    }
  }
  return deduped.map((entry) => entry.display);
}

export function formatArtistTitleList(
  artists: string[],
  aliasConflicts: EventEvidenceSourceConflict[] = [],
): string {
  const displayArtists = dedupeArtistDisplayNames(artists, aliasConflicts);
  if (displayArtists.length <= 2) {
    return displayArtists.join(" & ");
  }
  return `${displayArtists.slice(0, -1).join(", ")} & ${displayArtists.at(-1)}`;
}

export function isMeaninglessEventTitle(value: string): boolean {
  const normalized = toSearchableText(value);
  if (!normalized) {
    return true;
  }
  const tokens = normalized.split(/\s+/u).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => ["and", "i", "b2b", "x"].includes(token));
}

export function isGenericProgramScheduleTitle(value: string): boolean {
  const normalized = toSearchableText(value);
  if (!normalized) {
    return false;
  }
  const tokens = normalized.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens[0] !== "program") {
    return false;
  }
  return tokens.length <= 5;
}

export function buildMeaningfulEventTitle(options: {
  title: string;
  artists: string[];
  eventType: string;
  venue: string | null;
  baseTitle?: string;
}): string {
  const cleanedTitle = cleanSplitCaptionEntryText(options.title);
  if (!isMeaninglessEventTitle(cleanedTitle) && !isGenericProgramScheduleTitle(cleanedTitle)) {
    return cleanedTitle;
  }

  const cleanedBaseTitle = cleanSplitCaptionEntryText(options.baseTitle ?? "");
  if (
    cleanedBaseTitle &&
    !isMeaninglessEventTitle(cleanedBaseTitle) &&
    !isGenericProgramScheduleTitle(cleanedBaseTitle) &&
    !isGenericEventTitle(cleanedBaseTitle)
  ) {
    return cleanedBaseTitle;
  }

  const artistTitle = formatArtistTitleList(options.artists);
  if (artistTitle) {
    return artistTitle;
  }

  const normalizedEventType = normalizeString(options.eventType);
  const humanizedEventType = normalizedEventType
    ? `${normalizedEventType.charAt(0).toUpperCase()}${normalizedEventType.slice(1)}`
    : "Event";
  const venue = normalizeString(options.venue ?? "");
  return venue ? `${humanizedEventType} at ${venue}` : humanizedEventType;
}

export function getWeakEventTitleSectionParts(
  value: string,
): { baseTitle: string; sectionTerm: string } | null {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const lastToken = tokens[tokens.length - 1] ?? "";
  if (WEAK_EVENT_TITLE_SECTION_TERMS.has(toSearchableText(lastToken))) {
    return {
      baseTitle: tokens.slice(0, -1).join(" "),
      sectionTerm: lastToken,
    };
  }

  if (tokens.length === 1 && WEAK_EVENT_TITLE_SECTION_TERMS.has(toSearchableText(tokens[0]))) {
    return {
      baseTitle: "",
      sectionTerm: tokens[0],
    };
  }

  return null;
}

export function isWeakEventTitleSectionHeading(value: string): boolean {
  const parts = getWeakEventTitleSectionParts(value);
  if (!parts) {
    return false;
  }
  return parts.baseTitle.length === 0 || parts.baseTitle.split(/\s+/).length <= 4;
}

export function extractContextEventTitleKeyword(value: string): string | null {
  const tokens = toSearchableText(value).split(" ").filter((token) => token.length > 0);
  const lastToken = tokens[tokens.length - 1] ?? "";
  return CONTEXT_EVENT_TITLE_KEYWORDS.has(lastToken) ? lastToken : null;
}

export function formatContextEventTitleKeyword(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeContextDerivedTitle(value: string): string {
  const trimmed = trimTitleCandidate(value);
  if (!trimmed) {
    return "";
  }

  const tokens = trimmed.split(/\s+/);
  const keyword = extractContextEventTitleKeyword(trimmed);
  if (!keyword || tokens.length === 0) {
    return trimmed;
  }

  tokens[tokens.length - 1] = formatContextEventTitleKeyword(keyword);
  return tokens.join(" ");
}

export function extractContextualEventTitleCandidate(value: string): string | null {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(CONTEXT_EVENT_TITLE_REGEX);
  if (!match) {
    return null;
  }

  return trimTitleCandidate(match[1] ?? "");
}

export const QUOTED_CULTURAL_WORK_CONTEXT_STEMS = [
  "film",
  "movie",
  "screening",
  "projekc",
  "bioskop",
  "cinema",
  "predstav",
  "pozor",
  "theatr",
  "knjig",
  "book",
  "roman",
  "novel",
  "izloz",
  "izlož",
  "exhibition",
  "galer",
  "opera",
  "balet",
  "ballet",
  "dokumentar",
];

export const QUOTED_PROMOTIONAL_PHRASES = [
  /^vidimo se(?: tamo)?$/u,
  /^see you(?: there)?$/u,
  /^(?:dođi|dodji|dođite|dodjite)$/u,
  /^(?:rezerviši|rezervisi|reserve now)$/u,
  /^(?:kupi kartu|kupite karte|buy tickets)$/u,
  /^(?:save the date|stay tuned)$/u,
  /^(?:ne propustite|pridruži nam se|pridruzi nam se)$/u,
];

export const QUOTED_CULTURAL_WORK_LINK_WORDS = new Set([
  "pod",
  "nazivom",
  "naslovom",
  "naslova",
]);

export const QUOTED_NON_TITLE_CONTEXT_STEMS = [
  "poruc",
  "poruč",
  "kaze",
  "kaže",
  "replik",
  "citat",
  "slogan",
  "moto",
  "kod",
  "code",
  "promo",
  "popust",
  "discount",
];

export function isCulturalWorkEventType(value: string | undefined): boolean {
  const normalized = toSearchableText(value ?? "");
  return ["arts culture", "film", "cinema", "theatre", "theater", "literature", "exhibition"]
    .some((category) => normalized.includes(category));
}

export function hasDirectCulturalWorkLabel(value: string): boolean {
  const tokens = toSearchableText(value).split(/\s+/u).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (!QUOTED_CULTURAL_WORK_CONTEXT_STEMS.some((stem) => tokens[index]?.includes(stem))) {
      continue;
    }
    const trailingTokens = tokens.slice(index + 1);
    return (
      trailingTokens.length <= 3 &&
      trailingTokens.every((token) => QUOTED_CULTURAL_WORK_LINK_WORDS.has(token))
    );
  }
  return false;
}

export function hasQuotedNonTitleContext(value: string): boolean {
  const normalized = toSearchableText(value);
  return QUOTED_NON_TITLE_CONTEXT_STEMS.some((stem) => normalized.includes(stem));
}

export function hasImmediateQuotedWorkYear(text: string, matchEnd: number): boolean {
  return /^\s*[([]?\s*(?:19|20)\d{2}\s*[)\]]?/u.test(text.slice(matchEnd, matchEnd + 16));
}

export function extractQuotedCulturalWorkTitleCandidate(
  value: string,
  eventType: string | undefined,
): string | null {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }

  for (const match of text.matchAll(/[“„«"]([^”“„«»"\r\n]{2,100})[”»"]/gu)) {
    const candidate = trimTitleCandidate(match[1] ?? "");
    const normalized = toSearchableText(candidate);
    const tokenCount = normalized.split(/\s+/u).filter(Boolean).length;
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    const contextBeforeCandidate = text.slice(Math.max(0, matchStart - 100), matchStart);
    const immediateContextBeforeCandidate =
      contextBeforeCandidate.split(/[\r\n.!?]/u).pop() ?? contextBeforeCandidate;
    const hasCulturalContext =
      isCulturalWorkEventType(eventType) &&
      hasDirectCulturalWorkLabel(immediateContextBeforeCandidate);
    if (
      candidate &&
      /\p{L}/u.test(candidate) &&
      tokenCount >= 1 &&
      tokenCount <= 10 &&
      !QUOTED_PROMOTIONAL_PHRASES.some((pattern) => pattern.test(normalized)) &&
      !hasQuotedNonTitleContext(immediateContextBeforeCandidate) &&
      !isMeaninglessEventTitle(candidate) &&
      !isGenericEventTitle(candidate) &&
      !isWeakEventTitleSectionHeading(candidate) &&
      (hasImmediateQuotedWorkYear(text, matchEnd) || hasCulturalContext)
    ) {
      return candidate;
    }
  }

  return null;
}

export function isQuotedEventTitleDistinctFromVenue(
  candidate: string,
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  configuredVenueNamesByHandle: Record<string, string>,
): boolean {
  const normalizedCandidate = toSearchableText(candidate);
  const normalizedVenue = toSearchableText(venue.venue ?? "");
  const normalizedHandleTitle = toSearchableText(
    humanizeHandle(post.username, configuredVenueNamesByHandle),
  );
  return Boolean(
    normalizedCandidate &&
      normalizedCandidate !== normalizedVenue &&
      normalizedCandidate !== normalizedHandleTitle,
  );
}

export function isUsableContextEventTitleCandidate(
  candidate: string,
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  configuredVenueNamesByHandle: Record<string, string>,
): boolean {
  const normalizedCandidate = toSearchableText(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  const candidateTokens = normalizedCandidate.split(" ").filter((token) => token.length > 0);
  if (candidateTokens.length < 2 || candidateTokens.length > 6) {
    return false;
  }

  if (isGenericEventTitle(candidate) || isWeakEventTitleSectionHeading(candidate)) {
    return false;
  }

  const keyword = extractContextEventTitleKeyword(candidate);
  if (!keyword) {
    return false;
  }

  const baseTokens = candidateTokens
    .slice(0, -1)
    .filter((token) => !CONTEXT_TITLE_STOP_WORDS.has(token));
  if (baseTokens.length === 0) {
    return false;
  }

  const normalizedVenue = toSearchableText(venue.venue ?? "");
  if (normalizedVenue && normalizedCandidate === normalizedVenue) {
    return false;
  }

  const normalizedHandleTitle = toSearchableText(
    humanizeHandle(post.username, configuredVenueNamesByHandle),
  );
  if (normalizedHandleTitle && normalizedCandidate === normalizedHandleTitle) {
    return false;
  }

  return true;
}

export function buildContextDerivedEventTitle(
  rawTitle: string,
  extracted: ExtractedEventData,
  post: InstagramScrapedPost,
  venue: VenueNormalization,
  configuredVenueNamesByHandle: Record<string, string>,
): { title: string; contextCandidate: string } | null {
  const rawTitleParts = getWeakEventTitleSectionParts(rawTitle);
  const quotedCaptionTitle = extractQuotedCulturalWorkTitleCandidate(
    normalizeString(post.caption || extracted.source_caption),
    extracted.category,
  );
  if (
    quotedCaptionTitle &&
    isQuotedEventTitleDistinctFromVenue(
      quotedCaptionTitle,
      post,
      venue,
      configuredVenueNamesByHandle,
    )
  ) {
    return {
      title: quotedCaptionTitle,
      contextCandidate: quotedCaptionTitle,
    };
  }

  const contextSources = [
    normalizeString(extracted.description),
    normalizeString(post.caption),
  ];

  for (const sourceText of contextSources) {
    const candidate = extractContextualEventTitleCandidate(sourceText);
    if (
      !candidate ||
      !isUsableContextEventTitleCandidate(
        candidate,
        post,
        venue,
        configuredVenueNamesByHandle,
      )
    ) {
      continue;
    }

    const keyword = extractContextEventTitleKeyword(candidate);
    const normalizedRawBaseTitle = toSearchableText(rawTitleParts?.baseTitle ?? "");
    const normalizedVenue = toSearchableText(venue.venue ?? "");
    const normalizedHandleTitle = toSearchableText(
      humanizeHandle(post.username, configuredVenueNamesByHandle),
    );
    if (
      rawTitleParts?.baseTitle &&
      keyword &&
      normalizedRawBaseTitle &&
      normalizedRawBaseTitle !== normalizedVenue &&
      normalizedRawBaseTitle !== normalizedHandleTitle &&
      !isGenericEventTitle(rawTitleParts.baseTitle) &&
      !isWeakEventTitleSectionHeading(rawTitleParts.baseTitle)
    ) {
      return {
        title: `${rawTitleParts.baseTitle} ${formatContextEventTitleKeyword(keyword)}`.trim(),
        contextCandidate: candidate,
      };
    }

    return {
      title: normalizeContextDerivedTitle(candidate),
      contextCandidate: candidate,
    };
  }

  return null;
}

export function cleanSplitCaptionEntryText(value: string): string {
  const normalizedValue = normalizeString(value).replace(/[\p{Cf}]/gu, "");
  const trimmedValue = trimTitleCandidate(normalizedValue);
  if (/^@[\p{L}\p{N}._-]+$/u.test(trimmedValue)) {
    return trimmedValue;
  }
  return trimTitleCandidate(
    normalizedValue
      .replace(/@([\p{L}\p{N}._-]+)/gu, (_match, handle: string) => humanizeArtistHandle(handle))
      .replace(/\s*[•·●▪‣∙◦‧⁃◆◇■□▸►▶|]+\s*/gu, " | ")
      .replace(/[\p{Extended_Pictographic}\uFE0F]+$/gu, "")
      .replace(/\s+/g, " "),
  );
}

export const SPLIT_ENTRY_WEEKDAY_PREFIX_REGEX =
  /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|ponedeljak|pon|utorak|uto|sreda|sre|cetvrtak|četvrtak|cet|čet|petak|pet|subota|sub|nedelja|nedjelja|ned)\b[\s,.:;-]*/iu;

export function stripSplitEntryDateText(value: string, rawDate: string): string {
  let stripped = normalizeString(value);
  const normalizedRawDate = normalizeString(rawDate);
  if (normalizedRawDate) {
    stripped = stripped.replace(normalizedRawDate, " ");
  }

  return stripped
    .replace(SPLIT_ENTRY_WEEKDAY_PREFIX_REGEX, "")
    .replace(/\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|ponedeljak|pon|utorak|uto|sreda|sre|cetvrtak|četvrtak|cet|čet|petak|pet|subota|sub|nedelja|nedjelja|ned)\b/giu, " ")
    .replace(/^[\s.,:;|/\\—–-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyCaptionContextTitle(value: string): boolean {
  const normalized = cleanSplitCaptionEntryText(value);
  if (!normalized || normalized.length > 80) {
    return false;
  }
  if (findNamedWeekday(normalized) !== null) {
    return false;
  }
  if (collectDateCandidates(normalized, "caption", null).length > 0) {
    return false;
  }
  if (/^(?:video|photo|poster|tickets?|karte?|info|ulaz|free|gratis)$/iu.test(normalized)) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(normalized);
}

export function extractPostAltTextEvidence(value: string | null | undefined): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }

  const explicitTextMatch = normalized.match(/\btext that says\s*['"]?(.+?)['"]?\.?$/iu);
  if (explicitTextMatch?.[1]) {
    return normalizeString(explicitTextMatch[1]);
  }

  return normalized
    .replace(/^photo by .*? on .*?\.\s*/iu, "")
    .replace(/^may be an image of .*?\btext that says\s*/iu, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

export function buildIndependentPostTextEvidence(post: InstagramScrapedPost): string {
  return normalizeString(post.caption);
}

export function buildPostTextEvidence(
  post: InstagramScrapedPost,
  extracted?: Pick<ExtractedEventData, "source_caption">,
): string {
  return [...new Set([
    buildIndependentPostTextEvidence(post),
    normalizeString(extracted?.source_caption),
  ])]
    .filter((value) => value.length > 0)
    .join("\n");
}
