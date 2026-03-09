import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  extractEventDataFromPoster,
  type ExtractedEventData,
} from "@/lib/ai/extract-event-data";
import {
  downloadImage,
  isInstagramOrFbCdnUrl,
  normalizeToJpeg,
  resolveBestImageUrl,
  toDataUrl,
} from "@/lib/ai/prepare-image-for-openai";
import {
  scrapeInstagramAccount,
  type InstagramScrapedPost,
} from "@/lib/scraper/instagram-scraper";
import { getRequiredEnv } from "@/lib/utils/env";

type RunInstagramIngestionOptions = {
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
};

export type IngestionRunMode = "full_scrape" | "saved_posts";

type HandleSummary = {
  handle: string;
  fetchedPosts: number;
  fetched_posts: number;
  insertedEvents: number;
  inserted_events: number;
  skippedDuplicates: number;
  skipped_duplicates: number;
  skipped_duplicates_clean: number;
  skippedNoImage: number;
  skipped_missing_date: number;
  skipped_missing_venue: number;
  skipped_video: number;
  skipped_invalid_event: number;
  skipped_past_event: number;
  updated_duplicates_bad_data: number;
  duplicate_update_failed: number;
  failedDownloads: number;
  failed_downloads: number;
  failedConversions: number;
  failed_conversions: number;
  failedExtractions: number;
  failed_extractions: number;
  failed_extraction: number;
  errors: string[];
};

export type IngestionSummary = {
  startedAt: string;
  finishedAt: string;
  handles: HandleSummary[];
};

export type IngestionBatchState = {
  handleIndex: number;
  currentHandle: string | null;
  currentPostIndex: number;
  currentHandlePosts: InstagramScrapedPost[];
  seenSourceKeysByHandle: Record<string, string[]>;
};

export type IngestionBatchStepOptions = {
  handles: string[];
  summary: IngestionSummary;
  state: IngestionBatchState;
  resultsLimit?: number;
  daysBack?: number;
  batchSize?: number;
  mode?: IngestionRunMode;
};

export type IngestionBatchStepResult = {
  summary: IngestionSummary;
  state: IngestionBatchState;
  done: boolean;
};

export type ActiveVenueIngestionResult = {
  venueHandles: string[];
  summary: IngestionSummary;
};

const getByInstagramPostIdQuery =
  "events:getByInstagramPostId" as unknown as FunctionReference<"query">;
const getByInstagramPostUrlQuery =
  "events:getByInstagramPostUrl" as unknown as FunctionReference<"query">;
const listByInstagramPostIdQuery =
  "events:listByInstagramPostId" as unknown as FunctionReference<"query">;
const listByInstagramPostUrlQuery =
  "events:listByInstagramPostUrl" as unknown as FunctionReference<"query">;
const createEventMutation =
  "events:createEvent" as unknown as FunctionReference<"mutation">;
const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;
const listActiveVenuesQuery =
  "venues:listActiveVenues" as unknown as FunctionReference<"query">;
const listScrapedPostsByHandleQuery =
  "scrapedPosts:listByHandle" as unknown as FunctionReference<"query">;
const upsertScrapedPostsByHandleMutation =
  "scrapedPosts:upsertManyByHandle" as unknown as FunctionReference<"mutation">;
const KNOWN_VENUE_BY_HANDLE: Record<string, string> = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};
const GENERIC_EVENT_TITLE_PATTERNS = [
  /^(open\s+)?jam\s+session$/i,
  /^[a-z&/+ -]+jam\s+session$/i,
  /^(live\s+music|concert|party|event|session)$/i,
  /^(techno|house|jazz|blues|rock|metal|hip hop|hip-hop|drum and bass|dnb)(\s+(night|session|party))?$/i,
];

type PreparedEvent = {
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl: string;
  instagramPostId: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  status: "pending";
};

type DateSource = "model" | "caption";
type DateConfidence = "high" | "medium" | "low";

type DateCandidate = {
  isoDate: string;
  source: DateSource;
  confidence: DateConfidence;
  distanceFromPostDays: number | null;
  inferredYear: boolean;
  year: number;
  rawYearProvided: boolean;
  raw: string;
};

type DateNormalization = {
  isoDate: string | null;
  source: DateSource | null;
  confidence: DateConfidence | null;
  distanceFromPostDays: number | null;
  inferredYear: boolean;
  rawDateText: string | null;
  yearSelectionReason: string;
  suspiciousYear: boolean;
  reason?: "missing_date" | "low_confidence" | "implausible_date";
};

type VenueSource = "handle_map" | "location_name" | "model" | null;

type VenueNormalization = {
  venue: string | null;
  source: VenueSource;
  wasFallback: boolean;
  rawModelVenue: string;
  rawLocationName: string;
};

type PrepareEventResult =
  | {
      kind: "ok";
      event: PreparedEvent;
      normalizedFields: Record<string, unknown>;
    }
  | {
      kind: "skip";
      reason: "missing_date" | "missing_venue" | "invalid_event" | "past_event";
      normalizedFields: Record<string, unknown>;
    };

type EventStatus = "pending" | "approved" | "rejected";

type ExistingEventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  moderationNote?: string;
};

type ExistingSourceMatch = {
  existingEvent: ExistingEventRecord;
  matchedBy: "post_id" | "shortcode" | "post_url";
  matchedValue: string;
};

type DuplicateQualityReason =
  | "wrong_year"
  | "bad_venue"
  | "low_confidence"
  | "invalid_required_fields"
  | "invalid_normalized_fields";

type ExistingEventQuality = {
  isLowQuality: boolean;
  primaryReason: DuplicateQualityReason | null;
  reasons: DuplicateQualityReason[];
  details: Record<string, unknown>;
};

type DuplicateUpdateLogEvent =
  | "duplicate_updated_wrong_year"
  | "duplicate_updated_bad_venue"
  | "duplicate_updated_low_confidence"
  | "duplicate_updated_bad_data";

type IngestionStep =
  | "fetch_posts"
  | "normalize_posts"
  | "duplicate_lookup"
  | "extract_event"
  | "update_existing_event"
  | "insert_new_event";

type IngestionPostContext = {
  handle: string;
  sourcePostId: string | null;
  shortcode: string | null;
  instagramUrl: string;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MAX_DATE_DISTANCE_DAYS = 180;
const EXISTING_EVENT_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_EVENT_TIMEZONE = "Europe/Belgrade";

function logInfo(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: "info",
      event,
      ...payload,
    }),
  );
}

function logError(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...payload,
    }),
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function getPostContext(handle: string, post: InstagramScrapedPost): IngestionPostContext {
  const sourcePostId = normalizeString(post.postId) || null;
  const instagramUrl = normalizeString(post.instagramPostUrl) || "";
  return {
    handle,
    sourcePostId,
    shortcode: extractShortcodeFromPostUrl(instagramUrl),
    instagramUrl,
  };
}

function getConvexClient(): ConvexHttpClient {
  const convexUrl = getRequiredEnv("NEXT_PUBLIC_CONVEX_URL");
  return new ConvexHttpClient(convexUrl);
}

type ActiveVenueRecord = {
  instagramHandle: string;
};

type SavedScrapedPostRecord = {
  handle: string;
  postId: string;
  caption?: string;
  imageUrl?: string;
  imageUrls: string[];
  postType?: string;
  locationName?: string;
  instagramPostUrl: string;
  postedAt?: string;
  username: string;
  createdAt: number;
  updatedAt: number;
};

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

function toSearchableText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeHandle(handle: string): string {
  const normalized = normalizeHandle(handle);
  const mappedVenue = KNOWN_VENUE_BY_HANDLE[normalized];
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

function buildFallbackTitle(post: InstagramScrapedPost, venue: VenueNormalization): string {
  const mappedVenue = KNOWN_VENUE_BY_HANDLE[normalizeHandle(post.username)];
  if (mappedVenue) {
    return mappedVenue;
  }

  const locationName = normalizeString(post.locationName);
  if (locationName) {
    return locationName;
  }

  if (venue.source === "handle_map" && venue.venue) {
    return venue.venue;
  }

  return humanizeHandle(post.username);
}

function isGenericEventTitle(value: string): boolean {
  return GENERIC_EVENT_TITLE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function normalizeEventTitle(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  venue: VenueNormalization,
): {
  title: string;
  source: "model" | "handle_fallback";
  rawTitle: string;
  usedFallback: boolean;
} {
  const rawTitle = normalizeString(extracted.title);
  const captionText = normalizeString(post.caption);
  const normalizedRawTitle = toSearchableText(rawTitle);
  const normalizedCaption = toSearchableText(captionText);
  const titleAppearsInCaption =
    normalizedRawTitle.length > 0 && normalizedCaption.includes(normalizedRawTitle);

  if (rawTitle && (!isGenericEventTitle(rawTitle) || titleAppearsInCaption)) {
    return {
      title: rawTitle,
      source: "model",
      rawTitle,
      usedFallback: false,
    };
  }

  return {
    title: buildFallbackTitle(post, venue),
    source: "handle_fallback",
    rawTitle,
    usedFallback: true,
  };
}

function createEmptyHandleSummary(handle: string): HandleSummary {
  return {
    handle,
    fetchedPosts: 0,
    fetched_posts: 0,
    insertedEvents: 0,
    inserted_events: 0,
    skippedDuplicates: 0,
    skipped_duplicates: 0,
    skipped_duplicates_clean: 0,
    skippedNoImage: 0,
    skipped_missing_date: 0,
    skipped_missing_venue: 0,
    skipped_video: 0,
    skipped_invalid_event: 0,
    skipped_past_event: 0,
    updated_duplicates_bad_data: 0,
    duplicate_update_failed: 0,
    failedDownloads: 0,
    failed_downloads: 0,
    failedConversions: 0,
    failed_conversions: 0,
    failedExtractions: 0,
    failed_extractions: 0,
    failed_extraction: 0,
    errors: [],
  };
}

function getOrCreateHandleSummary(summary: IngestionSummary, handle: string): HandleSummary {
  const existing = summary.handles.find((entry) => entry.handle === handle);
  if (existing) {
    return existing;
  }
  const created = createEmptyHandleSummary(handle);
  summary.handles.push(created);
  return created;
}

export function createEmptyIngestionSummary(handles: string[]): IngestionSummary {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    finishedAt: now,
    handles: handles.map((handle) => createEmptyHandleSummary(handle)),
  };
}

export function createInitialIngestionBatchState(): IngestionBatchState {
  return {
    handleIndex: 0,
    currentHandle: null,
    currentPostIndex: 0,
    currentHandlePosts: [],
    seenSourceKeysByHandle: {},
  };
}

async function persistScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  posts: InstagramScrapedPost[],
): Promise<void> {
  if (posts.length === 0) {
    return;
  }

  await client.mutation(upsertScrapedPostsByHandleMutation, {
    handle,
    posts: posts.map((post) => ({
      handle,
      postId: post.postId,
      ...(post.caption ? { caption: post.caption } : {}),
      ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
      imageUrls: post.imageUrls,
      ...(post.postType ? { postType: post.postType } : {}),
      ...(post.locationName ? { locationName: post.locationName } : {}),
      instagramPostUrl: post.instagramPostUrl,
      ...(post.postedAt ? { postedAt: post.postedAt } : {}),
      username: post.username,
    })),
  });
}

async function loadSavedScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  resultsLimit: number | undefined,
  daysBack: number | undefined,
): Promise<InstagramScrapedPost[]> {
  const savedPosts = (await client.query(listScrapedPostsByHandleQuery, {
    handle,
  })) as SavedScrapedPostRecord[];

  const filtered = savedPosts
    .map(mapSavedScrapedPostToInstagramPost)
    .filter((post) => isPostWithinDaysBack(post.postedAt, daysBack))
    .sort((left, right) => comparePostedAtDescending(left.postedAt, right.postedAt));

  if (!resultsLimit || resultsLimit < 1) {
    return filtered;
  }

  return filtered.slice(0, resultsLimit);
}

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  const rounded = Math.trunc(value as number);
  return Math.max(1, Math.min(10, rounded));
}

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeScrapedPost(post: InstagramScrapedPost): InstagramScrapedPost {
  const normalizedImageUrls = (post.imageUrls ?? [])
    .map((url) => normalizeString(url))
    .filter((url) => url.length > 0);

  return {
    postId: normalizeString(post.postId) || post.postId,
    caption: normalizeString(post.caption) || null,
    imageUrl: normalizeString(post.imageUrl) || null,
    imageUrls: normalizedImageUrls,
    postType: normalizeString(post.postType).toLowerCase() || null,
    locationName: normalizeString(post.locationName) || null,
    instagramPostUrl: normalizeString(post.instagramPostUrl) || post.instagramPostUrl,
    postedAt: normalizeString(post.postedAt) || null,
    username: normalizeString(post.username) || post.username,
  };
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readJsonBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readJsonString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readJsonNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function parsePostedAt(postedAt: string | null): Date | null {
  if (!postedAt) {
    return null;
  }
  const parsed = Date.parse(postedAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function comparePostedAtDescending(left: string | null, right: string | null): number {
  return (
    (parsePostedAt(right)?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (parsePostedAt(left)?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

function isPostWithinDaysBack(postedAt: string | null, daysBack: number | undefined): boolean {
  if (!daysBack || daysBack <= 0) {
    return true;
  }
  const parsed = parsePostedAt(postedAt);
  if (!parsed) {
    return true;
  }
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return parsed.getTime() >= cutoff;
}

function mapSavedScrapedPostToInstagramPost(
  record: SavedScrapedPostRecord,
): InstagramScrapedPost {
  return {
    postId: record.postId,
    caption: record.caption ?? null,
    imageUrl: record.imageUrl ?? null,
    imageUrls: record.imageUrls,
    postType: record.postType ?? null,
    locationName: record.locationName ?? null,
    instagramPostUrl: record.instagramPostUrl,
    postedAt: record.postedAt ?? null,
    username: record.username,
  };
}

function getConfiguredEventTimezone(): string {
  const configured = normalizeString(process.env.EVENTS_TIMEZONE);
  return configured || DEFAULT_EVENT_TIMEZONE;
}

function getIsoDateInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return now.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function getEventDateFilterContext(now = new Date()): { todayIsoDate: string; timeZone: string } {
  const timeZone = getConfiguredEventTimezone();
  try {
    return {
      todayIsoDate: getIsoDateInTimeZone(timeZone, now),
      timeZone,
    };
  } catch {
    return {
      todayIsoDate: now.toISOString().slice(0, 10),
      timeZone: "UTC",
    };
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
}

function getSuspiciousYearDifference(
  parsedYear: number,
  postDate: Date | null,
): { isSuspicious: boolean; yearDistanceFromPost: number | null } {
  if (!postDate) {
    return { isSuspicious: false, yearDistanceFromPost: null };
  }
  const yearDistanceFromPost = Math.abs(parsedYear - postDate.getUTCFullYear());
  return { isSuspicious: yearDistanceFromPost >= 2, yearDistanceFromPost };
}

function normalizeYear(rawYear: string): number {
  if (rawYear.length === 2) {
    return 2000 + Number.parseInt(rawYear, 10);
  }
  return Number.parseInt(rawYear, 10);
}

function buildDateWithPossibleYearInference(
  day: number,
  month: number,
  rawYear: string | undefined,
  postDate: Date | null,
  isAmbiguousNumeric: boolean,
  source: DateSource,
  raw: string,
): DateCandidate | null {
  if (rawYear) {
    const year = normalizeYear(rawYear);
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      return null;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    return {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "medium" : "high",
      distanceFromPostDays: postDate ? daysBetween(parsed, postDate) : null,
      inferredYear: false,
      year,
      rawYearProvided: true,
      raw,
    };
  }

  if (!postDate) {
    return null;
  }

  const candidateYears = [postDate.getUTCFullYear() - 1, postDate.getUTCFullYear(), postDate.getUTCFullYear() + 1];
  let bestCandidate: DateCandidate | null = null;

  for (const year of candidateYears) {
    const isoDate = normalizeIsoDate(year, month, day);
    if (!isoDate) {
      continue;
    }
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    const candidate: DateCandidate = {
      isoDate,
      source,
      confidence: isAmbiguousNumeric ? "low" : "medium",
      distanceFromPostDays: daysBetween(parsed, postDate),
      inferredYear: true,
      year,
      rawYearProvided: false,
      raw,
    };
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    if (
      (candidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY) <
      (bestCandidate.distanceFromPostDays ?? Number.POSITIVE_INFINITY)
    ) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function collectDateCandidates(
  text: string,
  source: DateSource,
  postDate: Date | null,
): DateCandidate[] {
  const candidates: DateCandidate[] = [];
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return candidates;
  }

  const appendCandidate = (candidate: DateCandidate | null) => {
    if (!candidate) {
      return;
    }
    candidates.push(candidate);
  };

  for (const match of normalizedText.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[3], 10),
        Number.parseInt(match[2], 10),
        match[1],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g)) {
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    const rawYear = match[3];
    const dayMonthCandidate = buildDateWithPossibleYearInference(
      first,
      second,
      rawYear,
      postDate,
      first <= 12 && second <= 12,
      source,
      match[0],
    );
    appendCandidate(dayMonthCandidate);

    if (first <= 12 && second <= 12) {
      const monthDayCandidate = buildDateWithPossibleYearInference(
        second,
        first,
        rawYear,
        postDate,
        true,
        source,
        match[0],
      );
      appendCandidate(monthDayCandidate);
    }
  }

  for (const match of normalizedText.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,9})(?:\s*,?\s*(\d{4}))?\b/g,
  )) {
    const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[1], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  for (const match of normalizedText.matchAll(
    /\b([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/g,
  )) {
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (!month) {
      continue;
    }
    appendCandidate(
      buildDateWithPossibleYearInference(
        Number.parseInt(match[2], 10),
        month,
        match[3],
        postDate,
        false,
        source,
        match[0],
      ),
    );
  }

  return candidates;
}

function normalizeEventDate(
  rawModelDate: string,
  caption: string | null,
  postedAt: string | null,
): DateNormalization {
  const postDate = parsePostedAt(postedAt);
  const candidates = [
    ...collectDateCandidates(rawModelDate, "model", postDate),
    ...collectDateCandidates(caption ?? "", "caption", postDate),
  ];

  if (candidates.length === 0) {
    return {
      isoDate: null,
      source: null,
      confidence: null,
      distanceFromPostDays: null,
      inferredYear: false,
      rawDateText: null,
      yearSelectionReason: "no_date_candidate",
      suspiciousYear: false,
      reason: "missing_date",
    };
  }

  candidates.sort((a, b) => {
    const distanceA = a.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    const distanceB = b.distanceFromPostDays ?? Number.POSITIVE_INFINITY;
    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }

    const sourceWeightA = a.source === "model" ? 0 : 1;
    const sourceWeightB = b.source === "model" ? 0 : 1;
    if (sourceWeightA !== sourceWeightB) {
      return sourceWeightA - sourceWeightB;
    }

    const confidenceOrder: Record<DateConfidence, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    return confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
  });

  const selected = candidates[0];
  const yearSanity = getSuspiciousYearDifference(selected.year, postDate);
  const yearDistanceFromPost = yearSanity.yearDistanceFromPost;
  const suspiciousYear = yearSanity.isSuspicious;

  const yearSelectionReason = selected.rawYearProvided
    ? "explicit_year_from_text"
    : "year_inferred_from_post_timestamp_nearest";

  if (selected.confidence === "low") {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "low_confidence",
    };
  }

  const allowLongDistanceForVeryHighConfidence =
    selected.confidence === "high" &&
    selected.rawYearProvided &&
    yearDistanceFromPost !== null &&
    yearDistanceFromPost <= 1;

  if (
    postDate &&
    selected.distanceFromPostDays !== null &&
    selected.distanceFromPostDays > MAX_DATE_DISTANCE_DAYS &&
    !allowLongDistanceForVeryHighConfidence
  ) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear,
      reason: "implausible_date",
    };
  }

  if (suspiciousYear) {
    return {
      isoDate: null,
      source: selected.source,
      confidence: selected.confidence,
      distanceFromPostDays: selected.distanceFromPostDays,
      inferredYear: selected.inferredYear,
      rawDateText: selected.raw,
      yearSelectionReason,
      suspiciousYear: true,
      reason: "low_confidence",
    };
  }

  return {
    isoDate: selected.isoDate,
    source: selected.source,
    confidence: selected.confidence,
    distanceFromPostDays: selected.distanceFromPostDays,
    inferredYear: selected.inferredYear,
    rawDateText: selected.raw,
    yearSelectionReason,
    suspiciousYear,
  };
}

function parseIsoDateUtc(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function expandNormalizedDateRange(
  rawModelDate: string,
  postedAt: string | null,
): string[] | null {
  const normalizedRawDate = normalizeString(rawModelDate);
  if (!normalizedRawDate) {
    return null;
  }

  const hasRangeHint =
    /\b(to|through|thru|do)\b/i.test(normalizedRawDate) ||
    /[–—]/.test(normalizedRawDate) ||
    /\s-\s/.test(normalizedRawDate);
  if (!hasRangeHint) {
    return null;
  }

  const postDate = parsePostedAt(postedAt);
  const candidates = collectDateCandidates(normalizedRawDate, "model", postDate);
  const uniqueDates = [...new Set(candidates.map((candidate) => candidate.isoDate))].sort();
  if (uniqueDates.length < 2) {
    return null;
  }

  const start = parseIsoDateUtc(uniqueDates[0]);
  const end = parseIsoDateUtc(uniqueDates[uniqueDates.length - 1]);
  if (!start || !end) {
    return null;
  }

  const distanceDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (distanceDays < 1 || distanceDays > 14) {
    return null;
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= distanceDays; offset += 1) {
    dates.push(toIsoDateUtc(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}

function isLowConfidenceVenue(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  const exactGenericValues = new Set([
    "belgrade",
    "beograd",
    "belgrade klub",
    "belgrade club",
    "beograd klub",
    "beograd club",
    "club",
    "klub",
    "nightclub",
    "night club",
    "party",
    "event",
  ]);
  if (exactGenericValues.has(normalized)) {
    return true;
  }
  if (/^belgrade\s+(club|klub)$/.test(normalized)) {
    return true;
  }
  if (/^beograd\s+(club|klub)$/.test(normalized)) {
    return true;
  }
  return false;
}

function normalizeVenue(post: InstagramScrapedPost, rawModelVenue: string): VenueNormalization {
  const mappedVenue = KNOWN_VENUE_BY_HANDLE[normalizeHandle(post.username)] ?? "";
  const locationName = normalizeString(post.locationName);
  const modelVenue = normalizeString(rawModelVenue);

  if (mappedVenue) {
    return {
      venue: mappedVenue,
      source: "handle_map",
      wasFallback: true,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  if (locationName && !isLowConfidenceVenue(locationName)) {
    return {
      venue: locationName,
      source: "location_name",
      wasFallback: true,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  if (modelVenue && !isLowConfidenceVenue(modelVenue)) {
    return {
      venue: modelVenue,
      source: "model",
      wasFallback: false,
      rawModelVenue: modelVenue,
      rawLocationName: locationName,
    };
  }

  return {
    venue: null,
    source: null,
    wasFallback: true,
    rawModelVenue: modelVenue,
    rawLocationName: locationName,
  };
}

function extractShortcodeFromPostUrl(url: string): string | null {
  const match = url.match(/instagram\.com\/p\/([^/?#]+)/i);
  return match?.[1]?.trim() || null;
}

function getSourceIdentityKey(post: InstagramScrapedPost): string | null {
  const postId = normalizeString(post.postId);
  if (postId) {
    return `post_id:${postId}`;
  }
  const shortcode = extractShortcodeFromPostUrl(post.instagramPostUrl);
  if (shortcode) {
    return `shortcode:${shortcode}`;
  }
  const postUrl = normalizeString(post.instagramPostUrl);
  if (postUrl) {
    return `post_url:${postUrl}`;
  }
  return null;
}

function parseEventYear(date: string | undefined): number | null {
  if (!date) {
    return null;
  }
  const match = date.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function mapDuplicateReasonToLogEvent(reason: DuplicateQualityReason): DuplicateUpdateLogEvent {
  if (reason === "wrong_year") return "duplicate_updated_wrong_year";
  if (reason === "bad_venue") return "duplicate_updated_bad_venue";
  if (reason === "low_confidence") return "duplicate_updated_low_confidence";
  return "duplicate_updated_bad_data";
}

function isLowQualityExistingEvent(
  existing: ExistingEventRecord,
  postTimestamp: string | null,
): ExistingEventQuality {
  const reasons = new Set<DuplicateQualityReason>();
  const normalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const postDate = parsePostedAt(postTimestamp ?? existing.sourcePostedAt ?? null);
  const eventYear = parseEventYear(existing.date);
  const explicitYearHighConfidence =
    readJsonString(normalizedFields, "dateYearSelectionReason") === "explicit_year_from_text" &&
    readJsonString(normalizedFields, "dateConfidence") === "high";
  const confidence = readJsonNumber(normalizedFields, "confidence");

  if (!normalizeString(existing.title) || !normalizeString(existing.date) || !normalizeString(existing.venue) || !normalizeString(existing.eventType)) {
    reasons.add("invalid_required_fields");
  }

  if (readJsonBoolean(normalizedFields, "dateSuspiciousYear")) {
    reasons.add("wrong_year");
  }

  if (postDate && eventYear !== null) {
    const postYear = postDate.getUTCFullYear();
    if (Math.abs(eventYear - postYear) >= 2) {
      reasons.add("wrong_year");
    }
    if (eventYear < postYear && !explicitYearHighConfidence) {
      reasons.add("wrong_year");
    }
  }

  if (
    readJsonString(normalizedFields, "dateReason") !== null ||
    readJsonString(normalizedFields, "normalizedDate") === null ||
    readJsonBoolean(normalizedFields, "normalizedIsValid") === false
  ) {
    reasons.add("invalid_normalized_fields");
  }

  if (isLowConfidenceVenue(existing.venue)) {
    reasons.add("bad_venue");
  }

  const normalizedVenue = existing.venue.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedVenue === "unknown venue" || normalizedVenue === "20_44 nightclub") {
    reasons.add("bad_venue");
  }

  if (confidence !== null && confidence < EXISTING_EVENT_CONFIDENCE_THRESHOLD) {
    reasons.add("low_confidence");
  }

  const orderedReasons: DuplicateQualityReason[] = [];
  if (reasons.has("wrong_year")) orderedReasons.push("wrong_year");
  if (reasons.has("bad_venue")) orderedReasons.push("bad_venue");
  if (reasons.has("low_confidence")) orderedReasons.push("low_confidence");
  if (reasons.has("invalid_required_fields")) orderedReasons.push("invalid_required_fields");
  if (reasons.has("invalid_normalized_fields")) orderedReasons.push("invalid_normalized_fields");

  return {
    isLowQuality: orderedReasons.length > 0,
    primaryReason: orderedReasons[0] ?? null,
    reasons: orderedReasons,
    details: {
      postTimestamp: postTimestamp ?? existing.sourcePostedAt ?? null,
      existingDate: existing.date,
      existingVenue: existing.venue,
      existingStatus: existing.status,
      confidence,
      explicitYearHighConfidence,
      normalizedDateReason: readJsonString(normalizedFields, "dateReason"),
      normalizedDate: readJsonString(normalizedFields, "normalizedDate"),
      normalizedInvalidReason: readJsonString(normalizedFields, "normalizedInvalidReason"),
    },
  };
}

function normalizeArtistsForComparison(artists: string[]): string[] {
  return artists.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0).sort();
}

function hasMaterialEventChange(existing: ExistingEventRecord, next: PreparedEvent): boolean {
  if (normalizeString(existing.title) !== normalizeString(next.title)) return true;
  if (normalizeString(existing.date) !== normalizeString(next.date)) return true;
  if (normalizeString(existing.time) !== normalizeString(next.time)) return true;
  if (normalizeString(existing.venue) !== normalizeString(next.venue)) return true;
  if (normalizeString(existing.eventType) !== normalizeString(next.eventType)) return true;
  if (normalizeString(existing.ticketPrice) !== normalizeString(next.ticketPrice)) return true;
  if (normalizeString(existing.description) !== normalizeString(next.description)) return true;
  if (normalizeString(existing.imageUrl) !== normalizeString(next.imageUrl)) return true;
  if (
    JSON.stringify(normalizeArtistsForComparison(existing.artists)) !==
    JSON.stringify(normalizeArtistsForComparison(next.artists))
  ) {
    return true;
  }
  return false;
}

function buildDuplicateUpdatePatch(
  existing: ExistingEventRecord,
  next: PreparedEvent,
): {
  patch: {
    title?: string;
    date?: string;
    time?: string;
    venue?: string;
    artists?: string[];
    description?: string;
    imageUrl?: string;
    instagramPostUrl?: string;
    instagramPostId?: string;
    ticketPrice?: string;
    eventType?: string;
    sourceCaption?: string;
    sourcePostedAt?: string;
    rawExtractionJson?: string;
    normalizedFieldsJson?: string;
    status?: EventStatus;
    reviewedAt?: number;
    reviewedBy?: string;
    moderationNote?: string;
  };
  materiallyChanged: boolean;
  statusResetToPending: boolean;
} {
  const materiallyChanged = hasMaterialEventChange(existing, next);
  const statusResetToPending = materiallyChanged && existing.status !== "pending";
  const nextStatus: EventStatus = statusResetToPending ? "pending" : existing.status;

  return {
    patch: {
      title: next.title,
      date: next.date,
      ...(next.time ? { time: next.time } : {}),
      venue: next.venue,
      artists: next.artists,
      ...(next.description ? { description: next.description } : {}),
      ...(next.imageUrl ? { imageUrl: next.imageUrl } : {}),
      instagramPostUrl: next.instagramPostUrl,
      instagramPostId: next.instagramPostId,
      ...(next.ticketPrice ? { ticketPrice: next.ticketPrice } : {}),
      eventType: next.eventType,
      ...(next.sourceCaption ? { sourceCaption: next.sourceCaption } : {}),
      ...(next.sourcePostedAt ? { sourcePostedAt: next.sourcePostedAt } : {}),
      ...(next.rawExtractionJson ? { rawExtractionJson: next.rawExtractionJson } : {}),
      ...(next.normalizedFieldsJson ? { normalizedFieldsJson: next.normalizedFieldsJson } : {}),
      ...(nextStatus !== existing.status ? { status: nextStatus } : {}),
      ...(statusResetToPending
        ? {
            reviewedAt: undefined,
            reviewedBy: undefined,
            moderationNote: undefined,
          }
        : {}),
    },
    materiallyChanged,
    statusResetToPending,
  };
}

async function listExistingEventsBySourceIdentity(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
): Promise<ExistingSourceMatch[]> {
  const postContext = getPostContext(normalizeHandle(post.username), post);
  const matchesById = new Map<string, ExistingSourceMatch>();

  const loadMatchesByPostId = async (
    candidate: string,
    matchedBy: "post_id" | "shortcode",
  ): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostIdQuery, {
        instagramPostId: candidate,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy,
        matchedValue: candidate,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostId",
        ...postContext,
        candidate,
        matchedBy,
        error: getErrorMessage(listError),
      });

      try {
        const fallback = (await client.query(getByInstagramPostIdQuery, {
          instagramPostId: candidate,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy,
            matchedValue: candidate,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostId",
          ...postContext,
          candidate,
          matchedBy,
          error: getErrorMessage(fallbackError),
        });
        return [];
      }
    }
  };

  const loadMatchesByPostUrl = async (postUrl: string): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostUrlQuery, {
        instagramPostUrl: postUrl,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy: "post_url" as const,
        matchedValue: postUrl,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostUrl",
        ...postContext,
        postUrl,
        matchedBy: "post_url",
        error: getErrorMessage(listError),
      });

      try {
        const fallback = (await client.query(getByInstagramPostUrlQuery, {
          instagramPostUrl: postUrl,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy: "post_url",
            matchedValue: postUrl,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostUrl",
          ...postContext,
          postUrl,
          matchedBy: "post_url",
          error: getErrorMessage(fallbackError),
        });
        return [];
      }
    }
  };

  const identityCandidates = new Set<string>();
  if (post.postId) {
    identityCandidates.add(post.postId);
  }
  const shortcode = extractShortcodeFromPostUrl(post.instagramPostUrl);
  if (shortcode) {
    identityCandidates.add(shortcode);
  }

  for (const candidate of identityCandidates) {
    const matchedBy = candidate === post.postId ? "post_id" : "shortcode";
    const matches = await loadMatchesByPostId(candidate, matchedBy);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  const postUrl = normalizeString(post.instagramPostUrl);
  if (postUrl) {
    const matches = await loadMatchesByPostUrl(postUrl);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  return [...matchesById.values()];
}

function normalizeTitleKey(value: string | undefined): string {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}

function findBestExistingMatchForPreparedEvent(
  existingMatches: ExistingSourceMatch[],
  nextEvent: PreparedEvent,
): ExistingSourceMatch | null {
  const titleKey = normalizeTitleKey(nextEvent.title);
  const exactMatch = existingMatches.find(
    (existing) =>
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      normalizeTitleKey(existing.existingEvent.title) === titleKey,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const sameDateMatch = existingMatches.find(
    (existing) => normalizeString(existing.existingEvent.date) === nextEvent.date,
  );
  if (sameDateMatch) {
    return sameDateMatch;
  }

  return null;
}

function prepareEventsForInsert(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  selectedImageUrl: string,
): PrepareEventResult[] {
  const eventType = normalizeString(extracted.category);
  const description = normalizeString(extracted.description);
  const time = normalizeString(extracted.time ?? undefined);
  const price = normalizeString(extracted.price);
  const currency = normalizeString(extracted.currency);
  const ticketPrice = `${price}${price && currency ? " " : ""}${currency}`.trim();
  const parsedConfidence =
    typeof extracted.confidence === "number"
      ? extracted.confidence
      : Number.parseFloat(extracted.confidence);
  const confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : null;
  const venueNormalization = normalizeVenue(post, extracted.venue);
  const titleNormalization = normalizeEventTitle(post, extracted, venueNormalization);
  const title = normalizeString(titleNormalization.title);
  const dateNormalization = normalizeEventDate(
    normalizeString(extracted.date),
    post.caption,
    post.postedAt,
  );
  const expandedRangeDates = expandNormalizedDateRange(
    normalizeString(extracted.date),
    post.postedAt,
  );
  const candidateDates =
    expandedRangeDates && expandedRangeDates.length > 1
      ? expandedRangeDates
      : dateNormalization.isoDate
        ? [dateNormalization.isoDate]
        : [];
  const eventDateFilter = getEventDateFilterContext();
  const normalizedFieldsBase: Record<string, unknown> = {
    title,
    rawTitle: titleNormalization.rawTitle,
    titleSource: titleNormalization.source,
    titleUsedFallback: titleNormalization.usedFallback,
    rawDate: normalizeString(extracted.date),
    rawExtractedDateText: dateNormalization.rawDateText,
    normalizedDate: candidateDates[0] ?? null,
    dateSource: dateNormalization.source,
    dateConfidence: dateNormalization.confidence,
    dateDistanceFromPostDays: dateNormalization.distanceFromPostDays,
    dateInferredYear: dateNormalization.inferredYear,
    dateSuspiciousYear: dateNormalization.suspiciousYear,
    dateYearSelectionReason: dateNormalization.yearSelectionReason,
    dateReason: dateNormalization.reason ?? null,
    rawVenue: normalizeString(extracted.venue),
    normalizedVenue: venueNormalization.venue,
    venueSource: venueNormalization.source,
    locationName: venueNormalization.rawLocationName,
    eventType,
    time,
    ticketPrice: ticketPrice || null,
    city: normalizeString(extracted.city),
    country: normalizeString(extracted.country),
    confidence,
    reasoningNotes: normalizeString(extracted.reasoning_notes),
    sourceCaptionFromModel: normalizeString(extracted.source_caption),
    sourceUrlFromModel: normalizeString(extracted.source_url),
    artists: extracted.artists,
    description,
    postTimestamp: post.postedAt,
    dateRangeExpanded: candidateDates.length > 1,
    dateRangeExpandedCount: candidateDates.length,
    filterDateToday: eventDateFilter.todayIsoDate,
    filterDateTimezone: eventDateFilter.timeZone,
    normalizedIsValid: true,
    normalizedInvalidReason: null,
  };

  if (candidateDates.length === 0) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsBase,
      normalizedIsValid: false,
      normalizedInvalidReason: "invalid_date",
    };
    return [
      {
        kind: "skip",
        reason: dateNormalization.reason === "missing_date" ? "missing_date" : "invalid_event",
        normalizedFields,
      },
    ];
  }

  if (!venueNormalization.venue) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsBase,
      normalizedIsValid: false,
      normalizedInvalidReason: "invalid_venue",
    };
    return [
      {
        kind: "skip",
        reason: "missing_venue",
        normalizedFields,
      },
    ];
  }

  if (!title || !eventType) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsBase,
      normalizedIsValid: false,
      normalizedInvalidReason: "missing_required_fields",
    };
    return [
      {
        kind: "skip",
        reason: "invalid_event",
        normalizedFields,
      },
    ];
  }

  const artists = extracted.artists
    .map((artist) => normalizeString(artist))
    .filter((artist) => artist.length > 0);

  const preparedEvents: PrepareEventResult[] = [];

  for (const [index, date] of candidateDates.entries()) {
    const normalizedFields: Record<string, unknown> = {
      ...normalizedFieldsBase,
      normalizedDate: date,
      expandedDateIndex: index + 1,
      expandedDateTotal: candidateDates.length,
    };

    if (date < eventDateFilter.todayIsoDate) {
      preparedEvents.push({
        kind: "skip",
        reason: "past_event",
        normalizedFields: {
          ...normalizedFields,
          normalizedIsValid: false,
          normalizedInvalidReason: "past_event",
        },
      });
      continue;
    }

    preparedEvents.push({
      kind: "ok",
      normalizedFields,
      event: {
        title,
        date,
        ...(time ? { time } : {}),
        venue: venueNormalization.venue,
        artists,
        ...(description ? { description } : {}),
        imageUrl: selectedImageUrl,
        instagramPostUrl: post.instagramPostUrl,
        instagramPostId: post.postId,
        ...(ticketPrice ? { ticketPrice } : {}),
        eventType,
        ...(post.caption ? { sourceCaption: post.caption } : {}),
        ...(post.postedAt ? { sourcePostedAt: post.postedAt } : {}),
        rawExtractionJson: JSON.stringify(extracted),
        normalizedFieldsJson: JSON.stringify(normalizedFields),
        status: "pending",
      },
    });
  }

  return preparedEvents;
}

type ProcessIngestionPostOptions = {
  client: ConvexHttpClient;
  handle: string;
  post: InstagramScrapedPost;
  summary: HandleSummary;
};

async function processIngestionPost(options: ProcessIngestionPostOptions): Promise<void> {
  const { client, handle, post, summary } = options;
  const postContext = getPostContext(handle, post);

  if (post.postType === "video") {
    summary.skipped_video += 1;
    logInfo("ingestion.post.skipped_video", {
      ...postContext,
    });
    return;
  }

  const bestImageUrl = resolveBestImageUrl(post);
  if (!bestImageUrl) {
    summary.skippedNoImage += 1;
    logInfo("ingestion.image.skipped_no_image", {
      ...postContext,
      imageCandidates: post.imageUrls ?? [],
    });
    return;
  }

  logInfo("ingestion.image.selected", {
    ...postContext,
    selectedImageUrl: bestImageUrl,
    isInstagramOrFbCdn: isInstagramOrFbCdnUrl(bestImageUrl),
  });

  let downloadedImage: Awaited<ReturnType<typeof downloadImage>>;
  try {
    downloadedImage = await downloadImage(bestImageUrl);
    logInfo("ingestion.image.download.success", {
      ...postContext,
      selectedImageUrl: bestImageUrl,
      contentType: downloadedImage.contentType,
      downloadedBytes: downloadedImage.imageBuffer.byteLength,
    });
  } catch (error) {
    summary.failedDownloads += 1;
    summary.failed_downloads += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.image.download.failed", {
      ...postContext,
      selectedImageUrl: bestImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let imageDataUrl: string;
  try {
    const normalizedImage = await normalizeToJpeg(
      downloadedImage.imageBuffer,
      downloadedImage.contentType ?? bestImageUrl,
    );
    imageDataUrl = toDataUrl(normalizedImage.imageBuffer, normalizedImage.mimeType);
    logInfo("ingestion.image.conversion.success", {
      ...postContext,
      selectedImageUrl: bestImageUrl,
      wasConverted: normalizedImage.wasConverted,
      outputMimeType: normalizedImage.mimeType,
      outputBytes: normalizedImage.imageBuffer.byteLength,
    });
  } catch (error) {
    summary.failedConversions += 1;
    summary.failed_conversions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.image.conversion.failed", {
      ...postContext,
      selectedImageUrl: bestImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let extracted: ExtractedEventData;
  try {
    extracted = await extractEventDataFromPoster({
      imageDataUrl,
      caption: post.caption,
      instagramPostUrl: post.instagramPostUrl,
      sourceImageUrl: bestImageUrl,
      instagramHandle: post.username,
      instagramPostTimestamp: post.postedAt,
    });
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.openai.extraction.failed", {
      step: "extract_event" satisfies IngestionStep,
      ...postContext,
      sourceImageUrl: bestImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let preparedResults: PrepareEventResult[];
  try {
    preparedResults = prepareEventsForInsert(post, extracted, bestImageUrl);
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.normalization.failed", {
      step: "normalize_posts" satisfies IngestionStep,
      ...postContext,
      selectedImageUrl: bestImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  let existingMatches: ExistingSourceMatch[] = [];
  try {
    existingMatches = await listExistingEventsBySourceIdentity(client, post);
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.duplicate_check.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      selectedImageUrl: bestImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  for (const prepared of preparedResults) {
    if (prepared.kind === "skip") {
      if (prepared.reason === "missing_date") {
        summary.skipped_missing_date += 1;
      } else if (prepared.reason === "missing_venue") {
        summary.skipped_missing_venue += 1;
      } else if (prepared.reason === "past_event") {
        summary.skipped_past_event += 1;
      } else {
        summary.skipped_invalid_event += 1;
      }

      logInfo("ingestion.event.skipped", {
        ...postContext,
        selectedImageUrl: bestImageUrl,
        reason: prepared.reason,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
      continue;
    }

    const existingMatch = findBestExistingMatchForPreparedEvent(
      existingMatches,
      prepared.event,
    );

    if (existingMatch) {
      const quality = isLowQualityExistingEvent(existingMatch.existingEvent, post.postedAt);
      const hasMaterialChange = hasMaterialEventChange(
        existingMatch.existingEvent,
        prepared.event,
      );

      if (!quality.isLowQuality && !hasMaterialChange) {
        summary.skippedDuplicates += 1;
        summary.skipped_duplicates += 1;
        summary.skipped_duplicates_clean += 1;
        logInfo("duplicate_clean_skip", {
          ...postContext,
          selectedImageUrl: bestImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          existingStatus: existingMatch.existingEvent.status,
          normalizedFields: prepared.normalizedFields,
        });
        continue;
      }

      const primaryReason = quality.primaryReason ?? "invalid_normalized_fields";
      const updateReasonEvent = mapDuplicateReasonToLogEvent(primaryReason);
      const updatePayload = buildDuplicateUpdatePatch(
        existingMatch.existingEvent,
        prepared.event,
      );

      try {
        await client.mutation(updateEventMutation, {
          id: existingMatch.existingEvent._id,
          patch: updatePayload.patch,
        });
        summary.updated_duplicates_bad_data += 1;
        logInfo(updateReasonEvent, {
          phase: "duplicate_updated",
          ...postContext,
          selectedImageUrl: bestImageUrl,
          matchedBy: existingMatch.matchedBy,
          matchedValue: existingMatch.matchedValue,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          qualityDetails: quality.details,
          materiallyChanged: updatePayload.materiallyChanged,
          statusResetToPending: updatePayload.statusResetToPending,
          caption: post.caption,
          postTimestamp: post.postedAt,
          rawExtraction: extracted,
          normalizedFields: prepared.normalizedFields,
        });
        existingMatch.existingEvent = {
          ...existingMatch.existingEvent,
          ...prepared.event,
          status:
            updatePayload.patch.status ?? existingMatch.existingEvent.status,
          reviewedAt:
            updatePayload.patch.reviewedAt ?? existingMatch.existingEvent.reviewedAt,
          reviewedBy:
            updatePayload.patch.reviewedBy ?? existingMatch.existingEvent.reviewedBy,
          moderationNote:
            updatePayload.patch.moderationNote ?? existingMatch.existingEvent.moderationNote,
        };
      } catch (error) {
        summary.duplicate_update_failed += 1;
        summary.errors.push(getErrorMessage(error));
        logError("duplicate_update_failed", {
          step: "update_existing_event" satisfies IngestionStep,
          ...postContext,
          selectedImageUrl: bestImageUrl,
          existingEventId: existingMatch.existingEvent._id,
          qualityReasons: quality.reasons,
          error: getErrorMessage(error),
        });
      }
      continue;
    }

    try {
      const insertedId = (await client.mutation(
        createEventMutation,
        prepared.event,
      )) as string;
      summary.insertedEvents += 1;
      summary.inserted_events += 1;
      existingMatches.push({
        existingEvent: {
          _id: insertedId,
          ...prepared.event,
        },
        matchedBy: "post_url",
        matchedValue: prepared.event.instagramPostUrl,
      });
      logInfo("ingestion.event.inserted", {
        ...postContext,
        selectedImageUrl: bestImageUrl,
        caption: post.caption,
        postTimestamp: post.postedAt,
        rawExtraction: extracted,
        normalizedFields: prepared.normalizedFields,
      });
    } catch (error) {
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.failed_extraction += 1;
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.insert.failed", {
        step: "insert_new_event" satisfies IngestionStep,
        ...postContext,
        selectedImageUrl: bestImageUrl,
        error: getErrorMessage(error),
      });
    }
  }
}

export async function runInstagramIngestionBatchStep(
  options: IngestionBatchStepOptions,
): Promise<IngestionBatchStepResult> {
  const client = getConvexClient();
  const batchSize = normalizeBatchSize(options.batchSize);
  const mode = options.mode ?? "full_scrape";
  const summary = options.summary;
  const state = options.state;
  let processedPosts = 0;

  while (processedPosts < batchSize && state.handleIndex < options.handles.length) {
    const handle = options.handles[state.handleIndex];
    const handleSummary = getOrCreateHandleSummary(summary, handle);

    if (state.currentHandle !== handle) {
      state.currentHandle = handle;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
    }

    if (state.currentHandlePosts.length === 0) {
      try {
        const posts =
          mode === "saved_posts"
            ? await loadSavedScrapedPostsForHandle(
                client,
                handle,
                options.resultsLimit,
                options.daysBack,
              )
            : await scrapeInstagramAccount({
                handle,
                resultsLimit: options.resultsLimit,
                daysBack: options.daysBack,
              });

        if (mode === "full_scrape") {
          try {
            await persistScrapedPostsForHandle(client, handle, posts);
          } catch (persistError) {
            logError("ingestion.scrape.persist_failed", {
              step: "fetch_posts" satisfies IngestionStep,
              handle,
              sourcePostId: null,
              shortcode: null,
              instagramUrl: null,
              error: getErrorMessage(persistError),
            });
          }
        }

        handleSummary.fetchedPosts = posts.length;
        handleSummary.fetched_posts = posts.length;
        state.currentHandlePosts = posts;
      } catch (error) {
        handleSummary.errors.push(
          getErrorMessage(error),
        );
        logError("ingestion.scrape.failed", {
          step: "fetch_posts" satisfies IngestionStep,
          handle,
          sourcePostId: null,
          shortcode: null,
          instagramUrl: null,
          error: getErrorMessage(error),
        });
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        continue;
      }
    }

    if (state.currentPostIndex >= state.currentHandlePosts.length) {
      state.handleIndex += 1;
      state.currentHandle = null;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
      continue;
    }

    let post = state.currentHandlePosts[state.currentPostIndex];
    state.currentPostIndex += 1;

    try {
      post = normalizeScrapedPost(post);
    } catch (error) {
      handleSummary.errors.push(getErrorMessage(error));
      logError("ingestion.post.normalize.failed", {
        step: "normalize_posts" satisfies IngestionStep,
        ...getPostContext(handle, post),
        error: getErrorMessage(error),
      });
      continue;
    }

    const sourceKey = getSourceIdentityKey(post);
    if (sourceKey) {
      const seenForHandle = state.seenSourceKeysByHandle[handle] ?? [];
      if (seenForHandle.includes(sourceKey)) {
        continue;
      }
      seenForHandle.push(sourceKey);
      state.seenSourceKeysByHandle[handle] = seenForHandle;
    }

    await processIngestionPost({
      client,
      handle,
      post,
      summary: handleSummary,
    });
    processedPosts += 1;
  }

  const done = state.handleIndex >= options.handles.length;
  if (done) {
    state.currentHandle = null;
    state.currentPostIndex = 0;
    state.currentHandlePosts = [];
  }
  summary.finishedAt = new Date().toISOString();

  return {
    summary,
    state,
    done,
  };
}

export async function getActiveVenueHandles(): Promise<string[]> {
  const client = getConvexClient();
  const venues = (await client.query(listActiveVenuesQuery, {})) as ActiveVenueRecord[];
  const uniqueHandles = new Set<string>();

  for (const venue of venues) {
    const normalizedHandle = normalizeHandle(venue.instagramHandle);
    if (normalizedHandle.length > 0) {
      uniqueHandles.add(normalizedHandle);
    }
  }

  return [...uniqueHandles];
}

export async function runActiveVenueIngestion(options?: {
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
}): Promise<ActiveVenueIngestionResult> {
  const venueHandles = await getActiveVenueHandles();
  if (venueHandles.length === 0) {
    return {
      venueHandles: [],
      summary: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        handles: [],
      },
    };
  }

  const summary = await runInstagramIngestion({
    handles: venueHandles,
    resultsLimit: options?.resultsLimit,
    daysBack: options?.daysBack,
    mode: options?.mode,
  });

  return { venueHandles, summary };
}

export async function runInstagramIngestion(
  options: RunInstagramIngestionOptions,
): Promise<IngestionSummary> {
  const summary = createEmptyIngestionSummary(options.handles);
  const state = createInitialIngestionBatchState();
  let done = false;

  while (!done) {
    const batchResult = await runInstagramIngestionBatchStep({
      handles: options.handles,
      summary,
      state,
      resultsLimit: options.resultsLimit,
      daysBack: options.daysBack,
      batchSize: 10,
      mode: options.mode,
    });
    done = batchResult.done;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
