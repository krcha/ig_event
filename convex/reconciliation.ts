import { v } from "convex/values";

import { DomainError } from "../lib/domain/errors";
import { internalMutation } from "./_generated/server";
import { verifySourceOccurrenceForRollout } from "./internal/reconciliationSourceAudit";
import { executeSourceOccurrenceHandler } from "./internal/reconciliationSourceExecutor";
import { runReconciliationRolloutVerificationBatch } from "./internal/reconciliationRolloutVerification";

export { executeSourceOccurrenceHandler } from "./internal/reconciliationSourceExecutor";

const legacyOutcomeValidator = v.union(
  v.literal("attach"),
  v.literal("create"),
  v.literal("update"),
);
const verifiedOperationKindValidator = v.union(
  v.literal("create"),
  v.literal("attach"),
  v.literal("update"),
  v.literal("merge"),
  v.literal("coalesce"),
);
const reconciliationExecutionResultValidator = v.object({
  applied: v.boolean(),
  auditId: v.id("reconciliationAudits"),
  canonicalEventId: v.optional(v.id("events")),
  decision: v.any(),
  plan: v.any(),
});
const reconciliationRolloutVerificationResultValidator = v.object({
  comparedCount: v.number(),
  continueCursor: v.string(),
  errorCount: v.number(),
  evidenceDigestSha256: v.string(),
  expectedOccurrenceCount: v.number(),
  indeterminateCount: v.number(),
  isDone: v.boolean(),
  matchedCount: v.number(),
  mismatchCount: v.number(),
  operatorEnabled: v.literal(false),
  phase: v.union(
    v.literal("scanning"),
    v.literal("blocked"),
    v.literal("ready_for_review"),
  ),
  updatedAt: v.number(),
  verifiedOperationKinds: v.array(verifiedOperationKindValidator),
  verificationRunId: v.string(),
});

/**
 * Thin registered mutation boundary for one first-class source occurrence.
 * The internal executor regenerates every decision and plan from current state;
 * this entrypoint accepts no client-provided semantic result.
 */
export const executeSourceOccurrence = internalMutation({
  args: {
    expectedSourceOccurrenceUpdatedAt: v.number(),
    expectedSourceRevision: v.number(),
    legacyOutcome: v.optional(legacyOutcomeValidator),
    intent: v.optional(
      v.union(v.literal("ingest_occurrence"), v.literal("moderate")),
    ),
    mode: v.union(v.literal("shadow"), v.literal("apply")),
    processingOwner: v.optional(v.string()),
    sourceOccurrenceId: v.id("sourceOccurrences"),
  },
  returns: reconciliationExecutionResultValidator,
  handler: executeSourceOccurrenceHandler,
});

/**
 * Scheduled shadow entrypoint. It snapshots the latest occurrence version in
 * the same transaction that performs comparison, so normal ingestion retries
 * cannot turn an expected stale shadow job into an operational failure.
 */
export const executeLatestSourceOccurrenceShadow = internalMutation({
  args: {
    legacyOutcome: v.optional(legacyOutcomeValidator),
    sourceOccurrenceId: v.id("sourceOccurrences"),
  },
  returns: reconciliationExecutionResultValidator,
  handler: async (ctx, args) => {
    const occurrence = await ctx.db.get(args.sourceOccurrenceId);
    if (!occurrence) {
      throw new DomainError(
        "OCCURRENCE_INCOMPLETE",
        "Source occurrence not found.",
      );
    }
    return executeSourceOccurrenceHandler(ctx, {
      expectedSourceOccurrenceUpdatedAt: occurrence.updatedAt,
      expectedSourceRevision: occurrence.sourceRevision,
      legacyOutcome: args.legacyOutcome,
      intent:
        args.legacyOutcome === "update" ? "moderate" : "ingest_occurrence",
      mode: "shadow",
      shadowComparisonBasis: "post_write_counterfactual",
      sourceOccurrenceId: occurrence._id,
    });
  },
});

/**
 * Bounded, resumable server verifier for the complete current occurrence set.
 * It accepts no cursor, count, digest, plan, or decision from an operator. The
 * durable state machine owns those values and can only finish disabled in
 * `ready_for_review` or `blocked`.
 */
export const verifyReconciliationRolloutBatch = internalMutation({
  args: {
    limit: v.optional(v.number()),
    restartCompleted: v.optional(v.boolean()),
  },
  returns: reconciliationRolloutVerificationResultValidator,
  handler: (ctx, args) =>
    runReconciliationRolloutVerificationBatch(
      ctx,
      args,
      (occurrence, verificationRunId, topologyEpoch) =>
        verifySourceOccurrenceForRollout(
          ctx,
          occurrence,
          verificationRunId,
          topologyEpoch,
        ),
    ),
});
