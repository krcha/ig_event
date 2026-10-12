import { z } from "zod";

export const CAROUSEL_EXTRACTION_CONTRACT_VERSION = "carousel_evidence_v1" as const;
export const MAX_CAROUSEL_EXTRACTION_IMAGES = 20;

const httpImageUrl = z.string().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "Carousel image URLs must be HTTP URLs.");

export const carouselImageBindingSchema = z.object({
  slideIndex: z.number().int().min(0).max(MAX_CAROUSEL_EXTRACTION_IMAGES - 1),
  sourceUrl: httpImageUrl,
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const carouselMediaBindingSchema = z.object({
  version: z.literal(1),
  knownSlideCount: z.number().int().min(2).max(10_000),
  images: z.array(carouselImageBindingSchema).min(1).max(MAX_CAROUSEL_EXTRACTION_IMAGES),
}).superRefine((value, context) => {
  const indexes = new Set<number>();
  let previousIndex = -1;
  for (const [index, image] of value.images.entries()) {
    if (indexes.has(image.slideIndex) || image.slideIndex <= previousIndex ||
      image.slideIndex >= value.knownSlideCount) {
      context.addIssue({ code: "custom", path: ["images", index, "slideIndex"],
        message: "Carousel images must have unique ordered indexes within the declared source." });
    }
    indexes.add(image.slideIndex);
    previousIndex = image.slideIndex;
  }
});

export type CarouselImageBinding = z.infer<typeof carouselImageBindingSchema>;
export type CarouselMediaBinding = z.infer<typeof carouselMediaBindingSchema>;

export function parseCarouselMediaBinding(value: unknown): CarouselMediaBinding {
  return carouselMediaBindingSchema.parse(value);
}
