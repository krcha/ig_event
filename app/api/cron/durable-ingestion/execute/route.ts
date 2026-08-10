import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { persistScrapedPostsForHandle, runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { scrapeInstagramAccount } from "@/lib/scraper/instagram-scraper";
import { isTransientSavedPostProcessingError } from "@/lib/pipeline/durable-ingestion-execute";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const claim = "durableIngestionRuns:executeNext" as unknown as FunctionReference<"mutation">;
const complete = "durableIngestionRuns:completeReceipt" as unknown as FunctionReference<"mutation">;
const retry = "durableIngestionRuns:releaseReceiptForRetry" as unknown as FunctionReference<"mutation">;
const probe = "durableIngestionRuns:probeRun" as unknown as FunctionReference<"query">;
const markProviderAttempt = "durableIngestionRuns:markReceiptProviderAttemptStarted" as unknown as FunctionReference<"mutation">;
const markPostsPersisted = "durableIngestionRuns:markReceiptPostsPersisted" as unknown as FunctionReference<"mutation">;

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
  const workerId = `vps:${randomUUID()}`;
  const claimed = await convex.mutation(claim, { runId, workerId, workerSlot, serviceSecret }) as {
    receiptId: string; handle: string; controls: { resultsLimit: number; daysBack?: number; noAgeCutoff?: boolean; skipPinnedPosts: boolean; pinnedPostPolicy?: "exclude_all" | "include_recent"; ignoreCheckpoint: boolean; ignoreCooldown: boolean; costPerProfileMicros: number };
    providerAttemptCount?: number;
    providerResultStatus?: "persisted" | "no_post";
  } | null;
  if (!claimed) {
    const state = await convex.query(probe, { runId, serviceSecret }) as { complete?: boolean; status?: string } | null;
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
      await convex.mutation(complete, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        outcome: "deferred",
        detail: "provider_attempt_persistence_unconfirmed",
        serviceSecret,
      });
      return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: "deferred" });
    }
    if (alreadyFetched && claimed.providerResultStatus === "no_post") {
      await convex.mutation(complete, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        outcome: "no_post",
        detail: "persisted_provider_no_post",
        serviceSecret,
      });
      return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: "no_post" });
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
        await convex.mutation(complete, {
          runId,
          receiptId: claimed.receiptId,
          workerId,
          outcome: "deferred",
          detail: providerAttempt.reason ?? "budget_exhausted",
          serviceSecret,
        });
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
      await persistScrapedPostsForHandle(convex, claimed.handle, posts, serviceSecret);
      await convex.mutation(markPostsPersisted, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        postCount: posts.length,
        serviceSecret,
      });
    }
    const summary = await runInstagramIngestion({
      handles: [claimed.handle],
      // Fresh content is already persisted above. This phase keeps the existing
      // AI prompt/model and event processing path unchanged.
      resultsLimit: claimed.controls.resultsLimit,
      ...(claimed.controls.daysBack === undefined ? {} : { daysBack: claimed.controls.daysBack }),
      noAgeCutoff: claimed.controls.noAgeCutoff ?? claimed.controls.daysBack === undefined,
      skipPinnedPosts: claimed.controls.skipPinnedPosts,
      ignoreCheckpoint: claimed.controls.ignoreCheckpoint,
      ignoreCooldown: claimed.controls.ignoreCooldown,
      mode: "saved_posts",
      serviceSecret,
    });
    const processingError = summary.handles[0]?.errors[0];
    if (processingError) {
      const preserveAttempt = isTransientSavedPostProcessingError(processingError);
      await convex.mutation(retry, {
        runId,
        receiptId: claimed.receiptId,
        workerId,
        reason: processingError,
        ...(preserveAttempt ? { retryAfterMs: 30_000, preserveAttempt: true } : {}),
        serviceSecret,
      });
      return NextResponse.json({
        claimed: true,
        handle: claimed.handle,
        retryScheduled: true,
        processingPending: preserveAttempt,
      }, { status: preserveAttempt ? 202 : 503 });
    }
    const result = alreadyFetched || posts.length > 0
      ? { outcome: "fetched" as const, detail: `posts:${posts.length}` }
      : { outcome: "no_post" as const, detail: "provider_completed_without_post" };
    await convex.mutation(complete, { runId, receiptId: claimed.receiptId, workerId, ...result, serviceSecret });
    return NextResponse.json({ claimed: true, handle: claimed.handle, outcome: result.outcome });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown execution failure";
    // A provider/network failure remains explicit and retryable; it does not
    // become a false "checked" receipt.
    await convex.mutation(retry, { runId, receiptId: claimed.receiptId, workerId, reason, serviceSecret });
    return NextResponse.json({ claimed: true, retryScheduled: true }, { status: 503 });
  }
}
