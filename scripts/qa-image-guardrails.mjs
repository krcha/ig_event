import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchTrustedEventImage,
  isTrustedEventImageUrl,
} from "../lib/images/trusted-event-images.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

const guardrailsSource = read("lib/images/image-response-guardrails.ts");
const trustedImagesSource = read("lib/images/trusted-event-images.ts");
const mediaAssetsSource = read("convex/mediaAssets.ts");
const schemaSource = read("convex/schema.ts");
const cronSource = read("convex/crons.ts");
const eventsSource = read("convex/events.ts");
const scrapedPostsSource = read("convex/scrapedPosts.ts");
const ingestionSource = read("lib/pipeline/run-instagram-ingestion.ts");
const eventDetailSource = read("app/(main)/events/[eventId]/page.tsx");
const venueDetailSource = read("app/(main)/venues/[venueId]/page.tsx");
const moderationDashboardSource = read("components/admin/moderation-dashboard.tsx");
const imagePrepSource = read("lib/ai/prepare-image-for-openai.ts");
const discoverImageRouteSource = read("app/api/discover/images/[eventId]/route.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

assert.match(
  guardrailsSource,
  /DEFAULT_MAX_IMAGE_BYTES = 8 \* 1024 \* 1024/,
  "image guardrails should cap responses at 8 MB.",
);
assert.match(
  guardrailsSource,
  /RASTER_IMAGE_CONTENT_TYPES/,
  "image guardrails should define an allowlist of raster content types.",
);
assert.match(
  guardrailsSource,
  /content-length/,
  "image guardrails should check content-length before reading the body.",
);
assert.match(
  guardrailsSource,
  /response\.body\.getReader\(\)/,
  "image guardrails should stream response bodies through a byte counter.",
);
assert.match(
  imagePrepSource,
  /assertImageResponseHeaders/,
  "OpenAI image prep should validate image response headers.",
);
assert.match(
  imagePrepSource,
  /readImageResponseBodyWithLimit/,
  "OpenAI image prep should read images through the shared byte limit.",
);
assert.match(
  imagePrepSource,
  /finally\s*\{\s*clearTimeout\(timeoutId\);/s,
  "OpenAI image prep should clear abort timers in finally.",
);
assert.match(
  discoverImageRouteSource,
  /fetchTrustedEventImage/,
  "Discover image proxy should use the redirect-safe trusted image fetcher.",
);
assert.match(
  trustedImagesSource,
  /redirect: "manual"/,
  "Trusted image fetches must validate every redirect target before following it.",
);
assert.match(
  trustedImagesSource,
  /DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 12_000/,
  "Trusted image fetches should have a bounded timeout.",
);
assert.match(
  discoverImageRouteSource,
  /placeholderImageResponse/,
  "Discover image proxy should return a safe placeholder when an upstream image fails.",
);
assert.doesNotMatch(
  discoverImageRouteSource,
  /Image source failed[\s\S]*502/,
  "Discover image proxy should not break the feed with a 502 for stale upstream images.",
);
assert.match(
  discoverImageRouteSource,
  /catch \{\s*return placeholderImageResponse\(false\);/s,
  "Transient image/backend failures must return a non-cacheable placeholder.",
);
assert.match(
  discoverImageRouteSource,
  /"x-content-type-options": "nosniff"/,
  "Discover image proxy should set nosniff.",
);
assert.match(
  mediaAssetsSource,
  /ctx\.storage\.store/,
  "Instagram images should be copied into durable Convex storage.",
);
assert.match(
  schemaSource,
  /mediaAssets: defineTable/,
  "Stored Instagram media should be deduplicated by a durable media asset table.",
);
assert.match(
  mediaAssetsSource,
  /pruneOrphanedAssets[\s\S]*ctx\.storage\.delete/s,
  "Orphaned stored images should be deleted from Convex storage.",
);
assert.match(
  cronSource,
  /cleanup orphaned stored event images/,
  "Orphan cleanup should run on a bounded daily schedule.",
);
assert.match(
  mediaAssetsSource,
  /ctx\.storage\.getUrl\(existing\.storageId\)/,
  "Stored image URLs should be regenerated from canonical storage IDs.",
);
assert.match(
  ingestionSource,
  /failed_image_persistence/,
  "Ingestion summaries should expose durable image persistence failures.",
);
assert.match(
  eventsSource,
  /args\.patch\.imageUrl !== undefined && args\.patch\.imageStorageId === undefined/,
  "Event image URL replacements should clear stale storage IDs.",
);
assert.match(
  scrapedPostsSource,
  /post\.imageUrl !== undefined && post\.imageStorageId === undefined/,
  "Scraped-post image URL replacements should clear stale storage IDs.",
);
assert.match(
  ingestionSource,
  /mediaAssets:persistInstagramImage/,
  "Fresh ingestion should persist posters before publishing event image URLs.",
);
assert.match(
  ingestionSource,
  /if \(preparedResults\.some\(\(result\) => result\.kind === "ok"\)\) \{\s*await persistImageForScrapedPost/s,
  "Ingestion should persist images only after deterministic event validation succeeds.",
);
assert.match(
  eventDetailSource,
  /buildDiscoverImageUrl/,
  "Event details should render through the same-origin image endpoint.",
);
assert.match(
  venueDetailSource,
  /instagramPostUrl: event\.instagramPostUrl/,
  "Venue post grids should route all Instagram post images through the same-origin endpoint.",
);
assert.match(
  moderationDashboardSource,
  /src=\{posterUrl\}/,
  "Moderation images should use the same-origin endpoint instead of expiring CDN URLs.",
);

const storedMediaOrigin = "https://convex.example.test";
assert.equal(isTrustedEventImageUrl("https://images.apifyusercontent.com/poster.jpg"), true);
assert.equal(isTrustedEventImageUrl("https://scontent-lga3-2.cdninstagram.com/poster.jpg"), true);
assert.equal(isTrustedEventImageUrl("https://instagram.example.fbcdn.net/poster.jpg"), true);
assert.equal(
  isTrustedEventImageUrl(`${storedMediaOrigin}/api/storage/example`, { storedMediaOrigin }),
  true,
);
for (const rejectedUrl of [
  "http://images.apifyusercontent.com/image.jpg",
  "https://images.apifyusercontent.com:444/image.jpg",
  "http://127.0.0.1/image.jpg",
  "https://cdninstagram.com.evil.example/image.jpg",
  "https://evil.example/image.jpg",
]) {
  assert.equal(isTrustedEventImageUrl(rejectedUrl, { storedMediaOrigin }), false);
}

const expectedBytes = new Uint8Array([1, 2, 3, 4]);
const fetchedImage = await fetchTrustedEventImage(
  "https://images.apifyusercontent.com/poster.jpg",
  {
    fetchImpl: async () =>
      new Response(expectedBytes, {
        status: 200,
        headers: {
          "content-length": String(expectedBytes.byteLength),
          "content-type": "image/jpeg",
        },
      }),
  },
);
assert.deepEqual([...fetchedImage.bytes], [...expectedBytes]);
assert.equal(fetchedImage.contentType, "image/jpeg");

let redirectFetchCount = 0;
await assert.rejects(
  () =>
    fetchTrustedEventImage("https://images.apifyusercontent.com/poster.jpg", {
      fetchImpl: async () => {
        redirectFetchCount += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    }),
  /allowlisted/,
);
assert.equal(redirectFetchCount, 1, "A rejected redirect target must never be fetched.");

await assert.rejects(
  () =>
    fetchTrustedEventImage("https://images.apifyusercontent.com/poster.jpg", {
      fetchImpl: async () =>
        new Response("not an image", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    }),
  /supported raster content type/,
);
await assert.rejects(
  () =>
    fetchTrustedEventImage("https://images.apifyusercontent.com/poster.jpg", {
      maxBytes: 4,
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    }),
  /exceeds 4 bytes/,
);
await assert.rejects(
  () =>
    fetchTrustedEventImage("https://images.apifyusercontent.com/poster.jpg", {
      timeoutMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    }),
  /aborted/,
);

assert.ok(
  packageJson.scripts["qa:image-guardrails"]?.includes("qa-image-guardrails.mjs"),
  "package.json should expose qa:image-guardrails.",
);
assert.match(
  releaseCheckSource,
  /qa:image-guardrails/,
  "Release gate should include image guardrail QA.",
);

console.log("Image guardrail QA passed.");
