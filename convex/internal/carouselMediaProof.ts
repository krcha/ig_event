import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { parseCarouselMediaBinding } from "../../lib/ai/carousel-media-contract";
import { sha256Hex } from "../../lib/domain/reconciliation/evidence-digest";

export const retainedCarouselImageValidator = v.object({
  slideIndex: v.number(),
  sourceUrl: v.string(),
  checksumSha256: v.string(),
  assetId: v.id("mediaAssets"),
  storageId: v.id("_storage"),
  url: v.string(),
});

export type RetainedCarouselImage = {
  slideIndex: number;
  sourceUrl: string;
  checksumSha256: string;
  assetId: Id<"mediaAssets">;
  storageId: Id<"_storage">;
  url: string;
};

type CarouselInput = Pick<RetainedCarouselImage, "slideIndex" | "sourceUrl" | "checksumSha256">;
type ReadCtx = QueryCtx | MutationCtx;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function jsonObject(value: string | undefined): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value ?? "null"));
  } catch {
    return null;
  }
}

function indexes(value: unknown): number[] | null {
  return Array.isArray(value) && value.length <= 20 &&
    value.every((index) => Number.isSafeInteger(index) && index >= 0 && index < 20) &&
    new Set(value).size === value.length
    ? value as number[] : null;
}

export function hasCarouselAnalysisMarker(
  post: Pick<Doc<"scrapedPosts">, "analysisCarouselImages">,
  candidate: { rawExtractionJson?: string; normalizedFieldsJson?: string },
): boolean {
  if (post.analysisCarouselImages !== undefined) return true;
  // Either independently valid marker protects immutable inputs even when its
  // companion JSON has been damaged. Approval still requires both exact proofs.
  const fields = jsonObject(candidate.normalizedFieldsJson);
  const raw = jsonObject(candidate.rawExtractionJson);
  return fields?.extractionCarouselContractVersion !== undefined || raw?._carouselContractVersion !== undefined ||
    raw?._carouselMedia !== undefined;
}

export function parseCarouselInputs(result: Record<string, unknown>): {
  knownSlideCount: number;
  images: CarouselInput[];
} | null {
  if (result._carouselContractVersion !== "carousel_evidence_v1" ||
    result.extraction_contract_version !== "event_evidence_v2" ||
    result._extractionPolicyVersion !== "event_quality_v1") return null;
  try {
    return parseCarouselMediaBinding(result._carouselMedia);
  } catch {
    return null;
  }
}

export function carouselAssetSourceKey(
  sourceDocumentId: Id<"scrapedPosts">,
  sourceRevision: number,
  slideIndex: number,
  checksumSha256: string,
  sourceUrl: string,
): string {
  return `instagram-carousel:${sourceDocumentId}:r${sourceRevision}:s${slideIndex}:${checksumSha256}:${sha256Hex(sourceUrl)}`;
}

export function carouselInputsMatchRetainedImages(
  inputs: readonly CarouselInput[],
  retained: readonly RetainedCarouselImage[] | undefined,
): boolean {
  return Boolean(retained && retained.length === inputs.length &&
    new Set(retained.map((image) => image.slideIndex)).size === retained.length &&
    inputs.every((image, index) => {
      const receipt = retained[index];
      return receipt && receipt.slideIndex === image.slideIndex && receipt.sourceUrl === image.sourceUrl &&
        receipt.checksumSha256 === image.checksumSha256 && receipt.assetId && receipt.storageId && receipt.url;
    }));
}

export async function hasRetainedCarouselAsset(
  ctx: ReadCtx,
  post: Doc<"scrapedPosts">,
  image: RetainedCarouselImage,
): Promise<boolean> {
  const asset = await ctx.db.get(image.assetId);
  return Boolean(asset &&
    asset.sourceKey === carouselAssetSourceKey(post._id, post.sourceRevision ?? 1, image.slideIndex, image.checksumSha256, image.sourceUrl) &&
    asset.sourceKind === "instagram_post" && asset.carouselSourceDocumentId === post._id &&
    asset.carouselSourceRevision === (post.sourceRevision ?? 1) && asset.carouselSlideIndex === image.slideIndex &&
    asset.carouselSourceUrl === image.sourceUrl && asset.checksumSha256 === image.checksumSha256 &&
    asset.storageId === image.storageId && asset.url === image.url &&
    await ctx.storage.getUrl(asset.storageId) !== null);
}

export async function assertRecordedCarouselMedia(
  ctx: ReadCtx,
  post: Doc<"scrapedPosts">,
  result: Record<string, unknown>,
  retained: readonly RetainedCarouselImage[] | undefined,
): Promise<RetainedCarouselImage[]> {
  const bundle = parseCarouselInputs(result);
  const knownSlideCount = Math.max(post.imageSlideCount ?? 0, post.imageSlides?.length ?? 0);
  if (!bundle || bundle.knownSlideCount !== knownSlideCount ||
    !carouselInputsMatchRetainedImages(bundle.images, retained)) {
    throw new Error("Carousel analysis must match its complete independently retained input bundle.");
  }
  for (const image of retained!) {
    const matches = post.imageSlides?.filter((slide) => slide.index === image.slideIndex) ?? [];
    if (matches.length !== 1 || !matches[0]!.imageUrls.includes(image.sourceUrl)) {
      throw new Error("Carousel analysis image is not independently retained for the exact source revision and provider slide.");
    }
  }
  const verified = await Promise.all(retained!.map((image) => hasRetainedCarouselAsset(ctx, post, image)));
  if (verified.some((value) => !value)) {
    throw new Error("Carousel analysis image is not independently retained for the exact source revision and provider slide.");
  }
  return [...retained!];
}

/** Future carousel proof is independent of the legacy source-wide image. The
 * immutable analysis receipts also survive harmless CDN URL observations. */
export async function hasPersistedCarouselEventMediaProof(
  ctx: ReadCtx,
  post: Doc<"scrapedPosts">,
  candidate: { rawExtractionJson?: string; normalizedFieldsJson?: string; imageUrl?: string; imageStorageId?: Id<"_storage"> },
): Promise<boolean> {
  try {
    if (!candidate.rawExtractionJson || candidate.rawExtractionJson !== post.analysisResultJson ||
      post.analysisRevision !== (post.sourceRevision ?? 1)) return false;
    const result = object(JSON.parse(candidate.rawExtractionJson));
    const fields = object(JSON.parse(candidate.normalizedFieldsJson ?? "null"));
    if (!result || !fields || fields.extractionCarouselContractVersion !== "carousel_evidence_v1") return false;
    const bundle = parseCarouselInputs(result);
    if (!bundle || !carouselInputsMatchRetainedImages(bundle.images, post.analysisCarouselImages)) return false;
    const sourceIndexes = indexes(fields.carouselSourceSlideIndexes);
    const rowIndexes = fields.carouselSourceRowIndexes;
    if (!sourceIndexes || !Array.isArray(rowIndexes) || !rowIndexes.length || rowIndexes.length > 64 ||
      rowIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= 64) ||
      new Set(rowIndexes).size !== rowIndexes.length || !Array.isArray(result.schedule_entries)) return false;
    const rowSlides = new Set<number>();
    for (const rowIndex of rowIndexes) {
      const row = object(result.schedule_entries[rowIndex]);
      const refs = indexes(row?.source_slide_indexes);
      if (!row || !refs || !Array.isArray(row.poster_evidence) || row.poster_evidence.length > 24 ||
        !Array.isArray(row.text_evidence) || row.text_evidence.length > 8) return false;
      for (const ref of refs) rowSlides.add(ref);
      for (const value of row.poster_evidence) {
        const snippet = object(value);
        if (!snippet || !Number.isSafeInteger(snippet.slide_index) || !refs.includes(Number(snippet.slide_index)) ||
          typeof snippet.text !== "string" || snippet.text.length > 200) return false;
      }
      for (const key of ["date_evidence", "time_evidence"]) {
        const evidence = object(row[key]);
        if (!evidence || (evidence.source === "poster"
          ? !Number.isSafeInteger(evidence.slide_index) || !refs.includes(Number(evidence.slide_index))
          : evidence.slide_index !== null)) return false;
      }
    }
    if (sourceIndexes.length !== rowSlides.size || sourceIndexes.some((index) => !rowSlides.has(index)) ||
      sourceIndexes.some((index) => !bundle.images.some((image) => image.slideIndex === index)) ||
      !Number.isSafeInteger(fields.carouselDisplaySlideIndex) ||
      (sourceIndexes.length ? !sourceIndexes.includes(Number(fields.carouselDisplaySlideIndex)) :
        fields.carouselDisplaySlideIndex !== bundle.images[0]!.slideIndex)) return false;
    const retainedProofs = await Promise.all(post.analysisCarouselImages!.map((image) => hasRetainedCarouselAsset(ctx, post, image)));
    if (retainedProofs.some((value) => !value)) return false;
    const display = post.analysisCarouselImages!.find((image) => image.slideIndex === fields.carouselDisplaySlideIndex);
    return Boolean(display && candidate.imageUrl === display.url && candidate.imageStorageId === display.storageId);
  } catch {
    return false;
  }
}
