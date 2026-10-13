import { v } from "convex/values";
import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { loadCurrentSourceConflictInputs } from "./internal/sourceConflictReviewContext";
import { adaptInstagramScrapedPostToSourceDocument } from "../lib/domain/source-documents";
import { getBudgetDayKey } from "../lib/pipeline/instagram-ingestion-durability";
import { repairPendingBenignSourceConflictHandler } from "./internal/eventRepairs/pendingBenignSourceConflicts";
import { hasPersistedFocusedConflictReviewProof } from "./internal/focusedConflictReviewProof";
import { assertFocusedSourceConflictReviewContext, buildFocusedSourceConflictReviewKey, buildFocusedSourceConflictContextFingerprint, buildFocusedSourceConflictReviewSupplement, parseFocusedSourceConflictReviewResult,
  validateFocusedSourceConflictReviewResult, type FocusedSourceConflictReviewContext } from "../lib/events/focused-source-conflict-review";

type ReadCtx = QueryCtx | MutationCtx;
const LEASE_MS = 5 * 60_000;
const REVIEW_PROVIDER = "openai_conflict_review";
const MAX_CONTEXT_BYTES = 600_000;

async function currentContext(ctx: ReadCtx, sourcePostId: Parameters<typeof loadCurrentSourceConflictInputs>[1], sourceRevision: number) {
  const input = await loadCurrentSourceConflictInputs(ctx, sourcePostId, sourceRevision);
  const context: FocusedSourceConflictReviewContext = {
    scrapedPostId: input.source._id, sourceRevision, sourceIdentity: adaptInstagramScrapedPostToSourceDocument(input.source).sourceIdentity,
    sourceFingerprint: input.fingerprint, instagramPostUrl: input.source.instagramPostUrl, caption: input.source.caption ?? "",
    altText: input.source.altText ?? "", locationName: input.source.locationName ?? "", postedAt: input.source.postedAt ?? "",
    analysisResultJson: input.source.analysisResultJson!, retainedImages: input.images,
    events: input.events.map((event) => ({ id: event._id, updatedAt: event.updatedAt, status: "pending",
      title: event.title, date: event.date, time: event.time ?? "", venue: event.venue, artists: event.artists,
      rawExtractionJson: event.rawExtractionJson!, normalizedFieldsJson: event.normalizedFieldsJson!,
      sourceCaption: event.sourceCaption ?? "", ...(event.sourcePostedAt ? { sourcePostedAt: event.sourcePostedAt } : {}),
      sourceConflictFields: event.sourceConflictFields! })),
  };
  assertFocusedSourceConflictReviewContext(context);
  const contextJson = JSON.stringify(context);
  if (new TextEncoder().encode(contextJson).length > MAX_CONTEXT_BYTES) throw new Error("Focused review context exceeds its persisted bound.");
  return { context, contextJson, reviewKey: buildFocusedSourceConflictReviewKey(context) };
}
async function requireService(ctx: ReadCtx, secret: string | undefined) {
  if ((await requireAdminOrServiceSecret(ctx, secret)).kind !== "service") throw new Error("Focused review state requires service authentication.");
}
async function budgetRows(ctx: MutationCtx, day: string) {
  const rows = [];
  for (const provider of ["openai", REVIEW_PROVIDER]) {
    const found = await ctx.db.query("ingestionDailyBudgets").withIndex("by_key", (q) => q.eq("key", provider + ":" + day)).take(2);
    if (found.length > 1) throw new Error("Focused review budget is not unique.");
    rows.push({ provider, row: found[0] });
  }
  return rows;
}
async function releaseProvider(ctx: MutationCtx, owner: string, blockedStatus?: number) {
  const rows = await ctx.db.query("ingestionProviderLeases").withIndex("by_provider", (q) => q.eq("provider", "openai")).take(2);
  if (rows.length > 1) throw new Error("OpenAI provider lease is not unique.");
  const lease = rows[0];
  if (!lease || lease.owner !== owner) return;
  const now = Date.now();
  await ctx.db.patch(lease._id, { leaseExpiresAt: now, updatedAt: now,
    ...(blockedStatus === undefined ? lease.blockedAt !== undefined ? {} : { circuitState: "closed" as const, blockedAt: undefined, blockedStatus: undefined, blockedCode: undefined, cooldownUntil: undefined } : { blockedAt: now, blockedStatus, blockedCode: "focused_review_provider_blocked",
      circuitState: "open" as const, cooldownUntil: now + 60 * 60_000, failureCount: (lease.failureCount ?? 0) + 1 }) });
}
export const getContext = query({
  args: { sourcePostId: v.id("scrapedPosts"), sourceRevision: v.number(), serviceSecret: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return currentContext(ctx, args.sourcePostId, args.sourceRevision);
  },
});
export const claim = mutation({
  args: { sourcePostId: v.id("scrapedPosts"), sourceRevision: v.number(), reviewKey: v.string(), owner: v.string(),
    expectedContextFingerprint: v.string(), dailyReviewLimit: v.number(), globalDailyLimit: v.number(), serviceSecret: v.optional(v.string()) },
  returns: v.union(v.object({ status: v.literal("claimed") }), v.object({ status: v.literal("cached"), resultJson: v.string(), contextJson: v.string() }),
    v.object({ status: v.literal("deferred"), reason: v.string() })),
  handler: async (ctx, args) => {
    await requireService(ctx, args.serviceSecret);
    if (!args.owner.trim() || args.owner.length > 200 || !Number.isSafeInteger(args.dailyReviewLimit) ||
        !Number.isSafeInteger(args.globalDailyLimit) || args.dailyReviewLimit < 1 || args.globalDailyLimit < 1)
      throw new Error("Focused review requires a bounded owner and positive integer budgets.");
    const current = await currentContext(ctx, args.sourcePostId, args.sourceRevision);
    if (current.reviewKey !== args.reviewKey) throw new Error("Focused review source generation changed.");
    if (buildFocusedSourceConflictContextFingerprint(current.context) !== args.expectedContextFingerprint) throw new Error("Focused review event facts changed before claim.");
    const matches = await ctx.db.query("sourceConflictReviews").withIndex("by_reviewKey", (q) => q.eq("reviewKey", args.reviewKey)).take(2);
    if (matches.length > 1) throw new Error("Focused review key is not unique.");
    const existing = matches[0], now = Date.now(), day = getBudgetDayKey(new Date(now));
    if (existing?.status === "completed" && existing.resultJson) return { status: "cached" as const, resultJson: existing.resultJson, contextJson: existing.contextJson };
    if (existing?.requestStartedAt !== undefined || (existing && existing.status !== "claimed"))
      return { status: "deferred" as const, reason: "source_review_already_attempted" };
    if (existing && existing.leaseExpiresAt > now) return { status: "deferred" as const, reason: "source_review_busy" };
    if (existing && existing.dayKey !== day) return { status: "deferred" as const, reason: "expired_review_day_requires_audit" };
    const leases = await ctx.db.query("ingestionProviderLeases").withIndex("by_provider", (q) => q.eq("provider", "openai")).take(2);
    if (leases.length > 1) throw new Error("OpenAI provider lease is not unique.");
    const lease = leases[0];
    if (lease?.blockedAt && (lease.cooldownUntil ?? Infinity) > now) return { status: "deferred" as const, reason: "provider_blocked" };
    if (lease && lease.leaseExpiresAt > now && lease.owner !== args.owner) return { status: "deferred" as const, reason: "provider_busy" };
    const budgets = await budgetRows(ctx, day);
    const limits = [Math.min(10_000, args.globalDailyLimit), Math.min(50, args.dailyReviewLimit)];
    if (!existing && budgets.some(({ row }, index) => (row?.chargedMicros ?? 0) + (row?.reservedMicros ?? 0) >= limits[index]!))
      return { status: "deferred" as const, reason: "budget_exhausted" };
    // Read all budgets before writing either reservation; denial cannot leave
    // a partial reservation committed.
    if (!existing) for (let i = 0; i < budgets.length; i++) {
      const { provider, row } = budgets[i]!;
      if (row) await ctx.db.patch(row._id, { limitMicros: limits[i]!, reservedMicros: row.reservedMicros + 1,
        reservationCount: row.reservationCount + 1, updatedAt: now });
      else await ctx.db.insert("ingestionDailyBudgets", { key: provider + ":" + day, provider, dayKey: day,
        limitMicros: limits[i]!, reservedMicros: 1, chargedMicros: 0, releasedMicros: 0,
        reservationCount: 1, reconciledCount: 0, createdAt: now, updatedAt: now });
    }
    if (lease) await ctx.db.patch(lease._id, { owner: args.owner, leaseExpiresAt: now + LEASE_MS,
      circuitState: lease.blockedAt ? "half_open" : "closed", blockedAt: undefined, updatedAt: now });
    else await ctx.db.insert("ingestionProviderLeases", { provider: "openai", owner: args.owner,
      leaseExpiresAt: now + LEASE_MS, circuitState: "closed", createdAt: now, updatedAt: now });
    if (existing) await ctx.db.patch(existing._id, { owner: args.owner, leaseExpiresAt: now + LEASE_MS, contextJson: current.contextJson, updatedAt: now });
    else await ctx.db.insert("sourceConflictReviews", { reviewKey: args.reviewKey, sourcePostId: args.sourcePostId,
      sourceRevision: args.sourceRevision, sourceFingerprint: current.context.sourceFingerprint, policyVersion: 1,
      contextJson: current.contextJson, dayKey: day, status: "claimed", owner: args.owner,
      leaseExpiresAt: now + LEASE_MS, createdAt: now, updatedAt: now });
    return { status: "claimed" as const };
  },
});
export const markStarted = mutation({
  args: { reviewKey: v.string(), owner: v.string(), serviceSecret: v.optional(v.string()) }, returns: v.object({ started: v.boolean() }),
  handler: async (ctx, args) => {
    await requireService(ctx, args.serviceSecret);
    const rows = await ctx.db.query("sourceConflictReviews").withIndex("by_reviewKey", (q) => q.eq("reviewKey", args.reviewKey)).take(2);
    const review = rows.length === 1 ? rows[0] : null, now = Date.now();
    if (!review || review.status !== "claimed" || review.owner !== args.owner || review.leaseExpiresAt <= now ||
        review.requestStartedAt !== undefined || review.dayKey !== getBudgetDayKey(new Date(now))) throw new Error("Focused review start fence changed.");
    const current = await currentContext(ctx, review.sourcePostId, review.sourceRevision);
    if (current.reviewKey !== review.reviewKey) throw new Error("Focused review source changed before transport.");
    if (buildFocusedSourceConflictContextFingerprint(current.context) !== buildFocusedSourceConflictContextFingerprint(JSON.parse(review.contextJson))) {
      throw new Error("Focused review event facts changed before transport.");
    }
    const leases = await ctx.db.query("ingestionProviderLeases").withIndex("by_provider", (q) => q.eq("provider", "openai")).take(2);
    const lease = leases.length === 1 ? leases[0] : null;
    if (!lease || lease.owner !== args.owner || lease.leaseExpiresAt <= now || lease.blockedAt) throw new Error("Focused review provider lease changed.");
    const budgets = await budgetRows(ctx, review.dayKey);
    if (budgets.some(({ row }) => !row || row.reservedMicros < 1)) throw new Error("Focused review reservation is missing.");
    for (const { row } of budgets) await ctx.db.patch(row!._id, { reservedMicros: row!.reservedMicros - 1,
      chargedMicros: row!.chargedMicros + 1, reconciledCount: row!.reconciledCount + 1, updatedAt: now });
    await ctx.db.patch(review._id, { status: "transport_started", requestStartedAt: now, leaseExpiresAt: now + LEASE_MS, updatedAt: now });
    await ctx.db.patch(lease._id, { leaseExpiresAt: now + LEASE_MS, updatedAt: now });
    return { started: true };
  },
});
export const finish = mutation({
  args: { reviewKey: v.string(), owner: v.string(), resultJson: v.optional(v.string()), rawResponseJson: v.optional(v.string()),
    responseId: v.optional(v.string()), usageJson: v.optional(v.string()), error: v.optional(v.string()), blockedStatus: v.optional(v.number()),
    serviceSecret: v.optional(v.string()) }, returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    await requireService(ctx, args.serviceSecret);
    const rows = await ctx.db.query("sourceConflictReviews").withIndex("by_reviewKey", (q) => q.eq("reviewKey", args.reviewKey)).take(2);
    const review = rows.length === 1 ? rows[0] : null;
    if (!review || review.owner !== args.owner) return { recorded: false };
    if (review.status === "completed") return { recorded: true };
    if (!["claimed", "transport_started"].includes(review.status)) return { recorded: false };
    const bytes = (value: string | undefined) => new TextEncoder().encode(value ?? "").length;
    if (bytes(args.rawResponseJson) > 200_000 || bytes(args.resultJson) > 60_000 || bytes(args.usageJson) > 2000)
      throw new Error("Focused review result exceeds its retained bound.");
    if (args.resultJson !== undefined) {
      if (review.status !== "transport_started" || review.requestStartedAt === undefined || !args.rawResponseJson)
        throw new Error("Completed review requires an attested provider transport.");
      const context = JSON.parse(review.contextJson) as FocusedSourceConflictReviewContext;
      validateFocusedSourceConflictReviewResult(context, parseFocusedSourceConflictReviewResult(JSON.parse(args.resultJson)));
    }
    const started = review.requestStartedAt !== undefined, now = Date.now();
    if (!started) {
      for (const { row } of await budgetRows(ctx, review.dayKey)) {
        if (!row || row.reservedMicros < 1) throw new Error("Focused review release reservation is missing.");
        await ctx.db.patch(row._id, { reservedMicros: row.reservedMicros - 1, releasedMicros: row.releasedMicros + 1, reconciledCount: row.reconciledCount + 1, updatedAt: now });
      }
    }
    await ctx.db.patch(review._id, { status: args.resultJson !== undefined ? "completed" : started && !args.rawResponseJson ? "transport_unknown" : "failed",
      resultJson: args.resultJson, rawResponseJson: args.rawResponseJson, responseId: args.responseId?.slice(0, 200),
      usageJson: args.usageJson, error: args.error?.slice(0, 700), leaseExpiresAt: now, updatedAt: now });
    await releaseProvider(ctx, args.owner, args.blockedStatus);
    return { recorded: true };
  },
});

/** Reclassification keeps every public fact and raw extraction byte intact. */
export const applyCompleted = mutation({
  args: { reviewKey: v.string(), serviceSecret: v.optional(v.string()) },
  returns: v.array(v.object({ eventId: v.id("events"), outcome: v.string(), reason: v.string() })),
  handler: async (ctx, args) => {
    await requireService(ctx, args.serviceSecret);
    const rows = await ctx.db.query("sourceConflictReviews").withIndex("by_reviewKey", (q) => q.eq("reviewKey", args.reviewKey)).take(2);
    const review = rows.length === 1 ? rows[0] : null;
    if (!review || review.status !== "completed" || !review.resultJson) throw new Error("A completed retained conflict review is required.");
    const stored = JSON.parse(review.contextJson) as FocusedSourceConflictReviewContext;
    if (buildFocusedSourceConflictReviewKey(stored) !== review.reviewKey) throw new Error("Focused review source binding is invalid.");
    const result = parseFocusedSourceConflictReviewResult(JSON.parse(review.resultJson));
    const validations = validateFocusedSourceConflictReviewResult(stored, result);
    const outcomes = [];
    for (const validation of validations) {
      const event = stored.events.find((candidate) => candidate.id === validation.eventId)!;
      const id = ctx.db.normalizeId("events", event.id);
      if (!id) throw new Error("Focused review event ID is invalid.");
      const supplement = buildFocusedSourceConflictReviewSupplement(stored, result, event.id);
      if (validation.disposition !== "deterministic_reclassification" || !supplement) {
        outcomes.push({ eventId: id, outcome: validation.disposition, reason: validation.reason });
        continue;
      }
      const current = await ctx.db.get(id);
      const marker = { reviewId: review._id, reviewKey: review.reviewKey,
        policyVersion: 1, contextFingerprint: buildFocusedSourceConflictContextFingerprint(stored), eventId: event.id,
        posterTexts: supplement.posterTexts, captionQuotes: supplement.captionQuotes };
      if (!current) { outcomes.push({ eventId: id, outcome: "held", reason: "event_generation_changed" }); continue; }
      let fields: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(current.normalizedFieldsJson ?? "null");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_event_evidence");
        fields = value as Record<string, unknown>;
      } catch {
        outcomes.push({ eventId: id, outcome: "held", reason: "current_event_evidence_invalid" }); continue;
      }
      const candidate = { ...current, normalizedFieldsJson: JSON.stringify({ ...fields, focusedSourceConflictReview: marker }) };
      if (!(await hasPersistedFocusedConflictReviewProof(ctx, candidate))) {
        outcomes.push({ eventId: id, outcome: "held", reason: "focused_review_current_source_or_facts_changed" }); continue;
      }
      if (JSON.stringify(fields.focusedSourceConflictReview) === JSON.stringify(marker) &&
          (current.sourceConflictFields?.length ?? 0) === 0 && fields.materialSourceConflictCount === 0) {
        outcomes.push({ eventId: id, outcome: "already_repaired", reason: "verified_benign_source_conflicts" }); continue;
      }
      const repaired = await repairPendingBenignSourceConflictHandler(ctx, { id, expectedUpdatedAt: current.updatedAt,
        actor: "service:autonomous-moderation", reviewMarker: marker });
      outcomes.push({ eventId: id, outcome: repaired.outcome, reason: repaired.reason });
    }
    return outcomes;
  },
});
