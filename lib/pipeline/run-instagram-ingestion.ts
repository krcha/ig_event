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
};

type HandleSummary = {
  handle: string;
  fetchedPosts: number;
  fetched_posts: number;
  insertedEvents: number;
  inserted_events: number;
  skippedDuplicates: number;
  skipped_duplicates: number;
  skippedNoImage: number;
  skipped_missing_date: number;
  skipped_missing_venue: number;
  skipped_video: number;
  skipped_invalid_event: number;
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

export type ActiveVenueIngestionResult = {
  venueHandles: string[];
  summary: IngestionSummary;
};

const getByInstagramPostIdQuery =
  "events:getByInstagramPostId" as unknown as FunctionReference<"query">;
const createEventMutation =
  "events:createEvent" as unknown as FunctionReference<"mutation">;
const listActiveVenuesQuery =
  "venues:listActiveVenues" as unknown as FunctionReference<"query">;
const KNOWN_VENUE_BY_HANDLE: Record<string, string> = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};

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
      reason: "missing_date" | "missing_venue" | "invalid_event";
      normalizedFields: Record<string, unknown>;
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

function getConvexClient(): ConvexHttpClient {
  const convexUrl = getRequiredEnv("NEXT_PUBLIC_CONVEX_URL");
  return new ConvexHttpClient(convexUrl);
}

type ActiveVenueRecord = {
  instagramHandle: string;
};

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
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

function prepareEventForInsert(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  selectedImageUrl: string,
): PrepareEventResult {
  const title = normalizeString(extracted.title);
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
  const dateNormalization = normalizeEventDate(
    normalizeString(extracted.date),
    post.caption,
    post.postedAt,
  );
  const normalizedFields: Record<string, unknown> = {
    title,
    rawDate: normalizeString(extracted.date),
    rawExtractedDateText: dateNormalization.rawDateText,
    normalizedDate: dateNormalization.isoDate,
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
  };

  if (!dateNormalization.isoDate) {
    return {
      kind: "skip",
      reason: dateNormalization.reason === "missing_date" ? "missing_date" : "invalid_event",
      normalizedFields,
    };
  }

  if (!venueNormalization.venue) {
    return {
      kind: "skip",
      reason: "missing_venue",
      normalizedFields,
    };
  }

  if (!title || !eventType) {
    return {
      kind: "skip",
      reason: "invalid_event",
      normalizedFields,
    };
  }

  const artists = extracted.artists
    .map((artist) => normalizeString(artist))
    .filter((artist) => artist.length > 0);

  return {
    kind: "ok",
    normalizedFields,
    event: {
      title,
      date: dateNormalization.isoDate,
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
  });

  return { venueHandles, summary };
}

async function isDuplicatePost(
  client: ConvexHttpClient,
  postId: string,
): Promise<boolean> {
  const existing = (await client.query(getByInstagramPostIdQuery, {
    instagramPostId: postId,
  })) as unknown;

  return Boolean(existing);
}

export async function runInstagramIngestion(
  options: RunInstagramIngestionOptions,
): Promise<IngestionSummary> {
  const startedAt = new Date().toISOString();
  const client = getConvexClient();
  const handleSummaries: HandleSummary[] = [];

  for (const handle of options.handles) {
    const summary: HandleSummary = {
      handle,
      fetchedPosts: 0,
      fetched_posts: 0,
      insertedEvents: 0,
      inserted_events: 0,
      skippedDuplicates: 0,
      skipped_duplicates: 0,
      skippedNoImage: 0,
      skipped_missing_date: 0,
      skipped_missing_venue: 0,
      skipped_video: 0,
      skipped_invalid_event: 0,
      failedDownloads: 0,
      failed_downloads: 0,
      failedConversions: 0,
      failed_conversions: 0,
      failedExtractions: 0,
      failed_extractions: 0,
      failed_extraction: 0,
      errors: [],
    };
    handleSummaries.push(summary);

    let posts: InstagramScrapedPost[] = [];
    try {
      posts = await scrapeInstagramAccount({
        handle,
        resultsLimit: options.resultsLimit,
        daysBack: options.daysBack,
      });
      summary.fetchedPosts = posts.length;
      summary.fetched_posts = posts.length;
    } catch (error) {
      summary.errors.push(
        error instanceof Error ? error.message : "Unknown scrape error.",
      );
      continue;
    }

    for (const post of posts) {
      if (post.postType === "video") {
        summary.skipped_video += 1;
        logInfo("ingestion.post.skipped_video", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
        });
        continue;
      }

      const bestImageUrl = resolveBestImageUrl(post);
      if (!bestImageUrl) {
        summary.skippedNoImage += 1;
        logInfo("ingestion.image.skipped_no_image", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          imageCandidates: post.imageUrls ?? [],
        });
        continue;
      }

      logInfo("ingestion.image.selected", {
        handle,
        postId: post.postId,
        postUrl: post.instagramPostUrl,
        selectedImageUrl: bestImageUrl,
        isInstagramOrFbCdn: isInstagramOrFbCdnUrl(bestImageUrl),
      });

      try {
        const alreadyStored = await isDuplicatePost(client, post.postId);
        if (alreadyStored) {
          summary.skippedDuplicates += 1;
          summary.skipped_duplicates += 1;
          continue;
        }
      } catch (error) {
        summary.failedExtractions += 1;
        summary.failed_extractions += 1;
        summary.errors.push(
          error instanceof Error ? error.message : "Duplicate check error.",
        );
        logError("ingestion.duplicate_check.failed", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          error: error instanceof Error ? error.message : "Unknown duplicate check error.",
        });
        continue;
      }

      let downloadedImage: Awaited<ReturnType<typeof downloadImage>>;
      try {
        downloadedImage = await downloadImage(bestImageUrl);
        logInfo("ingestion.image.download.success", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          contentType: downloadedImage.contentType,
          downloadedBytes: downloadedImage.imageBuffer.byteLength,
        });
      } catch (error) {
        summary.failedDownloads += 1;
        summary.failed_downloads += 1;
        summary.errors.push(error instanceof Error ? error.message : "Image download failed.");
        logError("ingestion.image.download.failed", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          error: error instanceof Error ? error.message : "Unknown download error.",
        });
        continue;
      }

      let imageDataUrl: string;
      try {
        const normalizedImage = await normalizeToJpeg(
          downloadedImage.imageBuffer,
          downloadedImage.contentType ?? bestImageUrl,
        );
        imageDataUrl = toDataUrl(normalizedImage.imageBuffer, normalizedImage.mimeType);
        logInfo("ingestion.image.conversion.success", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          wasConverted: normalizedImage.wasConverted,
          outputMimeType: normalizedImage.mimeType,
          outputBytes: normalizedImage.imageBuffer.byteLength,
        });
      } catch (error) {
        summary.failedConversions += 1;
        summary.failed_conversions += 1;
        summary.errors.push(error instanceof Error ? error.message : "Image conversion failed.");
        logError("ingestion.image.conversion.failed", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          error: error instanceof Error ? error.message : "Unknown conversion error.",
        });
        continue;
      }

      try {
        const extracted = await extractEventDataFromPoster({
          imageDataUrl,
          caption: post.caption,
          instagramPostUrl: post.instagramPostUrl,
          sourceImageUrl: bestImageUrl,
          instagramHandle: post.username,
          instagramPostTimestamp: post.postedAt,
        });
        const prepared = prepareEventForInsert(post, extracted, bestImageUrl);
        if (prepared.kind === "skip") {
          if (prepared.reason === "missing_date") {
            summary.skipped_missing_date += 1;
          } else if (prepared.reason === "missing_venue") {
            summary.skipped_missing_venue += 1;
          } else {
            summary.skipped_invalid_event += 1;
          }

          logInfo("ingestion.event.skipped", {
            handle,
            postId: post.postId,
            postUrl: post.instagramPostUrl,
            selectedImageUrl: bestImageUrl,
            reason: prepared.reason,
            caption: post.caption,
            postTimestamp: post.postedAt,
            rawExtraction: extracted,
            normalizedFields: prepared.normalizedFields,
          });
          continue;
        }

        await client.mutation(createEventMutation, prepared.event);
        summary.insertedEvents += 1;
        summary.inserted_events += 1;
        logInfo("ingestion.event.inserted", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
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
        summary.errors.push(
          error instanceof Error ? error.message : "Unknown extraction error.",
        );
        logError("ingestion.openai.extraction.failed", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
          error: error instanceof Error ? error.message : "Unknown extraction error.",
        });
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    handles: handleSummaries,
  };
}
