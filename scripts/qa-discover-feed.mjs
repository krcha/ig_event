import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_DISCOVER_SCRAPED_POST_REFS,
  buildDiscoverScrapedPostBatch,
  mergeDiscoverScrapedPostBatch,
} from "../lib/discover/apify-post-alignment.ts";
import {
  buildDiscoverImageUrl,
  getDiscoverDisplayImageUrl,
  getDiscoverImageCandidate,
} from "../lib/discover/discover-image-source.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";
import {
  isApifyImageUrl,
  normalizeInstagramPostUrl,
  pickApifyImageUrl,
  pickApifySourcedImageUrl,
} from "../lib/images/apify-images.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

function assertIncludes(source, value, message) {
  assert.equal(source.includes(value), true, message);
}

function assertDoesNotInclude(source, value, message) {
  assert.equal(source.includes(value), false, message);
}

const discoverPageSource = read("app/(main)/discover/page.tsx");
const discoverErrorSource = read("app/(main)/discover/error.tsx");
const discoverFeedSource = read("components/discover/discover-feed.tsx");
const discoverImageSourceSource = read("lib/discover/discover-image-source.ts");
const apifyPostAlignmentSource = read("lib/discover/apify-post-alignment.ts");
const apifyPostsSource = read("lib/discover/apify-posts.ts");
const discoverImageRouteSource = read("app/api/discover/images/[eventId]/route.ts");
const readMoreTextSource = read("components/ui/read-more-text.tsx");
const scrapedPostsSource = read("convex/scrapedPosts.ts");
const nextConfigSource = read("next.config.mjs");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

assert.equal(
  isApifyImageUrl("https://images.apifyusercontent.com/example.jpg"),
  true,
  "Apify image helper should allow images.apifyusercontent.com.",
);
assert.equal(
  isApifyImageUrl("https://scontent.cdninstagram.com/example.jpg"),
  false,
  "Apify image helper should reject Instagram CDN images.",
);
assert.equal(
  isApifyImageUrl("https://example.fbcdn.net/example.jpg"),
  false,
  "Apify image helper should reject Facebook CDN images.",
);
assert.equal(
  pickApifyImageUrl([
    "https://scontent.cdninstagram.com/example.jpg",
    "https://images.apifyusercontent.com/example.jpg",
  ]),
  "https://images.apifyusercontent.com/example.jpg",
  "Apify image helper should choose the Apify candidate over CDN candidates.",
);
assert.equal(
  pickApifySourcedImageUrl([
    "https://scontent.cdninstagram.com/example.jpg",
    "https://images.apifyusercontent.com/example.jpg",
  ]),
  "https://images.apifyusercontent.com/example.jpg",
  "Apify-sourced helper should prefer stored Apify images when present.",
);
assert.equal(
  pickApifySourcedImageUrl(["https://scontent.cdninstagram.com/example.jpg"]),
  "https://scontent.cdninstagram.com/example.jpg",
  "Apify-sourced helper should keep Instagram CDN candidates available for first-party proxying.",
);
assert.equal(
  normalizeInstagramPostUrl("https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link"),
  "https://www.instagram.com/p/ABC123/",
  "Instagram post URL normalization should remove tracking query params.",
);
assert.equal(
  buildDiscoverImageUrl({ _id: "event123", instagramHandle: "@DrugstoreBelgrade" }),
  "/api/discover/images/event123",
  "Discover image URLs should use only first-party event identity, without venue-handle coupling.",
);
assert.equal(
  getDiscoverImageCandidate(
    { _id: "event123", imageUrl: "https://scontent.cdninstagram.com/example.jpg" },
    null,
  ),
  "https://scontent.cdninstagram.com/example.jpg",
  "Discover image candidate helper should accept Apify-scraped Instagram CDN candidates for proxying.",
);
assert.equal(
  getDiscoverDisplayImageUrl(
    { _id: "event123", imageUrl: "https://scontent.cdninstagram.com/example.jpg" },
    null,
  ),
  "/api/discover/images/event123",
  "Discover display image helper should expose only a first-party proxy URL for CDN candidates.",
);
assert.equal(
  getDiscoverDisplayImageUrl(
    { _id: "event123", imageUrl: "https://example.com/not-from-apify.jpg" },
    null,
  ),
  undefined,
  "Discover display image helper should reject unknown image hosts.",
);

assertIncludes(
  discoverPageSource,
  "enrichDiscoverEventsWithApifyPosts",
  "Discover page should enrich events from stored Apify scraped posts before rendering.",
);
assertIncludes(
  discoverPageSource,
  "loadPublicCalendarEventsWindow",
  "Discover should use the lean public calendar window query so high-volume nights do not break the tab.",
);
assertIncludes(
  discoverPageSource,
  "getNightlifeDefaultDateKey()",
  "Discover should use the nightlife business date so 00:00-06:59 defaults to the previous night.",
);
assertIncludes(
  discoverPageSource,
  "const DISCOVER_PAGE_SIZE = 9",
  "Discover should render a small first batch instead of hydrating a high-volume night at once.",
);
assertIncludes(
  discoverPageSource,
  "matchingEvents.slice(startIndex, startIndex + DISCOVER_PAGE_SIZE)",
  "Discover should slice the requested batch before Apify post enrichment.",
);
assertIncludes(
  discoverFeedSource,
  'data-discover-pagination="bounded"',
  "Discover should expose bounded previous/more controls for incremental loading.",
);
assertIncludes(
  discoverFeedSource,
  'contentVisibility: "auto"',
  "Discover cards should skip off-screen rendering work.",
);
assertIncludes(
  discoverErrorSource,
  'href="/discover"',
  "Discover should provide a clean document reload when a client route error occurs.",
);
assertIncludes(
  discoverPageSource,
  "instagramPostId",
  "Discover page should carry Instagram post IDs for scraped-post matching.",
);
assertDoesNotInclude(
  discoverPageSource,
  "description: event.description",
  "Discover page should not pass generated event descriptions as post captions.",
);

assertIncludes(
  discoverFeedSource,
  'data-discover-feed="instagram-scroll"',
  "Discover feed should expose a scroll-feed QA marker.",
);
assertIncludes(
  discoverFeedSource,
  'data-discover-post="true"',
  "Discover posts should expose a post QA marker.",
);
assertIncludes(
  discoverFeedSource,
  'data-discover-post-grid="true"',
  "Discover should render posts in a responsive grid on desktop instead of a single phone-width column.",
);
assertIncludes(
  discoverFeedSource,
  "lg:grid-cols-2 2xl:grid-cols-3",
  "Discover desktop layout should show multiple columns while preserving the mobile single-column feed.",
);
assertIncludes(
  discoverFeedSource,
  'data-discover-image-source="event-proxy"',
  "Discover image rendering should mark the first-party event image proxy path.",
);
assertIncludes(
  discoverFeedSource,
  'paragraphProps={{ "data-discover-caption-source": "instagram" }}',
  "Discover captions should identify exact Instagram caption rendering.",
);
assertIncludes(
  discoverFeedSource,
  'data-discover-save-action="true"',
  "Discover posts should include a save action QA marker.",
);
assertIncludes(
  discoverFeedSource,
  "authEnabled ?",
  "Discover save controls should be hidden when Clerk auth is disabled.",
);
assertIncludes(
  discoverFeedSource,
  "SaveEventButton",
  "Discover posts should keep the save/unsave control.",
);
assertIncludes(
  discoverFeedSource,
  'event.imageUrl?.startsWith("/api/discover/images/")',
  "Discover should render first-party image proxy URLs.",
);
assertDoesNotInclude(
  discoverFeedSource,
  "isApifyImageUrl(event.imageUrl)",
  "Discover should never bypass the first-party proxy for direct Apify image URLs.",
);
assertIncludes(
  discoverFeedSource,
  "event.sourceCaption?.trim() || null",
  "Discover caption body should use the exact captured Instagram caption.",
);
assertIncludes(
  discoverFeedSource,
  "ReadMoreText",
  "Discover captions should use the shared two-line read-more component.",
);
assertIncludes(
  discoverFeedSource,
  'moreLabel="more"',
  "Discover captions should expose an Instagram-style more affordance.",
);
assertIncludes(
  readMoreTextSource,
  "WebkitLineClamp: lines",
  "Read-more text should clamp collapsed content to the requested number of rows.",
);
assertIncludes(
  readMoreTextSource,
  "aria-expanded={expanded}",
  "Read-more button should expose expanded state to assistive tech.",
);
assertIncludes(
  readMoreTextSource,
  "absolute bottom-0 right-0",
  "Collapsed read-more affordance should sit inline at the end of the second row.",
);
assertIncludes(
  discoverFeedSource,
  "collapsedButtonClassName=\"bg-[#0d0f16] text-muted-foreground\"",
  "Discover captions should give the inline more button the card background like Instagram.",
);
assertDoesNotInclude(
  discoverFeedSource,
  "event.description",
  "Discover feed should not fall back to generated descriptions for captions.",
);
assertDoesNotInclude(
  discoverFeedSource,
  "cdninstagram",
  "Discover feed should not allow Instagram CDN images.",
);
assertDoesNotInclude(
  discoverFeedSource,
  "fbcdn",
  "Discover feed should not allow Facebook CDN images.",
);

assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-07-11T06:59:00+02:00")),
  "2026-07-10",
  "Before 07:00 Belgrade time, Discover should still default to the previous nightlife date.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-07-11T07:00:00+02:00")),
  "2026-07-11",
  "At 07:00 Belgrade time, Discover should roll over to the calendar date.",
);

function makeDiscoverEvent(id, overrides = {}) {
  return {
    _id: id,
    artists: [],
    date: "2026-07-14",
    eventType: "nightlife",
    status: "approved",
    title: id,
    venue: "Fixture Venue",
    ...overrides,
  };
}

const alignmentEvents = [
  makeDiscoverEvent("missing-ref"),
  makeDiscoverEvent("event-a", {
    instagramHandle: "@Fixture",
    instagramPostId: "post-a",
  }),
  makeDiscoverEvent("event-a-duplicate", {
    instagramHandle: "fixture",
    instagramPostId: "post-a",
    sourceCaption: "Exact event caption",
  }),
  makeDiscoverEvent("event-b", {
    instagramHandle: "fixture",
    instagramPostUrl: "https://www.instagram.com/p/POSTB/?utm_source=test",
  }),
];
const alignmentBatch = buildDiscoverScrapedPostBatch(alignmentEvents);
assert.deepEqual(
  alignmentBatch.postIndexByEvent,
  [null, 0, 0, 1],
  "Null refs and duplicate refs must retain event-to-result alignment.",
);
assert.equal(alignmentBatch.refs.length, 2, "Duplicate Discover refs should be queried only once.");
const alignedEvents = mergeDiscoverScrapedPostBatch(
  alignmentEvents,
  alignmentBatch.postIndexByEvent,
  [
    {
      caption: "Stored caption",
      imageUrl: "https://images.apifyusercontent.com/event-a.jpg",
      instagramPostUrl: "https://www.instagram.com/p/POSTA/",
      postId: "post-a",
    },
    null,
  ],
);
assert.equal(alignedEvents[0].sourceCaption, undefined);
assert.equal(alignedEvents[1].sourceCaption, "Stored caption");
assert.equal(
  alignedEvents[2].sourceCaption,
  "Exact event caption",
  "Exact event captions must win when duplicate events share one scraped-post result.",
);
assert.equal(alignedEvents[3].sourceCaption, undefined);

const boundaryEvents = Array.from({ length: MAX_DISCOVER_SCRAPED_POST_REFS + 1 }, (_, index) =>
  makeDiscoverEvent(`boundary-${index}`, {
    instagramHandle: "fixture",
    instagramPostId: `post-${index}`,
  }),
);
const boundaryBatch = buildDiscoverScrapedPostBatch(boundaryEvents);
assert.equal(boundaryBatch.refs.length, 100, "Discover's client batch must stop at 100 unique refs.");
assert.equal(
  boundaryBatch.postIndexByEvent[100],
  null,
  "The 101st unique ref must remain unenriched instead of shifting result alignment.",
);
const duplicateAfterBoundary = buildDiscoverScrapedPostBatch([
  ...boundaryEvents.slice(0, 100),
  makeDiscoverEvent("duplicate-after-boundary", {
    instagramHandle: "fixture",
    instagramPostId: "post-0",
  }),
]);
assert.equal(duplicateAfterBoundary.refs.length, 100);
assert.equal(
  duplicateAfterBoundary.postIndexByEvent[100],
  0,
  "A duplicate after the 100-ref boundary should reuse the existing batched result.",
);

assertIncludes(
  apifyPostsSource,
  "scrapedPosts:getManyByHandleAndPostRefs",
  "Discover should load matching stored Apify posts through one bounded batch query.",
);
assert.equal(
  (apifyPostsSource.match(/convex\.query\(/g) ?? []).length,
  1,
  "Discover enrichment should make one Convex round-trip per feed, not one per event.",
);
assertIncludes(
  apifyPostAlignmentSource,
  "getDiscoverDisplayImageUrl(event, post)",
  "Discover scraped-post enrichment should use the shared first-party image URL helper.",
);
assertIncludes(
  discoverImageSourceSource,
  "return `/api/discover/images/${encodeURIComponent(event._id)}`;",
  "Discover image helper should expose first-party image proxy URLs.",
);
assertIncludes(
  apifyPostAlignmentSource,
  "normalizeCaption(event.sourceCaption) ?? normalizeCaption(post?.caption)",
  "Discover scraped-post enrichment should preserve exact event captions and backfill exact scraped captions.",
);
assertIncludes(
  scrapedPostsSource,
  "export const getManyByHandleAndPostRefs = query",
  "Convex scrapedPosts should expose one bounded indexed batch lookup for Discover.",
);
assertIncludes(
  scrapedPostsSource,
  "args.refs.length > 100",
  "Discover's public scraped-post batch must have a hard upper bound.",
);
assertIncludes(
  scrapedPostsSource,
  ".withIndex(\"by_handle_postId\"",
  "Scraped-post lookup should use the handle/postId index.",
);
assertIncludes(
  scrapedPostsSource,
  ".withIndex(\"by_handle_postUrl\"",
  "Scraped-post lookup should use the handle/postUrl index.",
);

assertIncludes(
  discoverImageRouteSource,
  "mediaAssets:getPublicEventImageSource",
  "Discover image route should resolve media through the event source identity query.",
);
assertIncludes(
  discoverImageRouteSource,
  'source.kind === "stored"',
  "Discover image route should prefer durable stored media.",
);
assertIncludes(
  discoverImageRouteSource,
  "assertImageResponseHeaders",
  "Discover image route should enforce shared image content-type and content-length guardrails.",
);
assertIncludes(
  discoverImageRouteSource,
  "readImageResponseBodyWithLimit",
  "Discover image route should enforce a streamed byte cap before proxying.",
);
assertIncludes(
  discoverImageRouteSource,
  "\"x-content-type-options\": \"nosniff\"",
  "Discover image route should disable content sniffing.",
);
assertIncludes(
  discoverImageRouteSource,
  "public, max-age=3600, stale-while-revalidate=86400",
  "Discover image route should cache durable first-party image responses.",
);
assertDoesNotInclude(
  nextConfigSource,
  "cdninstagram.com",
  "Next image config should not globally allow Instagram CDN hosts.",
);
assertDoesNotInclude(
  nextConfigSource,
  "fbcdn.net",
  "Next image config should not globally allow Facebook CDN hosts.",
);
assertIncludes(
  nextConfigSource,
  "images.apifyusercontent.com",
  "Next image config should still allow Apify-hosted images.",
);

assert.ok(
  packageJson.scripts["qa:discover-feed"]?.includes("qa-discover-feed.mjs"),
  "package.json should expose qa:discover-feed.",
);
assert.match(
  releaseCheckSource,
  /qa:discover-feed/,
  "Release gate should include Discover feed QA.",
);

console.log("QA passed: Discover feed uses exact Instagram captions, two-line read-more text, Apify images, scroll posts, and save actions.");
