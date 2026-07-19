import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { renderEventCarouselSlide } from "@/lib/social/carousel-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_POSTER_BYTES = 15 * 1024 * 1024;
const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;

type RouteContext = {
  params: Promise<{
    eventId: string;
  }>;
};

type PublicEventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  venueInstagramHandle?: string;
  status: "approved";
};

async function fetchPoster(request: Request, event: PublicEventRecord): Promise<Buffer | null> {
  const handle = event.venueInstagramHandle?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  const url = new URL(`/api/discover/images/${encodeURIComponent(event._id)}`, request.url);
  if (handle) {
    url.searchParams.set("handle", handle);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "image/*" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/") || contentType.includes("svg")) {
      await response.body?.cancel();
      return null;
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_POSTER_BYTES) {
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    return body.byteLength > 0 && body.byteLength <= MAX_POSTER_BYTES ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function imageResponse(image: Buffer): Response {
  return new Response(new Uint8Array(image), {
    headers: {
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "content-type": "image/png",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request, context: RouteContext) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return new Response("Carousel rendering is not configured.", { status: 503 });
  }

  try {
    const { eventId } = await context.params;
    const convex = new ConvexHttpClient(convexUrl);
    const event = (await convex.query(getPublicApprovedEventQuery, {
      id: eventId,
    })) as PublicEventRecord | null;
    if (!event) {
      return new Response("Approved event not found.", { status: 404 });
    }

    const poster = await fetchPoster(request, event);
    const image = await renderEventCarouselSlide({
      poster,
      title: event.title,
      venue: event.venue,
      instagramHandle: event.venueInstagramHandle ?? "eventzeka",
      date: event.date,
      time: event.time,
    });
    return imageResponse(image);
  } catch {
    return new Response("Approved event not found.", { status: 404 });
  }
}
