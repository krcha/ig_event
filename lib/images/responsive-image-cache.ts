import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_IMAGE_BYTES } from "@/lib/images/image-response-guardrails";
import type { ResponsiveImageFormat } from "@/lib/images/responsive-image-url";
import { RESPONSIVE_IMAGE_RENDER_VERSION } from "@/lib/images/responsive-image-render";

type CacheOptions = { directory?: string; maxEntries?: number; maxBytes?: number; now?: () => number };
const flightsKey = Symbol.for("eventzeka.responsive-image-cache.in-flight");
const shared = globalThis as typeof globalThis & { [flightsKey]?: Map<string, Promise<Buffer>> };
const inFlight = shared[flightsKey] ??= new Map<string, Promise<Buffer>>();
const MAX_CACHE_AGE_MS = 3_600_000;
const validRaster = (bytes: Buffer, format: ResponsiveImageFormat) => bytes.length > 12 && bytes.length <= DEFAULT_MAX_IMAGE_BYTES && (
  format === "jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
);

// Live public/source validation belongs before this cache. v/query strings do
// not form cache keys: only the authoritative source identity and fixed variant.
export function createResponsiveImageCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 256;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < DEFAULT_MAX_IMAGE_BYTES) throw new Error("Invalid responsive image cache bounds.");

  async function trim(directory: string, current: string) {
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.(jpg|webp)$/.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        const info = await stat(filename);
        if (!info.isFile()) continue;
        if (name !== current && now() - info.mtimeMs > MAX_CACHE_AGE_MS) await rm(filename, { force: true });
        else entries.push({ name, filename, size: info.size, modified: info.mtimeMs });
      } catch { /* Another process may have evicted the file. */ }
    }
    entries.sort((a, b) => a.modified - b.modified);
    let bytes = entries.reduce((total, entry) => total + entry.size, 0), count = entries.length;
    for (const entry of entries) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      if (entry.name === current) continue;
      await rm(entry.filename, { force: true });
      count -= 1;
      bytes -= entry.size;
    }
  }

  return async function cachedResponsiveImage(
    contentKey: unknown,
    format: ResponsiveImageFormat,
    maxAgeMs: number,
    render: () => Promise<Buffer>,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_CACHE_AGE_MS) throw new Error("Invalid image cache lifetime.");
    const directory = options.directory || path.join(
      process.env.EVENTZEKA_IMAGE_CACHE_DIR || process.env.EVENTZEKA_REEL_CACHE_DIR || path.join(os.tmpdir(), "eventzeka-images"),
      "responsive-v1",
    );
    const key = createHash("sha256").update(JSON.stringify({ version: RESPONSIVE_IMAGE_RENDER_VERSION, content: contentKey, format })).digest("hex");
    const name = `${key}.${format === "jpeg" ? "jpg" : "webp"}`;
    const target = path.join(directory, name), flightKey = path.resolve(target);
    const existing = inFlight.get(flightKey);
    if (existing) return existing;
    if (inFlight.size >= 32) throw new Error("Image cache is busy.");
    const work = (async () => {
      try {
        const info = await stat(target);
        if (info.isFile() && info.size <= DEFAULT_MAX_IMAGE_BYTES && now() - info.mtimeMs <= maxAgeMs) {
          const bytes = await readFile(target);
          if (validRaster(bytes, format)) return bytes;
        }
      } catch { /* Optional cache miss; valid delivery must not depend on disk. */ }
      const bytes = await render();
      if (!validRaster(bytes, format)) throw new Error("Invalid responsive image output.");
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
        await trim(directory, name);
      } catch { /* An unwritable cache should still return the rendered image. */ }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return bytes;
    })();
    inFlight.set(flightKey, work);
    try { return await work; }
    finally { if (inFlight.get(flightKey) === work) inFlight.delete(flightKey); }
  };
}

export const getCachedResponsiveImage = createResponsiveImageCache();
