import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { createPublicEventImageHandler } from "../lib/images/public-event-image-delivery.ts";
import { fetchPublicEventRaster } from "../lib/images/public-event-raster.ts";
import { createPublicEventRasterCache } from "../lib/images/public-event-raster-cache.ts";
import { createResponsiveImageCache } from "../lib/images/responsive-image-cache.ts";
import { MAX_RESPONSIVE_IMAGE_PIXELS, OriginalRasterRequired, renderResponsiveImage } from "../lib/images/responsive-image-render.ts";
import { getResponsiveEventImageSrcSet, getResponsiveEventImageUrl, parseResponsiveImageRequest, RESPONSIVE_IMAGE_WIDTHS } from "../lib/images/responsive-image-url.ts";
import { getDiscoverImageVersion } from "../lib/discover/discover-image-source.ts";

const directory = await mkdtemp(path.join(os.tmpdir(), "eventzeka-responsive-qa-"));
const request = (query = "", accept = "image/webp,image/*;q=0.8") => new Request(`https://eventzeka.test/api/discover/images/event-1${query}`, { headers: { accept } });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const placeholderResponse = (options = {}) => new Response("placeholder", { headers: { "cache-control": options.authoritativeNoImage ? "public, max-age=60" : "no-store", "x-event-image-source": "placeholder" } });

try {
  assert.deepEqual(parseResponsiveImageRequest(request()), { width: undefined, format: "webp" });
  assert.deepEqual(parseResponsiveImageRequest(request("?w=384", "image/webp;q=0,image/jpeg")), { width: 384, format: "jpeg" });
  assert.deepEqual(parseResponsiveImageRequest(request("?w=768&format=jpeg")), { width: 768, format: "jpeg" });
  for (const query of ["?w=0", "?w=1", "?w=99999", "?w=0384", "?w=384.0", "?w=384&w=768", "?w=384&format=avif", "?w=384&quality=1", "?url=https://evil.test/a.jpg", "?format=webp", `?v=${"x".repeat(129)}`]) {
    assert.throws(() => parseResponsiveImageRequest(request(query)), undefined, `Reject unbounded/ambiguous variant: ${query.slice(0, 50)}`);
  }
  assert.equal(getResponsiveEventImageUrl("https://evil.test/image.jpg", 384), null);
  assert.equal(getResponsiveEventImageSrcSet("/api/discover/images/event-1", "storage-v2")?.split(", ").length, RESPONSIVE_IMAGE_WIDTHS.length);
  assert.match(getResponsiveEventImageUrl("/api/discover/images/event-1", 384, "storage-v2"), /w=384&v=storage-v2$/);
  assert.equal(getDiscoverImageVersion({ imageStorageId: "storage-v2", updatedAt: 100 }), "storage-v2");
  assert.equal(getDiscoverImageVersion({ updatedAt: 100 }), 100);

  // A deterministic high-resolution photo-like source catches real resizing,
  // byte savings and format errors rather than just inspecting function calls.
  const pixels = Buffer.alloc(2400 * 3000 * 3);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const original = await sharp(pixels, { raw: { width: 2400, height: 3000, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const originalHash = hash(original);
  const raster = { bytes: original, contentType: "image/jpeg" };
  const results = [];
  for (const width of RESPONSIVE_IMAGE_WIDTHS) {
    for (const format of ["webp", "jpeg"]) {
      const bytes = await renderResponsiveImage(raster, width, format);
      const info = await sharp(bytes).metadata();
      assert.equal(info.width, width);
      assert.equal(info.height, Math.round(width * 1.25));
      assert.equal(info.format, format);
      assert.ok(bytes.length < original.length, "Every mobile/display derivative must reduce the high-resolution fixture.");
      results.push({ width, format, bytes: bytes.length });
    }
  }
  assert.equal(hash(original), originalHash, "Transformations never mutate original/source bytes.");
  const tiny = await sharp({ create: { width: 120, height: 240, channels: 3, background: "red" } }).png().toBuffer();
  const tinyResult = await renderResponsiveImage({ bytes: tiny, contentType: "image/png" }, 1600, "webp");
  assert.equal((await sharp(tinyResult).metadata()).width, 120, "Small originals must never be upscaled.");
  const rotated = await sharp({ create: { width: 600, height: 800, channels: 3, background: "blue" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const rotatedInfo = await sharp(await renderResponsiveImage({ bytes: rotated, contentType: "image/jpeg" }, 384, "jpeg")).metadata();
  assert.deepEqual([rotatedInfo.width, rotatedInfo.height], [384, 288], "EXIF rotation is applied before fitting the poster.");
  const transparent = await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.equal((await sharp(await renderResponsiveImage({ bytes: transparent, contentType: "image/png" }, 192, "webp")).metadata()).hasAlpha, true);

  await assert.rejects(renderResponsiveImage({ bytes: Buffer.from("<svg><script>bad()</script></svg>"), contentType: "image/png" }, 384, "webp"), /signature/);
  await assert.rejects(renderResponsiveImage({ bytes: tiny, contentType: "image/jpeg" }, 384, "webp"), /MIME/);
  await assert.rejects(renderResponsiveImage({ bytes: Buffer.alloc(8 * 1024 * 1024 + 1), contentType: "image/png" }, 384, "webp"), /byte length/);
  const oversizedPixels = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "red" } }).png().toBuffer();
  assert.ok(5000 * 5000 > MAX_RESPONSIVE_IMAGE_PIXELS);
  await assert.rejects(renderResponsiveImage({ bytes: oversizedPixels, contentType: "image/png" }, 384, "webp"), /pixel limit|dimensions/i);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await assert.rejects(renderResponsiveImage({ bytes: gif, contentType: "image/gif" }, 384, "webp"), (error) => error instanceof OriginalRasterRequired && error.raster.bytes === gif);
  const animatedPixels = Buffer.concat([Buffer.alloc(4 * 4 * 3, 40), Buffer.alloc(4 * 4 * 3, 200)]);
  const animatedWebp = await sharp(animatedPixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animatedWebp, { animated: true }).metadata()).pages, 2);
  await assert.rejects(renderResponsiveImage({ bytes: animatedWebp, contentType: "image/webp" }, 384, "jpeg"), (error) => error instanceof OriginalRasterRequired, "Animated posters retain frames and original bytes.");

  let source = { eventExists: true, kind: "stored", storageId: "source-v1", url: "https://storage.test/v1" };
  let sourceReads = 0, fetches = 0, renders = 0;
  const cacheDirectory = path.join(directory, "delivery");
  const cacheVariant = createResponsiveImageCache({ directory: cacheDirectory });
  const handler = createPublicEventImageHandler({
    loadSource: async () => { sourceReads += 1; return source; },
    placeholderResponse,
    fetchRaster: async () => { fetches += 1; return raster; },
    renderVariant: async (...args) => { renders += 1; return renderResponsiveImage(...args); },
    cacheVariant,
  });
  const responses = await Promise.all(Array.from({ length: 6 }, () => handler(request("?w=384"), "event-1")));
  assert.equal(sourceReads, 6, "Coalesced image requests must each recheck current publication/source eligibility.");
  assert.equal(fetches, 1);
  assert.equal(renders, 1);
  assert.equal(responses[0].headers.get("vary"), "Accept");
  assert.equal(responses[0].headers.get("content-type"), "image/webp");
  assert.equal(responses[0].headers.get("x-content-type-options"), "nosniff");
  assert.ok(Number(responses[0].headers.get("content-length")) < original.length);
  await handler(request("?w=384&v=a-different-client-version"), "event-1");
  assert.equal(fetches, 1, "Client version strings must not create arbitrary server cache entries.");
  source = { eventExists: false, kind: "none" };
  const hidden = await handler(request("?w=384"), "event-1");
  assert.equal(hidden.headers.get("x-event-image-source"), "placeholder");
  assert.equal(hidden.headers.get("cache-control"), "no-store");
  assert.equal(fetches, 1, "A warm derivative must not disclose a revoked/hidden event.");
  source = { eventExists: true, kind: "stored", storageId: "source-v2", url: "https://storage.test/v2" };
  await handler(request("?w=384"), "event-1");
  assert.equal(fetches, 2, "A changed authoritative source identity invalidates a cached variant.");
  const legacy = await handler(request(), "event-1");
  assert.equal(legacy.headers.get("content-type"), "image/jpeg");
  assert.equal(hash(Buffer.from(await legacy.arrayBuffer())), originalHash, "The default proxy URL still serves exact originals.");
  const fallback = await handler(request("?w=384", "image/jpeg"), "event-1");
  assert.equal(fallback.headers.get("content-type"), "image/jpeg");
  assert.equal((await sharp(Buffer.from(await fallback.arrayBuffer())).metadata()).width, 384);
  const beforeInvalid = sourceReads;
  assert.equal((await handler(request("?w=1"), "event-1")).status, 400);
  assert.equal(sourceReads, beforeInvalid, "Invalid variant requests are rejected before backend/source work.");

  let sharedSourceReads = 0, originalDownloads = 0;
  let sharedSource = { eventExists: true, kind: "stored", storageId: "shared-original", url: "https://storage.test/shared-original" };
  const sharedHandler = createPublicEventImageHandler({
    loadSource: async () => { sharedSourceReads++; return sharedSource; }, placeholderResponse,
    fetchRaster: async () => { originalDownloads++; await new Promise(resolve => setTimeout(resolve, 10)); return raster; },
    cacheVariant: createResponsiveImageCache({ directory: path.join(directory, "cross-width") }),
  });
  const differentSlots = await Promise.all(["?w=192", "?w=768", "?w=1080&format=jpeg", ""].map(query => sharedHandler(request(query), "event-shared")));
  assert.equal(sharedSourceReads, 4, "Blur, poster and modal each retain a fresh public/source check.");
  assert.equal(originalDownloads, 1, "Different widths, formats and the full poster share one original download.");
  assert.equal(hash(Buffer.from(await differentSlots[3].arrayBuffer())), originalHash);
  await sharedHandler(request("?w=384"), "event-shared");
  assert.equal(originalDownloads, 1, "Opening a new display size shortly after the blur reuses its source bytes.");
  sharedSource = { eventExists: true, kind: "none" };
  assert.equal((await sharedHandler(request(), "event-shared")).headers.get("x-event-image-source"), "placeholder",
    "A warm original cache cannot reveal a newly hidden event, including the full-size URL.");
  sharedSource = { eventExists: true, kind: "stored", storageId: "shared-original-v2", url: "https://storage.test/shared-original-v2" };
  await sharedHandler(request(), "event-shared");
  assert.equal(originalDownloads, 2, "Replacing the authoritative stored source requires new original bytes.");

  let clock = 0, memoryDownloads = 0;
  const smallRaster = { bytes: tiny, contentType: "image/png" };
  const sourceFor = name => ({ eventExists: true, kind: "stored", storageId: name, url: `https://storage.test/${name}` });
  const loadSmall = async () => { memoryDownloads++; return smallRaster; };
  const memory = createPublicEventRasterCache({ now: () => clock, maxEntries: 2, maxBytes: tiny.length * 2 });
  await memory(sourceFor("a"), loadSmall); await memory(sourceFor("b"), loadSmall);
  await memory(sourceFor("a"), loadSmall); await memory(sourceFor("c"), loadSmall);
  assert.equal(memoryDownloads, 3);
  await memory(sourceFor("b"), loadSmall);
  assert.equal(memoryDownloads, 4, "Least recently used originals are evicted at the entry and byte bounds.");
  clock = 30_000; await memory(sourceFor("b"), loadSmall);
  clock = 60_001;
  await memory(sourceFor("b"), loadSmall);
  assert.equal(memoryDownloads, 5, "Stored original bytes expire without extending age on a hit.");
  const upstreamMemory = createPublicEventRasterCache({ now: () => clock });
  const upstreamSource = { eventExists: true, kind: "upstream", url: "https://cdn.test/original.jpg" };
  await upstreamMemory(upstreamSource, loadSmall); clock += 15_001; await upstreamMemory(upstreamSource, loadSmall);
  assert.equal(memoryDownloads, 7, "Mutable upstream originals have a shorter retention window.");
  let byteDownloads = 0;
  const byteBounded = createPublicEventRasterCache({ maxEntries: 4, maxBytes: tiny.length * 2 });
  const byteLoader = async () => { byteDownloads++; return smallRaster; };
  for (const name of ["byte-a", "byte-b", "byte-c", "byte-a"]) await byteBounded(sourceFor(name), byteLoader);
  assert.equal(byteDownloads, 4, "The byte limit evicts originals even below the entry limit.");
  let oversizedDownloads = 0;
  const noRoom = createPublicEventRasterCache({ maxBytes: tiny.length - 1 });
  for (let repeat = 0; repeat < 2; repeat++) await noRoom(sourceFor("no-room"), async () => { oversizedDownloads++; return smallRaster; });
  assert.equal(oversizedDownloads, 2, "An original larger than the retention budget is delivered without retaining it.");
  let identityDownloads = 0;
  const identity = createPublicEventRasterCache();
  const identityLoader = async () => { identityDownloads++; return smallRaster; };
  await identity(sourceFor("identity-a"), identityLoader);
  await identity({ ...sourceFor("identity-a"), storageId: "replacement" }, identityLoader);
  assert.equal(identityDownloads, 2, "Even an unchanged URL cannot mask a changed authoritative storage identity.");
  let attempts = 0;
  const retryable = createPublicEventRasterCache();
  const retryLoader = async () => { if (++attempts === 1) throw new Error("temporary source failure"); return smallRaster; };
  await assert.rejects(retryable(sourceFor("retry"), retryLoader), /temporary source failure/);
  await retryable(sourceFor("retry"), retryLoader);
  assert.equal(attempts, 2, "A failed download does not poison later image retries.");
  const limited = createPublicEventRasterCache({ maxInFlight: 1 });
  let releaseDownload;
  const held = limited(sourceFor("held"), () => new Promise(resolve => { releaseDownload = resolve; }));
  await Promise.resolve();
  await assert.rejects(limited(sourceFor("other"), loadSmall), /busy/);
  releaseDownload(smallRaster); await held;
  await limited(sourceFor("other"), loadSmall);
  for (const options of [{ maxEntries: 0 }, { maxBytes: NaN }, { maxInFlight: 1.1 }]) assert.throws(() => createPublicEventRasterCache(options), /bounds/);

  const animatedHandler = createPublicEventImageHandler({ loadSource: async () => source, placeholderResponse, fetchRaster: async () => ({ bytes: animatedWebp, contentType: "image/webp" }), cacheVariant: createResponsiveImageCache({ directory: path.join(directory, "animated") }) });
  const passthrough = await animatedHandler(request("?w=384"), "event-1");
  assert.equal(hash(Buffer.from(await passthrough.arrayBuffer())), hash(animatedWebp));
  const failedHandler = createPublicEventImageHandler({ loadSource: async () => { throw Error("backend down"); }, placeholderResponse });
  assert.equal((await failedHandler(request("?w=384"), "event-1")).headers.get("cache-control"), "no-store");

  const sample = await renderResponsiveImage(raster, 192, "jpeg");
  const boundedDirectory = path.join(directory, "bounded");
  const boundedCache = createResponsiveImageCache({ directory: boundedDirectory, maxEntries: 2 });
  for (const key of ["one", "two", "three"]) await boundedCache(key, "jpeg", 3_600_000, async () => sample);
  assert.equal((await readdir(boundedDirectory)).length, 2, "Disk cache must evict entries beyond its fixed bound.");
  const repairDirectory = path.join(directory, "repair");
  const repairCache = createResponsiveImageCache({ directory: repairDirectory });
  await repairCache("repair", "webp", 3_600_000, () => renderResponsiveImage(raster, 384, "webp"));
  const corruptedFile = path.join(repairDirectory, (await readdir(repairDirectory))[0]);
  await writeFile(corruptedFile, "invalid cached image");
  await repairCache("repair", "webp", 3_600_000, () => renderResponsiveImage(raster, 384, "webp"));
  assert.equal((await sharp(await readFile(corruptedFile)).metadata()).format, "webp", "Corrupt disk entries are regenerated rather than served.");
  let cacheTime = Date.now();
  const expiring = createResponsiveImageCache({ directory: path.join(directory, "expired"), now: () => cacheTime });
  let expiryRenders = 0;
  const expiryRender = async () => { expiryRenders += 1; return sample; };
  await expiring("one", "jpeg", 1000, expiryRender);
  cacheTime += 2000;
  await expiring("one", "jpeg", 1000, expiryRender);
  assert.equal(expiryRenders, 2);

  let fetchCalls = 0;
  const storedSource = { eventExists: true, kind: "stored", storageId: "qa", url: "https://storage.test/image" };
  await assert.rejects(fetchPublicEventRaster(storedSource, { fetchImpl: async () => new Response("<html>bad</html>", { headers: { "content-type": "text/html" } }) }), /content type|content-type/i);
  await assert.rejects(fetchPublicEventRaster(storedSource, { fetchImpl: async () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(8 * 1024 * 1024 + 1) } }) }), /limit|exceed/i);
  await assert.rejects(fetchPublicEventRaster(storedSource, { fetchImpl: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/jpeg" } }) }), /limit|exceed/i);
  await assert.rejects(fetchPublicEventRaster({ eventExists: true, kind: "upstream", url: "http://127.0.0.1/private" }, { fetchImpl: async () => { fetchCalls += 1; throw Error("must never fetch"); } }));
  assert.equal(fetchCalls, 0, "Responsive delivery must preserve the upstream URL allowlist/SSRF boundary.");

  const componentSource = await readFile("components/events/responsive-event-image.tsx", "utf8");
  const componentModule = { exports: {} };
  runInNewContext(ts.transpileModule(componentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: componentModule.exports,
    require: (name) => {
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
      if (name === "@/lib/images/responsive-image-url") return { getResponsiveEventImageSrcSet, getResponsiveEventImageUrl };
      throw Error(`Unexpected image component dependency: ${name}`);
    },
  });
  const image = componentModule.exports.ResponsiveEventImage({ src: "/api/discover/images/event-1", alt: "Poster", fill: true, sizes: "(max-width: 502px) 100vw, 470px", priority: true, className: "object-contain", version: "source-v2" });
  assert.equal(image.type, "img");
  assert.equal(image.props.className, "object-contain", "Poster contain semantics survive the component replacement.");
  assert.equal(image.props.style.position, "absolute");
  assert.equal(image.props.loading, "eager");
  assert.equal(image.props.fetchPriority, "high");
  assert.equal(image.props.sizes, "(max-width: 502px) 100vw, 470px");
  assert.match(image.props.srcSet, /w=192&v=source-v2 192w/);
  assert.match(image.props.srcSet, /w=1600&v=source-v2 1600w/);
  assert.equal(image.props.unoptimized, undefined);
  assert.equal(image.props.fill, undefined, "React DOM should receive native image props only.");

  console.log(`Responsive image QA passed: exact original ${original.length} bytes; 384px WebP ${results.find((entry) => entry.width === 384 && entry.format === "webp").bytes} bytes; finite variants, orientation/alpha/animation, byte/pixel/MIME/URL guards, publication-before-cache, coalescing, source versioning, eviction/expiry/corruption, native mobile srcset.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
