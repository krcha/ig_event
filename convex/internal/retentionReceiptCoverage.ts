import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "./sourceOccurrenceReceipts";
import { readSourceOccurrenceTopologyEpoch } from "./sourceOccurrenceTopologyEpoch";

export const RETENTION_RECEIPT_COVERAGE_KEY = "event-retention-reverse-receipts-v1";
const RECEIPT_BATCH_SIZE = 4;
const REFERENCE_SWEEP_BATCH_SIZE = 100;
const MAX_REFERENCES_PER_EVENT = 64;
const MAX_EXAMPLES = 8;
const auditPhases = [
  "retention_reference_receipts",
  "retention_reference_sweep",
  "retention_reference_complete",
  "retention_reference_blocked",
] as const;
type AuditPhase = (typeof auditPhases)[number];

type AuditDetails = {
  auditGeneration: number;
  missingEventReferenceCount: number;
  indexedReferenceCount: number;
  sweptReferenceCount: number;
  mismatchExamples: Array<{ receiptId: string; reason: string }>;
};

export type RetentionReceiptCoverageProof = Readonly<{
  stateId: Id<"eventDomainMigrationState">;
  topologyEpoch: number;
  auditGeneration: number;
}>;

function readDetails(state: Doc<"eventDomainMigrationState">): AuditDetails {
  const value = JSON.parse(state.auditDetailsJson ?? "null") as AuditDetails | null;
  if (!value || !Number.isSafeInteger(value.auditGeneration) || value.auditGeneration < 0 ||
    !Number.isSafeInteger(value.missingEventReferenceCount) || value.missingEventReferenceCount < 0 ||
    !Number.isSafeInteger(value.indexedReferenceCount) || value.indexedReferenceCount < 0 ||
    !Number.isSafeInteger(value.sweptReferenceCount) || value.sweptReferenceCount < 0 ||
    !Array.isArray(value.mismatchExamples) || value.mismatchExamples.length > MAX_EXAMPLES) {
    throw new Error("Retention receipt audit metadata is invalid.");
  }
  return value;
}

async function readState(ctx: MutationCtx) {
  const rows = await ctx.db.query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", RETENTION_RECEIPT_COVERAGE_KEY)).take(2);
  if (rows.length > 1) throw new Error("Retention receipt coverage is not unique.");
  return rows[0] ?? null;
}

function stateIsReady(state: Doc<"eventDomainMigrationState">, epoch: number): boolean {
  return state.phase === "retention_reference_complete" && state.isDone === true &&
    state.completedAt !== undefined && state.topologyEpoch === epoch &&
    state.mismatchCount === 0 && (state.errorCount ?? 0) === 0 &&
    state.scannedCount === state.unchangedCount;
}

/** This proof guarantees reverse discoverability, NOT semantic correctness. */
export async function assertCompleteRetentionReceiptCoverage(
  ctx: MutationCtx,
): Promise<RetentionReceiptCoverageProof> {
  const [state, epoch] = await Promise.all([readState(ctx), readSourceOccurrenceTopologyEpoch(ctx)]);
  if (!state || !stateIsReady(state, epoch?.currentEpoch ?? 0)) {
    throw new Error("Event expiry is waiting for complete current-epoch retention receipt coverage.");
  }
  const details = readDetails(state);
  return { stateId: state._id, topologyEpoch: state.topologyEpoch!, auditGeneration: details.auditGeneration };
}

/**
 * Every receipt naming this event is in this exact-generation reverse index.
 * The expiry caller must still verify ALL represented dates and source rows,
 * clear the retired bindings, and delete these index rows in its transaction.
 */
export async function loadCompleteRetentionReceiptReferences(
  ctx: MutationCtx,
  eventId: Id<"events">,
  proof: RetentionReceiptCoverageProof,
): Promise<{
  receipts: Doc<"instagramSourceOccurrenceReceipts">[];
  referenceRows: Doc<"eventRetentionReceiptReferences">[];
}> {
  const current = await assertCompleteRetentionReceiptCoverage(ctx);
  if (current.stateId !== proof.stateId || current.topologyEpoch !== proof.topologyEpoch ||
    current.auditGeneration !== proof.auditGeneration) {
    throw new Error("Retention receipt coverage proof is stale.");
  }
  const referenceRows = await ctx.db.query("eventRetentionReceiptReferences")
    .withIndex("by_auditGeneration_eventId", (q) =>
      q.eq("auditGeneration", proof.auditGeneration).eq("eventId", eventId))
    .take(MAX_REFERENCES_PER_EVENT + 1);
  if (referenceRows.length > MAX_REFERENCES_PER_EVENT) {
    throw new Error("Event expiry receipt references exceed the bounded operation limit.");
  }
  const receipts: Doc<"instagramSourceOccurrenceReceipts">[] = [];
  const seen = new Set<string>();
  for (const reference of referenceRows) {
    if (seen.has(reference.receiptId)) throw new Error("Event expiry receipt reference is duplicated.");
    seen.add(reference.receiptId);
    const receipt = await ctx.db.get(reference.receiptId);
    if (!receipt) throw new Error("Event expiry receipt reference is missing.");
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    if (!receipt.satisfiedOccurrences.some((item) => item.eventId === eventId)) {
      throw new Error("Event expiry receipt reference is stale.");
    }
    receipts.push(receipt);
  }
  return { receipts, referenceRows };
}

/**
 * Called ONLY after the expiry transaction has checked all reverse references,
 * removed exactly its expired bindings, and preserved all other bindings. The
 * stable generation is not the advancing source epoch. Other writers therefore
 * invalidate this proof; they cannot implicitly certify retention coverage.
 */
export async function advanceRetentionReceiptCoverage(
  ctx: MutationCtx,
  proof: RetentionReceiptCoverageProof,
): Promise<void> {
  const state = await readState(ctx);
  if (!state || state._id !== proof.stateId || !stateIsReady(state, proof.topologyEpoch) ||
    readDetails(state).auditGeneration !== proof.auditGeneration) {
    throw new Error("Retention receipt coverage cannot advance from a stale proof.");
  }
  const epoch = (await readSourceOccurrenceTopologyEpoch(ctx))?.currentEpoch ?? 0;
  if (epoch < proof.topologyEpoch) throw new Error("Retention source epoch regressed.");
  await ctx.db.patch(state._id, { topologyEpoch: epoch, updatedAt: Date.now() });
}

export const auditRetentionReceiptCoverageBatch = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    ready: v.boolean(), isDone: v.boolean(), restarted: v.boolean(),
    phase: v.union(
      v.literal("retention_reference_receipts"), v.literal("retention_reference_sweep"),
      v.literal("retention_reference_complete"), v.literal("retention_reference_blocked"),
    ),
    scannedCount: v.number(), mismatchCount: v.number(),
    missingEventReferenceCount: v.number(), indexedReferenceCount: v.number(),
    sweptReferenceCount: v.number(), topologyEpoch: v.number(), auditGeneration: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await readState(ctx);
    const topologyEpoch = (await readSourceOccurrenceTopologyEpoch(ctx))?.currentEpoch ?? 0;
    const restarted = !existing || existing.topologyEpoch !== topologyEpoch;
    const previousDetails = existing ? readDetails(existing) : null;
    const details: AuditDetails = restarted ? {
      auditGeneration: Math.max(now, (previousDetails?.auditGeneration ?? 0) + 1),
      missingEventReferenceCount: 0, indexedReferenceCount: 0, sweptReferenceCount: 0,
      mismatchExamples: [],
    } : previousDetails!;
    if (!Number.isSafeInteger(details.auditGeneration)) throw new Error("Retention audit generation exhausted.");
    if (!restarted && !auditPhases.includes(existing!.phase as AuditPhase)) {
      throw new Error("Retention receipt coverage phase is invalid.");
    }
    let phase: AuditPhase = restarted ? "retention_reference_receipts" : existing!.phase as AuditPhase;
    let cursor = restarted ? null : (existing!.cursor ?? null);
    let scannedCount = restarted ? 0 : existing!.scannedCount;
    let unchangedCount = restarted ? 0 : (existing!.unchangedCount ?? 0);
    let mismatchCount = restarted ? 0 : existing!.mismatchCount;

    if (phase === "retention_reference_receipts") {
      const limit = Number.isFinite(args.limit)
        ? Math.max(1, Math.min(RECEIPT_BATCH_SIZE, Math.trunc(args.limit!))) : RECEIPT_BATCH_SIZE;
      const page = await ctx.db.query("instagramSourceOccurrenceReceipts").order("asc")
        .paginate({ cursor, numItems: limit });
      for (const receipt of page.page) {
        scannedCount += 1;
        let reason: string | null = null;
        try {
          assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
        } catch {
          reason = "receipt_shape_or_bounds";
        }
        if (!reason) {
          const sameIdentity = await ctx.db.query("instagramSourceOccurrenceReceipts")
            .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", receipt.sourceIdentity)).take(2);
          if (sameIdentity.length !== 1 || sameIdentity[0]!._id !== receipt._id) reason = "duplicate_receipt_identity";
        }
        if (reason) {
          mismatchCount += 1;
          if (details.mismatchExamples.length < MAX_EXAMPLES) details.mismatchExamples.push({ receiptId: receipt._id, reason });
          continue;
        }
        const eventIds = new Set(receipt.satisfiedOccurrences.map((item) => item.eventId));
        for (const eventId of eventIds) {
          if (!(await ctx.db.get(eventId))) {
            details.missingEventReferenceCount += receipt.satisfiedOccurrences.filter((item) => item.eventId === eventId).length;
            continue;
          }
          const references = await ctx.db.query("eventRetentionReceiptReferences")
            .withIndex("by_receiptId_eventId", (q) => q.eq("receiptId", receipt._id).eq("eventId", eventId)).take(2);
          if (references.length > 1) throw new Error("Retention receipt reverse index is duplicated.");
          const reference = references[0];
          if (reference) {
            await ctx.db.patch(reference._id, { auditGeneration: details.auditGeneration, updatedAt: now });
          } else {
            await ctx.db.insert("eventRetentionReceiptReferences", {
              receiptId: receipt._id, eventId, auditGeneration: details.auditGeneration, createdAt: now, updatedAt: now,
            });
          }
          details.indexedReferenceCount += 1;
        }
        unchangedCount += 1;
      }
      cursor = page.continueCursor;
      if (page.isDone) {
        phase = mismatchCount ? "retention_reference_blocked" : "retention_reference_sweep";
        cursor = null;
      }
    } else if (phase === "retention_reference_sweep") {
      const page = await ctx.db.query("eventRetentionReceiptReferences").order("asc")
        .paginate({ cursor, numItems: REFERENCE_SWEEP_BATCH_SIZE });
      for (const reference of page.page) {
        if (reference.auditGeneration !== details.auditGeneration) {
          await ctx.db.delete(reference._id);
          details.sweptReferenceCount += 1;
        }
      }
      cursor = page.continueCursor;
      if (page.isDone) phase = "retention_reference_complete";
    } else if (phase !== "retention_reference_complete" && phase !== "retention_reference_blocked") {
      throw new Error("Retention receipt coverage phase is invalid.");
    }
    const isDone = phase === "retention_reference_complete" || phase === "retention_reference_blocked";
    const ready = phase === "retention_reference_complete" && mismatchCount === 0;
    if (restarted || !existing || !stateIsReady(existing, topologyEpoch)) {
      const patch = {
        phase, cursor: cursor ?? undefined, topologyEpoch, isDone, scannedCount, unchangedCount,
        mismatchCount, updatedCount: 0, errorCount: 0, auditDetailsJson: JSON.stringify(details),
        completedAt: isDone ? now : undefined, updatedAt: now,
        attempt: (existing?.attempt ?? 0) + (restarted ? 1 : 0),
      };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("eventDomainMigrationState", { key: RETENTION_RECEIPT_COVERAGE_KEY, createdAt: now, ...patch });
    }
    return { ready, isDone, restarted, phase, scannedCount, mismatchCount,
      missingEventReferenceCount: details.missingEventReferenceCount,
      indexedReferenceCount: details.indexedReferenceCount, sweptReferenceCount: details.sweptReferenceCount,
      topologyEpoch, auditGeneration: details.auditGeneration };
  },
});
