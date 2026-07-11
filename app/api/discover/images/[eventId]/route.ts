import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getDiscoverImageCandidate } from "@/lib/discover/discover-image-source";
import {
  normalizeInstagramPostUrl,
} from "@/lib/images/apify-images";
import {
  assertImageResponseHeaders,
  readImageResponseBodyWithLimit,
} from "@/lib/images/image-response-guardrails";

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

function placeholderImageResponse(): Response {
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
      "cache-control": "public, max-age=600, stale-while-revalidate=3600",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
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
    const event = (await convex.query(getPublicApprovedEventQuery, {
      id: context.params.eventId,
    })) as EventRecord | null;
    if (!event) {
      return errorResponse("Image not found.", 404);
    }

    const post = await loadMatchingScrapedPost(convex, event, handle);
    const sourceUrl = getDiscoverImageCandidate(event, post);
    if (!sourceUrl) {
      return errorResponse("Image not found.", 404);
    }

    const imageResponse = await fetchImage(sourceUrl);
    if (!imageResponse.ok) {
      return placeholderImageResponse();
    }
    const contentType = assertImageResponseHeaders(imageResponse);
    const imageBuffer = await readImageResponseBodyWithLimit(imageResponse);

    return new Response(new Uint8Array(imageBuffer), {
      headers: {
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
        "content-type": contentType,
        "content-length": String(imageBuffer.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return placeholderImageResponse();
  }
}
