import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getDiscoverImageCandidate } from "@/lib/discover/discover-image-source";
import {
  isConvexStorageImageUrl,
  normalizeInstagramPostUrl,
} from "@/lib/images/apify-images";
import { fetchTrustedEventImage } from "@/lib/images/trusted-event-images";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    eventId: string;
  }>;
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

const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
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
      "x-content-type-options": "nosniff",
    },
  });
}

function placeholderImageResponse(cacheable = true): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" role="img" aria-label="Poster unavailable">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#11131b"/>
      <stop offset="1" stop-color="#05060a"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="1500" fill="url(#bg)"/>
  <circle cx="600" cy="650" r="110" fill="#8b86fb" fill-opacity="0.18"/>
  <path d="M485 690h230l-74-98-58 72-35-44-63 70Z" fill="#8b86fb" fill-opacity="0.72"/>
  <text x="600" y="855" fill="#d7d4ff" font-family="Inter, Arial, sans-serif" font-size="54" font-weight="700" text-anchor="middle">Poster unavailable</text>
  <text x="600" y="930" fill="#8b86fb" fill-opacity="0.9" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="600" text-anchor="middle">Belgrade nights</text>
</svg>`;

  return new Response(svg, {
    headers: {
      "cache-control": cacheable
        ? "public, max-age=600, stale-while-revalidate=3600"
        : "no-store",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-event-image-source": "placeholder",
    },
  });
}

export async function GET(request: Request, context: RouteContext) {
  const convex = getConvexClient();
  if (!convex) {
    return errorResponse("Convex is not configured.", 503);
  }

  const handle = normalizeHandle(new URL(request.url).searchParams.get("handle"));
  const { eventId } = await context.params;

  try {
    const event = (await convex.query(getPublicApprovedEventQuery, {
      id: eventId,
    })) as EventRecord | null;
    if (!event) {
      return errorResponse("Image not found.", 404);
    }

    const post = await loadMatchingScrapedPost(convex, event, handle);
    const sourceUrl = getDiscoverImageCandidate(event, post);
    if (!sourceUrl) {
      return placeholderImageResponse();
    }

    const image = await fetchTrustedEventImage(sourceUrl, {
      storedMediaOrigin: process.env.NEXT_PUBLIC_CONVEX_URL,
    });
    const persisted = isConvexStorageImageUrl(sourceUrl);

    return new Response(image.bytes, {
      headers: {
        "cache-control": persisted
          ? "public, max-age=86400, stale-while-revalidate=604800"
          : "public, max-age=3600, stale-while-revalidate=86400",
        "content-type": image.contentType,
        "content-length": String(image.bytes.byteLength),
        "x-content-type-options": "nosniff",
        "x-event-image-source": persisted ? "stored" : "upstream",
      },
    });
  } catch {
    return placeholderImageResponse(false);
  }
}
