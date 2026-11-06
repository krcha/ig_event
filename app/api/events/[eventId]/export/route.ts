import os from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { fetchPublicEventRaster, type PublicEventImageSource } from "@/lib/images/public-event-raster";
import { projectPublicEventVenueDisplay } from "@/lib/events/public-event-venue-fields";
import { createCarouselJpegCache } from "@/lib/social/carousel-jpeg-cache";
import { renderEventExportImage, type ExportablePublicEvent } from "@/lib/social/event-export-image";
import {
  createEventExportGate,
  createPublicEventExportHandler,
  eventExportError,
} from "@/lib/social/public-event-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const eventQuery = "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
const imageQuery = "mediaAssets:getPublicEventImageSource" as unknown as FunctionReference<"query">;
const venueQuery = "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;
type PublicVenue = { _id: string; name: string };

const cachedJpeg = createCarouselJpegCache({
  directory: path.join(process.env.EVENTZEKA_IMAGE_CACHE_DIR || process.env.EVENTZEKA_REEL_CACHE_DIR ||
    path.join(os.tmpdir(), "eventzeka-reels"), "event-export"),
  maxEntries: 96,
  maxBytes: 32_000_000,
  maxAgeMs: 86_400_000,
});
const runWork = createEventExportGate(2);

async function boundedRead<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Public event read timed out.")), 8_000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function GET(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const convexUrl = process.env.CONVEX_PUBLIC_READ_URL?.trim() || process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return eventExportError("Event image export is not configured.", 503);
  const { eventId } = await context.params;
  const convex = new ConvexHttpClient(convexUrl);
  return createPublicEventExportHandler({
    async loadEvent(id) {
      const event = await boundedRead(convex.query(eventQuery, { id })) as ExportablePublicEvent | null;
      if (!event || event.status !== "approved" || !event.venueId) return event;
      const venues = await boundedRead(convex.query(venueQuery, { ids: [event.venueId] })) as PublicVenue[];
      return projectPublicEventVenueDisplay(event, venues.find(venue => venue._id === event.venueId));
    },
    loadImageSource: id => boundedRead(convex.query(imageQuery, { eventId: id })) as Promise<PublicEventImageSource>,
    fetchRaster: fetchPublicEventRaster,
    cachedJpeg,
    render: renderEventExportImage,
    runWork,
  })(request, eventId);
}
