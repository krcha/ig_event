import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { repairAutomaticVenueAlias } from "./autonomousVenueRepair";
import { repairPendingBenignSourceConflictHandler } from "./eventRepairs/pendingBenignSourceConflicts";

export type AutomaticRepairDiagnostic = {
  expectedUpdatedAt: number;
  holdReason: string;
  repairCategory: string;
  sourcePostId: Id<"scrapedPosts"> | null;
  sourceRevision: number | null;
  sourceProofReason?: string | null;
};
const RETRY_MS = 15 * 60_000;
const MAX_REPAIRS_PER_SOURCE_GENERATION = 3;

/** Called by the existing approval sweep after a failed, read-only preflight. */
export async function attemptAutomaticPendingRepair(
  ctx: MutationCtx, event: Doc<"events">, diagnostic: AutomaticRepairDiagnostic,
): Promise<{ repaired: boolean; repairReason: string; queued: boolean }> {
  const now = Date.now();
  const rows = await ctx.db.query("automaticApprovalHolds").withIndex("by_event", (q) => q.eq("eventId", event._id)).take(2);
  if (rows.length > 1) throw new Error("Automatic approval hold is not unique.");
  const previous = rows[0];
  const sameSource = previous?.sourcePostId === (diagnostic.sourcePostId ?? undefined) &&
    previous?.sourceRevision === (diagnostic.sourceRevision ?? undefined);
  const attempts = sameSource ? previous?.repairAttemptCount ?? 0 : 0;
  if (previous && sameSource && previous.expectedUpdatedAt === event.updatedAt && previous.holdReason === diagnostic.holdReason &&
      ((previous.leaseExpiresAt ?? 0) > now || previous.nextRetryAt > now)) {
    return { repaired: false, repairReason: previous.lastRepairReason ?? "retry_backoff", queued: previous.status === "queued" };
  }
  let repaired = false;
  let repairReason = diagnostic.holdReason;
  let queued = false;
  let attempted = false;
  if (attempts < MAX_REPAIRS_PER_SOURCE_GENERATION) {
    if (diagnostic.repairCategory === "certified_venue_rebind") {
      const result = await repairAutomaticVenueAlias(ctx, event);
      repaired = result.repaired; repairReason = result.reason; attempted = true;
    } else if (diagnostic.repairCategory === "source_conflict_review") {
      const result = await repairPendingBenignSourceConflictHandler(ctx, { id: event._id, expectedUpdatedAt: event.updatedAt, actor: "service:autonomous-moderation" });
      repaired = result.outcome === "repaired"; repairReason = result.reason; attempted = true;
      queued = !repaired && diagnostic.sourcePostId !== null;
    } else if (["saved_source_reprocess", "source_binding_repair", "occurrence_completion"].includes(diagnostic.repairCategory) && diagnostic.sourcePostId) {
      const source = await ctx.db.get(diagnostic.sourcePostId);
      queued = Boolean(source && (source.sourceRevision ?? 1) === diagnostic.sourceRevision &&
        source.analysisRevision === diagnostic.sourceRevision && source.analysisContractVersion === "event_evidence_v2" &&
        source.analysisResultJson && source.processingOutcome !== "openai_transport_ambiguous" && source.processingOutcome !== "source_media_partial" &&
        source.processingOutcome !== "terminal_permanent_failure" &&
        !(source.processingStatus === "processing" && (source.processingLeaseExpiresAt ?? 0) > now));
      repairReason = queued ? "cached_source_recovery_queued" : "current_cached_source_required";
    }
  } else repairReason = "repair_attempt_limit";
  const current = repaired ? await ctx.db.get(event._id) : event;
  const value = { eventId: event._id, expectedUpdatedAt: current?.updatedAt ?? event.updatedAt,
    holdReason: diagnostic.holdReason, repairCategory: diagnostic.repairCategory,
    sourcePostId: diagnostic.sourcePostId ?? undefined, sourceRevision: diagnostic.sourceRevision ?? undefined,
    diagnosticJson: JSON.stringify(diagnostic), status: repaired ? "resolved" as const : queued ? "queued" as const : "held" as const,
    repairAttemptCount: attempts + (attempted && repaired ? 1 : 0), lastRepairReason: repairReason,
    nextRetryAt: now + RETRY_MS, leaseOwner: undefined, leaseExpiresAt: undefined,
    observedAt: now, updatedAt: now };
  if (previous) await ctx.db.patch(previous._id, value);
  else await ctx.db.insert("automaticApprovalHolds", { ...value, createdAt: now });
  return { repaired, repairReason, queued };
}
