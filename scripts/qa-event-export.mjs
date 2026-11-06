import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ConvexHttpClient } from "convex/browser";
import { GET } from "../app/api/events/[eventId]/export/route.ts";
import { createCarouselJpegCache } from "../lib/social/carousel-jpeg-cache.ts";
import {
  EVENT_EXPORT_MAX_BYTES,
  getEventExportFacts,
  renderEventExportImage,
} from "../lib/social/event-export-image.ts";
import {
  createEventExportGate,
  createPublicEventExportHandler,
  EventExportBusyError,
} from "../lib/social/public-event-export.ts";

const id = "k17d3v0ks6wv7jaf99m2rrrxcs8b0yhr";
const event = {
  _id: id,
  title: "Friday Night: Live music & friends",
  venue: "KC Grad",
  date: "2026-11-06",
  time: "21:00",
  timeStatus: "confirmed",
  status: "approved",
  updatedAt: 1,
};
assert.equal(getEventExportFacts(event).time, "21:00 / Belgrade time");
assert.equal(getEventExportFacts({ ...event, time: "21:00-03:00" }).time, "21:00\u201303:00 / Belgrade time");
for (const timeStatus of ["unknown", "inferred"]) {
  assert.equal(getEventExportFacts({ ...event, timeStatus }).time, "Time not announced");
}
for (const time of [undefined, "TBD", "", "2026-11-06"]) {
  assert.equal(getEventExportFacts({ ...event, time }).time, "Time not announced");
}
assert.equal(getEventExportFacts(event).url, `https://eventzeka.com/events/${id}`);
assert.throws(() => getEventExportFacts({ ...event, date: "2026-02-29" }), /calendar date/);

const fixturePoster = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
  <rect width="900" height="1200" fill="#A99BFF"/><circle cx="450" cy="500" r="280" fill="#D5F56B"/>
  <path d="M0 1000L900 700V1200H0Z" fill="#34405A"/></svg>`)).jpeg().toBuffer();
const image = await renderEventExportImage(event, fixturePoster);
const metadata = await sharp(image).metadata();
assert.equal(metadata.width, 1080);
assert.equal(metadata.height, 1920);
assert.equal(metadata.format, "jpeg");
assert.ok(image.length < EVENT_EXPORT_MAX_BYTES);
const unicodeImage = await renderEventExportImage({
  ...event,
  title: "\u0412\u0435\u0447\u0435 \u045f\u0435\u0437\u0430 \u2014 \u017deljko & prijatelji",
  venue: "\u041a\u0443\u043b\u0442\u0443\u0440\u043d\u0438 \u0446\u0435\u043d\u0442\u0430\u0440",
  timeStatus: "unknown",
}, Buffer.from("broken poster"));
assert.equal((await sharp(unicodeImage).metadata()).height, 1920);
const longImage = await renderEventExportImage({
  ...event, title: "Long unabridged identity with special guests ".repeat(12), venue: "A long venue name ".repeat(10),
});
assert.equal((await sharp(longImage).metadata()).width, 1080);

const directory = await mkdtemp(path.join(os.tmpdir(), "eventzeka-export-qa-"));
try {
  let current = event;
  let publicSource = { eventExists: true, kind: "stored", storageId: "fixture", url: "https://source.example/poster.jpg" };
  let sourceBytes = fixturePoster;
  let renderCount = 0;
  let eventReads = 0;
  let posterUnavailable = false;
  const handler = createPublicEventExportHandler({
    loadEvent: async () => { eventReads += 1; return current; },
    loadImageSource: async () => publicSource,
    fetchRaster: async () => {
      if (posterUnavailable) throw new Error("Source expired");
      return { bytes: sourceBytes };
    },
    cachedJpeg: createCarouselJpegCache({ directory, maxEntries: 4, maxBytes: 8_000_000 }),
    render: async (snapshot, poster) => { renderCount += 1; return renderEventExportImage(snapshot, poster); },
    runWork: createEventExportGate(2),
  });
  const request = () => new Request(`https://eventzeka.com/api/events/${id}/export`);
  assert.equal((await handler(request(), "not-an-id")).status, 400);
  assert.equal(eventReads, 0, "invalid IDs never query the backend");
  const responses = await Promise.all([handler(request(), id), handler(request(), id)]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(renderCount, 1, "concurrent identical exports coalesce");
  assert.equal(responses[0].headers.get("cache-control"), "no-store");
  assert.equal(responses[0].headers.get("content-type"), "image/jpeg");
  await handler(request(), id);
  assert.equal(renderCount, 1, "cached JPEG avoids another render");
  assert.equal(eventReads, 3, "publication is read again on a cache hit");
  current = { ...event, updatedAt: 2 };
  await handler(request(), id);
  assert.equal(renderCount, 2, "event revision invalidates the image");
  sourceBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#D5F56B" } }).jpeg().toBuffer();
  await handler(request(), id);
  assert.equal(renderCount, 3, "changed source bytes invalidate even a stable source URL");
  current = { ...current, title: "Changed announcement" };
  await handler(request(), id);
  assert.equal(renderCount, 4, "changed visible facts invalidate independently of the revision");
  current = null;
  assert.equal((await handler(request(), id)).status, 404);
  current = { ...event, status: "pending" };
  assert.equal((await handler(request(), id)).status, 404);
  current = event;
  publicSource = { eventExists: false, kind: "none" };
  assert.equal((await handler(request(), id)).status, 404);
  assert.equal(renderCount, 4, "revocation cannot return cached bytes");
  publicSource = { eventExists: true, kind: "stored", storageId: "fixture", url: "https://source.example/poster.jpg" };
  posterUnavailable = true;
  const fallback = await handler(request(), id);
  assert.equal(fallback.status, 200, "expired external posters retain verified event facts");
  assert.equal((await sharp(Buffer.from(await fallback.arrayBuffer())).metadata()).height, 1920);
  const download = await handler(new Request(`${request().url}?download=1`), id);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="eventzeka-/);
  const head = await handler(new Request(request().url, { method: "HEAD" }), id);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
} finally { await rm(directory, { recursive: true, force: true }); }

const gate = createEventExportGate(1);
let release;
const running = gate(() => new Promise(resolve => { release = resolve; }));
await assert.rejects(gate(async () => "overflow"), EventExportBusyError);
release();
await running;
await assert.rejects(gate(async () => { throw new Error("failed render"); }), /failed render/);
assert.equal(await gate(async () => "recovered"), "recovered");

let fetchesStarted = 0;
const releaseFetches = [];
const boundedHandler = createPublicEventExportHandler({
  loadEvent: async () => event,
  loadImageSource: async () => ({ eventExists: true, kind: "upstream", url: "https://source.example/poster.jpg" }),
  fetchRaster: async () => {
    fetchesStarted += 1;
    await new Promise(resolve => releaseFetches.push(resolve));
    return { bytes: fixturePoster };
  },
  cachedJpeg: (_key, render) => render(),
  render: async () => image,
  runWork: createEventExportGate(2),
});
const boundedRequest = () => new Request(`https://eventzeka.com/api/events/${id}/export`);
const firstTwo = [boundedHandler(boundedRequest(), id), boundedHandler(boundedRequest(), id)];
await new Promise(resolve => setTimeout(resolve, 0));
const overflow = await boundedHandler(boundedRequest(), id);
assert.equal(overflow.status, 429);
assert.equal(overflow.headers.get("retry-after"), "3");
assert.equal(fetchesStarted, 2, "overflow rejects before allocating or fetching another source body");
for (const release of releaseFetches) release();
assert.ok((await Promise.all(firstTwo)).every(response => response.status === 200));

const originalQuery = ConvexHttpClient.prototype.query;
const originalConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const queries = [];
try {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://fixture.convex.cloud";
  ConvexHttpClient.prototype.query = async function(query, args) {
    queries.push({ query, args });
    if (query === "events:getPublicApprovedEvent") return { ...event, venueId: "fixture-venue", venue: "Old venue label" };
    if (query === "venues:listPublicVenueFieldsByIds") return [{ _id: "fixture-venue", name: "Current venue label" }];
    if (query === "mediaAssets:getPublicEventImageSource") return { eventExists: true, kind: "none" };
    throw new Error("Unexpected query");
  };
  const response = await GET(new Request(`https://eventzeka.com/api/events/${id}/export`), { params: Promise.resolve({ eventId: id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(queries.map(entry => entry.query), [
    "events:getPublicApprovedEvent", "venues:listPublicVenueFieldsByIds", "mediaAssets:getPublicEventImageSource",
  ]);
  assert.deepEqual(queries.at(-1).args, { eventId: id });
  assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 1080);
} finally {
  ConvexHttpClient.prototype.query = originalQuery;
  if (originalConvexUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalConvexUrl;
}

if (process.env.EVENT_EXPORT_QA_OUTPUT_DIR) {
  await mkdir(process.env.EVENT_EXPORT_QA_OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(process.env.EVENT_EXPORT_QA_OUTPUT_DIR, "event-export-story.jpg"), image);
  await writeFile(path.join(process.env.EVENT_EXPORT_QA_OUTPUT_DIR, "event-export-unicode-unknown-time.jpg"), unicodeImage);
  await writeFile(path.join(process.env.EVENT_EXPORT_QA_OUTPUT_DIR, "event-export-long-title.jpg"), longImage);
}
console.log(`Event export QA passed: publication, cache/coalescing, source checksum, dates/time, routing and 1080x1920 JPEG (${image.length} bytes).`);
