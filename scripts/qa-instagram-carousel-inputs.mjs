import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareInstagramCarouselInputs } from "../lib/pipeline/instagram-carousel-input.ts";
import { buildInstagramCarouselImageCoverage, parseCachedInstagramImageCoveragePartial } from "../lib/pipeline/instagram-image-coverage.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const urls = ["https://images.apifyusercontent.com/cover.jpg", "https://images.apifyusercontent.com/second.jpg"];
const post = { imageSlides: [{ index: 0, imageUrls: ["https://images.apifyusercontent.com/missing.jpg", urls[0]] },
  { index: 1, imageUrls: [urls[1]] }], imageSlideCount: 2 };
const original = Buffer.from("original raster bytes");
const converted = Buffer.from("normalized provider raster bytes");
const reads = [];
const retained = [];
const dependencies = {
  downloadImage: async (sourceUrl) => {
    reads.push(sourceUrl);
    if (sourceUrl.includes("missing")) throw new Error("HTTP 404");
    return { imageBuffer: original, contentType: "image/jpeg", sourceUrl };
  },
  normalizeToJpeg: async () => ({ imageBuffer: converted, mimeType: "image/jpeg", wasConverted: true }),
};
const retain = async (image) => {
  retained.push(image);
  return { ...image, assetId: `asset-${image.slideIndex}`, storageId: `storage-${image.slideIndex}`,
    url: `https://storage.example/${image.slideIndex}` };
};
const inputs = await prepareInstagramCarouselInputs({ post, dependencies, retain });
assert.equal(inputs.images.length, 2);
assert.deepEqual(inputs.images.map((image) => image.slideIndex), [0, 1]);
assert.equal(inputs.failedSlides.length, 0);
assert.ok(reads.includes(urls[0]) && reads.includes(urls[1]));
assert.ok(inputs.images.every((image) => image.checksumSha256 === sha(original)));
assert.ok(inputs.imageDataUrls.every((dataUrl) => sha(Buffer.from(dataUrl.split(",")[1], "base64")) === sha(converted)));
assert.equal(buildInstagramCarouselImageCoverage(post, inputs.images).complete, true);

const duplicated = { imageSlides: [{ index: 0, imageUrls: [urls[0]] }, { index: 1, imageUrls: [urls[0]] }], imageSlideCount: 2 };
const repeated = await prepareInstagramCarouselInputs({ post: duplicated, dependencies, retain });
assert.equal(repeated.images.length, 2);
assert.equal(repeated.imageDataUrls.length, 2);
assert.equal(buildInstagramCarouselImageCoverage(duplicated, repeated.images).complete, true);
const videoPost = { ...duplicated, imageSlides: duplicated.imageSlides.map((slide) => ({ ...slide, mediaType: "video" })) };
const videoCoverage = buildInstagramCarouselImageCoverage(videoPost, repeated.images);
assert.equal(videoCoverage.complete, false, "A video thumbnail cannot certify unseen video content.");
assert.deepEqual(videoCoverage.videoSlideIndexes, [0, 1]);

const partial = await prepareInstagramCarouselInputs({ post, dependencies,
  retain: async (image) => { if (image.slideIndex === 1) throw new Error("storage unavailable"); return retain(image); } });
assert.deepEqual(partial.images.map((image) => image.slideIndex), [0]);
assert.deepEqual(partial.failedSlides.map((slide) => slide.slideIndex), [1]);
assert.equal(partial.imageDataUrls.length, 1);
assert.equal(buildInstagramCarouselImageCoverage(post, partial.images).complete, false);

const forged = await prepareInstagramCarouselInputs({ post: duplicated, dependencies,
  retain: async (image) => ({ ...await retain(image), checksumSha256: "f".repeat(64) }) });
assert.equal(forged.images.length, 0);
assert.equal(forged.imageDataUrls.length, 0);
assert.equal(forged.failedSlides.length, 2);

const clipped = { imageSlides: Array.from({ length: 21 }, (_, index) => ({ index, imageUrls: [urls[0]] })), imageSlideCount: 21 };
const capped = await prepareInstagramCarouselInputs({ post: clipped, dependencies, retain });
assert.equal(capped.images.length, 20);
assert.equal(buildInstagramCarouselImageCoverage(clipped, capped.images).complete, false);

const cache = JSON.stringify({ _extractionPolicyVersion: "event_quality_v1", _carouselMedia: { version: 1, knownSlideCount: 2,
  images: inputs.images.map(({ slideIndex, sourceUrl, checksumSha256 }) => ({ slideIndex, sourceUrl, checksumSha256 })) } });
assert.equal(parseCachedInstagramImageCoveragePartial(cache, { imageSlides: post.imageSlides.map((slide) => ({ ...slide,
  imageUrls: [`https://images.apifyusercontent.com/rotated-${slide.index}.jpg`] })), imageSlideCount: 2 }), false);
assert.equal(parseCachedInstagramImageCoveragePartial(cache, { imageSlides: [...post.imageSlides,
  { index: 2, imageUrls: ["https://images.apifyusercontent.com/new.jpg"] }], imageSlideCount: 3 }), true);
assert.equal(parseCachedInstagramImageCoveragePartial(cache, videoPost), true);
console.log("Carousel input QA passed: all slides, alternate URLs, independent checksums, retained-only inputs, repeated images, partial failures, bounds, immutable CDN refresh.");
