import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { createPublicEventImageHandler } from "@/lib/images/public-event-image-delivery";
import type { PublicEventImageSource } from "@/lib/images/public-event-raster";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    eventId: string;
  }>;
};

const getPublicEventImageSourceQuery =
  "mediaAssets:getPublicEventImageSource" as unknown as FunctionReference<"query">;

function getConvexClient(): ConvexHttpClient | null {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  return convexUrl ? new ConvexHttpClient(convexUrl) : null;
}

function placeholderImageResponse(options: {
  authoritativeNoImage?: boolean;
} = {}): Response {
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
  <text x="600" y="930" fill="#8b86fb" fill-opacity="0.9" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="600" text-anchor="middle">Event Zeka</text>
</svg>`;

  return new Response(svg, {
    headers: {
      "cache-control": options.authoritativeNoImage
        ? "public, max-age=60, stale-while-revalidate=60"
        : "no-store",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-event-image-source": "placeholder",
    },
  });
}

const publicEventImage = createPublicEventImageHandler({
  async loadSource(eventId) {
    const convex = getConvexClient();
    if (!convex) throw new Error("Public media backend is unavailable.");
    return await convex.query(getPublicEventImageSourceQuery, { eventId }) as PublicEventImageSource;
  },
  placeholderResponse: placeholderImageResponse,
});

export async function GET(request: Request, context: RouteContext) {
  const { eventId } = await context.params;
  return publicEventImage(request, eventId);
}
