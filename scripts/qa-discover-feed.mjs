import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDiscoverImageUrl,
  getDiscoverDisplayImageUrl,
  getDiscoverImageCandidate,
} from "../lib/discover/discover-image-source.ts";
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
const discoverFeedSource = read("components/discover/discover-feed.tsx");
const discoverImageSourceSource = read("lib/discover/discover-image-source.ts");
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
  "/api/discover/images/event123?handle=drugstorebelgrade",
  "Discover image URLs should be first-party and carry the normalized handle.",
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
  'data-discover-image-source="apify-proxy"',
  "Discover image rendering should mark the Apify-backed first-party image path.",
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
assertIncludes(
  discoverFeedSource,
  "isApifyImageUrl(event.imageUrl) ? event.imageUrl : null",
  "Discover should still allow direct Apify-hosted image URLs.",
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

assertIncludes(
  apifyPostsSource,
  "scrapedPosts:getByHandleAndPostRef",
  "Discover should look up matching stored Apify scraped posts by post reference.",
);
assertIncludes(
  apifyPostsSource,
  "getDiscoverDisplayImageUrl(event, post)",
  "Discover scraped-post enrichment should use the shared first-party image URL helper.",
);
assertIncludes(
  discoverImageSourceSource,
  "`/api/discover/images/${encodeURIComponent(event._id)}${query}`",
  "Discover image helper should expose first-party image proxy URLs.",
);
assertIncludes(
  apifyPostsSource,
  "normalizeCaption(event.sourceCaption) ?? normalizeCaption(post?.caption)",
  "Discover scraped-post enrichment should preserve exact event captions and backfill exact scraped captions.",
);
assertIncludes(
  scrapedPostsSource,
  "export const getByHandleAndPostRef = query",
  "Convex scrapedPosts should expose an indexed post-reference lookup for Discover.",
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
  "getDiscoverImageCandidate",
  "Discover image route should resolve only Apify-sourced image candidates.",
);
assertIncludes(
  discoverImageRouteSource,
  "events:getPublicApprovedEvent",
  "Discover image route should load only approved public event records.",
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
  "\"cache-control\": \"public, max-age=3600, stale-while-revalidate=86400\"",
  "Discover image route should cache first-party image responses.",
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
