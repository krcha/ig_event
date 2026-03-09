import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { extractEventDataFromPoster } from "@/lib/ai/extract-event-data";
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
) {
  const extracted = await extractEventDataFromPoster({
    imageUrl: post.imageUrl as string,
    caption: post.caption,
    instagramPostUrl: post.instagramPostUrl,
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
      if (!post.imageUrl) {
        summary.skippedNoImage += 1;
        continue;
      }

      try {
        const alreadyStored = await isDuplicatePost(client, post.postId);
        if (alreadyStored) {
          summary.skippedDuplicates += 1;
          continue;
        }

        await persistExtractedEvent(client, post);
        summary.insertedEvents += 1;
      } catch (error) {
        summary.failedExtractions += 1;
        summary.errors.push(
          error instanceof Error ? error.message : "Unknown extraction error.",
        );
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    handles: handleSummaries,
  };
}
