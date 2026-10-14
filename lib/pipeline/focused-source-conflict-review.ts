import { buildFocusedSourceConflictReviewKey, buildFocusedSourceConflictContextFingerprint, parseFocusedSourceConflictReviewResult,
  validateFocusedSourceConflictReviewResult, type FocusedSourceConflictReviewContext, type FocusedSourceConflictValidation } from "@/lib/events/focused-source-conflict-review";
import { reviewSourceConflicts, type FocusedSourceConflictTransportResult, type FocusedSourceConflictTransportOptions } from "@/lib/ai/review-source-conflicts";
import { isOpenAiProviderBlockedError } from "@/lib/ai/extract-event-data";
export type FocusedSourceConflictReviewClaim = { status: "claimed" } | { status: "cached"; resultJson: string; contextJson: string } | { status: "deferred"; reason: string };
export type FocusedSourceConflictReviewDependencies = {
  claim: (context: FocusedSourceConflictReviewContext, reviewKey: string) => Promise<FocusedSourceConflictReviewClaim>;
  markStarted: (reviewKey: string) => Promise<void>;
  complete: (reviewKey: string, response: FocusedSourceConflictTransportResult) => Promise<void>;
  fail: (reviewKey: string, failure: { reason: string; transportStarted: boolean; blockedStatus?: number; rawResponseJson?: string }) => Promise<void>;
  review?: (context: FocusedSourceConflictReviewContext, options: FocusedSourceConflictTransportOptions) => Promise<FocusedSourceConflictTransportResult>;
};
export type FocusedSourceConflictReviewRun = { status: "completed" | "cached" | "deferred" | "failed"; reviewKey: string; validation: FocusedSourceConflictValidation[]; reason?: string };
/** Persistence controls one request; this coordinator never writes public facts. */
export async function runFocusedSourceConflictReview(
  context: FocusedSourceConflictReviewContext, deps: FocusedSourceConflictReviewDependencies,
): Promise<FocusedSourceConflictReviewRun> {
  const reviewKey = buildFocusedSourceConflictReviewKey(context), claim = await deps.claim(context, reviewKey);
  if (claim.status === "deferred") return { status: "deferred", reviewKey, validation: [], reason: claim.reason };
  if (claim.status === "cached") {
    const cachedContext = JSON.parse(claim.contextJson) as FocusedSourceConflictReviewContext;
    const retainedEvents = cachedContext.events.filter((event) => context.events.some((current) => current.id === event.id));
    if (retainedEvents.length !== context.events.length || buildFocusedSourceConflictReviewKey(cachedContext) !== reviewKey ||
        buildFocusedSourceConflictContextFingerprint({ ...cachedContext, events: retainedEvents }) !== buildFocusedSourceConflictContextFingerprint(context))
      return { status: "deferred", reviewKey, validation: [], reason: "Cached source review no longer matches pending event facts." };
    const result = parseFocusedSourceConflictReviewResult(JSON.parse(claim.resultJson) as unknown);
    return { status: "cached", reviewKey, validation: validateFocusedSourceConflictReviewResult(cachedContext, result)
      .filter((event) => context.events.some((current) => current.id === event.eventId))
      .map((event) => ({ ...event, expectedUpdatedAt: context.events.find((current) => current.id === event.eventId)!.updatedAt })) };
  }
  let transportStarted = false;
  let received: FocusedSourceConflictTransportResult | undefined;
  try {
    const output = received = await (deps.review ?? reviewSourceConflicts)(context, { beforeTransport: async () => { await deps.markStarted(reviewKey); transportStarted = true; } });
    const validation = validateFocusedSourceConflictReviewResult(context, output.result);
    await deps.complete(reviewKey, output);
    return { status: "completed", reviewKey, validation };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Focused review failed.";
    const raw = error && typeof error === "object" && "rawResponseJson" in error && typeof error.rawResponseJson === "string" ? error.rawResponseJson : received?.rawResponseJson;
    await deps.fail(reviewKey, { reason, transportStarted, ...(isOpenAiProviderBlockedError(error) ? { blockedStatus: error.status } : {}), ...(raw === undefined ? {} : { rawResponseJson: raw }) });
    return { status: "failed", reviewKey, validation: [], reason };
  }
}
