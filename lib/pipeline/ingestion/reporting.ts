import { type ApprovedEventAutoMergeSummary, runApprovedEventAutoMerge, runApprovedEventAutoMergeOnceForCompletedRun } from "@/lib/events/approved-event-automerge";
import { ConvexHttpClient } from "convex/browser";
import type { HandleSummary, IngestionBatchState, IngestionRunContext, IngestionRunMode, IngestionSummary, SavedPostCompletionClassificationInput } from "@/lib/pipeline/ingestion/contracts";
import { getErrorMessage, logError, logInfo } from "@/lib/pipeline/ingestion/runtime";

export function createEmptyHandleSummary(handle: string): HandleSummary {
  return {
    handle,
    fetchedPosts: 0,
    fetched_posts: 0,
    newFetchedPosts: 0,
    skippedAlreadyFetchedPosts: 0,
    apifyHighWatermarkApplied: 0,

    insertedEvents: 0,
    inserted_events: 0,
    insertedApprovedEvents: 0,
    insertedPendingEvents: 0,
    skippedDuplicates: 0,
    skipped_duplicates: 0,
    skipped_duplicates_clean: 0,
    skippedNoImage: 0,
    skipped_missing_date: 0,
    skipped_missing_venue: 0,
    skipped_video: 0,
    skipped_invalid_event: 0,
    skipped_past_event: 0,
    skipped_far_future_event: 0,
    updated_duplicates_bad_data: 0,
    duplicate_update_failed: 0,
    persistedImages: 0,
    failedImagePersistence: 0,
    failedDownloads: 0,
    failed_downloads: 0,
    failedConversions: 0,
    failed_conversions: 0,
    failedExtractions: 0,
    failed_extractions: 0,
    failed_extraction: 0,

    errors: [],
  };
}

export function getTerminalNoEventSkipCount(summary: HandleSummary): number {
  return (
    summary.skippedNoImage +
    summary.skipped_missing_date +
    summary.skipped_video +
    summary.skipped_invalid_event +
    summary.skipped_past_event +
    summary.skipped_far_future_event
  );
}

export function getRetryableProcessingFailureCount(
  summary: Pick<
    HandleSummary,
    | "failedDownloads"
    | "failedConversions"
    | "failedExtractions"
    | "failedImagePersistence"
    | "permanentMediaDownloadFailures"
    | "permanentImagePersistenceFailures"
    | "duplicate_update_failed"
  >,
): number {
  return (
    Math.max(
      0,
      summary.failedDownloads - (summary.permanentMediaDownloadFailures ?? 0),
    ) +
    summary.failedConversions +
    summary.failedExtractions +
    Math.max(
      0,
      summary.failedImagePersistence - (summary.permanentImagePersistenceFailures ?? 0),
    ) +
    summary.duplicate_update_failed
  );
}

export function classifySavedPostCompletionForTesting(
  input: SavedPostCompletionClassificationInput,
): {
  hasTerminalNoEventOutcome: boolean;
  hasMissingReceiptAfterEvent: boolean;
  hasRetryableFailure: boolean;
} {
  const hasTerminalNoEventOutcome =
    !input.hasTerminalPermanentFailure &&
    !input.hasProcessingFailure &&
    !input.receiptInspectionFailed &&
    input.eventActivityCountAfter === input.eventActivityCountBefore &&
    input.terminalNoEventSkipCountAfter > input.terminalNoEventSkipCountBefore;
  const hasMissingReceiptAfterEvent =
    input.receiptState === "absent" &&
    input.eventActivityCountAfter > input.eventActivityCountBefore;
  const hasRetryableFailure =
    !input.hasTerminalPermanentFailure &&
    !hasTerminalNoEventOutcome &&
    (input.hasProcessingFailure ||
      input.receiptInspectionFailed ||
      input.receiptState === "incomplete" ||
      hasMissingReceiptAfterEvent ||
      input.receiptState === "absent");
  return {
    hasTerminalNoEventOutcome,
    hasMissingReceiptAfterEvent,
    hasRetryableFailure,
  };
}

export function getOrCreateHandleSummary(summary: IngestionSummary, handle: string): HandleSummary {
  const existing = summary.handles.find((entry) => entry.handle === handle);
  if (existing) {
    Object.assign(existing, {
      ...createEmptyHandleSummary(handle),
      ...existing,
      errors: Array.isArray(existing.errors) ? existing.errors : [],
    });
    return existing;
  }
  const created = createEmptyHandleSummary(handle);
  summary.handles.push(created);
  return created;
}

export function markFreshFetchNotAttempted(
  summary: IngestionSummary,
  handle: string,
  reason: string,
  recordError = false,
): void {
  const handleSummary = getOrCreateHandleSummary(summary, handle);
  if (
    typeof handleSummary.freshFetchAttempted !== "number" ||
    handleSummary.freshFetchAttempted <= 0
  ) {
    handleSummary.freshFetchAttempted = 0;
  }
  if (recordError) {
    const message = `Fresh Apify fetch for @${handle} was not attempted (${reason}).`;
    if (!handleSummary.errors.includes(message)) {
      handleSummary.errors.push(message);
    }
  }
}

export function createEmptyIngestionSummary(
  handles: string[],
  runContext?: IngestionRunContext,
): IngestionSummary {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    finishedAt: now,
    handles: handles.map((handle) => createEmptyHandleSummary(handle)),
    ...(runContext ? { runContext } : {}),
  };
}

export function createInitialIngestionBatchState(): IngestionBatchState {
  return {
    stateVersion: 2,
    handleIndex: 0,
    currentHandle: null,
    currentPostIndex: 0,
    currentHandlePosts: [],
    currentScrapedPostCursor: null,
    currentScrapedPostIds: [],
    currentScrapedPostIdIndex: 0,
    currentScrapedPostPageDone: false,
    seenSourceKeysByHandle: {},
  };
}

export async function runApprovedDuplicateCleanupForIngestion(
  client: ConvexHttpClient,
  summary: IngestionSummary,
  options: {
    mode: IngestionRunMode;
    handles: string[];
    serviceSecret: string;
  },
): Promise<void> {
  try {
    const cleanupSummary = await runApprovedEventAutoMerge(client, {
      serviceSecret: options.serviceSecret,
    });
    summary.approvedDuplicateCleanup = cleanupSummary;

    logInfo("ingestion.approved_duplicates.auto_merged", {
      mode: options.mode,
      handles: options.handles,
      approvedCount: cleanupSummary.approvedCount,
      scannedEventCount: cleanupSummary.scannedEventCount,
      duplicateGroupCount: cleanupSummary.duplicateGroupCount,
      mergedGroupCount: cleanupSummary.mergedGroupCount,
      mergedDuplicateCount: cleanupSummary.mergedDuplicateCount,
      remainingGroupCount: cleanupSummary.remainingGroupCount,
      failedCount: cleanupSummary.failedCount,
      passes: cleanupSummary.passes,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    summary.approvedDuplicateCleanup = {
      approvedCount: 0,
      finalApprovedCount: 0,
      scannedEventCount: 0,
      duplicateGroupCount: 0,
      mergedGroupCount: 0,
      mergedDuplicateCount: 0,
      remainingGroupCount: 0,
      failedCount: 1,
      failures: [],
      passes: 0,
      error: message,
    };

    logError("ingestion.approved_duplicates.auto_merge_failed", {
      mode: options.mode,
      handles: options.handles,
      error: message,
    });
  }
}

/**
 * Durable ingestion processes one saved post per executor request. Cleanup is
 * therefore owned by the single request that completes the frozen run, not by
 * every terminal post/handle request.
 */
export async function runApprovedDuplicateCleanupForCompletedDurableRun(options: {
  client: ConvexHttpClient;
  runId: string;
  serviceSecret: string;
}): Promise<ApprovedEventAutoMergeSummary> {
  const summary = await runApprovedEventAutoMergeOnceForCompletedRun(options.client, {
    runId: options.runId,
    serviceSecret: options.serviceSecret,
  });
  if (summary.crossPostCampaignCoalescing) {
    logInfo("ingestion.cross_post_campaigns.auto_coalesced", {
      runId: options.runId,
      ...summary.crossPostCampaignCoalescing,
    });
  }
  return summary;
}
