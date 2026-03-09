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
  insertedEvents: number;
  inserted_events: number;
  skippedDuplicates: number;
  skippedNoImage: number;
  skipped_missing_date: number;
  skipped_missing_venue: number;
  skipped_video: number;
  skipped_invalid_event: number;
  failedDownloads: number;
  failedConversions: number;
  failedExtractions: number;
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
  status: "pending";
};

type PrepareEventResult =
  | {
      kind: "ok";
      event: PreparedEvent;
      usedVenueFallback: boolean;
      usedDateFallback: boolean;
    }
  | {
      kind: "skip";
      reason: "missing_date" | "missing_venue" | "invalid_event";
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

function inferDateFromCaption(
  caption: string | null,
  postedAt: string | null,
): string | null {
  const text = normalizeString(caption);
  if (!text) {
    return null;
  }

  const fallbackYear = postedAt
    ? new Date(postedAt).getUTCFullYear()
    : new Date().getUTCFullYear();

  const yyyyMmDdMatch = text.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (yyyyMmDdMatch) {
    return normalizeIsoDate(
      Number.parseInt(yyyyMmDdMatch[1], 10),
      Number.parseInt(yyyyMmDdMatch[2], 10),
      Number.parseInt(yyyyMmDdMatch[3], 10),
    );
  }

  const ddMmYyyyMatch = text.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
  if (ddMmYyyyMatch) {
    const day = Number.parseInt(ddMmYyyyMatch[1], 10);
    const month = Number.parseInt(ddMmYyyyMatch[2], 10);
    const rawYear = ddMmYyyyMatch[3];
    const year = rawYear
      ? rawYear.length === 2
        ? 2000 + Number.parseInt(rawYear, 10)
        : Number.parseInt(rawYear, 10)
      : fallbackYear;
    return normalizeIsoDate(year, month, day);
  }

  const dayMonthNameMatch = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,9})(?:\s*,?\s*(\d{4}))?\b/,
  );
  if (dayMonthNameMatch) {
    const day = Number.parseInt(dayMonthNameMatch[1], 10);
    const month = MONTHS[dayMonthNameMatch[2].slice(0, 3).toLowerCase()];
    const year = dayMonthNameMatch[3]
      ? Number.parseInt(dayMonthNameMatch[3], 10)
      : fallbackYear;
    if (month) {
      return normalizeIsoDate(year, month, day);
    }
  }

  const monthNameDayMatch = text.match(
    /\b([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/,
  );
  if (monthNameDayMatch) {
    const month = MONTHS[monthNameDayMatch[1].slice(0, 3).toLowerCase()];
    const day = Number.parseInt(monthNameDayMatch[2], 10);
    const year = monthNameDayMatch[3]
      ? Number.parseInt(monthNameDayMatch[3], 10)
      : fallbackYear;
    if (month) {
      return normalizeIsoDate(year, month, day);
    }
  }

  return null;
}

function prepareEventForInsert(
  post: InstagramScrapedPost,
  extracted: ExtractedEventData,
  selectedImageUrl: string,
): PrepareEventResult {
  const title = normalizeString(extracted.eventName);
  const eventType = normalizeString(extracted.eventType);
  const description = normalizeString(extracted.description);
  const time = normalizeString(extracted.time ?? undefined);
  const ticketPrice = normalizeString(extracted.ticketPrice ?? undefined);

  let venue = normalizeString(extracted.venue);
  let usedVenueFallback = false;
  if (!venue) {
    venue = normalizeString(post.locationName);
    usedVenueFallback = venue.length > 0;
  }
  if (!venue) {
    venue = KNOWN_VENUE_BY_HANDLE[normalizeHandle(post.username)] ?? "";
    usedVenueFallback = venue.length > 0;
  }
  if (!venue) {
    return { kind: "skip", reason: "missing_venue" };
  }

  let date = normalizeString(extracted.date);
  let usedDateFallback = false;
  if (!date) {
    date = inferDateFromCaption(post.caption, post.postedAt) ?? "";
    usedDateFallback = date.length > 0;
  }
  if (!date) {
    return { kind: "skip", reason: "missing_date" };
  }

  if (!title || !eventType) {
    return { kind: "skip", reason: "invalid_event" };
  }

  const artists = extracted.artists
    .map((artist) => normalizeString(artist))
    .filter((artist) => artist.length > 0);

  return {
    kind: "ok",
    usedVenueFallback,
    usedDateFallback,
    event: {
      title,
      date,
      ...(time ? { time } : {}),
      venue,
      artists,
      ...(description ? { description } : {}),
      imageUrl: selectedImageUrl,
      instagramPostUrl: post.instagramPostUrl,
      instagramPostId: post.postId,
      ...(ticketPrice ? { ticketPrice } : {}),
      eventType,
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
      insertedEvents: 0,
      inserted_events: 0,
      skippedDuplicates: 0,
      skippedNoImage: 0,
      skipped_missing_date: 0,
      skipped_missing_venue: 0,
      skipped_video: 0,
      skipped_invalid_event: 0,
      failedDownloads: 0,
      failedConversions: 0,
      failedExtractions: 0,
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
          continue;
        }
      } catch (error) {
        summary.failedExtractions += 1;
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
            extractedDate: extracted.date,
            extractedVenue: extracted.venue,
            locationName: post.locationName,
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
          usedVenueFallback: prepared.usedVenueFallback,
          usedDateFallback: prepared.usedDateFallback,
        });
      } catch (error) {
        summary.failedExtractions += 1;
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
