import { DEFAULT_MAX_IMAGE_BYTES, isRasterImageContentType } from "./image-response-guardrails";
import type { AvailablePublicEventImageSource, PublicEventRaster } from "./public-event-raster";

type RasterLoader = (source: AvailablePublicEventImageSource) => Promise<PublicEventRaster>;
type CacheOptions = { maxEntries?: number; maxBytes?: number; maxInFlight?: number; now?: () => number };

/** Only call after resolving this request's current public media source. */
export function createPublicEventRasterCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 24;
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  const maxInFlight = options.maxInFlight ?? 32;
  const now = options.now ?? Date.now;
  if (![maxEntries, maxBytes, maxInFlight].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Invalid original image cache bounds.");
  }
  const entries = new Map<string, { raster: PublicEventRaster; until: number }>();
  const pending = new Map<string, Promise<PublicEventRaster>>();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.raster.bytes.byteLength; entries.delete(key); }
  }
  return function cachedRaster(source: AvailablePublicEventImageSource, load: RasterLoader): Promise<PublicEventRaster> {
    // Neither event IDs nor caller-controlled version strings identify bytes.
    // Include the validated URL so a changed authoritative source is never reused.
    const key = JSON.stringify([source.kind, source.kind === "stored" ? source.storageId : null, source.url]);
    for (const [expiredKey, entry] of entries) if (entry.until <= now()) remove(expiredKey);
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key); entries.set(key, hit);
      return Promise.resolve(hit.raster);
    }
    const flight = pending.get(key);
    if (flight) return flight;
    if (pending.size >= maxInFlight) return Promise.reject(new Error("Original image cache is busy."));
    const work = Promise.resolve().then(() => load(source)).then(raster => {
      if (!Buffer.isBuffer(raster.bytes) || !raster.bytes.length || raster.bytes.length > DEFAULT_MAX_IMAGE_BYTES ||
          !isRasterImageContentType(raster.contentType)) throw new Error("Invalid original image response.");
      if (raster.bytes.byteLength <= maxBytes) {
        while (entries.size >= maxEntries || bytes + raster.bytes.byteLength > maxBytes) remove(entries.keys().next().value!);
        entries.set(key, { raster, until: now() + (source.kind === "stored" ? 60_000 : 15_000) });
        bytes += raster.bytes.byteLength;
      }
      return raster;
    }).finally(() => { if (pending.get(key) === work) pending.delete(key); });
    pending.set(key, work);
    return work;
  };
}
