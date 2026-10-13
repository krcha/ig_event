import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { buildInstagramSourceOccurrenceFingerprint } from "../../lib/domain/occurrences/source-fingerprint";
import { buildFocusedSourceConflictReviewKey, buildFocusedSourceConflictContextFingerprint, buildFocusedSourceConflictReviewSupplement,
  parseFocusedSourceConflictReviewResult, type FocusedSourceConflictReviewContext } from "../../lib/events/focused-source-conflict-review";

type ReadCtx = QueryCtx | MutationCtx;
// Completed artifacts are immutable; share their large snapshot across sibling
// checks in one request. Mutable source/media/fact proofs are always reread.
const completedReviewsByRequest = new WeakMap<ReadCtx, Map<string, Doc<"sourceConflictReviews">>>();
export type FocusedReviewEventFields = Pick<Doc<"events">, "title" | "date" | "venue" | "artists"> &
  Partial<Pick<Doc<"events">, "_id" | "time" | "rawExtractionJson" | "normalizedFieldsJson" | "sourceCaption" | "sourcePostedAt">>;
/** Supplemental image observations are authoritative only through their server ledger. */
export async function hasPersistedFocusedConflictReviewProof(ctx: ReadCtx, event: FocusedReviewEventFields): Promise<boolean> {
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(event.normalizedFieldsJson ?? "{}"); } catch { return false; }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const value = fields.focusedSourceConflictReview;
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (!event._id || marker.eventId !== event._id || marker.policyVersion !== 1 ||
      typeof marker.reviewId !== "string" || typeof marker.reviewKey !== "string" || typeof marker.contextFingerprint !== "string") return false;
  let cache = completedReviewsByRequest.get(ctx);
  if (!cache) { cache = new Map(); completedReviewsByRequest.set(ctx, cache); }
  let review = cache.get(marker.reviewKey) ?? null;
  if (!review) {
    const reviews = await ctx.db.query("sourceConflictReviews").withIndex("by_reviewKey", (q) => q.eq("reviewKey", marker.reviewKey as string)).take(2);
    review = reviews.length === 1 ? reviews[0]! : null;
    if (review?.status === "completed") cache.set(marker.reviewKey, review);
  }
  if (!review || review._id !== marker.reviewId || review.status !== "completed" || review.policyVersion !== 1 ||
      review.requestStartedAt === undefined || !review.resultJson || !review.rawResponseJson) return false;
  try {
    const context = JSON.parse(review.contextJson) as FocusedSourceConflictReviewContext;
    if (buildFocusedSourceConflictReviewKey(context) !== review.reviewKey ||
        buildFocusedSourceConflictContextFingerprint(context) !== marker.contextFingerprint) return false;
    const reviewedEvent = context.events.find((candidate) => candidate.id === event._id);
    if (!reviewedEvent || reviewedEvent.title !== event.title || reviewedEvent.date !== event.date ||
        reviewedEvent.time !== (event.time ?? "") || reviewedEvent.venue !== event.venue ||
        JSON.stringify(reviewedEvent.artists) !== JSON.stringify(event.artists) ||
        reviewedEvent.rawExtractionJson !== event.rawExtractionJson || reviewedEvent.sourceCaption !== (event.sourceCaption ?? "") ||
        (reviewedEvent.sourcePostedAt ?? "") !== (event.sourcePostedAt ?? "")) return false;
    const source = await ctx.db.get(review.sourcePostId);
    if (!source || (source.sourceRevision ?? 1) !== review.sourceRevision || source.analysisRevision !== review.sourceRevision ||
        source.analysisContractVersion !== "event_evidence_v2" || source.analysisResultJson !== context.analysisResultJson ||
        buildInstagramSourceOccurrenceFingerprint(source) !== review.sourceFingerprint ||
        review.sourceFingerprint !== context.sourceFingerprint || (source.caption ?? "") !== context.caption || (source.altText ?? "") !== context.altText ||
        (source.locationName ?? "") !== context.locationName || (source.postedAt ?? "") !== context.postedAt) return false;
    for (const image of context.retainedImages) {
      if (source.analysisCarouselImages?.length) {
        const retained = source.analysisCarouselImages.find((candidate) => candidate.slideIndex === image.slideIndex);
        if (!retained || retained.storageId !== image.storageId || retained.checksumSha256 !== image.checksumSha256 || retained.sourceUrl !== image.sourceUrl) return false;
        const asset = await ctx.db.get(retained.assetId);
        if (!asset || asset.storageId !== retained.storageId || asset.checksumSha256 !== retained.checksumSha256 ||
            asset.carouselSourceDocumentId !== source._id || asset.carouselSourceRevision !== review.sourceRevision ||
            asset.carouselSlideIndex !== retained.slideIndex || asset.carouselSourceUrl !== retained.sourceUrl) return false;
      } else {
        if (image.slideIndex !== 0 || source.imageStorageId !== image.storageId || source.analysisImageChecksumSha256 !== image.checksumSha256 ||
            source.analysisImageSourceUrl !== image.sourceUrl) return false;
        const assets = await ctx.db.query("mediaAssets").withIndex("by_sourceKey", (q) => q.eq("sourceKey", "instagram-post:" + source.postId)).take(2);
        if (assets.length !== 1 || assets[0]!.storageId !== image.storageId || assets[0]!.checksumSha256 !== image.checksumSha256) return false;
      }
    }
    const result = parseFocusedSourceConflictReviewResult(JSON.parse(review.resultJson));
    const supplement = buildFocusedSourceConflictReviewSupplement(context, result, event._id);
    if (!supplement || JSON.stringify(marker.posterTexts) !== JSON.stringify(supplement.posterTexts) ||
        JSON.stringify(marker.captionQuotes) !== JSON.stringify(supplement.captionQuotes)) return false;
    return true;
  } catch { return false; }
}
