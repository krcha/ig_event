import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const claim = "durableIngestionRuns:executeNext" as unknown as FunctionReference<"mutation">;
const complete = "durableIngestionRuns:completeReceipt" as unknown as FunctionReference<"mutation">;
const retry = "durableIngestionRuns:releaseReceiptForRetry" as unknown as FunctionReference<"mutation">;

function terminalOutcome(summary: Awaited<ReturnType<typeof runInstagramIngestion>>) {
  const handle = summary.handles[0];
  if (!handle) return { outcome: "deferred" as const, detail: "no_handle_summary" };
  if (handle.errors.length > 0) return { outcome: "deferred" as const, detail: handle.errors[0] };
  return handle.freshFetchAttempted && handle.freshFetchAttempted > 0
    ? { outcome: "fetched" as const, detail: `posts:${handle.fetchedPosts}` }
    : { outcome: "no_post" as const, detail: "provider_completed_without_new_post" };
}

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
    receiptId: string; handle: string; controls: { resultsLimit: number; daysBack?: number; noAgeCutoff?: boolean; skipPinnedPosts: boolean; ignoreCheckpoint: boolean; ignoreCooldown: boolean };
  } | null;
  if (!claimed) return NextResponse.json({ claimed: false, doneOrBusy: true });
  try {
    const summary = await runInstagramIngestion({
      handles: [claimed.handle],
      resultsLimit: claimed.controls.resultsLimit,
      ...(claimed.controls.daysBack === undefined ? {} : { daysBack: claimed.controls.daysBack }),
      noAgeCutoff: claimed.controls.noAgeCutoff ?? claimed.controls.daysBack === undefined,
      skipPinnedPosts: claimed.controls.skipPinnedPosts,
      ignoreCheckpoint: claimed.controls.ignoreCheckpoint,
      ignoreCooldown: claimed.controls.ignoreCooldown,
      mode: "full_scrape",
      serviceSecret,
    });
    const result = terminalOutcome(summary);
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
