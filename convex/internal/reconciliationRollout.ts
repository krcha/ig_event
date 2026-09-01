import { v } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  RECONCILIATION_POLICY_VERSION,
  sha256Hex,
} from "../../lib/domain/reconciliation/index";
import {
  assertCompleteReceiptTopologyCoverage,
  hasCompleteReceiptTopologyCoverage,
} from "./receiptTopologyCoverage";
import {
  assertReconciliationPrerequisites,
  readReconciliationPrerequisiteStatus,
} from "./reconciliationPrerequisites";
import { readSourceOccurrenceTopologyEpoch } from "./sourceOccurrenceTopologyEpoch";
import { assertNoReconciliationInputWriteSince } from "./reconciliationVerificationInputs";

export const RECONCILIATION_ROLLOUT_KEY =
  "source-occurrence-reconciliation-apply-v1" as const;

export type ReconciliationVerifiedOperationKind =
  | "create"
  | "attach"
  | "update"
  | "merge"
  | "coalesce";

const MAX_ROLLOUT_OCCURRENCE_COUNT = 10_000_000;
const MAX_REVIEW_TEXT_LENGTH = 2_000;
const MAX_VERIFICATION_RUN_ID_LENGTH = 256;

const verifiedOperationKindValidator = v.union(
  v.literal("create"),
  v.literal("attach"),
  v.literal("update"),
  v.literal("merge"),
  v.literal("coalesce"),
);
const verificationKindValidator = v.union(
  v.literal("operator_report_v1"),
  v.literal("server_full_outcome_v1"),
);
const verificationPhaseValidator = v.union(
  v.literal("scanning"),
  v.literal("blocked"),
  v.literal("ready_for_review"),
  v.literal("enabled"),
);

type ApplyReadyRolloutState = Doc<"reconciliationRolloutState"> & {
  completedAt: number;
  reviewedAt: number;
  verificationRunId: string;
  verificationStartedAt: number;
  verificationTopologyEpoch: number;
};

function assertCount(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ROLLOUT_OCCURRENCE_COUNT
  ) {
    throw new Error(`${label} is outside the reviewed rollout bound.`);
  }
}

function rolloutIsApplyReady(
  state: Doc<"reconciliationRolloutState"> | null,
): state is ApplyReadyRolloutState {
  return Boolean(
    state &&
    state.key === RECONCILIATION_ROLLOUT_KEY &&
    state.policyVersion === RECONCILIATION_POLICY_VERSION &&
    state.verificationKind === "server_full_outcome_v1" &&
    state.verificationPhase === "enabled" &&
    Boolean(state.verificationRunId) &&
    state.verificationStartedAt !== undefined &&
    state.verificationTopologyEpoch !== undefined &&
    state.reviewedAt !== undefined &&
    state.operatorEnabled &&
    state.completedAt !== undefined &&
    (state.verifiedOperationKinds?.length ?? 0) > 0 &&
    new Set(state.verifiedOperationKinds).size ===
      state.verifiedOperationKinds?.length &&
    (state.verifiedOperationKinds?.filter(
      (operation) => operation === "merge" || operation === "coalesce",
    ).length ?? 0) <= (state.verifiedConsolidationEvidenceCount ?? 0) &&
    state.expectedOccurrenceCount > 0 &&
    state.comparedCount === state.expectedOccurrenceCount &&
    state.matchedCount === state.expectedOccurrenceCount &&
    state.mismatchCount === 0 &&
    state.indeterminateCount === 0 &&
    state.errorCount === 0 &&
    state.coverageStartAt <= state.coverageEndAt,
  );
}

/** Non-throwing authority selector for ingress; every anomaly fails closed. */
export async function reconciliationIngestionApplyIsEnabled(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  try {
    const [rows, prerequisites, receiptTopologyCoverageSatisfied, topology] =
      await Promise.all([
        ctx.db
          .query("reconciliationRolloutState")
          .withIndex("by_key", (q) =>
            q.eq("key", RECONCILIATION_ROLLOUT_KEY),
          )
          .take(2),
        readReconciliationPrerequisiteStatus(ctx),
        hasCompleteReceiptTopologyCoverage(ctx),
        readSourceOccurrenceTopologyEpoch(ctx),
      ]);
    if (rows.length !== 1) return false;
    const state = rows[0]!;
    return Boolean(
      rolloutIsApplyReady(state) &&
      state.ingestionApplyEnabled === true &&
      prerequisites.satisfied &&
      receiptTopologyCoverageSatisfied &&
      topology &&
      topology.currentEpoch === topology.verifiedEpoch &&
      state.verificationTopologyEpoch !== undefined &&
      topology.currentEpoch >= state.verificationTopologyEpoch,
    );
  } catch {
    return false;
  }
}

export async function assertReconciliationRolloutEnabled(
  ctx: MutationCtx,
  requiredOperation: ReconciliationVerifiedOperationKind,
): Promise<void> {
  const rows = await ctx.db
    .query("reconciliationRolloutState")
    .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
    .take(2);
  const state = rows.length === 1 ? rows[0]! : null;
  if (!rolloutIsApplyReady(state)) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Automatic reconciliation apply is disabled until a complete zero-mismatch server verification is explicitly reviewed and enabled.",
      {
        details: {
          rolloutKey: RECONCILIATION_ROLLOUT_KEY,
          rolloutState:
            rows.length > 1 ? "duplicate" : state ? "not_ready" : "missing",
        },
      },
    );
  }
  if (!state.verifiedOperationKinds!.includes(requiredOperation)) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Automatic reconciliation apply is disabled for an operation that was not covered by the reviewed server verification.",
      {
        details: {
          requiredOperation,
          verifiedOperationKinds: state.verifiedOperationKinds,
        },
      },
    );
  }
  const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
  if (
    !epoch ||
    epoch.currentEpoch !== epoch.verifiedEpoch ||
    epoch.currentEpoch < state.verificationTopologyEpoch
  ) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Automatic reconciliation apply is disabled because topology verification no longer extends the reviewed baseline.",
      {
        details: {
          reviewedTopologyEpoch: state.verificationTopologyEpoch,
          liveTopologyEpoch: epoch,
        },
      },
    );
  }
}

/** Ingestion has a second operator gate beyond generic reviewed apply. */
export async function assertReconciliationIngestionApplyEnabled(
  ctx: MutationCtx,
  requiredOperation: ReconciliationVerifiedOperationKind,
): Promise<void> {
  await assertReconciliationPrerequisites(ctx);
  await assertReconciliationRolloutEnabled(ctx, requiredOperation);
  const rows = await ctx.db
    .query("reconciliationRolloutState")
    .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
    .take(2);
  const state = rows.length === 1 ? rows[0]! : null;
  if (state?.ingestionApplyEnabled !== true) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Automatic ingestion reconciliation writes remain disabled until their separate operator cutover is enabled.",
      {
        details: {
          rolloutKey: RECONCILIATION_ROLLOUT_KEY,
          rolloutState:
            rows.length > 1 ? "duplicate" : state ? "not_enabled" : "missing",
        },
      },
    );
  }
}

/**
 * Appends one bounded server-computed consolidation proof while the rollout is
 * still disabled. Operator reports cannot call this path, and the later human
 * authorization must review the resulting new digest and updatedAt fence.
 */
export async function appendServerVerifiedConsolidationCapability(
  ctx: MutationCtx,
  args: {
    evidenceMaterial: string;
    expectedUpdatedAt: number;
    operation: "merge" | "coalesce";
  },
): Promise<{
  evidenceDigestSha256: string;
  updatedAt: number;
  verifiedConsolidationEvidenceCount: number;
  verifiedOperationKinds: ReconciliationVerifiedOperationKind[];
  verificationRunId: string;
}> {
  if (!args.evidenceMaterial || args.evidenceMaterial.length > 100_000) {
    throw new Error("Consolidation verification evidence is invalid.");
  }
  const rows = await ctx.db
    .query("reconciliationRolloutState")
    .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
    .take(2);
  if (rows.length !== 1) {
    throw new Error("Reconciliation rollout state is missing or duplicated.");
  }
  const state = rows[0]!;
  if (
    state.updatedAt !== args.expectedUpdatedAt ||
    state.verificationKind !== "server_full_outcome_v1" ||
    state.verificationPhase !== "ready_for_review" ||
    !state.verificationRunId ||
    state.verificationStartedAt === undefined ||
    state.verificationTopologyEpoch === undefined ||
    state.operatorEnabled ||
    state.ingestionApplyEnabled === true ||
    state.completedAt === undefined ||
    state.expectedOccurrenceCount <= 0 ||
    state.comparedCount !== state.expectedOccurrenceCount ||
    state.matchedCount !== state.expectedOccurrenceCount ||
    state.mismatchCount !== 0 ||
    state.indeterminateCount !== 0 ||
    state.errorCount !== 0
  ) {
    throw new Error(
      "Consolidation capability requires a complete disabled server verification awaiting review.",
    );
  }
  await assertReconciliationPrerequisites(ctx);
  await assertCompleteReceiptTopologyCoverage(ctx);
  await assertNoReconciliationInputWriteSince(ctx, state.verificationStartedAt);
  const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
  if (
    !epoch ||
    epoch.currentEpoch !== epoch.verifiedEpoch ||
    epoch.currentEpoch !== state.verificationTopologyEpoch
  ) {
    throw new Error(
      "Reconciliation topology changed before consolidation capability verification.",
    );
  }
  const verifiedOperationKinds = [
    ...new Set([...(state.verifiedOperationKinds ?? []), args.operation]),
  ].sort() as ReconciliationVerifiedOperationKind[];
  const evidenceDigestSha256 = sha256Hex(
    [state.evidenceDigestSha256, args.evidenceMaterial].join("\n"),
  );
  const updatedAt = Math.max(Date.now(), state.updatedAt + 1);
  const verifiedConsolidationEvidenceCount =
    (state.verifiedConsolidationEvidenceCount ?? 0) + 1;
  await ctx.db.patch(state._id, {
    evidenceDigestSha256,
    note: "Server full-outcome verification and bounded consolidation capability proofs completed; explicit operator review is still required.",
    updatedAt,
    verifiedConsolidationEvidenceCount,
    verifiedOperationKinds,
  });
  return {
    evidenceDigestSha256,
    updatedAt,
    verifiedConsolidationEvidenceCount,
    verifiedOperationKinds,
    verificationRunId: state.verificationRunId,
  };
}

const rolloutReviewResult = v.object({
  completedAt: v.optional(v.number()),
  created: v.boolean(),
  operatorEnabled: v.boolean(),
  policyVersion: v.number(),
  updatedAt: v.number(),
});

/**
 * Records an operator report as a disabled checkpoint. Current legacy shadows
 * do not yet contain a versioned full semantic outcome, so this boundary is
 * deliberately unable to enable apply. Only the bounded server verifier may
 * write `server_full_outcome_v1`; this report can never self-certify.
 */
export const recordReconciliationRolloutReview = internalMutation({
  args: {
    comparedCount: v.number(),
    coverageEndAt: v.number(),
    coverageStartAt: v.number(),
    errorCount: v.number(),
    evidenceDigestSha256: v.string(),
    expectedOccurrenceCount: v.number(),
    expectedUpdatedAt: v.optional(v.number()),
    indeterminateCount: v.number(),
    matchedCount: v.number(),
    mismatchCount: v.number(),
    note: v.string(),
    operatorEnabled: v.boolean(),
    policyVersion: v.number(),
    reviewedBy: v.string(),
  },
  returns: rolloutReviewResult,
  handler: async (ctx, args) => {
    for (const [label, value] of [
      ["comparedCount", args.comparedCount],
      ["errorCount", args.errorCount],
      ["expectedOccurrenceCount", args.expectedOccurrenceCount],
      ["indeterminateCount", args.indeterminateCount],
      ["matchedCount", args.matchedCount],
      ["mismatchCount", args.mismatchCount],
    ] as const) {
      assertCount(value, label);
    }
    if (
      args.policyVersion !== RECONCILIATION_POLICY_VERSION ||
      !Number.isFinite(args.coverageStartAt) ||
      !Number.isFinite(args.coverageEndAt) ||
      args.coverageStartAt > args.coverageEndAt ||
      args.comparedCount !==
        args.matchedCount + args.mismatchCount + args.indeterminateCount ||
      args.expectedOccurrenceCount !== args.comparedCount + args.errorCount ||
      !/^[a-f0-9]{64}$/u.test(args.evidenceDigestSha256) ||
      !args.reviewedBy.trim() ||
      args.reviewedBy.length > MAX_REVIEW_TEXT_LENGTH ||
      args.note.trim().length < 20 ||
      args.note.length > MAX_REVIEW_TEXT_LENGTH
    ) {
      throw new Error(
        "Reconciliation rollout review is incomplete or malformed.",
      );
    }
    if (
      args.operatorEnabled &&
      (args.expectedOccurrenceCount === 0 ||
        args.matchedCount !== args.expectedOccurrenceCount ||
        args.mismatchCount !== 0 ||
        args.indeterminateCount !== 0 ||
        args.errorCount !== 0)
    ) {
      throw new Error(
        "Reconciliation apply cannot be enabled with incomplete or non-matching shadow evidence.",
      );
    }
    if (args.operatorEnabled) {
      throw new Error(
        "Reconciliation apply requires a server-computed full-outcome verification run; an operator report cannot enable it.",
      );
    }

    const existingRows = await ctx.db
      .query("reconciliationRolloutState")
      .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
      .take(2);
    if (existingRows.length > 1) {
      throw new Error("Reconciliation rollout state is duplicated.");
    }
    const existing = existingRows[0] ?? null;
    if (
      (existing && args.expectedUpdatedAt !== existing.updatedAt) ||
      (!existing && args.expectedUpdatedAt !== undefined)
    ) {
      throw new Error(
        "Reconciliation rollout review changed before authorization.",
      );
    }

    const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const complete =
      args.expectedOccurrenceCount === args.comparedCount + args.errorCount;
    const patch = {
      comparedCount: args.comparedCount,
      ...(complete ? { completedAt: now } : { completedAt: undefined }),
      coverageEndAt: args.coverageEndAt,
      coverageStartAt: args.coverageStartAt,
      errorCount: args.errorCount,
      evidenceDigestSha256: args.evidenceDigestSha256,
      expectedOccurrenceCount: args.expectedOccurrenceCount,
      ingestionApplyEnabled: false,
      indeterminateCount: args.indeterminateCount,
      key: RECONCILIATION_ROLLOUT_KEY,
      matchedCount: args.matchedCount,
      mismatchCount: args.mismatchCount,
      note: args.note.trim(),
      operatorEnabled: args.operatorEnabled,
      policyVersion: args.policyVersion,
      reviewedBy: args.reviewedBy.trim(),
      updatedAt: now,
      verificationKind: "operator_report_v1" as const,
      verificationPhase: undefined,
      verificationRunId: undefined,
      verificationCursor: undefined,
      verificationStartedAt: undefined,
      verificationTopologyEpoch: undefined,
      verifiedConsolidationEvidenceCount: undefined,
      verifiedOperationKinds: undefined,
      reviewedAt: undefined,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("reconciliationRolloutState", {
        ...patch,
        createdAt: now,
      });
    }
    return {
      ...(complete ? { completedAt: now } : {}),
      created: existing === null,
      operatorEnabled: args.operatorEnabled,
      policyVersion: args.policyVersion,
      updatedAt: now,
    };
  },
});

const rolloutAuthorizationResult = v.object({
  operatorEnabled: v.literal(true),
  policyVersion: v.number(),
  reviewedAt: v.number(),
  updatedAt: v.number(),
  verificationRunId: v.string(),
});

/**
 * Separate human review transition for a completed server attestation. The
 * verifier itself can only reach `ready_for_review`; it cannot self-enable.
 * Merely deploying this mutation leaves production disabled.
 */
export const authorizeServerVerifiedReconciliationRollout = internalMutation({
  args: {
    expectedEvidenceDigestSha256: v.string(),
    expectedUpdatedAt: v.number(),
    expectedVerificationRunId: v.string(),
    note: v.string(),
    reviewedBy: v.string(),
  },
  returns: rolloutAuthorizationResult,
  handler: async (ctx, args) => {
    if (
      !/^[a-f0-9]{64}$/u.test(args.expectedEvidenceDigestSha256) ||
      !args.expectedVerificationRunId.trim() ||
      !args.reviewedBy.trim() ||
      args.reviewedBy.length > MAX_REVIEW_TEXT_LENGTH ||
      args.note.trim().length < 20 ||
      args.note.length > MAX_REVIEW_TEXT_LENGTH
    ) {
      throw new Error("Reconciliation rollout authorization is malformed.");
    }
    const rows = await ctx.db
      .query("reconciliationRolloutState")
      .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
      .take(2);
    if (rows.length !== 1) {
      throw new Error("Reconciliation rollout state is missing or duplicated.");
    }
    const state = rows[0]!;
    if (
      state.updatedAt !== args.expectedUpdatedAt ||
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "ready_for_review" ||
      state.verificationRunId !== args.expectedVerificationRunId ||
      state.evidenceDigestSha256 !== args.expectedEvidenceDigestSha256 ||
      state.operatorEnabled ||
      state.ingestionApplyEnabled === true ||
      state.completedAt === undefined ||
      state.expectedOccurrenceCount <= 0 ||
      state.comparedCount !== state.expectedOccurrenceCount ||
      state.matchedCount !== state.expectedOccurrenceCount ||
      state.mismatchCount !== 0 ||
      state.indeterminateCount !== 0 ||
      state.errorCount !== 0 ||
      state.verificationTopologyEpoch === undefined ||
      (state.verifiedOperationKinds?.length ?? 0) === 0 ||
      (state.verifiedOperationKinds?.filter(
        (operation) => operation === "merge" || operation === "coalesce",
      ).length ?? 0) > (state.verifiedConsolidationEvidenceCount ?? 0)
    ) {
      throw new Error(
        "Reconciliation rollout is not a complete reviewed server attestation.",
      );
    }
    await assertReconciliationPrerequisites(ctx);
    await assertCompleteReceiptTopologyCoverage(ctx);
    await assertNoReconciliationInputWriteSince(
      ctx,
      state.verificationStartedAt!,
    );
    const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
    if (
      !epoch ||
      epoch.currentEpoch !== epoch.verifiedEpoch ||
      epoch.currentEpoch !== state.verificationTopologyEpoch
    ) {
      throw new Error(
        "Reconciliation topology changed after server verification; restart verification.",
      );
    }
    const now = Math.max(Date.now(), state.updatedAt + 1);
    await ctx.db.patch(state._id, {
      note: args.note.trim(),
      ingestionApplyEnabled: false,
      operatorEnabled: true as const,
      reviewedAt: now,
      reviewedBy: args.reviewedBy.trim(),
      updatedAt: now,
      verificationPhase: "enabled",
    });
    return {
      operatorEnabled: true as const,
      policyVersion: state.policyVersion,
      reviewedAt: now,
      updatedAt: now,
      verificationRunId: state.verificationRunId,
    };
  },
});

const rolloutControlResult = v.object({
  operatorEnabled: v.literal(false),
  policyVersion: v.number(),
  updatedAt: v.number(),
  verificationPhase: v.literal("blocked"),
  verificationRunId: v.string(),
});
const ingestionEnableResult = v.object({
  ingestionApplyEnabled: v.literal(true),
  operatorEnabled: v.literal(true),
  policyVersion: v.number(),
  updatedAt: v.number(),
  verificationRunId: v.string(),
});

type RolloutControlArgs = {
  actor: string;
  expectedEvidenceDigestSha256: string;
  expectedUpdatedAt: number;
  expectedVerificationRunId: string;
  note: string;
};

function assertRolloutControlArgs(args: RolloutControlArgs): void {
  if (
    !/^[a-f0-9]{64}$/u.test(args.expectedEvidenceDigestSha256) ||
    !Number.isSafeInteger(args.expectedUpdatedAt) ||
    args.expectedUpdatedAt < 0 ||
    !args.expectedVerificationRunId.trim() ||
    args.expectedVerificationRunId.length > MAX_VERIFICATION_RUN_ID_LENGTH ||
    !args.actor.trim() ||
    args.actor.length > MAX_REVIEW_TEXT_LENGTH ||
    args.note.trim().length < 20 ||
    args.note.length > MAX_REVIEW_TEXT_LENGTH
  ) {
    throw new Error("Reconciliation rollout control request is malformed.");
  }
}

async function loadControlledRolloutState(
  ctx: MutationCtx,
  args: RolloutControlArgs,
): Promise<Doc<"reconciliationRolloutState">> {
  const rows = await ctx.db
    .query("reconciliationRolloutState")
    .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
    .take(2);
  if (rows.length !== 1) {
    throw new Error("Reconciliation rollout state is missing or duplicated.");
  }
  const state = rows[0]!;
  if (
    state.updatedAt !== args.expectedUpdatedAt ||
    state.verificationRunId !== args.expectedVerificationRunId ||
    state.evidenceDigestSha256 !== args.expectedEvidenceDigestSha256
  ) {
    throw new Error(
      "Reconciliation rollout state changed before the operator control was applied.",
    );
  }
  return state;
}

/**
 * Separate ingestion write cutover after the generic apply authorization. It
 * repeats the immutable-input and topology fences instead of treating the
 * earlier authorization timestamp as sufficient.
 */
export const enableServerVerifiedReconciliationIngestionApply =
  internalMutation({
    args: {
      enabledBy: v.string(),
      expectedEvidenceDigestSha256: v.string(),
      expectedUpdatedAt: v.number(),
      expectedVerificationRunId: v.string(),
      note: v.string(),
    },
    returns: ingestionEnableResult,
    handler: async (ctx, args) => {
      const controlArgs = {
        actor: args.enabledBy,
        expectedEvidenceDigestSha256: args.expectedEvidenceDigestSha256,
        expectedUpdatedAt: args.expectedUpdatedAt,
        expectedVerificationRunId: args.expectedVerificationRunId,
        note: args.note,
      };
      assertRolloutControlArgs(controlArgs);
      const state = await loadControlledRolloutState(ctx, controlArgs);
      if (
        !rolloutIsApplyReady(state) ||
        state.ingestionApplyEnabled === true ||
        state.verificationStartedAt === undefined ||
        state.verificationTopologyEpoch === undefined
      ) {
        throw new Error(
          "Ingestion apply requires an enabled server-verified rollout whose ingestion cutover is still disabled.",
        );
      }
      await assertReconciliationPrerequisites(ctx);
      await assertCompleteReceiptTopologyCoverage(ctx);
      await assertNoReconciliationInputWriteSince(
        ctx,
        state.verificationStartedAt,
      );
      const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
      if (
        !epoch ||
        epoch.currentEpoch !== epoch.verifiedEpoch ||
        epoch.currentEpoch !== state.verificationTopologyEpoch
      ) {
        throw new Error(
          "Reconciliation topology changed before the ingestion apply cutover; restart verification.",
        );
      }
      const now = Math.max(Date.now(), state.updatedAt + 1);
      await ctx.db.patch(state._id, {
        ingestionApplyEnabled: true,
        note: args.note.trim(),
        reviewedAt: now,
        reviewedBy: args.enabledBy.trim(),
        updatedAt: now,
      });
      return {
        ingestionApplyEnabled: true as const,
        operatorEnabled: true as const,
        policyVersion: state.policyVersion,
        updatedAt: now,
        verificationRunId: state.verificationRunId,
      };
    },
  });

/**
 * Emergency reverse transition for an authorized rollout. The authorization
 * evidence is retained for diagnosis, but re-enabling requires a new complete
 * verification because this transition deliberately finishes in `blocked`.
 */
export const disableServerVerifiedReconciliationRollout = internalMutation({
  args: {
    disabledBy: v.string(),
    expectedEvidenceDigestSha256: v.string(),
    expectedUpdatedAt: v.number(),
    expectedVerificationRunId: v.string(),
    note: v.string(),
  },
  returns: rolloutControlResult,
  handler: async (ctx, args) => {
    const controlArgs = {
      actor: args.disabledBy,
      expectedEvidenceDigestSha256: args.expectedEvidenceDigestSha256,
      expectedUpdatedAt: args.expectedUpdatedAt,
      expectedVerificationRunId: args.expectedVerificationRunId,
      note: args.note,
    };
    assertRolloutControlArgs(controlArgs);
    const state = await loadControlledRolloutState(ctx, controlArgs);
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "enabled" ||
      !state.operatorEnabled
    ) {
      throw new Error(
        "Only an enabled server-verified reconciliation rollout can be disabled.",
      );
    }
    const now = Math.max(Date.now(), state.updatedAt + 1);
    await ctx.db.patch(state._id, {
      completedAt: state.completedAt ?? now,
      ingestionApplyEnabled: false,
      note: args.note.trim(),
      operatorEnabled: false,
      reviewedAt: now,
      reviewedBy: args.disabledBy.trim(),
      updatedAt: now,
      verificationCursor: undefined,
      verificationPhase: "blocked",
    });
    return {
      operatorEnabled: false as const,
      policyVersion: state.policyVersion,
      updatedAt: now,
      verificationPhase: "blocked" as const,
      verificationRunId: args.expectedVerificationRunId,
    };
  },
});

/**
 * Abandons an interrupted or drifted scan without trusting the live topology.
 * The bounded evidence summary remains inspectable while clearing the cursor
 * and moving out of `scanning`, so a later verifier may explicitly restart.
 */
export const abandonReconciliationRolloutVerification = internalMutation({
  args: {
    abandonedBy: v.string(),
    expectedEvidenceDigestSha256: v.string(),
    expectedUpdatedAt: v.number(),
    expectedVerificationRunId: v.string(),
    note: v.string(),
  },
  returns: rolloutControlResult,
  handler: async (ctx, args) => {
    const controlArgs = {
      actor: args.abandonedBy,
      expectedEvidenceDigestSha256: args.expectedEvidenceDigestSha256,
      expectedUpdatedAt: args.expectedUpdatedAt,
      expectedVerificationRunId: args.expectedVerificationRunId,
      note: args.note,
    };
    assertRolloutControlArgs(controlArgs);
    const state = await loadControlledRolloutState(ctx, controlArgs);
    if (
      state.verificationKind !== "server_full_outcome_v1" ||
      state.verificationPhase !== "scanning" ||
      state.operatorEnabled
    ) {
      throw new Error(
        "Only a disabled in-progress server verification can be abandoned.",
      );
    }
    const now = Math.max(Date.now(), state.updatedAt + 1);
    await ctx.db.patch(state._id, {
      completedAt: now,
      ingestionApplyEnabled: false,
      note: args.note.trim(),
      operatorEnabled: false,
      reviewedAt: now,
      reviewedBy: args.abandonedBy.trim(),
      updatedAt: now,
      verificationCursor: undefined,
      verificationPhase: "blocked",
    });
    return {
      operatorEnabled: false as const,
      policyVersion: state.policyVersion,
      updatedAt: now,
      verificationPhase: "blocked" as const,
      verificationRunId: args.expectedVerificationRunId,
    };
  },
});

const reconciliationRolloutStatusValidator = v.object({
  applyReady: v.boolean(),
  blockReasons: v.array(v.string()),
  comparedCount: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  errorCount: v.optional(v.number()),
  evidenceDigestSha256: v.optional(v.string()),
  expectedOccurrenceCount: v.optional(v.number()),
  incompleteMigrations: v.array(v.string()),
  ingestionApplyEnabled: v.boolean(),
  ingestionApplyReady: v.boolean(),
  indeterminateCount: v.optional(v.number()),
  matchedCount: v.optional(v.number()),
  mismatchCount: v.optional(v.number()),
  operatorEnabled: v.boolean(),
  policyVersion: v.optional(v.number()),
  prerequisitesSatisfied: v.boolean(),
  receiptTopologyCoverageSatisfied: v.boolean(),
  reviewedAt: v.optional(v.number()),
  reviewedBy: v.optional(v.string()),
  rolloutKey: v.literal(RECONCILIATION_ROLLOUT_KEY),
  singletonStatus: v.union(
    v.literal("missing"),
    v.literal("duplicate"),
    v.literal("present"),
  ),
  topology: v.union(
    v.null(),
    v.object({
      currentEpoch: v.number(),
      verifiedEpoch: v.number(),
    }),
  ),
  updatedAt: v.optional(v.number()),
  verificationCursorPresent: v.boolean(),
  verificationKind: v.optional(verificationKindValidator),
  verificationPhase: v.optional(verificationPhaseValidator),
  verificationRunId: v.optional(v.string()),
  verificationStartedAt: v.optional(v.number()),
  verificationTopologyEpoch: v.optional(v.number()),
  verifiedConsolidationEvidenceCount: v.optional(v.number()),
  verifiedOperationKinds: v.array(verifiedOperationKindValidator),
});

/**
 * Bounded read-only orchestration snapshot. Every data access is a singleton
 * index lookup; duplicate state is reported as disabled rather than selected.
 */
export const getReconciliationRolloutStatus = internalQuery({
  args: {},
  returns: reconciliationRolloutStatusValidator,
  handler: async (ctx) => {
    const [rows, prerequisites, receiptTopologyCoverageSatisfied, topology] =
      await Promise.all([
        ctx.db
          .query("reconciliationRolloutState")
          .withIndex("by_key", (q) =>
            q.eq("key", RECONCILIATION_ROLLOUT_KEY),
          )
          .take(2),
        readReconciliationPrerequisiteStatus(ctx),
        hasCompleteReceiptTopologyCoverage(ctx),
        readSourceOccurrenceTopologyEpoch(ctx),
      ]);
    const singletonStatus =
      rows.length === 0
        ? ("missing" as const)
        : rows.length === 1
          ? ("present" as const)
          : ("duplicate" as const);
    const state = rows.length === 1 ? rows[0]! : null;
    const topologyReady = Boolean(
      state &&
      topology &&
      topology.currentEpoch === topology.verifiedEpoch &&
      state.verificationTopologyEpoch !== undefined &&
      topology.currentEpoch >= state.verificationTopologyEpoch,
    );
    const blockReasons: string[] = [];
    if (singletonStatus !== "present") {
      blockReasons.push(`rollout_state_${singletonStatus}`);
    } else if (!rolloutIsApplyReady(state)) {
      blockReasons.push("rollout_attestation_not_apply_ready");
    }
    if (!prerequisites.satisfied) {
      blockReasons.push("prerequisite_migrations_incomplete");
    }
    if (!receiptTopologyCoverageSatisfied) {
      blockReasons.push("receipt_topology_coverage_incomplete");
    }
    if (!topology) {
      blockReasons.push("topology_epoch_missing");
    } else if (topology.currentEpoch !== topology.verifiedEpoch) {
      blockReasons.push("topology_epoch_unverified");
    } else if (
      state?.verificationTopologyEpoch === undefined ||
      topology.currentEpoch < state.verificationTopologyEpoch
    ) {
      blockReasons.push("topology_epoch_behind_rollout");
    }
    const applyReady = Boolean(
      rolloutIsApplyReady(state) &&
      prerequisites.satisfied &&
      receiptTopologyCoverageSatisfied &&
      topologyReady,
    );
    const ingestionApplyEnabled = state?.ingestionApplyEnabled === true;
    return {
      applyReady,
      blockReasons,
      ...(state
        ? {
            comparedCount: state.comparedCount,
            ...(state.completedAt === undefined
              ? {}
              : { completedAt: state.completedAt }),
            errorCount: state.errorCount,
            evidenceDigestSha256: state.evidenceDigestSha256,
            expectedOccurrenceCount: state.expectedOccurrenceCount,
            indeterminateCount: state.indeterminateCount,
            matchedCount: state.matchedCount,
            mismatchCount: state.mismatchCount,
            policyVersion: state.policyVersion,
            ...(state.reviewedAt === undefined
              ? {}
              : { reviewedAt: state.reviewedAt }),
            reviewedBy: state.reviewedBy,
            updatedAt: state.updatedAt,
            ...(state.verificationKind === undefined
              ? {}
              : { verificationKind: state.verificationKind }),
            ...(state.verificationPhase === undefined
              ? {}
              : { verificationPhase: state.verificationPhase }),
            ...(state.verificationRunId === undefined
              ? {}
              : { verificationRunId: state.verificationRunId }),
            ...(state.verificationStartedAt === undefined
              ? {}
              : { verificationStartedAt: state.verificationStartedAt }),
            ...(state.verificationTopologyEpoch === undefined
              ? {}
              : {
                  verificationTopologyEpoch:
                    state.verificationTopologyEpoch,
                }),
            ...(state.verifiedConsolidationEvidenceCount === undefined
              ? {}
              : {
                  verifiedConsolidationEvidenceCount:
                    state.verifiedConsolidationEvidenceCount,
                }),
          }
        : {}),
      incompleteMigrations: prerequisites.incompleteMigrations,
      ingestionApplyEnabled,
      ingestionApplyReady: applyReady && ingestionApplyEnabled,
      operatorEnabled: state?.operatorEnabled ?? false,
      prerequisitesSatisfied: prerequisites.satisfied,
      receiptTopologyCoverageSatisfied,
      rolloutKey: RECONCILIATION_ROLLOUT_KEY,
      singletonStatus,
      topology,
      verificationCursorPresent: Boolean(state?.verificationCursor),
      verifiedOperationKinds: state?.verifiedOperationKinds ?? [],
    };
  },
});
