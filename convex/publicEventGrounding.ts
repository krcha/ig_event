import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  hasCompleteSourceGroundedAutoApproval,
  hasCompleteSourceGroundingAttestation,
  hasEventEvidenceV2AutoApproval,
  hasHumanReviewedLegacySourceAttestation,
  hasTrustedSourceEventAnnouncementAutoApproval,
} from "../lib/events/event-update-precondition";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import { normalizeHandle } from "../lib/pipeline/venue-normalization";

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Reconstruct the public-approval decision from the canonical persisted
 * Instagram post. Event fields and normalized flags are necessary, but never
 * sufficient authority for public visibility.
 */
export async function isCanonicallyGroundedApprovedEvent(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  if (event.status !== "approved") return false;
  const fields = parseObject(event.normalizedFieldsJson);
  if (!fields) return false;
  const machineAuthorized = hasCompleteSourceGroundedAutoApproval(
    event.normalizedFieldsJson,
    {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    },
  );
  const trustedSourceAuthorized = hasTrustedSourceEventAnnouncementAutoApproval(
    event.normalizedFieldsJson,
    {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    },
  );
  const structuredEvidenceAuthorized = hasEventEvidenceV2AutoApproval(
    event.normalizedFieldsJson,
    event,
  );
  const hasHumanReviewMetadata =
    typeof event.reviewedAt === "number" &&
    Number.isFinite(event.reviewedAt) &&
    typeof event.reviewedBy === "string" &&
    Boolean(event.reviewedBy.trim());
  const humanReviewedLegacyAuthorized =
    hasHumanReviewMetadata &&
    event.humanReviewedLegacySourcePolicyVersion ===
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION &&
    typeof event.moderationNote === "string" &&
    event.moderationNote.trim().length >= 20 &&
    hasHumanReviewedLegacySourceAttestation(event.normalizedFieldsJson, event);
  const humanAuthorized =
    hasHumanReviewMetadata &&
    (humanReviewedLegacyAuthorized ||
      hasCompleteSourceGroundingAttestation(event.normalizedFieldsJson, {
        title: event.title,
        date: event.date,
        time: event.time,
        venue: event.venue,
        artists: event.artists,
        imageUrl: event.imageUrl,
        instagramPostId: event.instagramPostId,
        instagramPostUrl: event.instagramPostUrl,
        sourceCaption: event.sourceCaption,
        sourcePostedAt: event.sourcePostedAt,
        venueInstagramHandle: event.venueInstagramHandle,
      }));
  if (
    !machineAuthorized &&
    !trustedSourceAuthorized &&
    !structuredEvidenceAuthorized &&
    !humanAuthorized
  ) {
    return false;
  }

  const sourceHandle = normalizeHandle(
    readString(fields.sourceGroundingInstagramHandle) ??
      event.venueInstagramHandle ??
      "",
  );
  const postId = event.instagramPostId?.trim();
  if (!sourceHandle || !postId) return false;
  const persistedPosts = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .take(2);
  const persistedPost = persistedPosts.length === 1 ? persistedPosts[0] : null;
  if (
    !persistedPost ||
    typeof persistedPost.handle !== "string" ||
    typeof persistedPost.username !== "string" ||
    normalizeHandle(persistedPost.handle) !== sourceHandle ||
    normalizeHandle(persistedPost.username) !== sourceHandle
  ) {
    return false;
  }

  const normalizeSourceCaption = (value: string | undefined) =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
  const persistedCaption = normalizeSourceCaption(persistedPost.caption);
  const persistedUrl = normalizeInstagramPostUrl(persistedPost.instagramPostUrl);
  const eventUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  const groundedUrl = normalizeInstagramPostUrl(
    readString(fields.sourceGroundingInstagramPostUrl) ?? undefined,
  );
  if (
    normalizeSourceCaption(event.sourceCaption) !== persistedCaption ||
    normalizeSourceCaption(readString(fields.sourceGroundingSourceCaption) ?? undefined) !==
      persistedCaption ||
    persistedPost.postId !== postId ||
    readString(fields.sourceGroundingInstagramPostId) !== postId ||
    !persistedUrl ||
    !persistedUrl.startsWith("https://www.instagram.com/") ||
    persistedUrl !== eventUrl ||
    persistedUrl !== groundedUrl ||
    !persistedPost.postedAt ||
    persistedPost.postedAt !== event.sourcePostedAt
  ) {
    return false;
  }

  if (structuredEvidenceAuthorized) {
    const posterAssets =
      fields.extractionMode === "poster"
        ? await ctx.db
            .query("mediaAssets")
            .withIndex("by_sourceKey", (q) =>
              q.eq("sourceKey", `instagram-post:${postId}`),
            )
            .take(2)
        : [];
    const posterAsset = posterAssets.length === 1 ? posterAssets[0] : null;
    return Boolean(
      event.rawExtractionJson &&
        event.rawExtractionJson === persistedPost.analysisResultJson &&
        persistedPost.analysisRevision === (persistedPost.sourceRevision ?? 1) &&
        persistedPost.analysisContractVersion === "event_evidence_v2" &&
        persistedPost.analysisIsEvent === true &&
        persistedPost.analysisModel?.startsWith("gpt-5-mini") &&
        (fields.extractionMode !== "poster" ||
          Boolean(
            persistedPost.analysisImageSourceUrl &&
              persistedPost.analysisImageChecksumSha256 &&
              persistedPost.imageStorageId &&
              posterAsset &&
              posterAsset.storageId === persistedPost.imageStorageId &&
              posterAsset.checksumSha256 === persistedPost.analysisImageChecksumSha256 &&
              ((event.imageUrl === undefined && event.imageStorageId === undefined) ||
                (event.imageUrl === posterAsset.url &&
                  event.imageStorageId === posterAsset.storageId)),
          )),
    );
  }

  if (humanReviewedLegacyAuthorized) {
    return true;
  }

  return isCaptionSourceCoherentWithEvent({
    title: event.title,
    date: event.date,
    time: event.time,
    venue: event.venue,
    artists: event.artists,
    sourceCaption: persistedCaption,
    sourcePostedAt: persistedPost.postedAt,
    instagramPostId: persistedPost.postId,
    instagramPostUrl: persistedPost.instagramPostUrl,
    sourceInstagramHandle: persistedPost.handle,
    venueInstagramHandle: event.venueInstagramHandle,
  });
}
