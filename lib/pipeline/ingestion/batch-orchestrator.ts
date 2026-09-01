import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { ConvexHttpClient } from "convex/browser";
import type { IngestionBatchStepOptions, IngestionBatchStepResult, IngestionStep, IngestionVenueContext } from "@/lib/pipeline/ingestion/contracts";
import { processSavedBacklogBeforeFreshFetch } from "@/lib/pipeline/ingestion/durable-saved-posts";
import { fetchFreshPostsForHandlesInParallel } from "@/lib/pipeline/ingestion/fresh-fetch";
import { processLoadedPostsForHandle } from "@/lib/pipeline/ingestion/handle-processing";
import { getOrCreateHandleSummary, markFreshFetchNotAttempted, runApprovedDuplicateCleanupForIngestion } from "@/lib/pipeline/ingestion/reporting";
import { getConfiguredServiceSecret, getConvexClient, getErrorMessage, isFreshApifyFetchEnabled, logError, normalizeBatchSize, normalizeIngestionPostStepLimit, normalizeScrapedPostPageSize } from "@/lib/pipeline/ingestion/runtime";
import { loadSavedScrapedPostPageForHandle, loadScrapedPostsByIds } from "@/lib/pipeline/ingestion/source-documents";
import { loadIngestionVenueContext, loadIngestionVenueContextForHandles } from "@/lib/pipeline/ingestion/venue-context";

export async function runInstagramIngestionFullScrapeBatchStep(
  options: IngestionBatchStepOptions & IngestionVenueContext & {
    client: ConvexHttpClient;
    serviceSecret: string;
    workOwner: string;
  },
): Promise<IngestionBatchStepResult> {
  const summary = options.summary;
  const state = options.state;
  // Full scrapes include remote extraction plus a bounded durable-media action.
  // Keep each checkpoint step to one handle so one route request cannot queue
  // dozens of serial 15-second media imports before saving its lease state.
  const handleBatchSize = Math.min(normalizeBatchSize(options.batchSize), 1);
  const handleBatch = options.handles.slice(
    state.handleIndex,
    state.handleIndex + handleBatchSize,
  );

  if (handleBatch.length > 0) {
    const handlesReadyForFetch: string[] = [];
    for (const handle of handleBatch) {
      state.currentHandle = handle;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
      state.currentScrapedPostCursor = null;
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      state.currentScrapedPostPageDone = false;
      const seenSourceKeys = state.seenSourceKeysByHandle[handle] ?? [];
      state.seenSourceKeysByHandle[handle] = seenSourceKeys;
      const readyForFetch = await processSavedBacklogBeforeFreshFetch({
        client: options.client,
        handle,
        summary: getOrCreateHandleSummary(summary, handle),
        seenSourceKeys,
        serviceSecret: options.serviceSecret,
        workOwner: options.workOwner,
        daysBack: options.daysBack,
        canonicalVenueNamesByHandle: options.canonicalVenueNamesByHandle,
        canonicalVenueAliasesByHandle: options.canonicalVenueAliasesByHandle,
        canonicalVenueLocationsByHandle: options.canonicalVenueLocationsByHandle,
        venueResolverSnapshot: options.venueResolverSnapshot,
        venueNameOverridesByHandle: options.venueNameOverridesByHandle,
        configuredVenueNamesByHandle: options.configuredVenueNamesByHandle,
        sourceDisplayNamesByHandle: options.sourceDisplayNamesByHandle,
        sourceRolesByHandle: options.sourceRolesByHandle,
      });
      if (readyForFetch) {
        handlesReadyForFetch.push(handle);
      } else {
        markFreshFetchNotAttempted(summary, handle, "saved_backlog_not_ready");
      }
    }

    let postsByHandle: Record<string, InstagramScrapedPost[]> = {};
    if (isFreshApifyFetchEnabled()) {
      postsByHandle = await fetchFreshPostsForHandlesInParallel(
        options.client,
        handlesReadyForFetch,
        summary,
        options,
        options.serviceSecret,
        options.workOwner,
      );
    } else {
      for (const handle of handlesReadyForFetch) {
        markFreshFetchNotAttempted(summary, handle, "fresh_fetch_disabled");
      }
    }

    for (const handle of handleBatch) {
      const posts = postsByHandle[handle];
      if (posts) {
        const seenSourceKeys = state.seenSourceKeysByHandle[handle] ?? [];
        state.seenSourceKeysByHandle[handle] = seenSourceKeys;

        await processLoadedPostsForHandle({
          client: options.client,
          handle,
          posts,
          summary: getOrCreateHandleSummary(summary, handle),
          seenSourceKeys,
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

      state.handleIndex += 1;
    }
  }

  const done = state.handleIndex >= options.handles.length;
  if (done) {
    state.currentHandle = null;
    state.currentPostIndex = 0;
    state.currentHandlePosts = [];
    state.currentScrapedPostCursor = null;
    state.currentScrapedPostIds = [];
    state.currentScrapedPostIdIndex = 0;
    state.currentScrapedPostPageDone = false;
    await runApprovedDuplicateCleanupForIngestion(options.client, summary, {
      mode: "full_scrape",
      handles: options.handles,
      serviceSecret: options.serviceSecret,
    });
  }
  summary.finishedAt = new Date().toISOString();

  return {
    summary,
    state,
    done,
  };
}

export async function runInstagramIngestionBatchStep(
  options: IngestionBatchStepOptions,
): Promise<IngestionBatchStepResult> {
  const client = getConvexClient();
  const serviceSecret = getConfiguredServiceSecret(options.serviceSecret);
  const workOwner =
    options.workOwner?.trim() || `instagram-ingestion:${globalThis.crypto.randomUUID()}`;
  const mode = options.mode ?? "full_scrape";
  const venueContext =
    mode === "full_scrape"
      ? await loadIngestionVenueContextForHandles(
          client,
          serviceSecret,
          options.handles.slice(options.state.handleIndex, options.state.handleIndex + 1),
        )
      : await loadIngestionVenueContext(client, serviceSecret);
  const {
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    canonicalVenueLocationsByHandle,
    venueResolverSnapshot,
    venueNameOverridesByHandle,
    configuredVenueNamesByHandle,
    sourceDisplayNamesByHandle,
    sourceRolesByHandle,
  } = venueContext;
  const batchSize = normalizeBatchSize(options.batchSize);
  const summary = options.summary;
  const state = options.state;
  const postStepLimit = normalizeIngestionPostStepLimit(options.postStepLimit);
  const scrapedPostPageSize = normalizeScrapedPostPageSize(options.scrapedPostPageSize);

  if (mode === "full_scrape") {
    return runInstagramIngestionFullScrapeBatchStep({
      ...options,
      client,
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      canonicalVenueLocationsByHandle,
      venueResolverSnapshot,
      venueNameOverridesByHandle,
      configuredVenueNamesByHandle,
      sourceDisplayNamesByHandle,
      sourceRolesByHandle,
      batchSize,
      mode,
      serviceSecret,
      workOwner,
    });
  }

  let processedPosts = 0;

  while (processedPosts < postStepLimit && state.handleIndex < options.handles.length) {
    const handle = options.handles[state.handleIndex];
    const handleSummary = getOrCreateHandleSummary(summary, handle);

    if (state.currentHandle !== handle) {
      state.currentHandle = handle;
      state.currentPostIndex = 0;
      state.currentHandlePosts = [];
      state.currentScrapedPostCursor = null;
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      state.currentScrapedPostPageDone = false;
    }

    const currentIds = state.currentScrapedPostIds ?? [];
    const currentIdIndex = state.currentScrapedPostIdIndex ?? 0;
    if (currentIds.length === 0 || currentIdIndex >= currentIds.length) {
      if (state.currentScrapedPostPageDone) {
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
        continue;
      }

      try {
        const page = await loadSavedScrapedPostPageForHandle({
          client,
          handle,
          cursor: state.currentScrapedPostCursor ?? null,
          pageSize: scrapedPostPageSize,
          daysBack: options.daysBack,
          alreadyAcceptedCount: state.currentPostIndex,
          resultsLimit: options.resultsLimit,
          serviceSecret,
        });

        handleSummary.fetchedPosts = page.acceptedCount;
        handleSummary.fetched_posts = page.acceptedCount;
        state.currentPostIndex = page.acceptedCount;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = page.continueCursor;
        state.currentScrapedPostIds = page.candidateIds;
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = page.shouldCompleteHandle;

        if (page.candidateIds.length === 0) {
          if (page.shouldCompleteHandle) {
            state.handleIndex += 1;
            state.currentHandle = null;
            state.currentPostIndex = 0;
            state.currentHandlePosts = [];
            state.currentScrapedPostCursor = null;
            state.currentScrapedPostIds = [];
            state.currentScrapedPostIdIndex = 0;
            state.currentScrapedPostPageDone = false;
          }
          continue;
        }
      } catch (error) {
        handleSummary.errors.push(
          getErrorMessage(error),
        );
        logError("ingestion.scrape.failed", {
          step: "fetch_posts" satisfies IngestionStep,
          handle,
          sourcePostId: null,
          shortcode: null,
          instagramUrl: null,
          error: getErrorMessage(error),
        });
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
        continue;
      }
    }

    const ids = state.currentScrapedPostIds ?? [];
    const remainingCapacity = postStepLimit - processedPosts;
    const idsStartIndex = state.currentScrapedPostIdIndex ?? 0;
    const idsToLoad = ids.slice(
      idsStartIndex,
      idsStartIndex + remainingCapacity,
    );
    const posts = await loadScrapedPostsByIds(client, idsToLoad, serviceSecret);

    processedPosts += posts.length;
    const seenForHandle = state.seenSourceKeysByHandle[handle] ?? [];
    state.seenSourceKeysByHandle[handle] = seenForHandle;
    await processLoadedPostsForHandle({
      client,
      handle,
      posts,
      summary: handleSummary,
      seenSourceKeys: seenForHandle,
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
    });
    state.currentScrapedPostIdIndex = idsStartIndex + idsToLoad.length;

    if ((state.currentScrapedPostIdIndex ?? 0) >= ids.length) {
      state.currentScrapedPostIds = [];
      state.currentScrapedPostIdIndex = 0;
      if (state.currentScrapedPostPageDone) {
        state.handleIndex += 1;
        state.currentHandle = null;
        state.currentPostIndex = 0;
        state.currentHandlePosts = [];
        state.currentScrapedPostCursor = null;
        state.currentScrapedPostIds = [];
        state.currentScrapedPostIdIndex = 0;
        state.currentScrapedPostPageDone = false;
      }
    }
  }

  const done = state.handleIndex >= options.handles.length;
  if (done) {
    state.currentHandle = null;
    state.currentPostIndex = 0;
    state.currentHandlePosts = [];
    state.currentScrapedPostCursor = null;
    state.currentScrapedPostIds = [];
    state.currentScrapedPostIdIndex = 0;
    state.currentScrapedPostPageDone = false;
    await runApprovedDuplicateCleanupForIngestion(client, summary, {
      mode,
      handles: options.handles,
      serviceSecret,
    });
  }
  summary.finishedAt = new Date().toISOString();

  return {
    summary,
    state,
    done,
  };
}
