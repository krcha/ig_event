import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { adaptInstagramScrapedPostToSourceDocument } from "../../../lib/domain/source-documents";
import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { requireAdminOrServiceSecret } from "../../authz";
import { writeEventAuditLog } from "../../eventDomain/persistence";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  eventRepresentsExpectedOccurrence,
} from "../sourceOccurrenceReceipts";
import { nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { preparePendingCinemaSourceConflictReclassification } from "../../../lib/events/pending-source-conflict-reclassification";

const MAX_RECLASSIFICATION_BATCH_SIZE = 16;

export type PendingConflictReclassificationVersion = {
  id: Id<"events">;
  expectedUpdatedAt: number;
  expectedNormalizedFieldsJson: string;
  expectedSourceLinkId: Id<"instagramEventSources">;
  expectedSourceLinkUpdatedAt: number;
};

type Receipt = Doc<"instagramSourceOccurrenceReceipts">;
type ReclassificationCtx = QueryCtx | MutationCtx;

function assertBatchSize(length: number): void {
  if (length < 1 || length > MAX_RECLASSIFICATION_BATCH_SIZE) {
    throw new Error("Pending conflict reclassification batch size is invalid.");
  }
}

async function loadCompleteReceipt(
  ctx: ReclassificationCtx,
  sourceIdentity: string,
): Promise<Receipt> {
  if (!sourceIdentity.trim()) {
    throw new Error("Pending conflict reclassification requires a source identity.");
  }
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceIdentity))
    .take(2);
  if (receipts.length !== 1) {
    throw new Error("Pending conflict reclassification requires one source receipt.");
  }
  const receipt = receipts[0];
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expected = receipt.expectedOccurrences;
  const satisfied = receipt.satisfiedOccurrences;
  const expectedKeys = new Set(receipt.expectedKeys);
  if (
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    !Array.isArray(expected) ||
    expected.length === 0 ||
    expected.length !== expectedKeys.size ||
    expected.length !== satisfied.length ||
    receipt.satisfiedKeys.length !== expectedKeys.size ||
    new Set(expected.map((item) => item.key)).size !== expected.length ||
    new Set(satisfied.map((item) => item.key)).size !== satisfied.length ||
    new Set(satisfied.map((item) => item.eventId)).size !== satisfied.length ||
    expected.some((item) => !expectedKeys.has(item.key)) ||
    receipt.satisfiedKeys.some((key) => !expectedKeys.has(key)) ||
    satisfied.some((item) => !expectedKeys.has(item.key))
  ) {
    throw new Error("Pending conflict reclassification requires a complete unique receipt.");
  }
  return receipt;
}

async function loadCandidate(
  ctx: ReclassificationCtx,
  receipt: Receipt,
  id: Id<"events">,
) {
  const event = await ctx.db.get(id);
  if (!event || event.status !== "pending") {
    throw new Error(`Pending conflict reclassification event is unavailable: ${id}.`);
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", id))
    .take(2);
  const link = links.length === 1 ? links[0] : null;
  const expected = receipt.expectedOccurrences?.find(
    (item) => item.key === link?.sourceOccurrenceKey,
  );
  const satisfied = receipt.satisfiedOccurrences.find(
    (item) => item.key === link?.sourceOccurrenceKey,
  );
  if (
    !link ||
    link.sourceIdentity !== receipt.sourceIdentity ||
    link.sourceFingerprint !== receipt.sourceFingerprint ||
    link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    !link.sourceOccurrenceId ||
    !expected ||
    satisfied?.eventId !== id ||
    !eventRepresentsExpectedOccurrence(event, expected, {
      allowUnverifiedPending: true,
    })
  ) {
    throw new Error(`Pending conflict reclassification source binding failed: ${id}.`);
  }
  const occurrence = await ctx.db.get(link.sourceOccurrenceId);
  if (
    !occurrence ||
    occurrence.state !== "satisfied" ||
    occurrence.canonicalEventId !== id ||
    occurrence.sourceIdentity !== receipt.sourceIdentity ||
    occurrence.sourceFingerprint !== receipt.sourceFingerprint ||
    occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey
  ) {
    throw new Error(`Pending conflict reclassification occurrence binding failed: ${id}.`);
  }
  const currentFields = JSON.parse(event.normalizedFieldsJson ?? "null") as unknown;
  if (
    !currentFields ||
    typeof currentFields !== "object" ||
    Array.isArray(currentFields) ||
    (currentFields as Record<string, unknown>).sourceOccurrenceKey !== link.sourceOccurrenceKey ||
    (currentFields as Record<string, unknown>).sourceOccurrenceSourceFingerprint !== receipt.sourceFingerprint
  ) {
    throw new Error(`Pending conflict reclassification normalized binding failed: ${id}.`);
  }
  const handleValue = (currentFields as Record<string, unknown>).sourceGroundingInstagramHandle;
  const handle = typeof handleValue === "string" ? normalizeHandle(handleValue) : "";
  const postId = event.instagramPostId?.trim() ?? "";
  if (!handle || !postId) {
    throw new Error(`Pending conflict reclassification source document identity failed: ${id}.`);
  }
  const sourceRows = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) => q.eq("handle", handle).eq("postId", postId))
    .take(2);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  if (
    !source ||
    normalizeHandle(source.username) !== handle ||
    source.analysisRevision !== (source.sourceRevision ?? 1) ||
    source.analysisContractVersion !== "event_evidence_v2" ||
    source.analysisIsEvent !== true ||
    !source.analysisModel?.startsWith("gpt-5-mini") ||
    event.rawExtractionJson !== source.analysisResultJson ||
    occurrence.sourceDocumentId !== source._id ||
    occurrence.sourceRevision !== (source.sourceRevision ?? 1) ||
    adaptInstagramScrapedPostToSourceDocument(source).sourceIdentity !== receipt.sourceIdentity ||
    buildInstagramSourceOccurrenceFingerprint(source) !== receipt.sourceFingerprint
  ) {
    throw new Error(`Pending conflict reclassification current source revision failed: ${id}.`);
  }
  const prepared = preparePendingCinemaSourceConflictReclassification(event);
  if (
    !eventRepresentsExpectedOccurrence(
      { ...event, normalizedFieldsJson: prepared.normalizedFieldsJson },
      expected,
      { allowUnverifiedPending: true },
    )
  ) {
    throw new Error(`Pending conflict reclassification would change the occurrence: ${id}.`);
  }
  return { event, link, prepared };
}

export async function previewPendingCinemaSourceConflictReclassificationHandler(
  ctx: QueryCtx,
  args: {
    sourceIdentity: string;
    eventIds: Id<"events">[];
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("Pending conflict reclassification requires service authentication.");
  }
  assertBatchSize(args.eventIds.length);
  if (new Set(args.eventIds).size !== args.eventIds.length) {
    throw new Error("Pending conflict reclassification requires unique event IDs.");
  }
  const receipt = await loadCompleteReceipt(ctx, args.sourceIdentity);
  const items = [];
  for (const id of args.eventIds) {
    const candidate = await loadCandidate(ctx, receipt, id);
    items.push({
      id,
      expectedUpdatedAt: candidate.event.updatedAt,
      expectedNormalizedFieldsJson: candidate.event.normalizedFieldsJson ?? "",
      expectedSourceLinkId: candidate.link._id,
      expectedSourceLinkUpdatedAt: candidate.link.updatedAt,
      previousMaterialCount: candidate.prepared.previousMaterialCount,
      nextBenignCount: candidate.prepared.nextBenignCount,
    });
  }
  return {
    sourceIdentity: receipt.sourceIdentity,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
    expectedSourceFingerprint: receipt.sourceFingerprint,
    items,
  };
}

export async function reclassifyPendingCinemaSourceConflictsHandler(
  ctx: MutationCtx,
  args: {
    sourceIdentity: string;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceFingerprint: string;
    items: PendingConflictReclassificationVersion[];
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("Pending conflict reclassification requires service authentication.");
  }
  assertBatchSize(args.items.length);
  if (new Set(args.items.map((item) => item.id)).size !== args.items.length) {
    throw new Error("Pending conflict reclassification requires unique event IDs.");
  }
  const receipt = await loadCompleteReceipt(ctx, args.sourceIdentity);
  if (
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceFingerprint !== args.expectedSourceFingerprint
  ) {
    throw new Error("Pending conflict reclassification receipt version changed.");
  }
  const prepared = [];
  for (const item of args.items) {
    const candidate = await loadCandidate(ctx, receipt, item.id);
    if (
      candidate.event.updatedAt !== item.expectedUpdatedAt ||
      candidate.event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson ||
      candidate.link._id !== item.expectedSourceLinkId ||
      candidate.link.updatedAt !== item.expectedSourceLinkUpdatedAt
    ) {
      throw new Error(`Pending conflict reclassification version changed: ${item.id}.`);
    }
    prepared.push(candidate);
  }
  const updated = [];
  for (const candidate of prepared) {
    const updatedAt = nextEventUpdatedAt(candidate.event.updatedAt);
    await ctx.db.patch(candidate.event._id, {
      normalizedFieldsJson: candidate.prepared.normalizedFieldsJson,
      sourceConflictFields: candidate.prepared.sourceConflictFields,
      updatedAt,
    });
    await writeEventAuditLog(
      ctx,
      candidate.event._id,
      "pending_cinema_source_conflict_reclassified",
      {
        actor: authorization.actor,
        patch: {
          sourceIdentity: receipt.sourceIdentity,
          sourceFingerprint: receipt.sourceFingerprint,
          sourceOccurrenceKey: candidate.link.sourceOccurrenceKey,
          previousMaterialCount: candidate.prepared.previousMaterialCount,
          nextBenignCount: candidate.prepared.nextBenignCount,
        },
      },
    );
    updated.push({ id: candidate.event._id, updatedAt });
  }
  return {
    updatedCount: updated.length,
    receiptUpdatedAt: receipt.updatedAt,
    updated,
  };
}
