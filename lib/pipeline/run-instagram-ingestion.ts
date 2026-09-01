import { bindSourceOccurrenceMetadata, buildSourceOccurrenceChildTrackingKeyForTesting, buildSourceOccurrenceKeyForTesting, hasIncompleteSourceOccurrenceSetForTesting } from "@/lib/pipeline/source-occurrence-planning";
import { runInstagramIngestionBatchStep } from "@/lib/pipeline/ingestion/batch-orchestrator";
import type { ActiveVenueIngestionResult, IngestionRunMode, IngestionSummary, RunInstagramIngestionOptions } from "@/lib/pipeline/ingestion/contracts";
import { createEmptyIngestionSummary, createInitialIngestionBatchState } from "@/lib/pipeline/ingestion/reporting";
import { getConfiguredServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { getActiveVenueHandles } from "@/lib/pipeline/ingestion/source-imports";
export { runInstagramIngestionBatchStep } from "@/lib/pipeline/ingestion/batch-orchestrator";
export type { ActiveVenueIngestionResult, CoreEventSourceGrounding, DurableSavedPostProcessingResult, ExistingEventImportSummary, IngestionBatchState, IngestionBatchStepOptions, IngestionBatchStepResult, IngestionRunContext, IngestionRunMode, IngestionSummary, RecentApifyImportSummary } from "@/lib/pipeline/ingestion/contracts";
export { processSavedScrapedPostForDurableReceipt } from "@/lib/pipeline/ingestion/durable-saved-posts";
export { resolvePaidFetchLeaseAfterBacklogMaintenance } from "@/lib/pipeline/ingestion/fresh-fetch";
export { hasDurableMediaEligibleNormalizedFields, isExistingEventEligibleForDurableMediaRetry, isPermanentRemoteMediaFailure, persistInstagramMediaCandidate, persistInstagramMediaCandidates, resolveFailedMediaAttemptPolicy } from "@/lib/pipeline/ingestion/media-durability";
export { areEventTimesCompatibleForTesting, buildDuplicateUpdatePatch } from "@/lib/pipeline/ingestion/occurrence-comparison";
export { findBestExistingMatchForPreparedEventForTesting, hasIncompleteAmbiguousCollisionContextForTesting, listExistingEventsBySourceIdentityForTesting, reconcileAmbiguousOccurrenceKeysWithExistingEventsForTesting } from "@/lib/pipeline/ingestion/occurrence-matching";
export { normalizeEventDate } from "@/lib/pipeline/ingestion/parsing-date";
export { evaluateCoreEventSourceGrounding, getNonEventAutoApprovalBlockers, getPosterScheduleAutoApprovalBlockers, isNonEventClosureNotice } from "@/lib/pipeline/ingestion/parsing-source-evidence";
export { classifyExistingApprovedOccurrenceForTesting, resolveInstagramSourceExtractionContextForTesting } from "@/lib/pipeline/ingestion/post-processing-policy";
export { processIngestionPostWithExtractionForTesting } from "@/lib/pipeline/ingestion/post-processor";
export { classifySavedPostCompletionForTesting, createEmptyIngestionSummary, createInitialIngestionBatchState, getRetryableProcessingFailureCount, markFreshFetchNotAttempted, runApprovedDuplicateCleanupForCompletedDurableRun } from "@/lib/pipeline/ingestion/reporting";
export { persistScrapedPostsForHandle } from "@/lib/pipeline/ingestion/source-documents";
export { getActiveVenueHandles, importRecentApifyRunPostsToSavedPosts, importUpcomingEventsToSavedPosts } from "@/lib/pipeline/ingestion/source-imports";
export {
  prepareEventsForInsert,
  produceStructuredFactsForInsert,
} from "@/lib/pipeline/ingestion/structured-facts";

export {
  bindSourceOccurrenceMetadata,
  buildSourceOccurrenceChildTrackingKeyForTesting,
  buildSourceOccurrenceKeyForTesting,
  hasIncompleteSourceOccurrenceSetForTesting,
};

export async function runActiveVenueIngestion(options?: {
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
  serviceSecret?: string;
}): Promise<ActiveVenueIngestionResult> {
  const serviceSecret = getConfiguredServiceSecret(options?.serviceSecret);
  const venueHandles = await getActiveVenueHandles({ serviceSecret });
  if (venueHandles.length === 0) {
    return {
      venueHandles: [],
      summary: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        handles: [],
      },
    };
  }

  const summary = await runInstagramIngestion({
    handles: venueHandles,
    resultsLimit: options?.resultsLimit,
    daysBack: options?.daysBack,
    mode: options?.mode,
    serviceSecret,
  });

  return { venueHandles, summary };
}

export async function runInstagramIngestion(
  options: RunInstagramIngestionOptions,
): Promise<IngestionSummary> {
  const summary = createEmptyIngestionSummary(options.handles);
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);

  const state = createInitialIngestionBatchState();
  const mode = options.mode ?? "full_scrape";
  let done = false;

  while (!done) {
    const batchResult = await runInstagramIngestionBatchStep({
      handles: options.handles,
      summary,
      state,
      resultsLimit: options.resultsLimit,
      daysBack: options.daysBack,
      batchSize: mode === "full_scrape" ? 1 : 10,
      mode,
      serviceSecret,
    });
    done = batchResult.done;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
