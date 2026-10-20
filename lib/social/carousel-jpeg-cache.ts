import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CacheOptions = {
  directory?: string;
  maxEntries?: number;
  maxBytes?: number;
  maxAgeMs?: number;
};

const MAX_JPEG_BYTES = 8_000_000;
const CACHE_VERSION = "carousel-material-still-v1";
const flightsKey = Symbol.for("eventzeka.carousel-jpeg-cache.in-flight");
const shared = globalThis as typeof globalThis & { [flightsKey]?: Map<string, Promise<Buffer>> };
const inFlight = shared[flightsKey] ??= new Map<string, Promise<Buffer>>();
const isJpeg = (bytes: Buffer) => bytes.length >= 4 && bytes.length <= MAX_JPEG_BYTES &&
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

// Call this only after the route has rechecked every selected public event and
// its version. Cached bytes never replace live moderation/date/version checks.
export function createCarouselJpegCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 256;
  const maxBytes = options.maxBytes ?? 64_000_000;
  const maxAgeMs = options.maxAgeMs ?? 7 * 86_400_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxBytes < MAX_JPEG_BYTES || maxAgeMs < 1) {
    throw new Error("Invalid carousel JPEG cache bounds.");
  }

  async function trim(directory: string, current: string) {
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.jpg$/.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        const info = await stat(filename);
        if (!info.isFile()) continue;
        if (name !== current && Date.now() - info.mtimeMs > maxAgeMs) {
          await rm(filename, { force: true });
        } else entries.push({ name, filename, size: info.size, modified: info.mtimeMs });
      } catch { /* Another process may have evicted this file. */ }
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

  return async function cachedJpeg(contentKey: unknown, render: () => Promise<Buffer>): Promise<Buffer> {
    const directory = options.directory || process.env.EVENTZEKA_IMAGE_CACHE_DIR ||
      path.join(process.env.EVENTZEKA_REEL_CACHE_DIR || path.join(os.tmpdir(), "eventzeka-reels"), "jpeg");
    const key = createHash("sha256").update(JSON.stringify({ cache: CACHE_VERSION, content: contentKey })).digest("hex");
    const target = path.join(directory, `${key}.jpg`), flightKey = path.resolve(target);
    const existing = inFlight.get(flightKey);
    if (existing) return existing;
    const work = (async () => {
      try {
        const info = await stat(target);
        if (info.isFile() && info.size <= MAX_JPEG_BYTES && Date.now() - info.mtimeMs <= maxAgeMs) {
          const bytes = await readFile(target);
          if (isJpeg(bytes)) return bytes;
        }
      } catch { /* First render, expired entry, or unavailable optional cache. */ }
      const bytes = await render();
      if (!isJpeg(bytes)) throw new Error("Carousel renderer returned invalid JPEG bytes.");
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
        await trim(directory, `${key}.jpg`);
      } catch { /* Cache storage must not turn a valid poster into a failed post. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return bytes;
    })();
    inFlight.set(flightKey, work);
    try { return await work; }
    finally { if (inFlight.get(flightKey) === work) inFlight.delete(flightKey); }
  };
}

export const getCachedCarouselJpeg = createCarouselJpegCache();
