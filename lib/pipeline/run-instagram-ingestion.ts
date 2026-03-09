import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { extractEventDataFromPoster } from "@/lib/ai/extract-event-data";
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
  skippedDuplicates: number;
  skippedNoImage: number;
  failedDownloads: number;
  failedConversions: number;
  failedExtractions: number;
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

async function persistExtractedEvent(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  sourceImageUrl: string,
  imageDataUrl: string,
) {
  const extracted = await extractEventDataFromPoster({
    imageDataUrl,
    caption: post.caption,
    instagramPostUrl: post.instagramPostUrl,
    sourceImageUrl,
    instagramHandle: post.username,
  });

  await client.mutation(createEventMutation, {
    title: extracted.eventName,
    date: extracted.date,
    time: extracted.time ?? undefined,
    venue: extracted.venue,
    artists: extracted.artists,
    description: extracted.description,
    imageUrl: post.imageUrl ?? undefined,
    instagramPostUrl: post.instagramPostUrl,
    instagramPostId: post.postId,
    ticketPrice: extracted.ticketPrice ?? undefined,
    eventType: extracted.eventType,
    status: "pending",
  });
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
      skippedDuplicates: 0,
      skippedNoImage: 0,
      failedDownloads: 0,
      failedConversions: 0,
      failedExtractions: 0,
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
        await persistExtractedEvent(client, post, bestImageUrl, imageDataUrl);
        summary.insertedEvents += 1;
        logInfo("ingestion.openai.extraction.success", {
          handle,
          postId: post.postId,
          postUrl: post.instagramPostUrl,
          selectedImageUrl: bestImageUrl,
        });
      } catch (error) {
        summary.failedExtractions += 1;
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
