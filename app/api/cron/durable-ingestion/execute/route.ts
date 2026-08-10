import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { persistScrapedPostsForHandle, runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { scrapeInstagramAccount } from "@/lib/scraper/instagram-scraper";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const claim = "durableIngestionRuns:executeNext" as unknown as FunctionReference<"mutation">;
const complete = "durableIngestionRuns:completeReceipt" as unknown as FunctionReference<"mutation">;
const retry = "durableIngestionRuns:releaseReceiptForRetry" as unknown as FunctionReference<"mutation">;

/** One receipt per request. The VPS starts at most eight of these requests in
 * parallel; Convex also enforces the run's eight-slot semaphore. */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });
  const serviceSecret = requireServiceSecret();
  const convex = createConvexHttpClient();
  const workerId = `vps:${randomUUID()}`;
  const claimed = await convex.mutation(claim, { runId, workerId, serviceSecret }) as {
    receiptId: string; handle: string; controls: { resultsLimit: number; daysBack?: number; noAgeCutoff?: boolean; skipPinnedPosts: boolean; ignoreCheckpoint: boolean; ignoreCooldown: boolean; costPerProfileMicros: number };
  } | null;
  if (!claimed) return NextResponse.json({ claimed: false, doneOrBusy: true });
  try {
    // The controller owns the provider reservation and eight-slot semaphore.
    // Do not enter the legacy singleton paid-fetch lease here: that old safety
    // layer serializes all accounts and would turn eight workers into one.
    const posts = await scrapeInstagramAccount({
      handle: claimed.handle,
      resultsLimit: claimed.controls.resultsLimit,
      ...(claimed.controls.daysBack === undefined ? {} : { daysBack: claimed.controls.daysBack }),
      noAgeCutoff: claimed.controls.noAgeCutoff ?? claimed.controls.daysBack === undefined,
      skipPinnedPosts: claimed.controls.skipPinnedPosts,
      maxTotalChargeUsd: claimed.controls.costPerProfileMicros / 1_000_000,
    });
    // Controller receipts fence this new path. Omit the legacy global lease
    // owner so persistence accepts the controller-owned concurrent fetch.
    await persistScrapedPostsForHandle(convex, claimed.handle, posts, serviceSecret);
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
    const result = processingError
      ? { outcome: "deferred" as const, detail: processingError }
      : posts.length > 0
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
