import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchAllowedRemoteRasterImage,
} from "../lib/images/remote-image-fetch.ts";
import {
  assertAllowedRemoteImageUrl,
  isAllowedRemoteImageUrl,
} from "../lib/images/remote-image-policy.ts";
import {
  assertPublicEventImageWrite,
  getNonExpiringPublicEventImageUrl,
} from "../lib/images/public-event-image.ts";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images.ts";
import {
  hasCoherentInstagramMediaSourceRecord,
  normalizeInstagramMediaSourceIdentity,
} from "../lib/images/media-source-identity.ts";
import {
  resolveInstagramIngestionMediaSelection,
} from "../lib/pipeline/instagram-media-selection.ts";
import {
  parseArgs,
  parseManifestText,
  runRepair,
} from "./repair-durable-instagram-images.mjs";

const APIFY_IMAGE = "https://images.apifyusercontent.com/example/poster.webp";
const INSTAGRAM_IMAGE = "https://instagram.fna.fbcdn.net/example/poster.jpg";
const POST_URL = "https://www.instagram.com/p/QA123/?utm_source=test";

function read(path) {
  return readFileSync(path, "utf8");
}

function imageResponse(bytes = [0xff, 0xd8, 0xff], headers = {}) {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: { "content-type": "image/jpeg", ...headers },
  });
}

assert.equal(assertAllowedRemoteImageUrl(APIFY_IMAGE).hostname, "images.apifyusercontent.com");
assert.equal(isAllowedRemoteImageUrl(INSTAGRAM_IMAGE), true);
for (const unsafe of [
  "http://images.apifyusercontent.com/x.jpg",
  "https://images.apifyusercontent.com:444/x.jpg",
  "https://user:pass@images.apifyusercontent.com/x.jpg",
  "https://images.apifyusercontent.com.evil.example/x.jpg",
  "https://127.0.0.1/x.jpg",
]) {
  assert.throws(() => assertAllowedRemoteImageUrl(unsafe));
}

{
  const fetched = await fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
    fetchImpl: async () => imageResponse(),
    timeoutMs: 100,
  });
  assert.equal(fetched.contentType, "image/jpeg");
  assert.equal(fetched.bytes.byteLength, 3);
  assert.equal(fetched.redirectCount, 0);
}

{
  const urls = [];
  const fetched = await fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://instagram.fna.fbcdn.net/next.jpg" },
        });
      }
      return imageResponse();
    },
    timeoutMs: 100,
  });
  assert.equal(fetched.redirectCount, 1);
  assert.equal(urls.length, 2);
}

await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x.jpg" },
        }),
      timeoutMs: 100,
    }),
  /not allowed/,
);
{
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      () =>
        fetchAllowedRemoteRasterImage("https://evil.example/x.jpg", {
          fetchImpl: async () => new Promise(() => undefined),
          timeoutMs: 10,
        }),
      /not allowed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}
await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      timeoutMs: 5,
    }),
  /aborted|exceeded/,
);
await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async () => new Response("not an image", { headers: { "content-type": "text/plain" } }),
      timeoutMs: 100,
    }),
  /content type/i,
);
await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async () => imageResponse([1], { "content-length": "10" }),
      maxBytes: 3,
      timeoutMs: 100,
    }),
  /exceeds/i,
);
await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async () => imageResponse([1, 2, 3, 4]),
      maxBytes: 3,
      timeoutMs: 100,
    }),
  /exceeds/i,
);
await assert.rejects(
  () =>
    fetchAllowedRemoteRasterImage(APIFY_IMAGE, {
      fetchImpl: async () => imageResponse([]),
      timeoutMs: 100,
    }),
  /empty/i,
);

{
  const video = resolveInstagramIngestionMediaSelection({
    postId: "video-1",
    username: "qa",
    instagramPostUrl: POST_URL,
    imageUrl: INSTAGRAM_IMAGE,
    imageUrls: [INSTAGRAM_IMAGE],
    postType: "Video",
  });
  assert.equal(video.extractionMode, "caption_only");
  assert.equal(video.selectedImageUrl, null);
  assert.equal(video.durableMediaCandidate, INSTAGRAM_IMAGE);
}
assert.equal(getNonExpiringPublicEventImageUrl(INSTAGRAM_IMAGE), undefined);
assert.equal(getNonExpiringPublicEventImageUrl(APIFY_IMAGE), APIFY_IMAGE);
assert.throws(() => assertPublicEventImageWrite(INSTAGRAM_IMAGE, undefined), /must not reference/);
assert.throws(() => assertPublicEventImageWrite(undefined, "storage-id"), /requires/);
assert.doesNotThrow(() => assertPublicEventImageWrite(APIFY_IMAGE, undefined));
assert.equal(
  normalizeInstagramPostUrl("https://evilinstagram.com/p/QA123/?x=1"),
  "https://evilinstagram.com/p/QA123/?x=1",
);
assert.throws(
  () =>
    normalizeInstagramMediaSourceIdentity({
      postId: "post-a",
      instagramPostUrl: "https://evilinstagram.com/p/QA123/",
    }),
  /Instagram post URL/,
);
assert.equal(
  hasCoherentInstagramMediaSourceRecord(
    { postId: "post-a", instagramPostUrl: "https://www.instagram.com/p/AAA/" },
    [{ postId: "post-a", instagramPostUrl: "https://instagram.com/p/AAA/?x=1" }],
  ),
  true,
);
assert.equal(
  hasCoherentInstagramMediaSourceRecord(
    { postId: "post-a", instagramPostUrl: "https://www.instagram.com/p/BBB/" },
    [{ postId: "post-a", instagramPostUrl: "https://www.instagram.com/p/AAA/" }],
  ),
  false,
);
assert.equal(
  hasCoherentInstagramMediaSourceRecord(
    { postId: "post-a", instagramPostUrl: "https://www.instagram.com/p/AAA/" },
    [
      { postId: "post-a", instagramPostUrl: "https://www.instagram.com/p/AAA/" },
      { postId: "post-b", instagramPostUrl: "https://www.instagram.com/p/AAA/" },
    ],
  ),
  false,
);

const parsedRows = parseManifestText(
  JSON.stringify([
    { postId: "qa-post", instagramPostUrl: POST_URL, upstreamUrl: APIFY_IMAGE },
  ]),
  1,
);
assert.deepEqual(parsedRows, [
  {
    postId: "qa-post",
    instagramPostUrl: "https://www.instagram.com/p/QA123/",
    upstreamUrl: APIFY_IMAGE,
    sourceKey: "instagram-post:qa-post",
  },
]);
assert.throws(
  () => parseManifestText(JSON.stringify([parsedRows[0], parsedRows[0]]), 2),
  /duplicates source/,
);
assert.throws(
  () => parseManifestText(JSON.stringify([{ instagramPostUrl: POST_URL, upstreamUrl: "https://evil.example/x" }])),
  /not allowed/,
);
assert.equal(
  parseManifestText(
    JSON.stringify([
      {
        eventIds: ["ignored-event-id"],
        instagramPostId: "alias-post",
        instagramPostUrl: POST_URL,
        provider: "ignored-provider",
        sourceImageUrl: APIFY_IMAGE,
      },
    ]),
  )[0].sourceKey,
  "instagram-post:alias-post",
);
assert.throws(() => parseManifestText(JSON.stringify([parsedRows[0]]), 0), /exceeding/);
assert.equal(parseArgs(["--manifest", "x.json"]).apply, false);
assert.equal(parseArgs(["--manifest", "x.json", "--apply", "--concurrency", "8"]).apply, true);
assert.throws(() => parseArgs(["--manifest", "x.json", "--concurrency", "9"]), /Expected 1-8/);
assert.throws(() => parseArgs(["--manifest", "x.json", "--limit", "1x"]), /Expected 1-500/);

{
  const dryRun = await runRepair({ apply: false, concurrency: 3, rows: parsedRows });
  assert.equal(dryRun.processed, 1);
  assert.equal(dryRun.results[0].status, "dry-run");
}
{
  const actionArgs = [];
  const applied = await runRepair({
    apply: true,
    concurrency: 2,
    rows: parsedRows,
    serviceSecret: "qa-secret",
    client: {
      async action(_reference, args) {
        actionArgs.push(args);
        return {
          attachedEventCount: 2,
          attachedScrapedPostCount: 1,
          checksumSha256: "a".repeat(64),
          reused: false,
        };
      },
    },
  });
  assert.equal(applied.failed, 0);
  assert.equal(actionArgs.length, 1);
  assert.equal(actionArgs[0].serviceSecret, "qa-secret");
  assert.equal(applied.results[0].checksumSha256.length, 64);
}

const ingestionSource = read("lib/pipeline/run-instagram-ingestion.ts");
const mediaActionSource = read("convex/mediaActions.ts");
const mediaAssetSource = read("convex/mediaAssets.ts");
const eventsConvexSource = read("convex/events.ts");
const schemaSource = read("convex/schema.ts");
const routeSource = read("app/api/discover/images/[eventId]/route.ts");
const eventPageSource = read("app/(main)/events/[eventId]/page.tsx");
const venuePageSource = read("app/(main)/venues/[venueId]/page.tsx");
const discoverPageSource = read("app/(main)/discover/page.tsx");
const discoverFeedSource = read("components/discover/discover-feed.tsx");
const dashboardSource = read("components/admin/scraper-dashboard.tsx");
const moderationDashboardSource = read("components/admin/moderation-dashboard.tsx");
const maintenanceSource = read("convex/maintenance.ts");
const cronsSource = read("convex/crons.ts");

assert.match(schemaSource, /mediaAssets: defineTable/);
assert.match(schemaSource, /checksumSha256: v\.string\(\)/);
assert.match(mediaActionSource, /^"use node";/);
assert.match(mediaActionSource, /computeSha256Hex/);
assert.match(mediaActionSource, /ctx\.storage\.delete\(provisionalStorageId\)/);
assert.match(mediaAssetSource, /event\.imageStorageId !== attachment\.storageId/);
assert.match(mediaAssetSource, /imageStorageId: attachment\.storageId,[\s\S]*imageUrl: attachment\.url/);
assert.match(mediaAssetSource, /assertCoherentPersistedSourceIdentity/);
assert.match(mediaAssetSource, /matchingPosts, matchingEvents/);
assert.match(mediaAssetSource, /withIndex\("by_image_storage_id"/);
assert.match(mediaAssetSource, /ctx\.storage\.delete\(asset\.storageId\)/);
assert.match(eventsConvexSource, /const nextImageStorageId =/);
assert.match(eventsConvexSource, /imageStorageId: nextImageStorageId/);
assert.match(ingestionSource, /getNonExpiringPublicEventImageUrl\(selectedImageUrl\)/);
assert.match(ingestionSource, /hasDurableMediaAttachmentTarget && durableMediaCandidate/);
assert.match(ingestionSource, /isExistingEventEligibleForDurableMediaRetry/);
assert.match(ingestionSource, /failedImagePersistence \+= 1/);
assert.match(ingestionSource, /imageStorageId: preferredNext\.imageStorageId/);
assert.match(dashboardSource, /Persisted images/);
assert.match(dashboardSource, /Failed image persistence/);
assert.match(moderationDashboardSource, /src=\{event\.imageUrl\}[\s\S]*unoptimized/);
assert.match(schemaSource, /\.index\("by_image_storage_id", \["imageStorageId"\]\)/);
assert.match(maintenanceSource, /cleanupOrphanedMediaAssetsUntilDone/);
assert.match(cronsSource, /"cleanup orphaned media assets"/);
for (const source of [eventPageSource, venuePageSource, discoverPageSource]) {
  assert.match(source, /buildDiscoverImageUrl|getDiscoverDisplayImageUrl/);
}
assert.match(eventPageSource, /className="object-contain"/);
assert.match(discoverFeedSource, /startsWith\("\/api\/discover\/images\/"\)/);
assert.match(routeSource, /"x-event-image-source": "placeholder"/);
assert.match(routeSource, /rasterImageResponse\(image\.bytes, image\.contentType, "stored"\)/);
assert.match(routeSource, /rasterImageResponse\(image\.bytes, image\.contentType, "upstream"\)/);
assert.match(routeSource, /\? "public, max-age=60, stale-while-revalidate=60"\s*: "no-store"/);

console.log("Durable Instagram image QA passed.");
