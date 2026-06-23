import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getDiscoverImageCandidate } from "@/lib/discover/discover-image-source";
import {
  normalizeInstagramPostUrl,
} from "@/lib/images/apify-images";

export const runtime = "nodejs";

type RouteContext = {
  params: {
    eventId: string;
  };
};

type EventRecord = {
  _id: string;
  imageUrl?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
  status: "pending" | "approved" | "rejected";
};

type ScrapedPostRecord = {
  imageUrl?: string | null;
  imageUrls?: string[];
};

const getEventQuery = "events:getEvent" as unknown as FunctionReference<"query">;
const getScrapedPostByHandleAndPostRefQuery =
  "scrapedPosts:getByHandleAndPostRef" as unknown as FunctionReference<"query">;

function getConvexClient(): ConvexHttpClient | null {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  return convexUrl ? new ConvexHttpClient(convexUrl) : null;
}

function normalizeHandle(value: string | null): string {
  return value?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

async function loadMatchingScrapedPost(
  convex: ConvexHttpClient,
  event: EventRecord,
  handle: string,
): Promise<ScrapedPostRecord | null> {
  const instagramPostUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  if (!handle || (!event.instagramPostId && !instagramPostUrl)) {
    return null;
  }

  return (await convex.query(getScrapedPostByHandleAndPostRefQuery, {
    handle,
    ...(instagramPostUrl ? { instagramPostUrl } : {}),
    ...(event.instagramPostId ? { postId: event.instagramPostId } : {}),
  })) as ScrapedPostRecord | null;
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

async function fetchImage(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    return await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(request: Request, context: RouteContext) {
  const convex = getConvexClient();
  if (!convex) {
    return errorResponse("Convex is not configured.", 503);
  }

  const handle = normalizeHandle(new URL(request.url).searchParams.get("handle"));

  try {
    const event = (await convex.query(getEventQuery, {
      id: context.params.eventId,
    })) as EventRecord | null;
    if (!event || event.status !== "approved") {
      return errorResponse("Image not found.", 404);
    }

    const post = await loadMatchingScrapedPost(convex, event, handle);
    const sourceUrl = getDiscoverImageCandidate(event, post);
    if (!sourceUrl) {
      return errorResponse("Image not found.", 404);
    }

    const imageResponse = await fetchImage(sourceUrl);
    const contentType = imageResponse.headers.get("content-type") ?? "";
    if (!imageResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
      return errorResponse("Image source failed.", 502);
    }
    if (!imageResponse.body) {
      return errorResponse("Image source was empty.", 502);
    }

    return new Response(imageResponse.body, {
      headers: {
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
        "content-type": contentType,
      },
    });
  } catch {
    return errorResponse("Image could not be loaded.", 502);
  }
}
