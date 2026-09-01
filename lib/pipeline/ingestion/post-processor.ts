import { type ExtractedEventData, isOpenAiDefinitiveOutputError, isOpenAiPermanentError, isOpenAiProviderBlockedError, OpenAiProviderBlockedError, parseExtractedEventData } from "@/lib/ai/extract-event-data";
import { EVENT_EXTRACTION_ANALYSIS_PROTOCOL } from "@/lib/ai/openai-analysis-protocol";
import { downloadImage, toDataUrl } from "@/lib/ai/prepare-image-for-openai";
import { getNonExpiringPublicEventImageUrl } from "@/lib/images/public-event-image";
import { deduplicateMediaUrls, getBudgetDayKey, getOpenAiDailyPostLimit, getOpenAiMaxImagesPerPost } from "@/lib/pipeline/instagram-ingestion-durability";
import { resolveInstagramIngestionMediaSelection } from "@/lib/pipeline/instagram-media-selection";
import { buildSourceOccurrenceIdentity, isCompleteSourceOccurrenceReceipt, type SourceOccurrenceReceipt } from "@/lib/pipeline/source-occurrence-planning";
import { normalizeConfidencePayload } from "@/lib/utils/confidence";
import { createHash } from "node:crypto";
import type { ExistingSourceMatch, IngestionStep, PrepareEventResult, ProcessIngestionPostDependencies, ProcessIngestionPostOptions, SourceProcessingFence } from "@/lib/pipeline/ingestion/contracts";
import { getInstagramSourceOccurrenceReceiptQuery, markScrapedPostOpenAiAnalysisAttemptStartedMutation, recordScrapedPostOpenAiAnalysisMutation, recordScrapedPostOpenAiDefinitiveOutputFailureMutation, releaseScrapedPostOpenAiAnalysisAttemptMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import { getPreExtractionSourceDuplicateSkipDecision, hasIncompleteSourceOccurrenceSet, recordSourceDuplicateSkip, shouldReprocessExistingSourcePosts } from "@/lib/pipeline/ingestion/existing-source-policy";
import { existingEventRequiresExactPosterMediaBinding, getPostContext, isExistingEventEligibleForDurableMediaRetry, isPermanentRemoteMediaFailure, persistInstagramMediaCandidates, resolveFailedMediaAttemptPolicy } from "@/lib/pipeline/ingestion/media-durability";
import { listExistingEventsBySourceIdentity } from "@/lib/pipeline/ingestion/occurrence-matching";
import { buildPostTextEvidence, extractPostAltTextEvidence } from "@/lib/pipeline/ingestion/parsing-event-text";
import { DEFAULT_PROCESS_INGESTION_POST_DEPENDENCIES, resolveInstagramSourceExtractionContext } from "@/lib/pipeline/ingestion/post-processing-policy";
import { getErrorMessage, logError, logInfo, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { produceStructuredFactsForInsert } from "@/lib/pipeline/ingestion/structured-facts";
import { bindStructuredFactOccurrenceMetadata } from "@/lib/pipeline/ingestion/structured-fact-occurrence";
import { prepareStructuredFactsForPersistence } from "@/lib/pipeline/ingestion/structured-fact-persistence";
import { persistStructuredFactOccurrences } from "@/lib/pipeline/ingestion/occurrence-persister";
import type { StructuredFactExtractionResult } from "@/lib/pipeline/ingestion/structured-fact-contracts";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

export async function processIngestionPost(
  options: ProcessIngestionPostOptions,
  dependencies: ProcessIngestionPostDependencies = DEFAULT_PROCESS_INGESTION_POST_DEPENDENCIES,
): Promise<void> {
  const {
    client,
    handle,
    post,
    summary,
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle = {},
    canonicalVenueLocationsByHandle = {},
    venueResolverSnapshot,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
    sourceDisplayNamesByHandle = {},
    sourceRolesByHandle = {},
    serviceSecret,
    processingFence,
    cachedAnalysisJson,
    cachedAnalysisContractVersion,
    cachedAnalysisImageSourceUrl,
    cachedAnalysisImageChecksumSha256,
    providerExecution,
    eventDateFilterNow,
  } = options;
  const postContext = getPostContext(handle, post);
  const {
    canonicalVenueName,
    instagramSourceName,
    sourceRole,
  } = resolveInstagramSourceExtractionContext({
    sourceHandle: post.username,
    configuredVenueNamesByHandle,
    sourceDisplayNamesByHandle,
    sourceRolesByHandle,
  });
  const canUseCaptionOnlyExtraction = buildPostTextEvidence(post).length > 0;
  const mediaSelection = resolveInstagramIngestionMediaSelection(post);
  const hasCurrentEventEvidenceCache =
    Boolean(cachedAnalysisJson) && cachedAnalysisContractVersion === "event_evidence_v2";
  const hasCachedPosterUrl = Boolean(normalizeString(cachedAnalysisImageSourceUrl));
  const hasCachedPosterChecksum = Boolean(
    normalizeString(cachedAnalysisImageChecksumSha256),
  );
  if (hasCurrentEventEvidenceCache && hasCachedPosterUrl !== hasCachedPosterChecksum) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(
      "Cached event evidence has an incomplete analyzed-poster binding.",
    );
    return;
  }
  const cachedExtractionMode: "poster" | "caption_only" | null =
    hasCurrentEventEvidenceCache
      ? hasCachedPosterUrl
        ? "poster"
        : "caption_only"
      : null;
  let extractionMode = cachedExtractionMode ?? mediaSelection.extractionMode;
  const durableMediaCandidate = mediaSelection.durableMediaCandidate;
  const durableMediaCandidates = deduplicateMediaUrls(
    [durableMediaCandidate, ...(post.imageUrls ?? []), post.imageUrl],
    8,
  );
  let sourceIdentityMatches: ExistingSourceMatch[] = [];
  let selectedImageUrl =
    cachedExtractionMode === "poster"
      ? normalizeString(cachedAnalysisImageSourceUrl)
      : cachedExtractionMode === "caption_only"
        ? null
        : mediaSelection.selectedImageUrl;
  let selectedImageChecksumSha256: string | null =
    cachedExtractionMode === "poster"
      ? normalizeString(cachedAnalysisImageChecksumSha256).toLocaleLowerCase()
      : null;
  let imageDataUrl: string | null = null;
  const imageDataUrls: string[] = [];
  const durableRecoveryMediaCandidates =
    cachedExtractionMode === "poster" && selectedImageUrl
      ? deduplicateMediaUrls([selectedImageUrl, ...durableMediaCandidates], 16)
      : durableMediaCandidates;
  const durableRecoveryExpectedChecksum =
    cachedExtractionMode === "poster" ? selectedImageChecksumSha256 ?? undefined : undefined;

  try {
    sourceIdentityMatches = await listExistingEventsBySourceIdentity(
      client,
      post,
      serviceSecret,
    );
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.source_duplicate_precheck.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      error: getErrorMessage(error),
    });
    return;
  }

  let recoveringIncompleteSourceOccurrenceSet =
    hasIncompleteSourceOccurrenceSet(sourceIdentityMatches, post);

  let sourceReceipt: SourceOccurrenceReceipt | null = null;
  try {
    const queriedSourceReceipt = await client.query(getInstagramSourceOccurrenceReceiptQuery, {
      sourceIdentity: buildSourceOccurrenceIdentity(post),
      serviceSecret,
    });
    if (
      queriedSourceReceipt &&
      typeof queriedSourceReceipt === "object" &&
      !Array.isArray(queriedSourceReceipt)
    ) {
      sourceReceipt = queriedSourceReceipt as SourceOccurrenceReceipt;
    }
    if (
      isCompleteSourceOccurrenceReceipt(queriedSourceReceipt, post) &&
      !shouldReprocessExistingSourcePosts()
    ) {
      const retryTarget = sourceIdentityMatches.find((match) =>
        isExistingEventEligibleForDurableMediaRetry(match.existingEvent),
      );
      const missingExactPosterBinding =
        retryTarget &&
        existingEventRequiresExactPosterMediaBinding(retryTarget.existingEvent) &&
        !durableRecoveryExpectedChecksum;
      if (missingExactPosterBinding) {
        summary.failedImagePersistence += 1;
        summary.errors.push(
          "Structured poster media repair requires the cached analyzed-image checksum.",
        );
      } else if (retryTarget && durableRecoveryMediaCandidates.length > 0) {
        await persistInstagramMediaCandidates({
          client,
          handle,
          post,
          processingFence,
          summary,
          serviceSecret,
          upstreamUrls: durableRecoveryMediaCandidates,
          expectedChecksumSha256: durableRecoveryExpectedChecksum,
        });
      }
      summary.skippedDuplicates += 1;
      summary.skipped_duplicates += 1;
      summary.skipped_duplicates_clean += 1;
      logInfo("duplicate_source_receipt_precheck_skip", {
        ...postContext,
        extractionMode,
        sourceIdentity: queriedSourceReceipt.sourceIdentity,
        expectedOccurrenceCount: queriedSourceReceipt.expectedKeys.length,
      });
      return;
    }
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.source_receipt_precheck.failed", {
      step: "duplicate_lookup" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      error: getErrorMessage(error),
    });
    return;
  }

  if (sourceReceipt) {
    recoveringIncompleteSourceOccurrenceSet = true;
  }
  const sourceDuplicateSkipDecision = sourceReceipt
    ? null
    : getPreExtractionSourceDuplicateSkipDecision(sourceIdentityMatches, post);

  if (sourceDuplicateSkipDecision) {
    const retryTarget = sourceIdentityMatches.find((match) =>
      isExistingEventEligibleForDurableMediaRetry(match.existingEvent),
    );
    const missingExactPosterBinding =
      retryTarget &&
      existingEventRequiresExactPosterMediaBinding(retryTarget.existingEvent) &&
      !durableRecoveryExpectedChecksum;
    if (missingExactPosterBinding) {
      summary.failedImagePersistence += 1;
      summary.errors.push(
        "Structured poster media repair requires the cached analyzed-image checksum.",
      );
    } else if (retryTarget && durableRecoveryMediaCandidates.length > 0) {
      await persistInstagramMediaCandidates({
        client,
        handle,
        post,
        processingFence,
        summary,
        serviceSecret,
        upstreamUrls: durableRecoveryMediaCandidates,
        expectedChecksumSha256: durableRecoveryExpectedChecksum,
      });
    }
    recordSourceDuplicateSkip(summary, sourceDuplicateSkipDecision);
    logInfo("duplicate_source_precheck_skip", {
      ...postContext,
      extractionMode,
      matchedBy: sourceDuplicateSkipDecision.match.matchedBy,
      matchedValue: sourceDuplicateSkipDecision.match.matchedValue,
      existingEventId: sourceDuplicateSkipDecision.match.existingEvent._id,
      existingStatus: sourceDuplicateSkipDecision.match.existingEvent.status,
      reason: sourceDuplicateSkipDecision.reason,
      reprocessExistingSourcePosts: shouldReprocessExistingSourcePosts(),
      qualityReasons: sourceDuplicateSkipDecision.quality.reasons,
      qualityDetails: sourceDuplicateSkipDecision.quality.details,
    });
    return;
  }

  if (cachedExtractionMode === "poster") {
    const currentImageUrls = deduplicateMediaUrls(
      [...(post.imageUrls ?? []), post.imageUrl],
      16,
    );
    if (!selectedImageUrl || !selectedImageChecksumSha256) {
      summary.failedExtractions += 1;
      summary.failed_extractions += 1;
      summary.failed_extraction += 1;
      summary.errors.push(
        "Cached poster analysis is missing its exact source URL/checksum binding.",
      );
      return;
    }
    logInfo("ingestion.openai.cached_poster_binding", {
      ...postContext,
      extractionMode,
      selectedImageUrl,
      sourceUrlStillAdvertised: currentImageUrls.includes(selectedImageUrl),
    });
  } else if (extractionMode === "caption_only") {
    if (!canUseCaptionOnlyExtraction) {
      summary.skipped_video += 1;
      logInfo("ingestion.post.skipped_video", {
        ...postContext,
        reason: "missing_text_evidence",
      });
      return;
    }
    logInfo("ingestion.post.video_caption_only", {
      ...postContext,
      captionLength: normalizeString(post.caption).length,
      hasAltText: extractPostAltTextEvidence(post.altText).length > 0,
      selectedImageUrl,
      durableMediaCandidate,
    });
  } else {
    if (!selectedImageUrl) {
      summary.skippedNoImage += 1;
      logInfo("ingestion.image.skipped_no_image", {
        ...postContext,
        imageCandidates: post.imageUrls ?? [],
      });
      return;
    }

    logInfo("ingestion.image.selected", {
      ...postContext,
      selectedImageUrl,
      isInstagramOrFbCdn:
        getNonExpiringPublicEventImageUrl(selectedImageUrl) === undefined,
    });

    const relevantImageUrls = deduplicateMediaUrls(
      [selectedImageUrl, ...(post.imageUrls ?? []), post.imageUrl],
      getOpenAiMaxImagesPerPost(),
    );
    const failedDownloadsBefore = summary.failedDownloads;
    const failedDownloadsSnakeBefore = summary.failed_downloads;
    const permanentDownloadsBefore = summary.permanentMediaDownloadFailures ?? 0;
    const failedConversionsBefore = summary.failedConversions;
    const failedConversionsSnakeBefore = summary.failed_conversions;
    const mediaErrorsBefore = summary.errors.length;
    const mediaAttemptErrors: unknown[] = [];
    for (const candidateImageUrl of relevantImageUrls) {
      let downloadedImage: Awaited<ReturnType<typeof downloadImage>>;
      try {
        downloadedImage = await dependencies.downloadImage(candidateImageUrl);
        logInfo("ingestion.image.download.success", {
          ...postContext,
          selectedImageUrl: candidateImageUrl,
          contentType: downloadedImage.contentType,
          downloadedBytes: downloadedImage.imageBuffer.byteLength,
        });
      } catch (error) {
        summary.failedDownloads += 1;
        summary.failed_downloads += 1;
        if (isPermanentRemoteMediaFailure(error)) {
          summary.permanentMediaDownloadFailures =
            (summary.permanentMediaDownloadFailures ?? 0) + 1;
        }
        mediaAttemptErrors.push(error);
        summary.errors.push(getErrorMessage(error));
        logError("ingestion.image.download.failed", {
          ...postContext,
          selectedImageUrl: candidateImageUrl,
          permanentFailure: isPermanentRemoteMediaFailure(error),
          error: getErrorMessage(error),
        });
        continue;
      }

      try {
        const normalizedImage = await dependencies.normalizeToJpeg(
          downloadedImage.imageBuffer,
          downloadedImage.contentType ?? candidateImageUrl,
        );
        imageDataUrls.push(toDataUrl(normalizedImage.imageBuffer, normalizedImage.mimeType));
        if (imageDataUrls.length === 1) {
          selectedImageUrl = candidateImageUrl;
          selectedImageChecksumSha256 = createHash("sha256")
            .update(downloadedImage.imageBuffer)
            .digest("hex");
        }
        logInfo("ingestion.image.conversion.success", {
          ...postContext,
          selectedImageUrl: candidateImageUrl,
          wasConverted: normalizedImage.wasConverted,
          outputMimeType: normalizedImage.mimeType,
          outputBytes: normalizedImage.imageBuffer.byteLength,
        });
        // The durable analysis attestation currently binds exactly one source
        // URL and checksum. Send only that successfully decoded image so the
        // model cannot rely on an unpersisted carousel sibling.
        break;
      } catch (error) {
        summary.failedConversions += 1;
        summary.failed_conversions += 1;
        mediaAttemptErrors.push(error);
        summary.errors.push(getErrorMessage(error));
        logError("ingestion.image.conversion.failed", {
          ...postContext,
          selectedImageUrl: candidateImageUrl,
          error: getErrorMessage(error),
        });
      }
    }

    if (imageDataUrls.length > 0) {
      // A candidate set succeeds as an operation when any candidate is usable.
      // Keep failed-candidate details in structured logs, not retry counters.
      summary.failedDownloads = failedDownloadsBefore;
      summary.failed_downloads = failedDownloadsSnakeBefore;
      summary.permanentMediaDownloadFailures = permanentDownloadsBefore;
      summary.failedConversions = failedConversionsBefore;
      summary.failed_conversions = failedConversionsSnakeBefore;
      summary.errors.splice(mediaErrorsBefore);
    }

    if (imageDataUrls.length === 0) {
      const failedMediaPolicy = resolveFailedMediaAttemptPolicy({
        canFallbackToCaptionOnly: canUseCaptionOnlyExtraction,
        errors: mediaAttemptErrors,
      });
      if (failedMediaPolicy === "terminal_permanent") {
        summary.terminalPermanentExtractionFailures =
          (summary.terminalPermanentExtractionFailures ?? 0) + 1;
        logInfo("ingestion.image.exhausted_permanent_candidates", postContext);
        return;
      }
      if (failedMediaPolicy === "retryable") {
        return;
      }
      extractionMode = "caption_only";
      selectedImageUrl = null;
      logInfo("ingestion.image.caption_fallback", {
        ...postContext,
        failedCandidateCount: mediaAttemptErrors.length,
      });
    }
    imageDataUrl = imageDataUrls[0] ?? null;
  }

  let extracted: ExtractedEventData;
  let cachedExtracted: ExtractedEventData | null = null;
  if (cachedAnalysisJson) {
    try {
      cachedExtracted = normalizeConfidencePayload(
        parseExtractedEventData(JSON.parse(cachedAnalysisJson)),
      );
    } catch (error) {
      logError("ingestion.openai.cached_analysis_invalid", {
        step: "extract_event" satisfies IngestionStep,
        ...postContext,
        extractionMode,
        error: getErrorMessage(error),
      });
    }
  }
  if (cachedExtracted) {
    extracted = cachedExtracted;
  } else {
    let providerLeaseHeld = false;
    let providerBlockPersisted = false;
    let analysisAttemptRecorded = false;
    let transportStarted = false;
    try {
    if (providerExecution) {
      const claim = await providerExecution.claim();
      if (!claim.claimed) {
        if (claim.reason === "provider_blocked") {
          throw new OpenAiProviderBlockedError(
            claim.blockedStatus ?? 429,
            `OpenAI provider circuit is blocked${claim.blockedCode ? ` (${claim.blockedCode})` : ""}.`,
          );
        }
        throw new Error(
          claim.reason === "busy"
            ? "OpenAI provider execution lease is busy; retry this saved post later."
            : "OpenAI provider execution lease could not be acquired.",
        );
      }
      providerLeaseHeld = true;
    }
    extracted = await dependencies.extractEventDataFromPost({
      imageDataUrl,
      imageDataUrls,
      caption: post.caption,
      altText: post.altText,
      instagramPostUrl: post.instagramPostUrl,
      sourceImageUrl: selectedImageUrl,
      instagramHandle: post.username,
      instagramPostTimestamp: post.postedAt,
      instagramLocationName: post.locationName,
      canonicalVenueName,
      instagramSourceRole: sourceRole,
      instagramSourceName,
      extractionMode,
      ...(providerExecution
        ? {
            beforeTransport: async () => {
              const marker = await client.mutation(
                markScrapedPostOpenAiAnalysisAttemptStartedMutation,
                withServiceSecret(
                  {
                    handle: processingFence.handle,
                    scrapedPostId: processingFence.scrapedPostId,
                    postId: processingFence.postId,
                    instagramPostUrl: processingFence.instagramPostUrl,
                    owner: processingFence.owner,
                    sourceRevision: processingFence.sourceRevision,
                    protocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
                    budgetDayKey: getBudgetDayKey(),
                    dailyRequestLimit: getOpenAiDailyPostLimit(),
                  },
                  serviceSecret,
                ),
              );
              if (!marker.recorded) {
                throw new Error(`OpenAI analysis attempt was not started (${marker.reason}).`);
              }
              analysisAttemptRecorded = true;
            },
            onTransportStarted: () => {
              // Recovery callers enforce their transport ceiling here. Run
              // that guard before marking the transport as started so a
              // rejected fourth call is durably released as definitely unsent.
              options.onOpenAiTransportStarted?.();
              transportStarted = true;
            },
          }
        : {}),
    });
    extracted = normalizeConfidencePayload(extracted);
    if (providerExecution) {
      await client.mutation(
        recordScrapedPostOpenAiAnalysisMutation,
        withServiceSecret(
          {
            handle: processingFence.handle,
            scrapedPostId: processingFence.scrapedPostId,
            postId: processingFence.postId,
            instagramPostUrl: processingFence.instagramPostUrl,
            owner: processingFence.owner,
            sourceRevision: processingFence.sourceRevision,
            resultJson: JSON.stringify(extracted),
            imageSourceUrl: selectedImageUrl ?? undefined,
            imageChecksumSha256: selectedImageChecksumSha256 ?? undefined,
            model: extracted._openaiUsage?.model,
            inputTokens: extracted._openaiUsage?.inputTokens,
            outputTokens: extracted._openaiUsage?.outputTokens,
            reasoningTokens: extracted._openaiUsage?.reasoningTokens,
            totalTokens: extracted._openaiUsage?.totalTokens,
          },
          serviceSecret,
        ),
      );
    }
  } catch (error) {
    if (providerLeaseHeld && providerExecution && isOpenAiProviderBlockedError(error)) {
      await providerExecution.block(error.status, `http_${error.status}`);
      providerBlockPersisted = true;
    }
    if (analysisAttemptRecorded && isOpenAiDefinitiveOutputError(error)) {
      if (!processingFence.scrapedPostId) {
        throw new Error(
          "Definitive OpenAI output failure has no exact saved-post identity for durable attestation.",
        );
      }
      try {
        await client.mutation(
          recordScrapedPostOpenAiDefinitiveOutputFailureMutation,
          withServiceSecret(
            {
              handle: processingFence.handle,
              scrapedPostId: processingFence.scrapedPostId,
              postId: processingFence.postId,
              instagramPostUrl: processingFence.instagramPostUrl,
              owner: processingFence.owner,
              sourceRevision: processingFence.sourceRevision,
              attemptProtocol: EVENT_EXTRACTION_ANALYSIS_PROTOCOL,
              failureKind: error.kind,
              message: error.message,
              model: error.model,
              ...(error.inputTokens === undefined
                ? {}
                : { inputTokens: error.inputTokens }),
              ...(error.outputTokens === undefined
                ? {}
                : { outputTokens: error.outputTokens }),
              ...(error.reasoningTokens === undefined
                ? {}
                : { reasoningTokens: error.reasoningTokens }),
              ...(error.totalTokens === undefined
                ? {}
                : { totalTokens: error.totalTokens }),
            },
            serviceSecret,
          ),
        );
      } catch (attestationError) {
        throw new Error(
          `Definitive OpenAI output failure attestation did not complete: ${getErrorMessage(attestationError)}`,
        );
      }
    }
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    if (isOpenAiPermanentError(error)) {
      summary.terminalPermanentExtractionFailures =
        (summary.terminalPermanentExtractionFailures ?? 0) + 1;
    }
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.openai.extraction.failed", {
      step: "extract_event" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      sourceImageUrl: selectedImageUrl,
      providerBlocked: isOpenAiProviderBlockedError(error),
      permanentFailure: isOpenAiPermanentError(error),
      definitiveOutputFailure: isOpenAiDefinitiveOutputError(error),
      definitiveOutputFailureKind: isOpenAiDefinitiveOutputError(error)
        ? error.kind
        : undefined,
      error: getErrorMessage(error),
    });
    if (isOpenAiProviderBlockedError(error)) {
      throw error;
    }
    return;
  } finally {
    if (analysisAttemptRecorded && !transportStarted) {
      try {
        await client.mutation(
          releaseScrapedPostOpenAiAnalysisAttemptMutation,
          withServiceSecret(
            {
              handle: processingFence.handle,
              scrapedPostId: processingFence.scrapedPostId,
              postId: processingFence.postId,
              instagramPostUrl: processingFence.instagramPostUrl,
              owner: processingFence.owner,
              sourceRevision: processingFence.sourceRevision,
            },
            serviceSecret,
          ),
        );
      } catch (releaseError) {
        summary.errors.push(
          `OpenAI definitely-unsent attempt release failed: ${getErrorMessage(releaseError)}`,
        );
      }
    }
    if (providerLeaseHeld && providerExecution && !providerBlockPersisted) {
      try {
        await providerExecution.release();
      } catch (releaseError) {
        summary.errors.push(`OpenAI provider lease release failed: ${getErrorMessage(releaseError)}`);
      }
    }
  }
  }

  let analyzedPosterPersisted = false;
  if (providerExecution && extracted.is_event && selectedImageUrl && selectedImageChecksumSha256) {
    analyzedPosterPersisted = await persistInstagramMediaCandidates({
      client,
      handle,
      post,
      processingFence,
      summary,
      serviceSecret,
      upstreamUrls:
        cachedExtractionMode === "poster"
          ? deduplicateMediaUrls(
              [selectedImageUrl, ...(post.imageUrls ?? []), post.imageUrl],
              16,
            )
          : [selectedImageUrl],
      expectedChecksumSha256: selectedImageChecksumSha256,
    });
  }

  let preparedResults: PrepareEventResult[];
  let structuredFacts: StructuredFactExtractionResult[];
  try {
    structuredFacts = bindStructuredFactOccurrenceMetadata(
      post,
      produceStructuredFactsForInsert(
        post,
        extracted,
        selectedImageUrl,
        canonicalVenueNamesByHandle,
        venueNameOverridesByHandle,
        configuredVenueNamesByHandle,
        {
          sourceRolesByHandle,
          eventDateFilterNow,
          canonicalVenueAliasesByHandle,
          canonicalVenueLocationsByHandle,
          venueResolverSnapshot,
        },
      ),
    );
    preparedResults = prepareStructuredFactsForPersistence(structuredFacts);
  } catch (error) {
    summary.failedExtractions += 1;
    summary.failed_extractions += 1;
    summary.failed_extraction += 1;
    summary.errors.push(getErrorMessage(error));
    logError("ingestion.normalization.failed", {
      step: "normalize_posts" satisfies IngestionStep,
      ...postContext,
      extractionMode,
      selectedImageUrl,
      error: getErrorMessage(error),
    });
    return;
  }

  await persistStructuredFactOccurrences({
    analyzedPosterPersisted,
    client,
    durableMediaCandidates,
    existingSourceMatches: sourceIdentityMatches,
    extracted,
    extractionMode,
    handle,
    post,
    postContext,
    preparedResults,
    processingFence,
    recoveringIncompleteSourceOccurrenceSet,
    selectedImageChecksumSha256,
    selectedImageUrl,
    serviceSecret,
    sourceReceipt,
    structuredFacts,
    summary,
  });
}

export async function processIngestionPostWithExtractionForTesting(
  options: Omit<ProcessIngestionPostOptions, "processingFence"> & {
    dependencies?: Partial<Omit<ProcessIngestionPostDependencies, "extractEventDataFromPost">>;
    extracted: ExtractedEventData;
    processingFence?: SourceProcessingFence;
  },
): Promise<void> {
  const { dependencies, extracted, processingFence, ...processOptions } = options;
  const effectiveProcessingFence = processingFence ?? {
    handle: options.handle,
    ...(options.post.postId ? { postId: options.post.postId } : {}),
    ...(options.post.instagramPostUrl
      ? { instagramPostUrl: options.post.instagramPostUrl }
      : {}),
    owner: "qa-processing-owner",
    sourceRevision: 1,
  };
  await processIngestionPost(
    { ...processOptions, processingFence: effectiveProcessingFence },
    {
      ...DEFAULT_PROCESS_INGESTION_POST_DEPENDENCIES,
      ...dependencies,
      extractEventDataFromPost: async () => extracted,
    },
  );
}
