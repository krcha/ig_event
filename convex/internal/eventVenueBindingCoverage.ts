import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const EVENT_VENUE_BINDING_MIGRATION_KEY =
  "event-venue-bindings-v1" as const;

export function isCompleteEventVenueBindingCoverage(
  state: Doc<"eventDomainMigrationState"> | null,
): boolean {
  if (
    !state ||
    state.key !== EVENT_VENUE_BINDING_MIGRATION_KEY ||
    state.isDone !== true ||
    state.completedAt === undefined ||
    state.mismatchCount !== 0 ||
    (state.errorCount ?? 0) !== 0 ||
    (state.skippedCount ?? 0) !== 0 ||
    (state.quarantinedLineageMarkerCount ?? 0) !== 0
  ) {
    return false;
  }
  return (
    state.scannedCount ===
    state.updatedCount +
      (state.unchangedCount ?? 0) +
      state.mismatchCount +
      (state.errorCount ?? 0) +
      (state.skippedCount ?? 0)
  );
}

export async function hasCompleteEventVenueBindingCoverage(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const rows = await ctx.db
    .query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", EVENT_VENUE_BINDING_MIGRATION_KEY))
    .take(2);
  return rows.length === 1 && isCompleteEventVenueBindingCoverage(rows[0]!);
}

export async function assertCompleteEventVenueBindingCoverage(
  ctx: QueryCtx | MutationCtx,
): Promise<void> {
  if (!(await hasCompleteEventVenueBindingCoverage(ctx))) {
    throw new Error(
      "Venue publication cannot be reduced until event-venue-bindings-v1 proves complete zero-exception coverage.",
    );
  }
}
