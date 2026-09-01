import { isOpenAiProviderBlockedError } from "@/lib/ai/extract-event-data";
import { getBudgetDayKey, getOpenAiCircuitCooldownMs, getOpenAiDailyPostLimit } from "@/lib/pipeline/instagram-ingestion-durability";
import type { IngestionStep, ProcessLoadedPostsForHandleOptions, ProviderExecutionControl, SourceOccurrenceReceiptState, SourceProcessingFence } from "@/lib/pipeline/ingestion/contracts";
import { blockProviderMutation, claimProviderLeaseMutation, claimScrapedPostProcessingMutation, recordScrapedPostProcessingResultMutation, releaseProviderLeaseMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import { getCurrentSourceOccurrenceReceiptState } from "@/lib/pipeline/ingestion/existing-source-policy";
import { getPostContext } from "@/lib/pipeline/ingestion/media-durability";
import { processIngestionPost } from "@/lib/pipeline/ingestion/post-processor";
import { classifySavedPostCompletionForTesting, getRetryableProcessingFailureCount, getTerminalNoEventSkipCount } from "@/lib/pipeline/ingestion/reporting";
import { getErrorMessage, logError, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { getSourceIdentityKey, normalizeScrapedPost } from "@/lib/pipeline/ingestion/source-documents";

export async function processLoadedPostsForHandle(
  options: ProcessLoadedPostsForHandleOptions,
): Promise<void> {
  const {
    client,
    handle,
    posts,
    summary,
    seenSourceKeys,
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    canonicalVenueLocationsByHandle,
    venueResolverSnapshot,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
    sourceDisplayNamesByHandle,
    sourceRolesByHandle,
    serviceSecret,
    workOwner,
    scrapedPostId,
    expectedSourceRevision,
    onOpenAiTransportStarted,
  } = options;

  for (const rawPost of posts) {
    let post = rawPost;

    const claim = (await client.mutation(
      claimScrapedPostProcessingMutation,
      withServiceSecret(
        {
          handle,
          ...(scrapedPostId ? { scrapedPostId } : {}),
          postId: rawPost.postId || undefined,
          instagramPostUrl: rawPost.instagramPostUrl || undefined,
          owner: workOwner,
          leaseMs: 15 * 60_000,
          ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }),
        },
        serviceSecret,
      ),
    )) as {
      claimed?: boolean;
      reason?: string;
      sourceRevision?: number;
      analysisResultJson?: string;
      analysisContractVersion?: string;
      analysisImageSourceUrl?: string;
      analysisImageChecksumSha256?: string;
    };
    if (!claim.claimed) {
      if (claim.reason === "analysis_attempt_ambiguous") {
        summary.failedExtractions += 1;
        summary.failed_extractions += 1;
        summary.failed_extraction += 1;
        summary.errors.push(
          `OpenAI transport outcome is ambiguous for ${rawPost.postId ?? rawPost.instagramPostUrl}; automatic replay is blocked.`,
        );
      } else if (claim.reason === "busy" || claim.reason === "deferred") {
        // The post is durably saved, but its current AI worker owns a valid
        // lease. Surface this to the durable controller so it retries saved
        // processing instead of falsely completing the paid-fetch receipt.
        summary.errors.push(
          `Saved post processing is ${claim.reason}; retry this saved post later.`,
        );
      } else if (claim.reason === "source_revision_mismatch") {
        summary.errors.push(
          "Durable saved-post source revision changed before processing; exact recovery is required.",
        );
      }
      continue;
    }
    const processingFence: SourceProcessingFence = {
      handle,
      ...(scrapedPostId ? { scrapedPostId } : {}),
      ...(rawPost.postId ? { postId: rawPost.postId } : {}),
      ...(rawPost.instagramPostUrl
        ? { instagramPostUrl: rawPost.instagramPostUrl }
        : {}),
      owner: workOwner,
      sourceRevision: claim.sourceRevision ?? 1,
    };
    const providerLeaseOwner = `${workOwner}:openai:${handle}:${rawPost.postId ?? rawPost.instagramPostUrl}`.slice(
      0,
      200,
    );
    const providerExecution: ProviderExecutionControl = {
      claim: async () =>
        (await client.mutation(
          claimProviderLeaseMutation,
          withServiceSecret(
            {
              provider: "openai",
              owner: providerLeaseOwner,
              leaseMs: 5 * 60_000,
              budgetDayKey: getBudgetDayKey(),
              dailyRequestLimit: getOpenAiDailyPostLimit(),
            },
            serviceSecret,
          ),
        )) as Awaited<ReturnType<ProviderExecutionControl["claim"]>>,
      block: async (status, code) => {
        await client.mutation(
          blockProviderMutation,
          withServiceSecret(
            {
              provider: "openai",
              owner: providerLeaseOwner,
              status,
              cooldownMs: getOpenAiCircuitCooldownMs(),
              ...(code ? { code } : {}),
            },
            serviceSecret,
          ),
        );
      },
      release: async () => {
        await client.mutation(
          releaseProviderLeaseMutation,
          withServiceSecret(
            { provider: "openai", owner: providerLeaseOwner },
            serviceSecret,
          ),
        );
      },
    };

    try {
      post = normalizeScrapedPost(post);
    } catch (error) {
      summary.errors.push(getErrorMessage(error));
      logError("ingestion.post.normalize.failed", {
        step: "normalize_posts" satisfies IngestionStep,
        ...getPostContext(handle, post),
        error: getErrorMessage(error),
      });
      await client.mutation(
        recordScrapedPostProcessingResultMutation,
        withServiceSecret(
          {
            handle,
            scrapedPostId: processingFence.scrapedPostId,
            postId: rawPost.postId || undefined,
            instagramPostUrl: rawPost.instagramPostUrl || undefined,
            status: "retryable_failure",
            outcome: "normalization_failed",
            error: getErrorMessage(error),
            owner: workOwner,
            sourceRevision: processingFence.sourceRevision,
          },
          serviceSecret,
        ),
      );
      continue;
    }

    const sourceKey = getSourceIdentityKey(post);
    if (sourceKey && seenSourceKeys.includes(sourceKey)) {
      let duplicateReceiptState: "absent" | "complete" | "incomplete" = "absent";
      try {
        duplicateReceiptState = await getCurrentSourceOccurrenceReceiptState(
          client,
          post,
          serviceSecret,
        );
      } catch (error) {
        summary.errors.push(getErrorMessage(error));
      }
      const duplicateIsComplete = duplicateReceiptState === "complete";
      await client.mutation(
        recordScrapedPostProcessingResultMutation,
        withServiceSecret(
          {
            handle,
            scrapedPostId: processingFence.scrapedPostId,
            postId: rawPost.postId || undefined,
            instagramPostUrl: rawPost.instagramPostUrl || undefined,
            status: duplicateIsComplete ? "completed" : "retryable_failure",
            outcome: duplicateIsComplete
              ? "receipt_complete"
              : "duplicate_source_receipt_incomplete",
            ...(!duplicateIsComplete
              ? { error: "Duplicate source identity does not yet have a complete receipt." }
              : {}),
            owner: workOwner,
            sourceRevision: processingFence.sourceRevision,
          },
          serviceSecret,
        ),
      );
      continue;
    }

    const retryableFailureCountBefore = getRetryableProcessingFailureCount(summary);
    const terminalNoEventSkipCountBefore = getTerminalNoEventSkipCount(summary);
    const terminalPermanentFailureCountBefore =
      summary.terminalPermanentExtractionFailures ?? 0;
    const eventActivityCountBefore =
      summary.insertedEvents + summary.skippedDuplicates + summary.updated_duplicates_bad_data;
    try {
      await processIngestionPost({
        client,
        handle,
        post,
        summary,
        canonicalVenueNamesByHandle,
        canonicalVenueAliasesByHandle,
        canonicalVenueLocationsByHandle,
        venueResolverSnapshot,
        venueNameOverridesByHandle,
        configuredVenueNamesByHandle,
        sourceDisplayNamesByHandle,
        sourceRolesByHandle,
        serviceSecret,
        processingFence,
        cachedAnalysisJson: claim.analysisResultJson,
        cachedAnalysisContractVersion: claim.analysisContractVersion,
        cachedAnalysisImageSourceUrl: claim.analysisImageSourceUrl,
        cachedAnalysisImageChecksumSha256: claim.analysisImageChecksumSha256,
        providerExecution,
        onOpenAiTransportStarted,
      });
    } catch (error) {
      await client.mutation(
        recordScrapedPostProcessingResultMutation,
        withServiceSecret(
          {
            handle,
            scrapedPostId: processingFence.scrapedPostId,
            postId: post.postId || undefined,
            instagramPostUrl: post.instagramPostUrl || undefined,
            status: "retryable_failure",
            outcome: isOpenAiProviderBlockedError(error)
              ? "provider_blocked"
              : "processing_exception",
            error: getErrorMessage(error),
            owner: workOwner,
            sourceRevision: processingFence.sourceRevision,
          },
          serviceSecret,
        ),
      );
      throw error;
    }

    const retryableFailureCountAfter = getRetryableProcessingFailureCount(summary);
    const hasTerminalPermanentFailure =
      (summary.terminalPermanentExtractionFailures ?? 0) > terminalPermanentFailureCountBefore;
    const hasProcessingFailure =
      !hasTerminalPermanentFailure &&
      retryableFailureCountAfter > retryableFailureCountBefore;
    let receiptState: SourceOccurrenceReceiptState = "absent";
    let receiptInspectionFailed = false;
    try {
      receiptState = await getCurrentSourceOccurrenceReceiptState(client, post, serviceSecret);
    } catch (error) {
      receiptInspectionFailed = true;
      summary.errors.push(getErrorMessage(error));
    }
    const eventActivityCountAfter =
      summary.insertedEvents + summary.skippedDuplicates + summary.updated_duplicates_bad_data;
    const {
      hasTerminalNoEventOutcome,
      hasMissingReceiptAfterEvent,
      hasRetryableFailure,
    } = classifySavedPostCompletionForTesting({
      hasTerminalPermanentFailure,
      hasProcessingFailure,
      receiptInspectionFailed,
      receiptState,
      eventActivityCountBefore,
      eventActivityCountAfter,
      terminalNoEventSkipCountBefore,
      terminalNoEventSkipCountAfter: getTerminalNoEventSkipCount(summary),
    });
    await client.mutation(
      recordScrapedPostProcessingResultMutation,
      withServiceSecret(
        {
          handle,
          scrapedPostId: processingFence.scrapedPostId,
          postId: post.postId || undefined,
          instagramPostUrl: post.instagramPostUrl || undefined,
          status: hasRetryableFailure ? "retryable_failure" : "completed",
          owner: workOwner,
          sourceRevision: processingFence.sourceRevision,
          outcome: hasTerminalPermanentFailure
            ? "terminal_permanent_failure"
            : hasRetryableFailure
            ? receiptInspectionFailed
              ? "receipt_inspection_failed"
              : receiptState === "incomplete"
                ? "incomplete_occurrence_receipt"
                : hasMissingReceiptAfterEvent
                  ? "missing_occurrence_receipt"
                  : hasProcessingFailure
                    ? "processing_failed"
                    : "unclassified_retryable"
            : receiptState === "complete"
              ? "receipt_complete"
            : hasTerminalNoEventOutcome
              ? "terminal_no_event"
              : "unclassified_retryable",
          ...(hasRetryableFailure
            ? { error: summary.errors[summary.errors.length - 1] ?? "Processing failed." }
            : {}),
        },
        serviceSecret,
      ),
    );
    if (!hasRetryableFailure && sourceKey) {
      seenSourceKeys.push(sourceKey);
    }
  }
}
