import type { InstagramImageSlide } from "../scraper/instagram-scraper";

export type InstagramImageCoverage = {
  version: 1;
  knownSlideCount: number;
  analyzedSlideIndexes: number[];
  unanalyzedSlideIndexes: number[];
  complete: boolean;
  manifestKnown: boolean;
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

/** Future wrapper-owned diagnostics alone affect source completion, never old cached evidence. */
export function hasKnownUnanalyzedInstagramSlides(analysis: unknown): boolean {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return false;
  const result = analysis as Record<string, unknown>;
  if (result._extractionPolicyVersion !== "event_quality_v1") return false;
  const coverage = result._imageCoverage as InstagramImageCoverage | undefined;
  return coverage?.version === 1 && coverage.manifestKnown === true && coverage.complete === false &&
    Number.isSafeInteger(coverage.knownSlideCount) && coverage.knownSlideCount > 1 &&
    Array.isArray(coverage.analyzedSlideIndexes) && Array.isArray(coverage.unanalyzedSlideIndexes) &&
    coverage.knownSlideCount > coverage.analyzedSlideIndexes.length;
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
    return hasKnownUnanalyzedInstagramSlides({
      ...result,
      _imageCoverage: buildInstagramImageCoverage(currentObservations,
        analyzedSourceUrl ? [analyzedSourceUrl] : []),
    });
  }
  return hasKnownUnanalyzedInstagramSlides(result);
}
