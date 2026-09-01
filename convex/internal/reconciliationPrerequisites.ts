import type { MutationCtx, QueryCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";

export const REQUIRED_RECONCILIATION_MIGRATIONS = [
  "canonical-event-domain-fields-v1",
  "venue-identities-v1",
  "event-venue-bindings-v1",
  "legacy-source-occurrence-admission-v1",
  "source-occurrences-generic-v2",
  "source-occurrence-canonical-payload-v1",
] as const;

type ReadContext = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type ReconciliationPrerequisiteStatus = {
  incompleteMigrations: (typeof REQUIRED_RECONCILIATION_MIGRATIONS)[number][];
  satisfied: boolean;
};

/** Bounded prerequisite status shared by admission and operator visibility. */
export async function readReconciliationPrerequisiteStatus(
  ctx: ReadContext,
): Promise<ReconciliationPrerequisiteStatus> {
  const states = await Promise.all(
    REQUIRED_RECONCILIATION_MIGRATIONS.map((key) =>
      ctx.db
        .query("eventDomainMigrationState")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique(),
    ),
  );
  const incomplete = REQUIRED_RECONCILIATION_MIGRATIONS.filter((_, index) => {
    const state = states[index];
    if (
      !state?.completedAt ||
      state.mismatchCount !== 0 ||
      (state.errorCount ?? 0) !== 0
    ) {
      return true;
    }
    if (
      state.key === "source-occurrence-canonical-payload-v1" &&
      ((state.skippedCount ?? 0) !== 0 ||
        (state.quarantinedLineageMarkerCount ?? 0) !== 0)
    ) {
      return true;
    }
    if (
      state.key !== "source-occurrences-generic-v2" &&
      state.key !== "event-venue-bindings-v1"
    ) {
      return false;
    }
    const skippedCount = state.skippedCount ?? 0;
    const quarantinedCount = state.quarantinedLineageMarkerCount ?? 0;
    if (skippedCount !== quarantinedCount) return true;
    try {
      const reasons = state.skipReasonCountsJson
        ? (JSON.parse(state.skipReasonCountsJson) as unknown)
        : {};
      return !(
        reasons &&
        typeof reasons === "object" &&
        !Array.isArray(reasons) &&
        Object.keys(reasons as Record<string, unknown>).every(
          (key) => key === "audited_lineage_requires_reattestation",
        ) &&
        ((reasons as Record<string, unknown>)
          .audited_lineage_requires_reattestation ?? 0) === quarantinedCount
      );
    } catch {
      return true;
    }
  });
  return {
    incompleteMigrations: incomplete,
    satisfied: incomplete.length === 0,
  };
}

/** Shared migration admission used by both server verification and apply. */
export async function assertReconciliationPrerequisites(
  ctx: ReadContext,
): Promise<void> {
  const status = await readReconciliationPrerequisiteStatus(ctx);
  if (!status.satisfied) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Automatic reconciliation is disabled until required migrations complete without mismatches.",
      { details: { incompleteMigrations: status.incompleteMigrations } },
    );
  }
}
