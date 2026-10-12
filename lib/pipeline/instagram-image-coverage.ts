import type { InstagramImageSlide } from "../scraper/instagram-scraper";
import { carouselMediaBindingSchema, type CarouselImageBinding } from "../ai/carousel-media-contract";

export type InstagramImageCoverage = {
  version: 1;
  knownSlideCount: number;
  analyzedSlideIndexes: number[];
  unanalyzedSlideIndexes: number[];
  complete: boolean;
  manifestKnown: boolean;
  videoSlideIndexes?: number[];
};

type ImageSlideObservations = { imageSlides?: InstagramImageSlide[]; imageSlideCount?: number };

/** Later partial provider responses cannot erase already observed siblings. */
export function mergeInstagramImageSlideObservations(
  existing: ImageSlideObservations | undefined,
  incoming: ImageSlideObservations,
): ImageSlideObservations {
  const prior = existing?.imageSlides ?? [];
  const next = incoming.imageSlides ?? [];
  if (prior.length === 0 && next.length === 0) return {};
  const retainedCount = Math.min(20, Math.max(prior.length, next.length));
  const imageSlides = Array.from({ length: retainedCount }, (_, index) => ({
    index,
    ...((prior[index]?.mediaType === "video" || next[index]?.mediaType === "video")
      ? { mediaType: "video" as const }
      : next[index]?.mediaType !== undefined ? { mediaType: next[index].mediaType }
        : prior[index]?.mediaType !== undefined ? { mediaType: prior[index].mediaType } : {}),
    imageUrls: [...new Set([
      ...(prior[index]?.imageUrls ?? []), ...(next[index]?.imageUrls ?? []),
    ])].slice(0, 8),
  }));
  return {
    imageSlides,
    imageSlideCount: Math.max(existing?.imageSlideCount ?? prior.length,
      incoming.imageSlideCount ?? next.length, retainedCount),
  };
}

export function buildInstagramImageCoverage(
  post: { imageSlides?: InstagramImageSlide[]; imageSlideCount?: number },
  analyzedSourceUrls: readonly string[],
): InstagramImageCoverage {
  const slides = post.imageSlides;
  const manifestKnown = Array.isArray(slides) && slides.length > 0;
  if (!manifestKnown) {
    return {
      version: 1, knownSlideCount: 0, analyzedSlideIndexes: [],
      unanalyzedSlideIndexes: [], complete: false, manifestKnown: false,
    };
  }
  const urls = new Set(analyzedSourceUrls.map((url) => url.trim()));
  const analyzed = new Set<number>();
  // A URL shared by multiple declared slides is ambiguous; do not pretend it
  // attests both independently attendable programs.
  for (const url of urls) {
    const matchingSlides = slides.filter((slide) => slide.imageUrls.includes(url));
    if (matchingSlides.length === 1) analyzed.add(matchingSlides[0].index);
  }
  const knownSlideCount = Math.max(post.imageSlideCount ?? slides.length, slides.length);
  const analyzedSlideIndexes = [...analyzed].sort((left, right) => left - right);
  return {
    version: 1,
    knownSlideCount,
    analyzedSlideIndexes,
    unanalyzedSlideIndexes: slides.filter((slide) => !analyzed.has(slide.index)).map((slide) => slide.index),
    complete: knownSlideCount === analyzedSlideIndexes.length,
    manifestKnown: true,
  };
}

/** Explicit inputs attest declared indexes independently, including repeated slide URLs. */
export function buildInstagramCarouselImageCoverage(
  post: ImageSlideObservations,
  images: readonly CarouselImageBinding[],
): InstagramImageCoverage {
  const slides = post.imageSlides ?? [];
  const analyzedSlideIndexes = images.filter((image) =>
    slides.some((slide) => slide.index === image.slideIndex && slide.imageUrls.includes(image.sourceUrl)))
    .map((image) => image.slideIndex).sort((left, right) => left - right);
  const knownSlideCount = Math.max(post.imageSlideCount ?? slides.length, slides.length);
  const videoSlideIndexes = slides.filter((slide) => slide.mediaType === "video").map((slide) => slide.index);
  return { version: 1, manifestKnown: slides.length > 0, knownSlideCount,
    analyzedSlideIndexes: [...new Set(analyzedSlideIndexes)],
    unanalyzedSlideIndexes: slides.filter((slide) => !analyzedSlideIndexes.includes(slide.index)).map((slide) => slide.index),
    ...(videoSlideIndexes.length > 0 ? { videoSlideIndexes } : {}),
    complete: knownSlideCount > 0 && knownSlideCount === new Set(analyzedSlideIndexes).size && videoSlideIndexes.length === 0 };
}

/** Future wrapper-owned diagnostics alone affect source completion, never old cached evidence. */
export function hasKnownUnanalyzedInstagramSlides(analysis: unknown): boolean {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return false;
  const result = analysis as Record<string, unknown>;
  if (result._extractionPolicyVersion !== "event_quality_v1") return false;
  const coverage = result._imageCoverage as InstagramImageCoverage | undefined;
  return coverage?.version === 1 && coverage.manifestKnown === true && coverage.complete === false &&
    Number.isSafeInteger(coverage.knownSlideCount) && coverage.knownSlideCount > 1 &&
    Array.isArray(coverage.analyzedSlideIndexes) && Array.isArray(coverage.unanalyzedSlideIndexes) &&
    (coverage.knownSlideCount > coverage.analyzedSlideIndexes.length || (coverage.videoSlideIndexes?.length ?? 0) > 0);
}

function readCachedQualityAnalysis(resultJson: string | undefined): Record<string, unknown> | null {
  if (!resultJson) return null;
  try {
    const result = JSON.parse(resultJson) as unknown;
    return result && typeof result === "object" && !Array.isArray(result) &&
      (result as Record<string, unknown>)._extractionPolicyVersion === "event_quality_v1"
      ? result as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function hasCachedExtractionQualityPolicy(resultJson: string | undefined): boolean {
  return readCachedQualityAnalysis(resultJson) !== null;
}

export function parseCachedInstagramImageCoveragePartial(
  resultJson: string | undefined,
  currentObservations?: ImageSlideObservations,
  analyzedSourceUrl?: string,
): boolean {
  const result = readCachedQualityAnalysis(resultJson);
  if (!result) return false;
  if (currentObservations?.imageSlides?.length) {
    const carousel = carouselMediaBindingSchema.safeParse(result._carouselMedia);
    if (carousel.success) {
      // Saved, independently attested inputs remain valid after CDN URL rotation.
      // New indexes still make an old bundle partial; immutable raw bytes stay intact.
      const knownSlideCount = Math.max(currentObservations.imageSlideCount ?? 0,
        currentObservations.imageSlides.length, carousel.data.knownSlideCount);
      const analyzed = new Set(carousel.data.images.map((image) => image.slideIndex));
      return knownSlideCount > analyzed.size || currentObservations.imageSlides.some((slide) => slide.mediaType === "video") ||
        ((result._imageCoverage as InstagramImageCoverage | undefined)?.videoSlideIndexes?.length ?? 0) > 0;
    }
    return hasKnownUnanalyzedInstagramSlides({
      ...result,
      _imageCoverage: buildInstagramImageCoverage(currentObservations,
        analyzedSourceUrl ? [analyzedSourceUrl] : []),
    });
  }
  return hasKnownUnanalyzedInstagramSlides(result);
}
