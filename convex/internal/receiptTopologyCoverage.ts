import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { readSourceOccurrenceTopologyEpoch } from "./sourceOccurrenceTopologyEpoch";
import type { SourceOccurrenceTopologyEpochSnapshot } from "./sourceOccurrenceTopologyEpoch";

export const RECEIPT_TOPOLOGY_AUDIT_KEY =
  "source-occurrence-receipt-topology-v1" as const;

/**
 * A clean full-table audit is the compatibility bridge that makes legacy
 * receipt satisfactions reverse-discoverable while the normalized occurrence
 * model is rolled out. Without it, an event can be named only inside a receipt
 * array and a destructive event operation cannot discover that provenance by
 * event ID.
 */
export function isCompleteReceiptTopologyCoverage(
  state: Doc<"eventDomainMigrationState"> | null,
  liveTopologyEpoch: SourceOccurrenceTopologyEpochSnapshot | null,
): boolean {
  if (
    !state ||
    state.key !== RECEIPT_TOPOLOGY_AUDIT_KEY ||
    state.phase !== "receipt_topology_audit" ||
    state.isDone !== true ||
    state.completedAt === undefined ||
    !liveTopologyEpoch ||
    state.topologyEpoch === undefined ||
    !Number.isSafeInteger(state.topologyEpoch) ||
    state.topologyEpoch < 0 ||
    liveTopologyEpoch.currentEpoch !== liveTopologyEpoch.verifiedEpoch ||
    state.topologyEpoch > liveTopologyEpoch.verifiedEpoch ||
    state.mismatchCount !== 0 ||
    (state.errorCount ?? 0) !== 0 ||
    (state.skippedCount ?? 0) !== 0 ||
    (state.quarantinedLineageMarkerCount ?? 0) !== 0 ||
    state.updatedCount !== 0
  ) {
    return false;
  }

  return state.scannedCount === (state.unchangedCount ?? 0);
}

export async function hasCompleteReceiptTopologyCoverage(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const [rows, liveTopologyEpoch] = await Promise.all([
    ctx.db
      .query("eventDomainMigrationState")
      .withIndex("by_key", (q) => q.eq("key", RECEIPT_TOPOLOGY_AUDIT_KEY))
      .take(2),
    readSourceOccurrenceTopologyEpoch(ctx),
  ]);
  return (
    rows.length === 1 &&
    isCompleteReceiptTopologyCoverage(rows[0]!, liveTopologyEpoch)
  );
}

export async function assertCompleteReceiptTopologyCoverage(
  ctx: QueryCtx | MutationCtx,
): Promise<void> {
  if (!(await hasCompleteReceiptTopologyCoverage(ctx))) {
    throw new Error(
      "Destructive event reconciliation is disabled until source-occurrence-receipt-topology-v1 proves complete zero-exception receipt coverage.",
    );
  }
}
