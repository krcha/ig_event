import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { buildPendingModerationUniquenessReview } from "./eventDomain/moderationUniqueness";
import { automaticUniqueApprovalDiagnosticValidator, evaluateAutomaticUniqueApproval, type AutomaticUniqueApprovalDiagnostic } from "./internal/automaticUniqueApprovalPreflight";

/** Reads exact pending versions; never patches events, source rows, or holds. */
export const diagnosePending = query({
  args: { items: v.array(v.object({ id: v.id("events"), expectedUpdatedAt: v.number() })), asOfMs: v.optional(v.number()), serviceSecret: v.optional(v.string()) },
  returns: v.object({ observedAt: v.number(), items: v.array(automaticUniqueApprovalDiagnosticValidator) }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.items.length < 1 || args.items.length > 5 || new Set(args.items.map((item) => item.id)).size !== args.items.length ||
        args.items.some((item) => !Number.isSafeInteger(item.expectedUpdatedAt))) throw new Error("Automatic approval diagnostics require 1-5 unique exact pending event versions.");
    const observedAt = args.asOfMs ?? Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Automatic approval diagnostics require a non-negative safe-integer clock.");
    const events = await Promise.all(args.items.map((item) => ctx.db.get(item.id)));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]; const item = args.items[index]!;
      if (!event || event.status !== "pending" || event.updatedAt !== item.expectedUpdatedAt) throw new Error(`Event changed since the reviewed version: ${item.id}.`);
    }
    if (new Set(events.map((event) => event!.date)).size !== 1) throw new Error("Automatic approval diagnostics require one same-date batch.");
    const prebuiltReview = await buildPendingModerationUniquenessReview(ctx, { items: args.items, asOfMs: observedAt, moderationNote: "Automatic source and uniqueness verification; no human moderation is claimed." });
    const items: AutomaticUniqueApprovalDiagnostic[] = [];
    for (const event of events) {
      if (!event) throw new Error("Exact pending event disappeared.");
      items.push((await evaluateAutomaticUniqueApproval(ctx, event, { asOfMs: observedAt, prebuiltReview })).diagnostic);
    }
    return { observedAt, items };
  },
});
