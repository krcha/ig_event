import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { PUBLICATION_POLICY_VERSION } from "../lib/domain/publication/policy";
import { readSourceOccurrenceTopologyEpoch } from "./internal/sourceOccurrenceTopologyEpoch";

export const PUBLICATION_MIGRATION_STATE_KEY =
  "materialized-publication-v1" as const;

type ReadContext = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type PublicationReadMode = "compatibility" | "materialized";

/** Venue lifecycle and identity rows participate in publication eligibility
 * but do not advance event.updatedAt. This indexed frontier closes that gap
 * without trusting every historical writer to maintain a second counter. */
export async function hasPublicationDependencyWriteSince(
  ctx: ReadContext,
  startedAt: number,
): Promise<boolean> {
  if (!Number.isFinite(startedAt) || startedAt < 0) return true;
  const [venueWrite, identityWrite] = await Promise.all([
    ctx.db
      .query("venues")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", startedAt))
      .first(),
    ctx.db
      .query("venueIdentities")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", startedAt))
      .first(),
  ]);
  return Boolean(venueWrite || identityWrite);
}

export async function loadPublicationMigrationState(
  ctx: ReadContext,
): Promise<Doc<"publicationMigrationState"> | null> {
  const rows = await ctx.db
    .query("publicationMigrationState")
    .withIndex("by_key", (q) => q.eq("key", PUBLICATION_MIGRATION_STATE_KEY))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Publication migration state is not unique.");
  }
  return rows[0] ?? null;
}

export function isPublicationMigrationStateEquivalent(
  state: Doc<"publicationMigrationState">,
): boolean {
  return (
    state.policyVersion === PUBLICATION_POLICY_VERSION &&
    state.backfillDone &&
    state.mismatchCount === 0 &&
    state.auditDone &&
    state.auditScannedCount >= state.scannedCount &&
    state.auditDriftCount === 0 &&
    state.completedAt !== undefined
  );
}

/**
 * The indexed path is enabled only by one clean, explicitly reviewed state and
 * the exact source-topology frontier that was audited. Any topology drift
 * immediately falls back to the visibility-safe compatibility paginator.
 */
export async function resolvePublicationReadMode(
  ctx: ReadContext,
): Promise<PublicationReadMode> {
  const [state, topologyEpoch] = await Promise.all([
    loadPublicationMigrationState(ctx),
    readSourceOccurrenceTopologyEpoch(ctx),
  ]);
  if (
    !state ||
    !state.readCutoverEnabled ||
    state.phase !== "cutover_enabled" ||
    !isPublicationMigrationStateEquivalent(state) ||
    state.reviewedAt === undefined ||
    !state.reviewedBy?.trim() ||
    !state.reviewNote?.trim() ||
    state.sourceTopologyEpoch === undefined ||
    state.auditStartedAt === undefined ||
    !topologyEpoch ||
    topologyEpoch.currentEpoch !== topologyEpoch.verifiedEpoch ||
    topologyEpoch.currentEpoch !== state.sourceTopologyEpoch ||
    (await hasPublicationDependencyWriteSince(ctx, state.auditStartedAt))
  ) {
    return "compatibility";
  }
  return "materialized";
}
