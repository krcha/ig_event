import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  RECONCILIATION_POLICY_VERSION,
  sha256Hex,
} from "../../lib/domain/reconciliation/index";
import { assertCompleteReceiptTopologyCoverage } from "./receiptTopologyCoverage";
import { assertReconciliationPrerequisites } from "./reconciliationPrerequisites";
import {
  RECONCILIATION_ROLLOUT_KEY,
  type ReconciliationVerifiedOperationKind,
} from "./reconciliationRollout";
import { readSourceOccurrenceTopologyEpoch } from "./sourceOccurrenceTopologyEpoch";
import { assertNoReconciliationInputWriteSince } from "./reconciliationVerificationInputs";

const DEFAULT_VERIFICATION_BATCH_SIZE = 16;
const MAX_VERIFICATION_BATCH_SIZE = 32;
const MAX_VERIFICATION_RUN_ID_LENGTH = 256;
const MAX_VERIFIED_OCCURRENCE_COUNT = 10_000_000;

export type FullOutcomeEvidenceStatus =
  | "matched"
  | "mismatch"
  | "indeterminate";

export type FullOutcomeEvidence =
  | {
      digestMaterial: string;
      operationKind: ReconciliationVerifiedOperationKind;
      status: "matched";
    }
  | {
      digestMaterial: string;
      operationKind?: ReconciliationVerifiedOperationKind;
      status: "mismatch" | "indeterminate";
    };

export type ReconciliationRolloutVerificationResult = {
  comparedCount: number;
  continueCursor: string;
  errorCount: number;
  evidenceDigestSha256: string;
  expectedOccurrenceCount: number;
  indeterminateCount: number;
  isDone: boolean;
  matchedCount: number;
  mismatchCount: number;
  operatorEnabled: false;
  phase: "scanning" | "blocked" | "ready_for_review";
  updatedAt: number;
  verifiedOperationKinds: ReconciliationVerifiedOperationKind[];
  verificationRunId: string;
};

type VerificationArgs = {
  limit?: number;
  restartCompleted?: boolean;
};

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_VERIFICATION_BATCH_SIZE;
  return Math.max(
    1,
    Math.min(MAX_VERIFICATION_BATCH_SIZE, Math.trunc(value as number)),
  );
}

async function loadUniqueRolloutState(
  ctx: Pick<MutationCtx, "db">,
): Promise<Doc<"reconciliationRolloutState"> | null> {
  const rows = await ctx.db
    .query("reconciliationRolloutState")
    .withIndex("by_key", (q) => q.eq("key", RECONCILIATION_ROLLOUT_KEY))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Reconciliation rollout state is duplicated.");
  }
  return rows[0] ?? null;
}

async function requireStableVerifiedEpoch(
  ctx: MutationCtx,
  expectedEpoch?: number,
): Promise<number> {
  const epoch = await readSourceOccurrenceTopologyEpoch(ctx);
  if (
    !epoch ||
    epoch.currentEpoch !== epoch.verifiedEpoch ||
    (expectedEpoch !== undefined && epoch.currentEpoch !== expectedEpoch)
  ) {
    throw new Error(
      "Reconciliation verification requires one stable, completely verified topology epoch.",
    );
  }
  return epoch.currentEpoch;
}

function nextRunId(now: number, topologyEpoch: number): string {
  const value = `reconciliation-full-outcome-v1:${RECONCILIATION_POLICY_VERSION}:${topologyEpoch}:${now}`;
  if (value.length > MAX_VERIFICATION_RUN_ID_LENGTH) {
    throw new Error(
      "Reconciliation verification run identity exceeds its bound.",
    );
  }
  return value;
}

/**
 * Durable bounded state machine for server-computed full-outcome evidence.
 * The callback may inspect current state and append immutable audit evidence,
 * but only this helper owns the cursor, cumulative counts, and rolling digest.
 */
export async function runReconciliationRolloutVerificationBatch(
  ctx: MutationCtx,
  args: VerificationArgs,
  verifyOccurrence: (
    occurrence: Doc<"sourceOccurrences">,
    verificationRunId: string,
    topologyEpoch: number,
  ) => Promise<FullOutcomeEvidence>,
): Promise<ReconciliationRolloutVerificationResult> {
  await assertReconciliationPrerequisites(ctx);
  await assertCompleteReceiptTopologyCoverage(ctx);
  const existing = await loadUniqueRolloutState(ctx);
  const restartCompleted = args.restartCompleted ?? false;
  if (existing?.operatorEnabled) {
    throw new Error(
      "An enabled reconciliation rollout cannot be silently replaced by a verifier run.",
    );
  }
  if (restartCompleted && existing?.verificationPhase === "scanning") {
    throw new Error("An in-progress verification run cannot be restarted.");
  }
  if (
    !restartCompleted &&
    existing &&
    existing.verificationPhase !== "scanning"
  ) {
    throw new Error(
      "Reconciliation verification is complete; restart it explicitly after review.",
    );
  }

  const starting = !existing || restartCompleted;
  const topologyEpoch = await requireStableVerifiedEpoch(
    ctx,
    starting ? undefined : existing.verificationTopologyEpoch,
  );
  const now = Date.now();
  const verificationStartedAt = starting
    ? Math.max(now, (existing?.updatedAt ?? 0) + 1)
    : existing?.verificationStartedAt;
  if (verificationStartedAt === undefined) {
    throw new Error(
      "Reconciliation verification state is missing its start fence.",
    );
  }
  await assertNoReconciliationInputWriteSince(ctx, verificationStartedAt);
  const verificationRunId = starting
    ? nextRunId(verificationStartedAt, topologyEpoch)
    : existing?.verificationRunId;
  if (
    !verificationRunId ||
    (existing?.policyVersion !== undefined &&
      !starting &&
      existing.policyVersion !== RECONCILIATION_POLICY_VERSION)
  ) {
    throw new Error(
      "Reconciliation verification state is incomplete or stale.",
    );
  }
  const cursor = starting ? null : (existing?.verificationCursor ?? null);
  if (!starting && cursor === null) {
    throw new Error(
      "In-progress reconciliation verification has no durable cursor.",
    );
  }
  const page = await ctx.db
    .query("sourceOccurrences")
    .order("asc")
    .paginate({
      cursor,
      numItems: normalizeBatchSize(args.limit),
    });
  if (!page.isDone && !page.continueCursor) {
    throw new Error("Reconciliation verification pagination did not advance.");
  }

  let batchMatched = 0;
  let batchMismatch = 0;
  let batchIndeterminate = 0;
  let batchErrors = 0;
  const evidenceRows: string[] = [];
  const verifiedOperationKinds = new Set<ReconciliationVerifiedOperationKind>(
    starting ? [] : (existing?.verifiedOperationKinds ?? []),
  );
  for (const occurrence of page.page) {
    try {
      const evidence = await verifyOccurrence(
        occurrence,
        verificationRunId,
        topologyEpoch,
      );
      if (evidence.status === "matched") {
        batchMatched += 1;
        verifiedOperationKinds.add(evidence.operationKind);
      } else if (evidence.status === "mismatch") batchMismatch += 1;
      else batchIndeterminate += 1;
      evidenceRows.push(
        JSON.stringify({
          evidence: evidence.digestMaterial,
          sourceOccurrenceId: occurrence._id,
          sourceRevision: occurrence.sourceRevision,
          status: evidence.status,
          updatedAt: occurrence.updatedAt,
        }),
      );
    } catch (error) {
      batchErrors += 1;
      evidenceRows.push(
        JSON.stringify({
          error:
            error instanceof Error
              ? `${error.name}:${error.message}`.slice(0, 1_000)
              : "unknown_verification_error",
          sourceOccurrenceId: occurrence._id,
          sourceRevision: occurrence.sourceRevision,
          status: "error",
          updatedAt: occurrence.updatedAt,
        }),
      );
    }
  }
  await requireStableVerifiedEpoch(ctx, topologyEpoch);
  await assertNoReconciliationInputWriteSince(ctx, verificationStartedAt);

  const previousCompared = starting ? 0 : (existing?.comparedCount ?? 0);
  const previousMatched = starting ? 0 : (existing?.matchedCount ?? 0);
  const previousMismatch = starting ? 0 : (existing?.mismatchCount ?? 0);
  const previousIndeterminate = starting
    ? 0
    : (existing?.indeterminateCount ?? 0);
  const previousErrors = starting ? 0 : (existing?.errorCount ?? 0);
  const matchedCount = previousMatched + batchMatched;
  const mismatchCount = previousMismatch + batchMismatch;
  const indeterminateCount = previousIndeterminate + batchIndeterminate;
  const errorCount = previousErrors + batchErrors;
  const comparedCount =
    previousCompared + batchMatched + batchMismatch + batchIndeterminate;
  const expectedOccurrenceCount = comparedCount + errorCount;
  if (
    !Number.isSafeInteger(expectedOccurrenceCount) ||
    expectedOccurrenceCount > MAX_VERIFIED_OCCURRENCE_COUNT
  ) {
    throw new Error(
      "Reconciliation verification occurrence count exceeds its bound.",
    );
  }
  const previousDigest = starting
    ? sha256Hex(
        JSON.stringify({
          policyVersion: RECONCILIATION_POLICY_VERSION,
          topologyEpoch,
          verificationRunId,
          verificationStartedAt,
        }),
      )
    : existing?.evidenceDigestSha256;
  if (!previousDigest || !/^[a-f0-9]{64}$/u.test(previousDigest)) {
    throw new Error("Reconciliation verification evidence digest is missing.");
  }
  const evidenceDigestSha256 = sha256Hex(
    [previousDigest, ...evidenceRows].join("\n"),
  );
  const hasCleanCompleteCoverage =
    page.isDone &&
    expectedOccurrenceCount > 0 &&
    matchedCount === expectedOccurrenceCount &&
    mismatchCount === 0 &&
    indeterminateCount === 0 &&
    errorCount === 0;
  const phase = page.isDone
    ? hasCleanCompleteCoverage
      ? ("ready_for_review" as const)
      : ("blocked" as const)
    : ("scanning" as const);
  const createdTimes = page.page.map((occurrence) => occurrence.createdAt);
  const coverageStartAt = Math.min(
    starting
      ? verificationStartedAt
      : (existing?.coverageStartAt ?? verificationStartedAt),
    ...createdTimes,
  );
  const coverageEndAt = Math.max(
    starting
      ? verificationStartedAt
      : (existing?.coverageEndAt ?? verificationStartedAt),
    ...createdTimes,
  );
  const updatedAt = Math.max(now, (existing?.updatedAt ?? 0) + 1);
  const patch = {
    comparedCount,
    ...(page.isDone ? { completedAt: updatedAt } : { completedAt: undefined }),
    coverageEndAt,
    coverageStartAt,
    errorCount,
    evidenceDigestSha256,
    expectedOccurrenceCount,
    ingestionApplyEnabled: false,
    indeterminateCount,
    key: RECONCILIATION_ROLLOUT_KEY,
    matchedCount,
    mismatchCount,
    note: page.isDone
      ? hasCleanCompleteCoverage
        ? "Server full-outcome verification completed; explicit operator review is still required."
        : "Server full-outcome verification completed with blocking results; apply remains disabled."
      : "Server full-outcome verification is in progress; apply remains disabled.",
    operatorEnabled: false,
    policyVersion: RECONCILIATION_POLICY_VERSION,
    reviewedAt: undefined,
    reviewedBy: "server_full_outcome_verifier",
    updatedAt,
    verificationCursor: page.isDone ? undefined : page.continueCursor,
    verificationKind: "server_full_outcome_v1" as const,
    verificationPhase: phase,
    verificationRunId,
    verificationStartedAt,
    verificationTopologyEpoch: topologyEpoch,
    verifiedConsolidationEvidenceCount: starting
      ? 0
      : (existing?.verifiedConsolidationEvidenceCount ?? 0),
    verifiedOperationKinds: [...verifiedOperationKinds].sort(),
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
    comparedCount,
    continueCursor: page.continueCursor,
    errorCount,
    evidenceDigestSha256,
    expectedOccurrenceCount,
    indeterminateCount,
    isDone: page.isDone,
    matchedCount,
    mismatchCount,
    operatorEnabled: false,
    phase,
    updatedAt,
    verifiedOperationKinds: [...verifiedOperationKinds].sort(),
    verificationRunId,
  };
}
