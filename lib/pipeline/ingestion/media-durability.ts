import { RemoteMediaHttpError } from "@/lib/ai/prepare-image-for-openai";
import { deduplicateMediaUrls } from "@/lib/pipeline/instagram-ingestion-durability";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { ConvexHttpClient } from "convex/browser";
import type { ExistingEventRecord, HandleSummary, IngestionPostContext, SourceProcessingFence } from "@/lib/pipeline/ingestion/contracts";
import { persistInstagramImageAction } from "@/lib/pipeline/ingestion/convex-bindings";
import { getErrorMessage, logError, logInfo, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { extractShortcodeFromPostUrl } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString, parseJsonRecord } from "@/lib/pipeline/ingestion/values";

export function isPermanentRemoteMediaFailure(error: unknown): boolean {
  if (error instanceof RemoteMediaHttpError) {
    return [403, 404, 410].includes(error.status);
  }
  const marker = /(?:^|\b)REMOTE_MEDIA_HTTP_STATUS=(403|404|410)(?:;|\b)/.exec(
    getErrorMessage(error),
  );
  return marker !== null;
}

export function resolveFailedMediaAttemptPolicy(options: {
  canFallbackToCaptionOnly: boolean;
  errors: unknown[];
}): "caption_fallback" | "terminal_permanent" | "retryable" {
  if (
    options.errors.length > 0 &&
    options.errors.every((error) => isPermanentRemoteMediaFailure(error))
  ) {
    return options.canFallbackToCaptionOnly
      ? "caption_fallback"
      : "terminal_permanent";
  }
  return "retryable";
}

export function getPostContext(handle: string, post: InstagramScrapedPost): IngestionPostContext {
  const sourcePostId = normalizeString(post.postId) || null;
  const instagramUrl = normalizeString(post.instagramPostUrl) || "";
  return {
    handle,
    sourcePostId,
    shortcode: extractShortcodeFromPostUrl(instagramUrl),
    instagramUrl,
  };
}

export function hasDurableMediaEligibleNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    normalizedFields?.normalizedIsValid === true &&
    (normalizedFields.sourceGroundingVerified === true ||
      (normalizedFields.extractionContractVersion === "event_evidence_v2" &&
        normalizedFields.extractionIsEvent === true &&
        normalizedFields.structuredEvidenceVerified === true))
  );
}

export function isExistingEventEligibleForDurableMediaRetry(
  event: Pick<ExistingEventRecord, "imageStorageId" | "normalizedFieldsJson">,
): boolean {
  return (
    !event.imageStorageId &&
    hasDurableMediaEligibleNormalizedFields(parseJsonRecord(event.normalizedFieldsJson))
  );
}

export function existingEventRequiresExactPosterMediaBinding(
  event: Pick<ExistingEventRecord, "normalizedFieldsJson">,
): boolean {
  const normalizedFields = parseJsonRecord(event.normalizedFieldsJson);
  return (
    normalizedFields?.extractionContractVersion === "event_evidence_v2" &&
    normalizedFields.extractionMode === "poster"
  );
}

export async function persistInstagramMediaCandidate(options: {
  client: ConvexHttpClient;
  handle: string;
  post: InstagramScrapedPost;
  processingFence: SourceProcessingFence;
  serviceSecret: string;
  summary: Pick<
    HandleSummary,
    | "errors"
    | "failedImagePersistence"
    | "permanentImagePersistenceFailures"
    | "persistedImages"
  >;
  upstreamUrl: string;
  expectedChecksumSha256?: string;
}): Promise<boolean> {
  try {
    await options.client.action(
      persistInstagramImageAction,
      withServiceSecret(
        {
          postId: options.post.postId,
          instagramPostUrl: options.post.instagramPostUrl,
          processingFence: options.processingFence,
          upstreamUrl: options.upstreamUrl,
          expectedChecksumSha256: options.expectedChecksumSha256,
        },
        options.serviceSecret,
      ),
    );
    options.summary.persistedImages += 1;
    logInfo("ingestion.image.persistence.succeeded", {
      ...getPostContext(options.handle, options.post),
      upstreamUrl: options.upstreamUrl,
    });
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    options.summary.failedImagePersistence += 1;
    if (isPermanentRemoteMediaFailure(error)) {
      options.summary.permanentImagePersistenceFailures =
        (options.summary.permanentImagePersistenceFailures ?? 0) + 1;
    }
    options.summary.errors.push(`Durable image persistence failed: ${message}`);
    logError("ingestion.image.persistence.failed", {
      ...getPostContext(options.handle, options.post),
      upstreamUrl: options.upstreamUrl,
      error: message,
    });
    return false;
  }
}

export async function persistInstagramMediaCandidates(options: {
  client: ConvexHttpClient;
  handle: string;
  post: InstagramScrapedPost;
  processingFence: SourceProcessingFence;
  serviceSecret: string;
  summary: HandleSummary;
  upstreamUrls: string[];
  expectedChecksumSha256?: string;
}): Promise<boolean> {
  const failedBefore = options.summary.failedImagePersistence;
  const permanentFailedBefore = options.summary.permanentImagePersistenceFailures ?? 0;
  const errorsBefore = options.summary.errors.length;
  for (const upstreamUrl of deduplicateMediaUrls(options.upstreamUrls, 8)) {
    if (
      await persistInstagramMediaCandidate({
        client: options.client,
        handle: options.handle,
        post: options.post,
        processingFence: options.processingFence,
        serviceSecret: options.serviceSecret,
        summary: options.summary,
        upstreamUrl,
        expectedChecksumSha256: options.expectedChecksumSha256,
      })
    ) {
      // Candidate failures are diagnostics, not a failed persistence operation,
      // when a later candidate succeeds. Detailed per-candidate logs remain.
      options.summary.failedImagePersistence = failedBefore;
      options.summary.permanentImagePersistenceFailures = permanentFailedBefore;
      options.summary.errors.splice(errorsBefore);
      return true;
    }
  }
  return false;
}
