import assert from "node:assert/strict";
import "./qa-instaloader-source-cache.mjs";
import { readFileSync } from "node:fs";
import { getInstagramScraperProvider, fetchInstaloaderItems } from "../lib/scraper/instaloader-client.ts";
import { isInertGeneratedAltEnrichment, sameInstagramSlideAssets } from "../lib/scraper/instagram-accessibility-compatibility.ts";
import { scrapeInstagramAccount, getInstagramScrapeRawItemCount } from "../lib/scraper/instagram-scraper.ts";
import { durableControlsFor } from "../lib/pipeline/durable-ingestion-controller.ts";

const names = ["INSTAGRAM_SCRAPER_PROVIDER", "INSTALOADER_API_URL", "INSTALOADER_API_TOKEN", "INSTALOADER_TIMEOUT_SECONDS", "APIFY_API_TOKEN"];
const savedEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const now = Date.parse("2026-10-12T12:00:00.000Z");
function shortcode(id) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = BigInt(id), code = "";
  while (value) { code = alphabet[Number(value & 63n)] + code; value >>= 6n; }
  return code;
}
const fixture = (id, label, overrides = {}) => {
  const code = shortcode(id);
  return ({
  id, shortCode: code, ownerUsername: "fixture_venue", type: "Image",
  caption: "Friday event at the venue", timestamp: "2026-10-12T10:00:00.000Z",
  url: `https://www.instagram.com/p/${code}/`,
  displayUrl: `https://scontent.cdninstagram.com/${label}.jpg`,
  alt: null, ...overrides,
}); };
const oldPin = fixture("39000000000000000001", "OLD_PIN", { isPinned: true, timestamp: "2026-09-01T10:00:00.000Z" });
const carousel = fixture("39000000000000000002", "CAROUSEL", {
  type: "Sidecar", isPinned: true, childPostsCount: 3, carouselMediaCount: 3,
  childPosts: [
    { id: "39000000000000000003", index: 0, type: "Image", displayUrl: "https://scontent.cdninstagram.com/slide-0.jpg" },
    { id: "39000000000000000004", index: 1, type: "Video", isVideo: true, displayUrl: "https://scontent.cdninstagram.com/slide-1-thumb.jpg" },
    { id: "39000000000000000005", index: 2, type: "Image", displayUrl: "https://scontent.cdninstagram.com/slide-2.jpg" },
  ],
});
const second = fixture("39000000000000000006", "SECOND", { timestamp: "2026-10-12T09:00:00.000Z" });
const foreign = fixture("39000000000000000007", "FOREIGN", { ownerUsername: "other_organizer" });
const payload = items => ({ schemaVersion: 1, items, rawItemCount: items.length });
let calls = [];
let marked = false;
let invoked = false;
const useResponse = (value, status = 200) => {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/ready")) {
      return Response.json({ ready: true, sessionAvailable: true, paused: false });
    }
    calls.push({ url: String(url), init, request: JSON.parse(init.body) });
    return new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
  };
};
try {
  assert.equal(getInstagramScraperProvider({}), "apify");
  assert.equal(getInstagramScraperProvider({ INSTAGRAM_SCRAPER_PROVIDER: "instaloader" }), "instaloader");
  assert.throws(() => getInstagramScraperProvider({ INSTAGRAM_SCRAPER_PROVIDER: "typo" }));
  Date.now = () => now;
  process.env.INSTAGRAM_SCRAPER_PROVIDER = "instaloader";
  process.env.INSTALOADER_API_URL = "http://eventzeka-instaloader:8080";
  process.env.INSTALOADER_API_TOKEN = "fixture-private-collector-token-0000000";
  delete process.env.APIFY_API_TOKEN;
  useResponse(payload([oldPin, carousel, second, foreign]));
  const posts = await scrapeInstagramAccount({
    handle: "@fixture_venue", ...durableControlsFor("daily"), selectAllEligiblePosts: true,
    requestId: "durable:fixture:receipt", onRequestStarted: () => { marked = true; },
    onTransportInvoked: () => { assert.ok(marked); invoked = true; },
  });
  assert.ok(invoked);
  assert.deepEqual(posts.map(p => p.postId), [carousel.id, second.id]);
  assert.equal(getInstagramScrapeRawItemCount(posts), 4);
  assert.equal(posts[0].postedAt, "2026-10-12T10:00:00.000Z");
  assert.equal(posts[0].postType, "sidecar");
  assert.equal(posts[0].imageSlideCount, 3);
  assert.deepEqual(posts[0].imageSlides.map(s => [s.index, s.mediaType]), [[0, "image"], [1, "video"], [2, "image"]]);
  assert.equal(posts[0].imageSlides[1].imageUrls[0], carousel.childPosts[1].displayUrl);
  assert.equal(calls[0].request.resultsLimit, 6);
  assert.equal(calls[0].request.target, "fixture_venue");
  assert.equal(calls[0].request.onlyPostsNewerThan, "2026-10-11T12:00:00.000Z");
  assert.equal(calls[0].request.requestId, "durable:fixture:receipt");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(!calls.some(c => c.url.includes("apify.com")));

  const oldAlt = "Photo by Cafe Alpha on October 04, 2026.";
  const equivalentAlt = "Photo shared by Cafe Alpha on October 04, 2026 tagging @dj_one, @artist.two, and @photographer_3. May be an image of poster and text.";
  assert.equal(isInertGeneratedAltEnrichment(oldAlt, equivalentAlt), true);
  assert.equal(isInertGeneratedAltEnrichment(oldAlt, equivalentAlt.replace("Photo shared by", "Photo by")), true,
    "both complete observed attribution wrappers are recognized");
  assert.equal(isInertGeneratedAltEnrichment("Photo by 𝗖𝗮𝗳𝗲 𝗔𝗹𝗽𝗵𝗮 on October 04, 2026.", equivalentAlt), true,
    "mathematical presentation forms compare by NFKC author text");
  for (const [previous, incoming] of [
    [oldAlt, `${equivalentAlt} Doors at 9 PM.`],
    [oldAlt, equivalentAlt.replace("October 04, 2026", "October 05, 2026")],
    [oldAlt, equivalentAlt.replace("Cafe Alpha", "Cafe Beta")],
    [oldAlt, equivalentAlt.replace("poster and text", "poster reading \"doors at 9 PM\"")],
    [oldAlt, equivalentAlt.replace("@dj_one, @artist.two, and @photographer_3", "@dj_one, @artist.two")],
    ["Photo by Cafe Alpha on October 04, 2026. Doors at 9 PM.", equivalentAlt],
    ["Photo by Cafe Alpha on February 30, 2026.", equivalentAlt.replace("October 04, 2026", "February 30, 2026")],
    [oldAlt, "Photo shared by Cafe Alpha on October 04, 2026 tagging @dj_one. Poster says 8 PM. May be an image."],
  ]) {
    assert.equal(isInertGeneratedAltEnrichment(previous, incoming), false,
      "custom, mismatched or unrecognized accessibility text must not qualify");
  }
  assert.equal(isInertGeneratedAltEnrichment(null, equivalentAlt), false);
  assert.equal(isInertGeneratedAltEnrichment(oldAlt, null), false);
  assert.equal(isInertGeneratedAltEnrichment(`${oldAlt}${"x".repeat(1_025)}`, equivalentAlt), false,
    "oversized prior alt text fails closed");
  assert.equal(isInertGeneratedAltEnrichment(oldAlt, `${equivalentAlt}${"x".repeat(4_096)}`), false,
    "oversized incoming alt text fails closed");
  const longAuthor = "A".repeat(257);
  assert.equal(isInertGeneratedAltEnrichment(
    `Photo by ${longAuthor} on October 04, 2026.`,
    `Photo shared by ${longAuthor} on October 04, 2026 tagging @dj_one. May be an image of poster and text.`,
  ), false, "authors over 256 UTF-16 code units fail closed");
  assert.equal(isInertGeneratedAltEnrichment(
    oldAlt,
    `Photo shared by Cafe Alpha on October 04, 2026 tagging @${"a".repeat(31)}. May be an image of poster and text.`,
  ), false, "labels over 30 characters fail closed");

  const assetUrl = (host, path, cacheKey, extra = "") =>
    `https://${host}${path}?ig_cache_key=${cacheKey}${extra}`;
  const pathA = "/v/t51.82787-15/834500447_17948904960289767_2981624846562425485_n.jpg";
  const pathB = "/v/t51.82787-15/835748645_17948904945289767_6654409283338105362_n.jpg";
  const alternateA = Array.from({ length: 8 }, (_, index) => assetUrl(
    `scontent-fra${index + 1}-1.cdninstagram.com`, pathA, "asset-a", `&variant=${index}`,
  ));
  const alternateB = Array.from({ length: 8 }, (_, index) => assetUrl(
    `scontent-fra${index + 1}-2.cdninstagram.com`, pathB, "asset-b", `&variant=${index}`,
  ));
  const oldAssets = { completeCount: 2, slides: [
    { index: 0, mediaType: "image", imageUrls: [assetUrl("scontent-fra3-1.cdninstagram.com", pathA, "asset-a", "&width=1080")] },
    { index: 1, mediaType: "image", imageUrls: [assetUrl("scontent-fra3-2.cdninstagram.com", pathB, "asset-b")] },
  ] };
  const sameAssets = { completeCount: 2, slides: [
    { index: 0, mediaType: "image", imageUrls: alternateA },
    { index: 1, mediaType: "image", imageUrls: alternateB },
  ] };
  assert.equal(sameInstagramSlideAssets(oldAssets, sameAssets), true,
    "one old URL and eight new alternate URLs collapse to matching ordered photo identities");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    { ...sameAssets.slides[1], index: 0 }, { ...sameAssets.slides[0], index: 1 },
  ] }), false,
    "changed slide order must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, completeCount: 3 }), false,
    "changed provider-declared total count must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [sameAssets.slides[0]] }), false,
    "partial slide manifests must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    sameAssets.slides[0], { ...sameAssets.slides[1], mediaType: "video" },
  ] }), false, "video slides do not qualify as static photo identity");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    sameAssets.slides[0], { ...sameAssets.slides[1], imageUrls: [assetUrl("scontent.cdninstagram.com", pathA, "asset-b")] },
  ] }), false, "changed asset paths must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    sameAssets.slides[0], { ...sameAssets.slides[1], imageUrls: [assetUrl("scontent.cdninstagram.com", pathB, "different-key")] },
  ] }), false, "contradictory cache keys must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    { ...sameAssets.slides[0], imageUrls: [...alternateA.slice(0, 7), assetUrl("scontent.cdninstagram.com", pathB, "asset-b")] },
    sameAssets.slides[1],
  ] }), false, "alternate URLs resolving to mixed asset identities must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    { ...sameAssets.slides[0], imageUrls: [assetUrl("scontent.cdninstagram.com", pathA.replace("t51.82787-15", "t51.82788-15"), "asset-a")] },
    sameAssets.slides[1],
  ] }), false, "unknown Instagram photo version families must fail closed");
  assert.equal(sameInstagramSlideAssets(oldAssets, { ...sameAssets, slides: [
    { ...sameAssets.slides[0], imageUrls: [`http://scontent.cdninstagram.com${pathA}?ig_cache_key=asset-a`] }, sameAssets.slides[1],
  ] }), false, "non-HTTPS or unrecognized assets must fail closed");

  useResponse(payload([carousel, second, second]));
  const latest = await scrapeInstagramAccount({ handle: "fixture_venue", ...durableControlsFor("canary") });
  assert.deepEqual(latest.map(p => p.postId), [carousel.id]);
  const bounded = await scrapeInstagramAccount({ handle: "fixture_venue", resultsLimit: 3, selectAllEligiblePosts: true,
    pinnedPostPolicy: "include_recent", onlyPostsNewerThan: "2026-10-12T09:30:00.000Z" });
  assert.deepEqual(bounded.map(p => p.postId), [carousel.id], "saved checkpoint must remain effective locally");

  useResponse(payload([foreign]));
  const direct = await scrapeInstagramAccount({ handle: foreign.url, resultsLimit: 1, noAgeCutoff: true });
  assert.equal(direct[0].username, "other_organizer", "direct URLs preserve original owner");
  assert.equal(calls.at(-1).request.onlyPostsNewerThan, null);
  useResponse(payload([]));
  assert.equal((await scrapeInstagramAccount({ handle: "fixture_venue" })).length, 0);

  for (const [bad, status] of [
    [{ schemaVersion: 1, items: [], rawItemCount: 1 }, 200],
    [payload([fixture(39000000000000000002, "PRECISION_LOSS")]), 200],
    [payload([{ ...carousel, childPosts: [] }]), 200],
    [payload([{ ...carousel, childPostsCount: 2 }]), 200],
    [payload([{ ...second, id: "12345" }]), 200],
    [payload([{ ...second, ownerUsername: undefined }]), 200],
    [payload([{ ...second, url: "https://example.com/p/SECOND/" }]), 200],
    [{ schemaVersion: 1, error: { code: "session_unavailable", message: "private" } }, 503],
    ["not JSON", 200],
  ]) {
    useResponse(bad, status);
    await assert.rejects(() => scrapeInstagramAccount({ handle: "fixture_venue" }));
  }
  calls = [];
  useResponse(payload([]));
  await assert.rejects(() => fetchInstaloaderItems({ target: "fixture_venue", resultsLimit: 6,
    onlyPostsNewerThan: null, skipPinnedPosts: false, abortAtMs: now + 10_000,
    onRequestStarted: () => { Date.now = () => now + 9_000; },
  }), /lease expired/);
  assert.equal(calls.length, 0, "expired marker cannot invoke collector transport");
  Date.now = () => now;
  let rejectedMarker = false;
  calls = [];
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith("/ready"));
    return Response.json({ ready: false, sessionAvailable: false, paused: false }, { status: 503 });
  };
  await assert.rejects(() => scrapeInstagramAccount({ handle: "fixture_venue",
    onRequestStarted: () => { rejectedMarker = true; },
  }), /not ready/);
  assert.equal(rejectedMarker, false, "readiness holds must precede the legacy durable attempt marker");
  assert.equal(calls.length, 0);
  let afterMarkerPreflights = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/ready")) { afterMarkerPreflights++; throw new Error("paused after controller preflight"); }
    calls.push({ url: String(url), init });
    return Response.json(payload([]));
  };
  await scrapeInstagramAccount({ handle: "fixture_venue", collectorReadinessChecked: true });
  assert.equal(afterMarkerPreflights, 0, "a controller-preflighted attempt must not acquire another pretransport hold");
  assert.equal(calls.length, 1);
  calls = [];
  delete process.env.INSTALOADER_API_TOKEN;
  await assert.rejects(() => scrapeInstagramAccount({ handle: "fixture_venue" }), /INSTALOADER_API_TOKEN/);
  assert.equal(calls.length, 0, "missing collector config must not fall back to paid scraping");

  const compose = readFileSync("docker-compose.instaloader.yml", "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/mu);
  assert.match(compose, /traefik.enable: "false"/u);
  assert.match(compose, /INSTALOADER_ALLOW_ANONYMOUS: "false"/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /mem_limit: 384m/u);
  assert.match(readFileSync("app/api/cron/durable-ingestion/execute/route.ts", "utf8"), /requestId: `durable:\$\{runId\}:\$\{claimed.receiptId\}`/u);
  console.log("Instaloader QA passed: common account rules, exact IDs, carousel order, deadlines and fail-closed transport.");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
