import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { RECEIPT_TOPOLOGY_AUDIT_KEY } from "../receiptTopologyCoverage";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import {
  finalizeSourceOccurrenceTopologyAudit,
  readSourceOccurrenceTopologyEpoch,
  type SourceOccurrenceTopologyEpochSnapshot,
} from "../sourceOccurrenceTopologyEpoch";
import {
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

const DEFAULT_RECEIPT_TOPOLOGY_AUDIT_BATCH_SIZE = 4;
const MAX_RECEIPT_TOPOLOGY_AUDIT_BATCH_SIZE = 4;

function normalizeReceiptTopologyAuditBatchSize(
  value: number | undefined,
): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RECEIPT_TOPOLOGY_AUDIT_BATCH_SIZE;
  }
  return Math.max(
    1,
    Math.min(
      MAX_RECEIPT_TOPOLOGY_AUDIT_BATCH_SIZE,
      Math.trunc(value as number),
    ),
  );
}

function assertReceiptTopologyAuditEpochCompatible(
  auditEpoch: number,
  live: SourceOccurrenceTopologyEpochSnapshot | null,
): void {
  if (!Number.isSafeInteger(auditEpoch) || auditEpoch < 0) {
    throw new Error(
      "Receipt-topology audit epoch is invalid; restart is required.",
    );
  }
  if (!live) {
    if (auditEpoch !== 0) {
      throw new Error(
        "Receipt-topology epoch state disappeared during the audit; restart is required.",
      );
    }
    return;
  }
  if (live.currentEpoch === auditEpoch) return;
  if (
    live.currentEpoch === live.verifiedEpoch &&
    auditEpoch <= live.verifiedEpoch
  ) {
    return;
  }
  throw new Error(
    "Source-occurrence topology changed without verification during the audit; restart is required.",
  );
}

async function receiptHasCompleteNormalizedTopology(
  ctx: MutationCtx,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
): Promise<boolean> {
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return false;
  }
  if (!receipt.expectedOccurrences) return false;

  const expectedByKey = new Map(
    receipt.expectedOccurrences.map((expected) => [expected.key, expected]),
  );
  for (const satisfaction of receipt.satisfiedOccurrences) {
    const expected = expectedByKey.get(satisfaction.key);
    if (!expected) return false;
    const [event, links, occurrences] = await Promise.all([
      ctx.db.get(satisfaction.eventId),
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", receipt.sourceIdentity)
            .eq("sourceOccurrenceKey", satisfaction.key),
        )
        .take(2),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", receipt.sourceIdentity)
            .eq("sourceOccurrenceKey", satisfaction.key),
        )
        .take(2),
    ]);
    const link = links.length === 1 ? links[0] : null;
    const occurrence = occurrences.length === 1 ? occurrences[0] : null;
    if (
      !event ||
      !sourceOccurrenceRepresentativeMatchesExpected(event, expected) ||
      !link ||
      link.eventId !== event._id ||
      link.sourceFingerprint !== receipt.sourceFingerprint ||
      !occurrence ||
      occurrence.state !== "satisfied" ||
      occurrence.canonicalEventId !== event._id ||
      occurrence.sourceFingerprint !== receipt.sourceFingerprint ||
      link.sourceOccurrenceId !== occurrence._id
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Full receipt-topology audit used as a cutover gate for generic destructive
 * event operations. The audit is read-only apart from its resumable progress
 * record and deliberately requires both compatibility links and first-class
 * occurrences for every satisfied receipt entry.
 */
export async function auditSourceOccurrenceReceiptTopologyBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const restart = args.restart ?? false;
  const inputCursor = args.cursor ?? null;
  const progressRows = dryRun
    ? []
    : await ctx.db
        .query("eventDomainMigrationState")
        .withIndex("by_key", (q) => q.eq("key", RECEIPT_TOPOLOGY_AUDIT_KEY))
        .take(2);
  if (progressRows.length > 1) {
    throw new Error("Receipt-topology audit progress is not unique.");
  }
  const existingProgress = progressRows[0] ?? null;
  if (!dryRun && !existingProgress && inputCursor !== null) {
    throw new Error("A receipt-topology audit must start from a null cursor.");
  }
  if (!dryRun && restart && inputCursor !== null) {
    throw new Error(
      "A receipt-topology audit restart must start from a null cursor.",
    );
  }
  if (
    !dryRun &&
    existingProgress &&
    !restart &&
    existingProgress.topologyEpoch === undefined
  ) {
    throw new Error(
      "Legacy receipt-topology audit progress has no epoch; restart is required.",
    );
  }
  const liveTopologyEpoch = await readSourceOccurrenceTopologyEpoch(ctx);
  const topologyEpoch =
    dryRun || restart || !existingProgress
      ? (liveTopologyEpoch?.currentEpoch ?? 0)
      : existingProgress.topologyEpoch!;
  assertReceiptTopologyAuditEpochCompatible(topologyEpoch, liveTopologyEpoch);
  const page = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .order("asc")
    .paginate({
      cursor: inputCursor,
      numItems: normalizeReceiptTopologyAuditBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: 0,
    scannedCount: page.page.length,
    skippedCount: 0,
    unchangedCount: 0,
    updatedCount: 0,
  };
  for (const receipt of page.page) {
    if (await receiptHasCompleteNormalizedTopology(ctx, receipt)) {
      counts.unchangedCount! += 1;
    } else {
      counts.mismatchCount += 1;
    }
  }
  const previousMismatchCount =
    existingProgress && !restart ? existingProgress.mismatchCount : 0;
  const previousErrorCount =
    existingProgress && !restart ? (existingProgress.errorCount ?? 0) : 0;
  const previousSkippedCount =
    existingProgress && !restart ? (existingProgress.skippedCount ?? 0) : 0;
  const previousQuarantinedCount =
    existingProgress && !restart
      ? (existingProgress.quarantinedLineageMarkerCount ?? 0)
      : 0;
  const previousUpdatedCount =
    existingProgress && !restart ? existingProgress.updatedCount : 0;
  const completeAndClean =
    page.isDone &&
    previousMismatchCount + counts.mismatchCount === 0 &&
    previousErrorCount + (counts.errorCount ?? 0) === 0 &&
    previousSkippedCount + (counts.skippedCount ?? 0) === 0 &&
    previousQuarantinedCount + (counts.quarantinedLineageMarkerCount ?? 0) ===
      0 &&
    previousUpdatedCount + counts.updatedCount === 0;
  if (!dryRun && completeAndClean) {
    await finalizeSourceOccurrenceTopologyAudit(ctx, {
      auditEpoch: topologyEpoch,
    });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor,
    isDone: page.isDone,
    key: RECEIPT_TOPOLOGY_AUDIT_KEY,
    phase: "receipt_topology_audit",
    restart,
    topologyEpoch,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
