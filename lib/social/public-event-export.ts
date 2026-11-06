import { isPlausibleConvexPublicId } from "../convex/public-id.ts";
import type { PublicEventImageSource } from "../images/public-event-raster.ts";
import {
  EVENT_EXPORT_DESIGN_VERSION,
  eventExportSourceChecksum,
  getEventExportFacts,
  type ExportablePublicEvent,
} from "./event-export-image.ts";

type RasterSource = Extract<PublicEventImageSource, { kind: "stored" | "upstream" }>;
type ExportDependencies = {
  loadEvent: (id: string) => Promise<ExportablePublicEvent | null>;
  loadImageSource: (id: string) => Promise<PublicEventImageSource>;
  fetchRaster: (source: RasterSource) => Promise<{ bytes: Buffer }>;
  cachedJpeg: (key: unknown, render: () => Promise<Buffer>) => Promise<Buffer>;
  render: (event: ExportablePublicEvent, poster?: Buffer) => Promise<Buffer>;
  runWork: <T>(work: () => Promise<T>) => Promise<T>;
};

export class EventExportBusyError extends Error {}

// Bound source buffers as well as native renders. Identical renders are
// coalesced by the JPEG cache; excess work is rejected without a waiting queue.
export function createEventExportGate(limit = 2) {
  let active = 0;
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) throw new EventExportBusyError("Image export is busy.");
    active += 1;
    try { return await work(); }
    finally { active -= 1; }
  };
}

export function eventExportError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...(status === 429 ? { "retry-after": "3" } : {}),
    },
  });
}

export function createPublicEventExportHandler(dependencies: ExportDependencies) {
  return async (request: Request, eventId: string): Promise<Response> => {
    if (!isPlausibleConvexPublicId(eventId)) return eventExportError("Invalid event ID.", 400);
    try {
      const event = await dependencies.loadEvent(eventId);
      if (!event || event._id !== eventId || event.status !== "approved") {
        return eventExportError("This event is no longer public.", 404);
      }
      const facts = getEventExportFacts(event);
      const source = await dependencies.loadImageSource(eventId);
      // Publication can change between reads; neither a cached image nor a
      // source URL may bypass the second current public-event check.
      if (!source.eventExists) return eventExportError("This event is no longer public.", 404);
      return await dependencies.runWork(async () => {
        let poster: Buffer | undefined;
        if (source.kind === "stored" || source.kind === "upstream") {
          try { poster = (await dependencies.fetchRaster(source)).bytes; }
          catch { /* Keep factual sharing available when the external poster expires. */ }
        }
        const image = await dependencies.cachedJpeg({
          kind: "public-event-export",
          design: EVENT_EXPORT_DESIGN_VERSION,
          format: "jpeg-1080x1920",
          eventId,
          revision: event.updatedAt ?? null,
          facts,
          source: source.kind === "none" ? "none" : source,
          sourceChecksum: eventExportSourceChecksum(poster),
        }, () => dependencies.render(event, poster));
        const attachment = new URL(request.url).searchParams.get("download") === "1";
        return new Response(request.method === "HEAD" ? null : new Uint8Array(image), {
          headers: {
            // Always recheck publication on a new GET. Disk cache saves render CPU.
            "cache-control": "no-store",
            "content-type": "image/jpeg",
            "content-length": String(image.length),
            "content-disposition": `${attachment ? "attachment" : "inline"}; filename="eventzeka-${event.date}-${eventId}.jpg"`,
            "x-content-type-options": "nosniff",
          },
        });
      });
    } catch (error) {
      return eventExportError(
        error instanceof EventExportBusyError ? "Image export is busy. Try again in a moment." : "Could not prepare this event image. Try again shortly.",
        error instanceof EventExportBusyError ? 429 : 503,
      );
    }
  };
}
