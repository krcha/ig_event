import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { buildInstagramSourceOccurrenceFingerprint } from "../../lib/domain/occurrences/source-fingerprint";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { isSupportedExtractionModel } from "./extractionModel";

type ReadCtx = QueryCtx | MutationCtx;
export type RetainedReviewImage = {
  slideIndex: number; sourceUrl: string; url: string; checksumSha256: string; storageId: string;
};

export async function loadCurrentSourceConflictInputs(
  ctx: ReadCtx, id: Id<"scrapedPosts">, revision: number,
): Promise<{ source: Doc<"scrapedPosts">; events: Doc<"events">[]; images: RetainedReviewImage[]; fingerprint: string }> {
  const source = await ctx.db.get(id);
  if (!source || (source.sourceRevision ?? 1) !== revision || source.analysisRevision !== revision ||
      source.analysisContractVersion !== "event_evidence_v2" || source.analysisIsEvent !== true ||
      !source.analysisResultJson || !isSupportedExtractionModel(source.analysisModel)) {
    throw new Error("Focused review requires current retained event analysis.");
  }
  const candidates = await ctx.db.query("events").withIndex("by_instagramPostId", (q) => q.eq("instagramPostId", source.postId)).take(51);
  if (candidates.length > 50) throw new Error("Focused review source exceeds its event bound.");
  const fingerprint = buildInstagramSourceOccurrenceFingerprint(source);
  const events = candidates.filter((event) => {
    if (event.status !== "pending" || event.reviewedAt !== undefined || event.reviewedBy !== undefined ||
        event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
        event.rawExtractionJson !== source.analysisResultJson || !event.sourceConflictFields?.length) return false;
    try {
      const fields = JSON.parse(event.normalizedFieldsJson ?? "null");
      if (fields.humanReviewedLegacySourcePolicyVersion !== undefined || fields.humanReviewedStructuredSourcePolicyVersion !== undefined) return false;
      return normalizeHandle(fields.sourceGroundingInstagramHandle ?? "") === normalizeHandle(source.handle) &&
        fields.sourceOccurrenceSourceFingerprint === fingerprint;
    } catch { return false; }
  });
  if (events.length === 0) throw new Error("No current pending source conflicts remain.");
  const images: RetainedReviewImage[] = [];
  if (source.analysisCarouselImages?.length) {
    if (source.analysisCarouselImages.length > 8) throw new Error("Focused review retained-image bound exceeded.");
    for (const retained of source.analysisCarouselImages) {
      const asset = await ctx.db.get(retained.assetId);
      if (!asset || asset.storageId !== retained.storageId || asset.checksumSha256 !== retained.checksumSha256 ||
          asset.carouselSourceDocumentId !== source._id || asset.carouselSourceRevision !== revision ||
          asset.carouselSlideIndex !== retained.slideIndex || asset.carouselSourceUrl !== retained.sourceUrl) {
        throw new Error("Focused review carousel binding is incomplete.");
      }
      const url = await ctx.storage.getUrl(retained.storageId);
      if (!url) throw new Error("Focused review retained image is missing.");
      images.push({ slideIndex: retained.slideIndex, sourceUrl: retained.sourceUrl, url,
        checksumSha256: retained.checksumSha256, storageId: retained.storageId });
    }
  } else if (source.analysisImageSourceUrl && source.analysisImageChecksumSha256 && source.imageStorageId) {
    const assets = await ctx.db.query("mediaAssets").withIndex("by_sourceKey", (q) => q.eq("sourceKey", `instagram-post:${source.postId}`)).take(2);
    const asset = assets.length === 1 ? assets[0] : null;
    if (!asset || asset.storageId !== source.imageStorageId || asset.checksumSha256 !== source.analysisImageChecksumSha256) {
      throw new Error("Focused review poster binding is incomplete.");
    }
    const url = await ctx.storage.getUrl(asset.storageId);
    if (!url) throw new Error("Focused review retained poster is missing.");
    images.push({ slideIndex: 0, sourceUrl: source.analysisImageSourceUrl, url,
      checksumSha256: source.analysisImageChecksumSha256, storageId: source.imageStorageId });
  }
  images.sort((left, right) => left.slideIndex - right.slideIndex);
  return { source, events, images, fingerprint };
}
