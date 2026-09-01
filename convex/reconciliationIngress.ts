import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { requireAdminOrServiceSecret } from "./authz";
import { mutation } from "./_generated/server";
import {
  assertSourceOccurrencePlanWithinBounds,
  assertSourceProcessingFence,
  prepareSourceOccurrencePlanForReconciliation,
  reconcileSourceOccurrenceReceiptAndSync,
  sourceOccurrencePlan,
  sourceProcessingFence,
} from "./internal/sourceOccurrenceReceipts";
import {
  assertReconciliationIngestionApplyEnabled,
  reconciliationIngestionApplyIsEnabled,
} from "./internal/reconciliationRollout";
import { executeSourceOccurrenceHandler } from "./internal/reconciliationSourceExecutor";

const genericIngestionAction = v.union(
  v.literal("attach"),
  v.literal("create"),
  v.literal("manual_review"),
  v.literal("update"),
);

const genericIngestionResult = v.union(
  v.object({
    authority: v.literal("legacy"),
    outcomes: v.array(v.any()),
  }),
  v.object({
    authority: v.literal("reconciliation"),
    outcomes: v.array(
      v.object({
        action: genericIngestionAction,
        applied: v.boolean(),
        canonicalEventId: v.optional(v.id("events")),
        canonicalEventStatus: v.optional(
          v.union(
            v.literal("approved"),
            v.literal("pending"),
            v.literal("rejected"),
          ),
        ),
        sourceOccurrenceId: v.id("sourceOccurrences"),
        sourceOccurrenceKey: v.string(),
      }),
    ),
  }),
);

/**
 * Atomic authority switch for ingestion. When disabled this mutation performs
 * no writes and explicitly delegates to the compatibility worker. When
 * enabled it prepares every expected SourceOccurrence and applies only
 * server-regenerated reconciliation outcomes. There is deliberately no
 * per-occurrence fallback to the legacy matcher after this decision.
 */
export const reconcileIngestionPlan = mutation({
  args: {
    plan: v.union(sourceOccurrencePlan, v.null()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.string(),
  },
  returns: genericIngestionResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(
      ctx,
      args.serviceSecret,
    );
    if (authorization.kind !== "service") {
      throw new Error("Generic ingestion requires service authentication.");
    }
    if (!(await reconciliationIngestionApplyIsEnabled(ctx))) {
      return { authority: "legacy" as const, outcomes: [] };
    }
    if (!args.plan) {
      throw new Error(
        "Generic ingestion is enabled but structured facts did not produce a complete source-occurrence plan.",
      );
    }
    assertSourceOccurrencePlanWithinBounds(args.plan);

    // The switch is valid only if the reviewed rollout covered every action
    // this ingress can generate. Assert all capabilities before the first row
    // is written so a partial rollout cannot dirty topology and then fail.
    await assertReconciliationIngestionApplyEnabled(ctx, "create");
    await assertReconciliationIngestionApplyEnabled(ctx, "attach");
    await assertReconciliationIngestionApplyEnabled(ctx, "update");
    const sourceDocument = await assertSourceProcessingFence(
      ctx,
      args.processingFence,
    );

    if (args.plan.expectedKeys.length === 0) {
      await reconcileSourceOccurrenceReceiptAndSync(
        ctx,
        args.plan,
        sourceDocument,
      );
      return { authority: "reconciliation" as const, outcomes: [] };
    }

    const sourceOccurrenceIds =
      await prepareSourceOccurrencePlanForReconciliation(
        ctx,
        args.plan,
        sourceDocument,
      );
    const outcomes: Array<{
      action: "attach" | "create" | "manual_review" | "update";
      applied: boolean;
      canonicalEventId?: Id<"events">;
      canonicalEventStatus?: "approved" | "pending" | "rejected";
      sourceOccurrenceId: (typeof sourceOccurrenceIds)[number];
      sourceOccurrenceKey: string;
    }> = [];
    for (const sourceOccurrenceId of sourceOccurrenceIds) {
      const occurrence = await ctx.db.get(sourceOccurrenceId);
      if (!occurrence) {
        throw new Error("Prepared source occurrence disappeared before apply.");
      }
      const execution = await executeSourceOccurrenceHandler(ctx, {
        expectedSourceOccurrenceUpdatedAt: occurrence.updatedAt,
        expectedSourceRevision: occurrence.sourceRevision,
        intent: "ingest_occurrence",
        mode: "apply",
        processingOwner: args.processingFence.owner,
        sourceOccurrenceId,
      });
      const action = execution.plan.action;
      if (
        action !== "attach" &&
        action !== "create" &&
        action !== "manual_review" &&
        action !== "update"
      ) {
        throw new Error("Generic ingestion generated an unsupported action.");
      }
      const canonicalEvent = execution.canonicalEventId
        ? await ctx.db.get(execution.canonicalEventId)
        : null;
      outcomes.push({
        action,
        applied: execution.applied,
        ...(execution.canonicalEventId
          ? { canonicalEventId: execution.canonicalEventId }
          : {}),
        ...(canonicalEvent
          ? { canonicalEventStatus: canonicalEvent.status }
          : {}),
        sourceOccurrenceId,
        sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
      });
    }
    return { authority: "reconciliation" as const, outcomes };
  },
});
