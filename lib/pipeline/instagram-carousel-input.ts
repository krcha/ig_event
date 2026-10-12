import { createHash } from "node:crypto";
import { MAX_CAROUSEL_EXTRACTION_IMAGES, type CarouselImageBinding } from "../ai/carousel-media-contract";
import { toDataUrl } from "../ai/prepare-image-for-openai";
import type { ProcessIngestionPostDependencies } from "./ingestion/contracts";
import type { InstagramScrapedPost } from "../scraper/instagram-scraper";

export type RetainedCarouselImage = CarouselImageBinding & {
  assetId: string;
  storageId: string;
  url: string;
};

export function hasExplicitInstagramCarousel(post: InstagramScrapedPost): boolean {
  return Boolean(post.imageSlides?.length &&
    Math.max(post.imageSlideCount ?? 0, post.imageSlides.length) > 1);
}

/** Download alternatives within each declared slide; never treat resolutions as siblings. */
export async function prepareInstagramCarouselInputs(options: {
  post: InstagramScrapedPost;
  dependencies: Pick<ProcessIngestionPostDependencies, "downloadImage" | "normalizeToJpeg">;
  retain: (binding: CarouselImageBinding) => Promise<RetainedCarouselImage>;
  now?: () => number;
}): Promise<{
  images: RetainedCarouselImage[];
  imageDataUrls: string[];
  failedSlides: Array<{ slideIndex: number; errors: unknown[] }>;
}> {
  const now = options.now ?? Date.now;
  const deadline = now() + 60_000;
  const slides = (options.post.imageSlides ?? []).slice(0, MAX_CAROUSEL_EXTRACTION_IMAGES);
  const results: Array<{ image: RetainedCarouselImage; dataUrl: string } | undefined> = [];
  const failedSlides: Array<{ slideIndex: number; errors: unknown[] }> = [];
  let next = 0;
  let reservedBytes = 0;
  // Base64 stays comfortably below the provider's total image payload limit.
  const maxNormalizedBytes = 24 * 1024 * 1024;
  await Promise.all(Array.from({ length: Math.min(3, slides.length) }, async () => {
    while (next < slides.length) {
      const position = next++;
      const slide = slides[position];
      const errors: unknown[] = [];
      for (const sourceUrl of [...new Set(slide.imageUrls)].slice(0, 8)) {
        if (now() >= deadline) break;
        let reserved = 0;
        let reservationHeld = false;
        try {
          const downloaded = await options.dependencies.downloadImage(sourceUrl,
            { maxAttempts: 1, timeoutMs: Math.min(5_000, Math.max(1, deadline - now())) });
          const normalized = await options.dependencies.normalizeToJpeg(
            downloaded.imageBuffer, downloaded.contentType ?? sourceUrl);
          reserved = normalized.imageBuffer.byteLength;
          if (reservedBytes + reserved > maxNormalizedBytes) {
            throw new Error("Carousel image payload exceeds its bounded input budget.");
          }
          reservedBytes += reserved;
          reservationHeld = true;
          const binding = { slideIndex: slide.index, sourceUrl,
            checksumSha256: createHash("sha256").update(downloaded.imageBuffer).digest("hex") };
          const image = await options.retain(binding);
          if (image.slideIndex !== binding.slideIndex || image.sourceUrl !== binding.sourceUrl ||
            image.checksumSha256 !== binding.checksumSha256 || !image.assetId || !image.storageId || !image.url) {
            throw new Error("Retained carousel image does not match its actual downloaded input.");
          }
          results[position] = { image, dataUrl: toDataUrl(normalized.imageBuffer, normalized.mimeType) };
          break;
        } catch (error) {
          if (reservationHeld) reservedBytes = Math.max(0, reservedBytes - reserved);
          errors.push(error);
        }
      }
      if (!results[position]) failedSlides.push({ slideIndex: slide.index, errors });
    }
  }));
  const completed = results.filter((result): result is NonNullable<typeof result> => Boolean(result));
  return { images: completed.map((result) => result.image),
    imageDataUrls: completed.map((result) => result.dataUrl),
    failedSlides: failedSlides.sort((left, right) => left.slideIndex - right.slideIndex) };
}
