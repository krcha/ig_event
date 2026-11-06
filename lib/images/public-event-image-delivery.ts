import { fetchPublicEventRaster, type PublicEventImageSource } from "@/lib/images/public-event-raster";
import { getCachedResponsiveImage } from "@/lib/images/responsive-image-cache";
import { OriginalRasterRequired, renderResponsiveImage } from "@/lib/images/responsive-image-render";
import { parseResponsiveImageRequest } from "@/lib/images/responsive-image-url";

type ImageDeliveryDependencies = {
  loadSource: (eventId: string) => Promise<PublicEventImageSource>;
  placeholderResponse: (options?: { authoritativeNoImage?: boolean }) => Response;
  fetchRaster?: typeof fetchPublicEventRaster;
  cacheVariant?: typeof getCachedResponsiveImage;
  renderVariant?: typeof renderResponsiveImage;
};

function rasterImageResponse(bytes: Buffer, contentType: string, source: "stored" | "upstream"): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "cache-control": source === "stored"
        ? "public, max-age=3600, stale-while-revalidate=86400"
        : "public, max-age=300, stale-while-revalidate=3600",
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "vary": "Accept",
      "x-content-type-options": "nosniff",
      "x-event-image-source": source,
    },
  });
}

export function createPublicEventImageHandler(dependencies: ImageDeliveryDependencies) {
  return async function publicEventImage(request: Request, eventId: string): Promise<Response> {
    let variant: ReturnType<typeof parseResponsiveImageRequest>;
    try { variant = parseResponsiveImageRequest(request); }
    catch {
      return new Response("Unsupported image variant.", { status: 400, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    }
    let source: PublicEventImageSource;
    try { source = await dependencies.loadSource(eventId); }
    catch { return dependencies.placeholderResponse(); }
    // This runs before ALL cache reads. Revoked, hidden, or deleted events may
    // never expose a previously rendered derivative through this origin route.
    if (source.kind === "none") return dependencies.placeholderResponse({ authoritativeNoImage: source.eventExists });
    const fetchRaster = dependencies.fetchRaster ?? fetchPublicEventRaster;
    try {
      if (variant.width === undefined) {
        const image = await fetchRaster(source);
        return rasterImageResponse(image.bytes, image.contentType, source.kind);
      }
      const { width, format } = variant;
      const cache = dependencies.cacheVariant ?? getCachedResponsiveImage;
      const bytes = await cache(
        { source, width },
        format,
        source.kind === "stored" ? 3_600_000 : 300_000,
        async () => (dependencies.renderVariant ?? renderResponsiveImage)(await fetchRaster(source), width, format),
      );
      return rasterImageResponse(bytes, `image/${format}`, source.kind);
    } catch (error) {
      if (error instanceof OriginalRasterRequired) return rasterImageResponse(error.raster.bytes, error.raster.contentType, source.kind);
      return dependencies.placeholderResponse();
    }
  };
}
