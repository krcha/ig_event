import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { getOpenAiDailyPostLimit } from "@/lib/pipeline/instagram-ingestion-durability";
import { processSavedScrapedPostForDurableReceipt } from "@/lib/pipeline/ingestion/durable-saved-posts";
import { isTransientSavedPostProcessingError } from "@/lib/pipeline/durable-ingestion-execute";
import { runFocusedSourceConflictReview, type FocusedSourceConflictReviewClaim } from "@/lib/pipeline/focused-source-conflict-review";
import { buildFocusedSourceConflictContextFingerprint, type FocusedSourceConflictReviewContext } from "@/lib/events/focused-source-conflict-review";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const claimNextWork = "autonomousModeration:claimNextWork" as unknown as FunctionReference<"mutation">;
const completeWork = "autonomousModeration:completeWork" as unknown as FunctionReference<"mutation">;
const getContext = "sourceConflictReviews:getContext" as unknown as FunctionReference<"query">;
const claimReview = "sourceConflictReviews:claim" as unknown as FunctionReference<"mutation">;
const markStarted = "sourceConflictReviews:markStarted" as unknown as FunctionReference<"mutation">;
const finishReview = "sourceConflictReviews:finish" as unknown as FunctionReference<"mutation">;
const applyCompleted = "sourceConflictReviews:applyCompleted" as unknown as FunctionReference<"mutation">;

type Work = {
  holdId: string; eventId: string; expectedUpdatedAt: number; category: string;
  sourcePostId: string; sourceRevision: number; handle: string;
};

function reviewDailyLimit() {
  const value = Number(process.env.AUTONOMOUS_MODERATION_REVIEW_DAILY_LIMIT ?? 20);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(50, value) : 20;
}

/** One leased source per invocation; no Instagram fetch or fresh extraction. */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized moderation request." }, { status: 401 });
  }
  const serviceSecret = requireServiceSecret();
  const convex = createConvexHttpClient();
  const owner = `autonomous-moderation:${randomUUID()}`;
  let work: Work | null = null;
  const complete = async (outcome: "repaired" | "retry" | "held", reason: string, attempted = true) => {
    const recorded = await convex.mutation(completeWork, {
      holdId: work!.holdId, owner, sourceRevision: work!.sourceRevision,
      outcome, reason, attempted, serviceSecret,
    }) as { recorded: boolean };
    if (!recorded.recorded) throw new Error("Automatic moderation work lease changed before completion.");
  };
  try {
    work = await convex.mutation(claimNextWork, {
      owner, allowFocusedReviews: process.env.AUTONOMOUS_MODERATION_AI_ENABLED === "true", serviceSecret,
    }) as Work | null;
    if (!work) return NextResponse.json({ processed: false, state: "idle" });
    if (work.category !== "source_conflict_review") {
      const result = await processSavedScrapedPostForDurableReceipt({
        handle: work.handle, scrapedPostId: work.sourcePostId, expectedSourceRevision: work.sourceRevision,
        workOwner: owner, serviceSecret, requireCachedAnalysisOnly: true,
      });
      if (result.transportAttempted) throw new Error("Cached source recovery attempted an unexpected provider transport.");
      if (result.state === "terminal") {
        await complete(result.outcome === "terminal_permanent_failure" ? "held" : "repaired", result.outcome);
      } else {
        await complete(result.state === "blocked" ? "held" : "retry", result.reason,
          !isTransientSavedPostProcessingError(result.reason));
      }
      return NextResponse.json({ processed: true, eventId: work.eventId, state: result.state });
    }
    const loaded = await convex.query(getContext, {
      sourcePostId: work.sourcePostId, sourceRevision: work.sourceRevision, serviceSecret,
    }) as { context: FocusedSourceConflictReviewContext };
    const review = await runFocusedSourceConflictReview(loaded.context, {
      claim: async (context, reviewKey) => await convex.mutation(claimReview, {
        sourcePostId: context.scrapedPostId, sourceRevision: context.sourceRevision, reviewKey, owner,
        expectedContextFingerprint: buildFocusedSourceConflictContextFingerprint(context),
        dailyReviewLimit: reviewDailyLimit(), globalDailyLimit: getOpenAiDailyPostLimit(), serviceSecret,
      }) as FocusedSourceConflictReviewClaim,
      markStarted: async (reviewKey) => {
        const result = await convex.mutation(markStarted, { reviewKey, owner, serviceSecret }) as { started: boolean };
        if (!result.started) throw new Error("Focused review transport was not authorized.");
      },
      complete: async (reviewKey, response) => {
        const result = await convex.mutation(finishReview, {
          reviewKey, owner, resultJson: JSON.stringify(response.result), rawResponseJson: response.rawResponseJson,
          ...(response.responseId ? { responseId: response.responseId } : {}),
          ...(response.usage ? { usageJson: JSON.stringify(response.usage) } : {}), serviceSecret,
        }) as { recorded: boolean };
        if (!result.recorded) throw new Error("Focused review result persistence was not confirmed.");
      },
      fail: async (reviewKey, failure) => {
        await convex.mutation(finishReview, { reviewKey, owner, error: failure.reason,
          ...(failure.rawResponseJson === undefined ? {} : { rawResponseJson: failure.rawResponseJson }),
          ...(failure.blockedStatus === undefined ? {} : { blockedStatus: failure.blockedStatus }), serviceSecret });
      },
    });
    if (review.status === "deferred") {
      const permanent = ["source_review_already_attempted", "expired_review_day_requires_audit"].includes(review.reason ?? "");
      await complete(permanent ? "held" : "retry", review.reason ?? "review_deferred", false);
    } else if (review.status === "failed") {
      await complete("held", review.reason ?? "focused_review_failed");
    } else {
      const outcomes = await convex.mutation(applyCompleted, { reviewKey: review.reviewKey, serviceSecret }) as
        Array<{ eventId: string; outcome: string; reason: string }>;
      const target = outcomes.find((item) => item.eventId === work!.eventId);
      await complete(target?.outcome === "repaired" || target?.outcome === "already_repaired" ? "repaired" : "held",
        target?.reason ?? "focused_review_requires_source_resolution");
    }
    return NextResponse.json({ processed: true, eventId: work.eventId, state: review.status });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 512) : "Automatic moderation state unavailable.";
    // Never repeat an uncertain paid request. The persisted review marker and
    // expiring work lease govern the next invocation.
    if (work) {
      try { await complete("retry", reason); } catch { /* Keep the lease for durable readback. */ }
    }
    return NextResponse.json({ processed: Boolean(work), state: "deferred", error: reason }, { status: 202 });
  }
}
