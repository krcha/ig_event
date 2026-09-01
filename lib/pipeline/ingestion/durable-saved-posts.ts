import { type IngestionVenueResolverSnapshotInput } from "@/lib/domain/venues/index";
import { isTransientSavedPostProcessingError } from "@/lib/pipeline/durable-ingestion-execute";
import { type CanonicalVenueAliasesByHandle, normalizeHandle } from "@/lib/pipeline/venue-normalization";
import { ConvexHttpClient } from "convex/browser";
import type { DurableSavedPostProcessingResult, HandleSummary, SavedScrapedPostRecord } from "@/lib/pipeline/ingestion/contracts";
import { getScrapedPostBacklogStateByHandleQuery } from "@/lib/pipeline/ingestion/convex-bindings";
import { processLoadedPostsForHandle } from "@/lib/pipeline/ingestion/handle-processing";
import { createEmptyIngestionSummary, getOrCreateHandleSummary } from "@/lib/pipeline/ingestion/reporting";
import { getConfiguredServiceSecret, getConvexClient, getErrorMessage, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { loadSavedScrapedPostRecordById, loadSavedScrapedPostsForHandle, mapSavedScrapedPostToInstagramPost } from "@/lib/pipeline/ingestion/source-documents";
import { loadIngestionVenueContextForHandles } from "@/lib/pipeline/ingestion/venue-context";

export const DURABLE_TERMINAL_SAVED_POST_OUTCOMES = new Set([
  "terminal_no_event",
  "terminal_permanent_failure",
  "receipt_complete",
]);

export function isDurableSavedPostTerminal(record: SavedScrapedPostRecord): boolean {
  return (
    record.processingStatus === "completed" &&
    DURABLE_TERMINAL_SAVED_POST_OUTCOMES.has(record.processingOutcome ?? "")
  );
}

/**
 * Process only the post selected and linked by a durable fetch receipt. This
 * deliberately reuses the existing extraction pipeline, prompt, model,
 * scraped-post fence, and global OpenAI lease; it only narrows selection from
 * a handle page to one durable ID.
 */
export async function processSavedScrapedPostForDurableReceipt(options: {
  handle: string;
  scrapedPostId: string;
  expectedSourceRevision: number;
  workOwner: string;
  serviceSecret?: string;
  onOpenAiTransportStarted?: () => void;
}): Promise<DurableSavedPostProcessingResult> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  let transportAttempted = false;
  const initial = await loadSavedScrapedPostRecordById(
    client,
    options.scrapedPostId,
    serviceSecret,
  );
  if (!initial || normalizeHandle(initial.handle) !== normalizeHandle(options.handle)) {
    return {
      state: "blocked",
      reason: "The linked durable saved post is missing or mismatched.",
      transportAttempted,
    };
  }
  if ((initial.sourceRevision ?? 1) !== options.expectedSourceRevision) {
    return {
      state: "blocked",
      reason: "Durable saved-post source revision changed; exact recovery is required.",
      transportAttempted,
    };
  }
  const summary = createEmptyIngestionSummary([options.handle]);
  const handleSummary = getOrCreateHandleSummary(summary, options.handle);
  if (isDurableSavedPostTerminal(initial)) {
    return {
      state: "terminal",
      outcome: initial.processingOutcome ?? "receipt_complete",
      transportAttempted,
    };
  }

  const venueContext = await loadIngestionVenueContextForHandles(
    client,
    serviceSecret,
    [options.handle],
  );
  let thrownError: string | undefined;
  try {
    await processLoadedPostsForHandle({
      client,
      handle: options.handle,
      posts: [mapSavedScrapedPostToInstagramPost(initial)],
      summary: handleSummary,
      seenSourceKeys: [],
      serviceSecret,
      workOwner: options.workOwner,
      scrapedPostId: options.scrapedPostId,
      expectedSourceRevision: options.expectedSourceRevision,
      onOpenAiTransportStarted: () => {
        options.onOpenAiTransportStarted?.();
        transportAttempted = true;
      },
      ...venueContext,
    });
  } catch (error) {
    thrownError = getErrorMessage(error);
  }

  const refreshed = await loadSavedScrapedPostRecordById(
    client,
    options.scrapedPostId,
    serviceSecret,
  );
  if (!refreshed) {
    return {
      state: "blocked",
      reason: "The linked durable saved post disappeared during processing.",
      transportAttempted,
    };
  }
  if ((refreshed.sourceRevision ?? 1) !== options.expectedSourceRevision) {
    return {
      state: "blocked",
      reason: "Durable saved-post source revision changed during processing; exact recovery is required.",
      transportAttempted,
    };
  }
  if (isDurableSavedPostTerminal(refreshed)) {
    return {
      state: "terminal",
      outcome: refreshed.processingOutcome ?? "receipt_complete",
      transportAttempted,
    };
  }

  const processingReasons = [
    thrownError,
    refreshed.processingError,
    ...handleSummary.errors,
    refreshed.processingOutcome,
  ].filter((value): value is string => Boolean(value));
  const reason =
    processingReasons.find(isTransientSavedPostProcessingError) ??
    processingReasons[0] ??
    "Saved post processing did not reach a terminal outcome.";
  if (refreshed.processingOutcome === "openai_transport_ambiguous") {
    return { state: "blocked", reason, transportAttempted };
  }
  const retryAt = Math.max(
    Date.now() + 1_000,
    refreshed.processingRetryAt ?? refreshed.processingLeaseExpiresAt ?? Date.now() + 30_000,
  );
  return {
    state: "pending",
    reason,
    retryAfterMs: Math.min(6 * 60 * 60_000, Math.max(1_000, retryAt - Date.now())),
    transportAttempted,
  };
}

export async function processSavedBacklogBeforeFreshFetch(options: {
  client: ConvexHttpClient;
  handle: string;
  summary: HandleSummary;
  seenSourceKeys: string[];
  serviceSecret: string;
  workOwner: string;
  daysBack?: number;
  canonicalVenueNamesByHandle: Record<string, string>;
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle;
  canonicalVenueLocationsByHandle: Record<string, string>;
  venueResolverSnapshot: IngestionVenueResolverSnapshotInput;
  venueNameOverridesByHandle: Record<string, string>;
  configuredVenueNamesByHandle: Record<string, string>;
  sourceDisplayNamesByHandle: Record<string, string>;
  sourceRolesByHandle: Record<string, "venue" | "promoter" | "unknown">;
}): Promise<boolean> {
  const savedPosts = await loadSavedScrapedPostsForHandle(
    options.client,
    options.handle,
    undefined,
    options.daysBack,
    options.serviceSecret,
  );
  if (savedPosts.length > 0) {
    await processLoadedPostsForHandle({
      client: options.client,
      handle: options.handle,
      posts: savedPosts,
      summary: options.summary,
      seenSourceKeys: options.seenSourceKeys,
      serviceSecret: options.serviceSecret,
      workOwner: options.workOwner,
      canonicalVenueNamesByHandle: options.canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle: options.canonicalVenueAliasesByHandle,
      canonicalVenueLocationsByHandle: options.canonicalVenueLocationsByHandle,
      venueResolverSnapshot: options.venueResolverSnapshot,
      venueNameOverridesByHandle: options.venueNameOverridesByHandle,
      configuredVenueNamesByHandle: options.configuredVenueNamesByHandle,
      sourceDisplayNamesByHandle: options.sourceDisplayNamesByHandle,
      sourceRolesByHandle: options.sourceRolesByHandle,
    });
  }
  const backlog = (await options.client.query(
    getScrapedPostBacklogStateByHandleQuery,
    withServiceSecret(
      {
        handle: options.handle,
        ...(options.daysBack && options.daysBack > 0
          ? { horizonCutoffMs: Date.now() - options.daysBack * 86_400_000 }
          : {}),
      },
      options.serviceSecret,
    ),
  )) as { actionable?: number; busy?: number };
  return (backlog.actionable ?? 0) === 0 && (backlog.busy ?? 0) === 0;
}
