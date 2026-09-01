import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import {
  persistScrapedPostsForHandle,
  processSavedScrapedPostForDurableReceipt,
  runApprovedDuplicateCleanupForCompletedDurableRun,
} from "@/lib/pipeline/run-instagram-ingestion";
import { scrapeInstagramAccount } from "@/lib/scraper/instagram-scraper";
import {
  isDurableSavedPostRevisionMismatch,
  isTransientSavedPostProcessingError,
} from "@/lib/pipeline/durable-ingestion-execute";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const claim = "durableIngestionRuns:executeNext" as unknown as FunctionReference<"mutation">;
const complete = "durableIngestionRuns:completeReceipt" as unknown as FunctionReference<"mutation">;
const retry = "durableIngestionRuns:releaseReceiptForRetry" as unknown as FunctionReference<"mutation">;
const probe = "durableIngestionRuns:probeRun" as unknown as FunctionReference<"query">;
const markProviderAttempt = "durableIngestionRuns:markReceiptProviderAttemptStarted" as unknown as FunctionReference<"mutation">;
const markPostsPersisted = "durableIngestionRuns:markReceiptPostsPersisted" as unknown as FunctionReference<"mutation">;
const claimProcessing = "durableIngestionRuns:claimNextProcessingReceipt" as unknown as FunctionReference<"mutation">;
const completeProcessing = "durableIngestionRuns:completeProcessingReceipt" as unknown as FunctionReference<"mutation">;
const releaseProcessing = "durableIngestionRuns:releaseProcessingReceiptForRetry" as unknown as FunctionReference<"mutation">;

function deferredExecutorResponse(
  error: unknown,
  context: { runId: string; workerSlot: number; workerId: string; claimed?: boolean },
) {
  console.error(JSON.stringify({
    level: "error",
    event: "durable_ingestion.execute.deferred",
    ...context,
    error: error instanceof Error ? error.message.slice(0, 512) : "unknown executor failure",
  }));
  return NextResponse.json({
    ...(context.claimed === undefined
      ? { claimState: "unknown" }
      : { claimed: context.claimed }),
    retryDeferred: true,
    durableStateUnknown: true,
    error: "durable_executor_temporarily_unavailable",
  }, { status: 202 });
}

function deferredApprovedCleanupResponse(
  error: unknown,
  context: { runId: string; workerSlot: number; claimed: boolean },
) {
  console.error(JSON.stringify({
    level: "error",
    event: "durable_ingestion.approved_cleanup.deferred",
    ...context,
    error: error instanceof Error ? error.message.slice(0, 512) : "unknown cleanup failure",
  }));
  return NextResponse.json({
    claimed: context.claimed,
    complete: false,
    retryDeferred: true,
    durableStateUnknown: false,
    error: "approved_duplicate_cleanup_deferred",
  }, { status: 202 });
}

/** One receipt per request. The VPS starts one worker per fixed lane. */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  const runId = new URL(request.url).searchParams.get("runId");
  const workerSlotRaw = new URL(request.url).searchParams.get("workerSlot");
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });
  const workerSlot = Number(workerSlotRaw);
  if (!Number.isInteger(workerSlot) || workerSlot < 0 || workerSlot >= 6) {
    return NextResponse.json({ error: "workerSlot must be 0 through 5." }, { status: 400 });
  }
  const serviceSecret = requireServiceSecret();
  const convex = createConvexHttpClient();
  // The owner is persisted with every OpenAI attempt. Binding it to this
  // durable run lets authenticated accounting distinguish work performed by
  // this run from a concurrent or previously cached analysis of the same post.
  const workerId = `vps:${runId}:${workerSlot}:${randomUUID()}`;
  const runCompletionCleanup = async (completion: unknown) => {
    if (
      !completion ||
      typeof completion !== "object" ||
      (completion as { complete?: unknown }).complete !== true
    ) {
      return null;
    }
    // Fixed lane 0 owns the completion side effect. Other lanes may exit once
    // the run is terminal; lane 0 remains supervised until cleanup succeeds.
    if (workerSlot !== 0) return null;
    try {
      const completionState =
        typeof (completion as { mode?: unknown }).mode === "string"
          ? (completion as { complete: true; mode: string })
          : (await convex.query(probe, { runId, serviceSecret })) as {
                complete?: boolean;
                mode?: string;
              } | null;
      if (!completionState || completionState.complete !== true) {
        throw new Error("Completed durable run could not be re-probed before cleanup.");
      }
      // A 16-profile canary is allowed to mutate only artifacts attributable
      // to its frozen receipts. The global approved-catalog merge remains a
      // required completion side effect for catch-up and daily production runs.
      if (completionState.mode === "canary") return null;
      if (completionState.mode !== "catch_up" && completionState.mode !== "daily") {
        throw new Error("Completed durable run has an unsupported cleanup mode.");
      }
      const summary = await runApprovedDuplicateCleanupForCompletedDurableRun({
        client: convex,
        runId,
        serviceSecret,
      });
      if (summary.error || summary.failedCount > 0 || summary.remainingGroupCount > 0) {
        throw new Error(
          summary.error ??
            `Approved cleanup incomplete: failed=${summary.failedCount};remaining=${summary.remainingGroupCount}.`,
        );
      }
      return null;
    } catch (error) {
      return error;
    }
  };
  const runCompletionCleanupOrDefer = async (
    completion: unknown,
    claimed: boolean,
  ) => {
    const cleanupError = await runCompletionCleanup(completion);
    return cleanupError
      ? deferredApprovedCleanupResponse(cleanupError, { runId, workerSlot, claimed })
      : null;
  };

  // Convex elects fixed slot 0 as the one global AI consumer before reading
  // shared queue state. The other five requests remain fetch-capable without
  // contending on the same processing-pending receipt.
  let processingClaim: {
    receiptId: string;
    handle: string;
    scrapedPostId: string;
    scrapedPostSourceRevision: number;
    processingAttemptCount: number;
    providerAttemptCount: number;
  } | null;
  try {
    processingClaim = await convex.mutation(claimProcessing, {
      runId,
      workerId,
      workerSlot,
      serviceSecret,
    }) as typeof processingClaim;
  } catch (error) {
    return deferredExecutorResponse(error, { runId, workerSlot, workerId });
  }
  if (processingClaim) {
    try {
      const processingResult = await processSavedScrapedPostForDurableReceipt({
        handle: processingClaim.handle,
        scrapedPostId: processingClaim.scrapedPostId,
        expectedSourceRevision: processingClaim.scrapedPostSourceRevision,
        workOwner: workerId,
        serviceSecret,
      });
      if (processingResult.state === "terminal") {
        const completion = await convex.mutation(completeProcessing, {
          runId,
          receiptId: processingClaim.receiptId,
          workerId,
          detail: `saved_post:${processingClaim.scrapedPostId};${processingResult.outcome}`,
          serviceSecret,
        }) as {
          complete: boolean;
          status: "fetched" | "failed";
          processingOutcome: string;
        };
        const cleanupDeferred = await runCompletionCleanupOrDefer(completion, true);
        if (cleanupDeferred) return cleanupDeferred;
        return NextResponse.json({
          claimed: true,
          work: "processing",
          handle: processingClaim.handle,
          outcome: completion.status,
          processingOutcome: completion.processingOutcome,
        });
      }

      const revisionMismatch = isDurableSavedPostRevisionMismatch(processingResult.reason);
      const preserveAttempt =
        revisionMismatch ||
        (processingResult.state === "pending" &&
          isTransientSavedPostProcessingError(processingResult.reason));
      const released = await convex.mutation(releaseProcessing, {
        runId,
        receiptId: processingClaim.receiptId,
        workerId,
        reason: processingResult.reason,
        retryAfterMs:
          revisionMismatch
            ? 6 * 60 * 60_000
            : processingResult.state === "pending"
              ? processingResult.retryAfterMs
              : 1_000,
        ...(preserveAttempt ? { preserveAttempt: true } : {}),
        serviceSecret,
      }) as {
        terminal: boolean;
        status: "processing_pending" | "fetched" | "no_post" | "deferred" | "failed";
      };
      return NextResponse.json({
        claimed: true,
        work: "processing",
        handle: processingClaim.handle,
        processingPending: !released.terminal,
        outcome: released.terminal ? released.status : undefined,
      }, { status: released.terminal ? 200 : 202 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown saved-post processing failure";
      const revisionMismatch = isDurableSavedPostRevisionMismatch(error);
      const preserveAttempt =
        revisionMismatch || isTransientSavedPostProcessingError(error);
      let released: {
        terminal: boolean;
        status: "processing_pending" | "fetched" | "no_post" | "deferred" | "failed";
      };
      try {
        released = await convex.mutation(releaseProcessing, {
          runId,
          receiptId: processingClaim.receiptId,
          workerId,
          reason,
          retryAfterMs: revisionMismatch ? 6 * 60 * 60_000 : 30_000,
          ...(preserveAttempt ? { preserveAttempt: true } : {}),
          serviceSecret,
        }) as typeof released;
      } catch (releaseError) {
        return deferredExecutorResponse(releaseError, {
          runId,
          workerSlot,
          workerId,
          claimed: true,
        });
      }
      // The failure has crossed a durable retry/terminal boundary. Return 202
      // while it remains pending so curl --fail never restarts all six lanes.
      return NextResponse.json({
        claimed: true,
        work: "processing",
        processingPending: !released.terminal,
        outcome: released.terminal ? released.status : undefined,
      }, { status: released.terminal ? 200 : 202 });
    }
  }

  let claimed: {
    receiptId: string; handle: string; controls: { resultsLimit: number; daysBack?: number; noAgeCutoff?: boolean; skipPinnedPosts: boolean; pinnedPostPolicy?: "exclude_all" | "include_recent"; ignoreCheckpoint: boolean; ignoreCooldown: boolean; costPerProfileMicros: number };
    providerAttemptCount?: number;
    providerResultStatus?: "persisted" | "no_post";
  } | null;
  try {
    claimed = await convex.mutation(claim, {
      runId,
      workerId,
      workerSlot,
      serviceSecret,
    }) as typeof claimed;
  } catch (error) {
    return deferredExecutorResponse(error, { runId, workerSlot, workerId });
  }
  if (!claimed) {
    let state: { complete?: boolean; status?: string } | null;
    try {
      state = await convex.query(probe, { runId, serviceSecret }) as typeof state;
    } catch (error) {
      return deferredExecutorResponse(error, { runId, workerSlot, workerId, claimed: false });
    }
    const cleanupDeferred = await runCompletionCleanupOrDefer(state, false);
    if (cleanupDeferred) return cleanupDeferred;
    return NextResponse.json({
      claimed: false,
      complete: state?.complete ?? true,
      status: state?.status ?? "missing",
    });
  }
  try {
    let posts: Awaited<ReturnType<typeof scrapeInstagramAccount>> = [];
    const alreadyFetched = (claimed.providerAttemptCount ?? 0) > 0;
    if (alreadyFetched && claimed.providerResultStatus === undefined) {
      // Apify may have charged before the process crashed, but no durable
      // post-persistence receipt exists. Do not re-fetch and do not pretend a
      // post was saved; surface the exact uncertainty for operator recovery.
      const completion = await convex.mutation(complete, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        outcome: "deferred",
        detail: "provider_attempt_persistence_unconfirmed",
        serviceSecret,
      });
      const cleanupDeferred = await runCompletionCleanupOrDefer(completion, true);
      if (cleanupDeferred) return cleanupDeferred;
      return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: "deferred" });
    }
    if (alreadyFetched && claimed.providerResultStatus === "no_post") {
      const completion = await convex.mutation(complete, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        outcome: "no_post",
        detail: "persisted_provider_no_post",
        serviceSecret,
      });
      const cleanupDeferred = await runCompletionCleanupOrDefer(completion, true);
      if (cleanupDeferred) return cleanupDeferred;
      return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: "no_post" });
    }
    if (alreadyFetched && claimed.providerResultStatus === "persisted") {
      // This can occur only during an old-web/new-Convex rolling overlap. Keep
      // it queued for the processing migration; never enter Apify or report a
      // fetched terminal result from this compatibility branch.
      await convex.mutation(retry, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        reason: "saved_post_processing_migration_pending",
        retryAfterMs: 1_000,
        preserveAttempt: true,
        serviceSecret,
      });
      return NextResponse.json({
        claimed: true,
        handle: claimed.handle,
        processingPending: true,
      }, { status: 202 });
    }
    if (!alreadyFetched) {
      // This is immediately before the outbound provider call. It consumes the
      // frozen one-cent reservation or charges a retry only if run budget remains.
      const providerAttempt = await convex.mutation(markProviderAttempt, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        serviceSecret,
      }) as { started: boolean; reason?: string };
      if (!providerAttempt.started) {
        const completion = await convex.mutation(complete, {
          runId,
          receiptId: claimed.receiptId,
          workerId,
          outcome: "deferred",
          detail: providerAttempt.reason ?? "budget_exhausted",
          serviceSecret,
        });
        const cleanupDeferred = await runCompletionCleanupOrDefer(completion, true);
        if (cleanupDeferred) return cleanupDeferred;
        return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: "deferred" });
      }
      // The controller owns the provider reservation and eight-slot semaphore.
      // Do not enter the legacy singleton paid-fetch lease here: that old safety
      // layer serializes all accounts and would turn eight workers into one.
      posts = await scrapeInstagramAccount({
        handle: claimed.handle,
        resultsLimit: claimed.controls.resultsLimit,
        ...(claimed.controls.daysBack === undefined ? {} : { daysBack: claimed.controls.daysBack }),
        noAgeCutoff: claimed.controls.noAgeCutoff ?? claimed.controls.daysBack === undefined,
        skipPinnedPosts: claimed.controls.skipPinnedPosts,
        ...(claimed.controls.pinnedPostPolicy
          ? { pinnedPostPolicy: claimed.controls.pinnedPostPolicy }
          : {}),
        maxTotalChargeUsd: claimed.controls.costPerProfileMicros / 1_000_000,
      });
      // Controller receipts fence this new path. Omit the legacy global lease
      // owner so persistence accepts the controller-owned concurrent fetch.
      const persistedPosts = await persistScrapedPostsForHandle(
        convex,
        claimed.handle,
        posts,
        serviceSecret,
      );
      const selectedPersistedPost = posts[0]
        ? persistedPosts.find((post) => post.postId === posts[0].postId)
        : undefined;
      if (posts.length === 1 && !selectedPersistedPost) {
        throw new Error("Selected provider post did not return an exact durable row identity.");
      }
      await convex.mutation(markPostsPersisted, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        postCount: posts.length,
        ...(selectedPersistedPost?.scrapedPostId
          ? { scrapedPostId: selectedPersistedPost.scrapedPostId }
          : {}),
        ...(selectedPersistedPost?.sourceRevision
          ? { scrapedPostSourceRevision: selectedPersistedPost.sourceRevision }
          : {}),
        ...(posts[0]?.postId ? { postId: posts[0].postId } : {}),
        ...(posts[0]?.instagramPostUrl
          ? { instagramPostUrl: posts[0].instagramPostUrl }
          : {}),
        processingProtocolVersion: 1,
        serviceSecret,
      });
    }
    if (posts.length > 0) {
      return NextResponse.json({
        claimed: true,
        work: "fetch",
        handle: claimed.handle,
        processingPending: true,
      }, { status: 202 });
    }
    const result = { outcome: "no_post" as const, detail: "provider_completed_without_post" };
    const completion = await convex.mutation(complete, {
      runId,
      receiptId: claimed.receiptId,
      workerId,
      ...result,
      serviceSecret,
    });
    const cleanupDeferred = await runCompletionCleanupOrDefer(completion, true);
    if (cleanupDeferred) return cleanupDeferred;
    return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: result.outcome });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown execution failure";
    const preserveAttempt = isTransientSavedPostProcessingError(error);
    // A provider/network failure remains explicit and retryable; it does not
    // become a false "checked" receipt.
    try {
      await convex.mutation(retry, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        reason,
        ...(preserveAttempt ? { retryAfterMs: 30_000, preserveAttempt: true } : {}),
        serviceSecret,
      });
    } catch (releaseError) {
      return deferredExecutorResponse(releaseError, {
        runId,
        workerSlot,
        workerId,
        claimed: true,
      });
    }
    return NextResponse.json(
      { claimed: true, retryScheduled: true, processingPending: preserveAttempt },
      { status: preserveAttempt ? 202 : 503 },
    );
  }
}
