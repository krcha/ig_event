import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  assertImageResponseHeaders,
  readImageResponseBodyWithLimit,
} from "@/lib/images/image-response-guardrails";
import { fetchAllowedRemoteRasterImage } from "@/lib/images/remote-image-fetch";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    eventId: string;
  }>;
};

type PublicImageSource =
  | { eventExists: false; kind: "none" }
  | { eventExists: true; kind: "none" }
  | { eventExists: true; kind: "stored"; storageId: string; url: string }
  | { eventExists: true; kind: "upstream"; url: string };

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

async function fetchStoredRasterImage(url: string): Promise<{
  bytes: Buffer;
  contentType: string;
}> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Stored image fetch timed out."));
    }, 12_000);
  });
  try {
    const response = await Promise.race([
      fetch(url, {
        cache: "no-store",
        headers: { accept: "image/*,*/*;q=0.8" },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      throw new Error(`Stored image fetch failed with status ${response.status}.`);
    }
    const contentType = assertImageResponseHeaders(response);
    const bytes = await Promise.race([
      readImageResponseBodyWithLimit(response),
      timeoutPromise,
    ]);
    return { bytes, contentType };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function rasterImageResponse(
  bytes: Buffer,
  contentType: string,
  source: "stored" | "upstream",
): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "cache-control":
        source === "stored"
          ? "public, max-age=3600, stale-while-revalidate=86400"
          : "public, max-age=300, stale-while-revalidate=3600",
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "x-content-type-options": "nosniff",
      "x-event-image-source": source,
    },
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const convex = getConvexClient();
  if (!convex) {
    return placeholderImageResponse();
  }

  const { eventId } = await context.params;
  let source: PublicImageSource;
  try {
    source = (await convex.query(getPublicEventImageSourceQuery, {
      eventId,
    })) as PublicImageSource;
  } catch {
    return placeholderImageResponse();
  }

  if (source.kind === "none") {
    return placeholderImageResponse({ authoritativeNoImage: source.eventExists });
  }

  try {
    if (source.kind === "stored") {
      const image = await fetchStoredRasterImage(source.url);
      return rasterImageResponse(image.bytes, image.contentType, "stored");
    }
    const image = await fetchAllowedRemoteRasterImage(source.url, { timeoutMs: 12_000 });
    return rasterImageResponse(image.bytes, image.contentType, "upstream");
  } catch {
    return placeholderImageResponse();
  }
}
