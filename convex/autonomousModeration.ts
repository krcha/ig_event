import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";

const MAX_SOURCE_RECOVERY_ATTEMPTS = 3;
const workResult = v.union(v.null(), v.object({
  holdId: v.id("automaticApprovalHolds"), eventId: v.id("events"), expectedUpdatedAt: v.number(),
  category: v.string(), sourcePostId: v.id("scrapedPosts"), sourceRevision: v.number(), handle: v.string(),
}));

/** A claim never fetches Instagram or changes immutable analysis bytes. */
export const claimNextWork = mutation({
  args: { owner: v.string(), allowFocusedReviews: v.optional(v.boolean()), serviceSecret: v.optional(v.string()) }, returns: workResult,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const owner = args.owner.trim();
    if (!owner || owner.length > 200) throw new Error("A bounded recovery owner is required.");
    const now = Date.now();
    const categories = ["saved_source_reprocess", "source_binding_repair", "occurrence_completion",
      ...(args.allowFocusedReviews === true ? ["source_conflict_review"] : [])];
    const candidates = [];
    for (const category of categories) {
      for (const status of ["queued", "processing"] as const) {
        candidates.push(...await ctx.db.query("automaticApprovalHolds")
          .withIndex("by_repairCategory_status_nextRetryAt", (q) => q.eq("repairCategory", category).eq("status", status).lte("nextRetryAt", now)).take(5));
      }
    }
    for (const hold of candidates.sort((a, b) => a.nextRetryAt - b.nextRetryAt)) {
      if ((hold.leaseExpiresAt ?? 0) > now) continue;
      const event = await ctx.db.get(hold.eventId);
      if (!event || event.status !== "pending" || event.updatedAt !== hold.expectedUpdatedAt ||
          !hold.sourcePostId || hold.sourceRevision === undefined) {
        await ctx.db.patch(hold._id, { status: "resolved", lastRepairReason: "event_generation_changed", updatedAt: now });
        continue;
      }
      if (hold.repairAttemptCount >= MAX_SOURCE_RECOVERY_ATTEMPTS) {
        // Retry budgets never override a human decision.
        await ctx.db.patch(hold._id, { status: "held", lastRepairReason: "repair_attempt_limit", updatedAt: now });
        continue;
      }
      let normalizedFields: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
        normalizedFields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch { /* Invalid evidence stays held. */ }
      if (event.reviewedAt !== undefined || event.reviewedBy !== undefined ||
          event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined ||
          normalizedFields?.humanReviewedLegacySourcePolicyVersion !== undefined || normalizedFields?.humanReviewedStructuredSourcePolicyVersion !== undefined) {
        await ctx.db.patch(hold._id, { status: "resolved", lastRepairReason: "human_review_preserved", updatedAt: now });
        continue;
      }
      if (!normalizedFields) {
        await ctx.db.patch(hold._id, { status: "held", lastRepairReason: "invalid_normalized_evidence", updatedAt: now });
        continue;
      }
      const source = await ctx.db.get(hold.sourcePostId);
      if (!source || (source.sourceRevision ?? 1) !== hold.sourceRevision ||
          source.analysisRevision !== hold.sourceRevision || source.analysisContractVersion !== "event_evidence_v2" ||
          !source.analysisResultJson || (hold.repairCategory === "source_conflict_review" && source.analysisResultJson !== event.rawExtractionJson) ||
          source.processingOutcome === "openai_transport_ambiguous" || source.processingOutcome === "terminal_permanent_failure" ||
          (source.processingStatus === "processing" && (source.processingLeaseExpiresAt ?? 0) > now)) {
        await ctx.db.patch(hold._id, { status: "held", lastRepairReason: "current_saved_source_unavailable", updatedAt: now });
        continue;
      }
      const conflict = hold.repairCategory === "source_conflict_review";
      const needsCachedProcessing = !conflict || source.processingStatus !== "completed";
      if (!conflict && source.processingOutcome === "source_media_partial") {
        await ctx.db.patch(hold._id, { status: "held", lastRepairReason: "unread_source_media_requires_review", updatedAt: now });
        continue;
      }
      // An expired external claim is counted: its transport may have happened.
      // Cached processing can resume safely under the ordinary source lease.
      await ctx.db.patch(hold._id, { status: "processing", leaseOwner: owner, leaseExpiresAt: now + 5 * 60_000,
        nextRetryAt: now + 5 * 60_000, repairAttemptCount: hold.repairAttemptCount + 1, updatedAt: now });
      if (needsCachedProcessing && source.processingStatus === "completed") {
        await ctx.db.patch(source._id, { processingStatus: "pending", processingOutcome: "automatic_cached_source_recovery",
          processingRetryAt: undefined, processingError: undefined, blocksPaidFetch: true, updatedAt: now });
      }
      return { holdId: hold._id, eventId: event._id, expectedUpdatedAt: event.updatedAt,
        category: needsCachedProcessing && conflict ? "occurrence_completion" : hold.repairCategory,
        sourcePostId: source._id, sourceRevision: hold.sourceRevision, handle: source.handle };
    }
    return null;
  },
});

export const completeWork = mutation({
  args: { holdId: v.id("automaticApprovalHolds"), owner: v.string(), sourceRevision: v.number(),
    outcome: v.union(v.literal("repaired"), v.literal("retry"), v.literal("held")), reason: v.string(), attempted: v.optional(v.boolean()), serviceSecret: v.optional(v.string()) },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.status !== "processing" || hold.leaseOwner !== args.owner || hold.sourceRevision !== args.sourceRevision ||
        (hold.leaseExpiresAt ?? 0) <= Date.now()) return { recorded: false };
    const source = hold.sourcePostId ? await ctx.db.get(hold.sourcePostId) : null;
    const event = await ctx.db.get(hold.eventId);
    if (!source || (source.sourceRevision ?? 1) !== hold.sourceRevision || source.analysisRevision !== hold.sourceRevision ||
        !event || event.status !== "pending" || event.updatedAt !== hold.expectedUpdatedAt || event.reviewedAt !== undefined || event.reviewedBy !== undefined ||
        event.humanReviewedLegacySourcePolicyVersion !== undefined || event.humanReviewedStructuredSourcePolicyVersion !== undefined) return { recorded: false };
    try {
      const fields = JSON.parse(event.normalizedFieldsJson ?? "null");
      if (!fields || typeof fields !== "object" || Array.isArray(fields) ||
          fields.humanReviewedLegacySourcePolicyVersion !== undefined || fields.humanReviewedStructuredSourcePolicyVersion !== undefined) return { recorded: false };
    } catch { return { recorded: false }; }
    const now = Date.now();
    const attempts = args.attempted === false ? Math.max(0, hold.repairAttemptCount - 1) : hold.repairAttemptCount;
    await ctx.db.patch(hold._id, { status: args.outcome === "repaired" ? "resolved" : args.outcome === "retry" && attempts < MAX_SOURCE_RECOVERY_ATTEMPTS ? "queued" : "held",
      repairAttemptCount: attempts,
      lastRepairReason: args.reason.slice(0, 300), nextRetryAt: now + 30 * 60_000,
      leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return { recorded: true };
  },
});

export const getHolds = query({
  args: { eventIds: v.array(v.id("events")), serviceSecret: v.optional(v.string()) },
  returns: v.array(v.object({ eventId: v.id("events"), expectedUpdatedAt: v.number(), holdReason: v.string(), repairReason: v.union(v.string(), v.null()),
    repairCategory: v.string(), status: v.string(), repairAttemptCount: v.number(), observedAt: v.number() })),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.eventIds.length > 50 || new Set(args.eventIds).size !== args.eventIds.length) throw new Error("Diagnostics require at most 50 unique event IDs.");
    const result = [];
    for (const id of args.eventIds) {
      const rows = await ctx.db.query("automaticApprovalHolds").withIndex("by_event", (q) => q.eq("eventId", id)).take(2);
      if (rows.length > 1) throw new Error("Automatic approval hold is not unique.");
      const h = rows[0];
      if (h) result.push({ eventId: h.eventId, expectedUpdatedAt: h.expectedUpdatedAt, holdReason: h.holdReason,
        repairReason: h.lastRepairReason ?? null, repairCategory: h.repairCategory, status: h.status, repairAttemptCount: h.repairAttemptCount, observedAt: h.observedAt });
    }
    return result;
  },
});
