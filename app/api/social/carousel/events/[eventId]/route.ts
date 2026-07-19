import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { renderEventCarouselSlide } from "@/lib/social/carousel-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function imageResponse(image: Buffer): Response {
  return new Response(new Uint8Array(image), {
    headers: {
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "content-type": "image/jpeg",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(_request: Request, context: RouteContext) {
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

    const image = await renderEventCarouselSlide({
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
