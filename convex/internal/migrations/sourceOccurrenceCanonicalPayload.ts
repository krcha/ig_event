import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  parseCanonicalEventPayload,
  serializeCanonicalEventPayload,
  type CanonicalEventPayload,
} from "../../../lib/domain/occurrences/canonical-event-payload";
import { parseStructuredFactsJson } from "../../../lib/domain/occurrences/facts";
import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { adaptInstagramScrapedPostToSourceDocument } from "../../../lib/domain/source-documents";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeInstagramPostUrl } from "../../../lib/images/apify-images";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { receiptExpectedMatchesOccurrenceFacts } from "../reconciliationReceiptFacts";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
} from "../sourceOccurrenceReceipts";
import {
  sourceOccurrenceBindingWithinBounds,
  sourceOccurrenceSerializedPayloadWithinBounds,
} from "../sourceOccurrenceLimits";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import {
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const SOURCE_OCCURRENCE_CANONICAL_PAYLOAD_MIGRATION_KEY =
  "source-occurrence-canonical-payload-v1" as const;

type AttestationFailure = {
  kind: "mismatch" | "quarantined";
  reason: string;
};

type AttestedPayload = {
  canonicalEventJson: string;
  expectedOccurrenceIndex: number;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
};

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function optionalNonempty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function buildPayloadFromCanonicalEvent(
  event: Doc<"events">,
): string | null {
  if (
    (event.status !== "approved" && event.status !== "pending") ||
    !parseObject(event.normalizedFieldsJson) ||
    event.timeConfidence === undefined ||
    event.timeSource === undefined ||
    event.timeStatus === undefined
  ) {
    return null;
  }
  const payload: CanonicalEventPayload = {
    ...(event.dateEvidenceIsRelative !== undefined
      ? { dateEvidenceIsRelative: event.dateEvidenceIsRelative }
      : {}),
    ...(optionalNonempty(event.dateEvidenceResolvedDate)
      ? { dateEvidenceResolvedDate: event.dateEvidenceResolvedDate }
      : {}),
    ...(event.dateEvidenceSource
      ? { dateEvidenceSource: event.dateEvidenceSource }
      : {}),
    ...(optionalNonempty(event.dateEvidenceText)
      ? { dateEvidenceText: event.dateEvidenceText }
      : {}),
    ...(optionalNonempty(event.description)
      ? { description: event.description }
      : {}),
    normalizedFieldsJson: event.normalizedFieldsJson!,
    requestedStatus: event.status,
    sourceConflictFields: [...(event.sourceConflictFields ?? [])],
    ...(optionalNonempty(event.ticketPrice)
      ? { ticketPrice: event.ticketPrice }
      : {}),
    ...(optionalNonempty(event.time) ? { time: event.time } : {}),
    timeConfidence: event.timeConfidence,
    ...(event.timeEvidenceKind
      ? { timeEvidenceKind: event.timeEvidenceKind }
      : {}),
    ...(optionalNonempty(event.timeEvidenceText)
      ? { timeEvidenceText: event.timeEvidenceText }
      : {}),
    timeSource: event.timeSource,
    timeStatus: event.timeStatus,
  };
  try {
    return serializeCanonicalEventPayload(payload);
  } catch {
    return null;
  }
}

function eventHasExactOccurrenceSignature(
  event: Doc<"events">,
  occurrence: Doc<"sourceOccurrences">,
): boolean {
  const signature = buildEventOccurrenceIndexPatch(event);
  return Object.entries(signature).every(
    ([field, value]) =>
      JSON.stringify(
        occurrence[field as keyof Doc<"sourceOccurrences">],
      ) === JSON.stringify(value),
  );
}

function canonicalEventMatchesImmutableSource(options: {
  event: Doc<"events">;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: Doc<"scrapedPosts">;
}): boolean {
  const { event, occurrence, sourceDocument } = options;
  let adapted;
  try {
    adapted = adaptInstagramScrapedPostToSourceDocument(sourceDocument);
  } catch {
    return false;
  }
  const expectedImageUrl = sourceDocument.imageUrl ?? sourceDocument.imageUrls[0];
  const expectedAccountIdentity = normalizeHandle(
    sourceDocument.username ?? sourceDocument.handle,
  );
  const normalizedFields = parseObject(event.normalizedFieldsJson);
  const sourceGroundingIdentity = normalizeHandle(
    typeof normalizedFields?.sourceGroundingInstagramHandle === "string"
      ? normalizedFields.sourceGroundingInstagramHandle
      : "",
  );
  const currentFingerprint = buildInstagramSourceOccurrenceFingerprint({
    altText: sourceDocument.altText,
    caption: sourceDocument.caption,
    locationName: sourceDocument.locationName,
  });
  return Boolean(
    sourceDocument.processingStatus === "completed" &&
      sourceDocument.analysisRevision === adapted.sourceRevision &&
      sourceDocument.analysisResultJson &&
      occurrence.sourceDocumentId === sourceDocument._id &&
      occurrence.sourceRevision === adapted.sourceRevision &&
      occurrence.sourceIdentity === adapted.sourceIdentity &&
      occurrence.canonicalSourceUrl === adapted.canonicalSource.canonicalUrl &&
      occurrence.sourceFingerprint === currentFingerprint &&
      event.canonicalSourceUrl === adapted.canonicalSource.canonicalUrl &&
      event.sourceOccurrenceKey === occurrence.sourceOccurrenceKey &&
      event.instagramPostId === sourceDocument.postId &&
      event.instagramPostUrl === sourceDocument.instagramPostUrl &&
      event.normalizedInstagramPostUrl ===
        normalizeInstagramPostUrl(sourceDocument.instagramPostUrl) &&
      event.rawExtractionJson === sourceDocument.analysisResultJson &&
      event.sourceCaption ===
        (sourceDocument.caption ? sourceDocument.caption : undefined) &&
      event.sourcePostedAt ===
        (sourceDocument.postedAt ? sourceDocument.postedAt : undefined) &&
      event.imageUrl === (expectedImageUrl ? expectedImageUrl : undefined) &&
      event.imageStorageId === sourceDocument.imageStorageId &&
      normalizedFields !== null &&
      expectedAccountIdentity !== "" &&
      sourceGroundingIdentity === expectedAccountIdentity,
  );
}

async function attestOccurrencePayload(
  ctx: MutationCtx,
  occurrence: Doc<"sourceOccurrences">,
): Promise<AttestedPayload | AttestationFailure> {
  if (occurrence.state !== "satisfied" || !occurrence.canonicalEventId) {
    return { kind: "mismatch", reason: "occurrence_not_satisfied" };
  }
  const [event, sourceDocument, links, receipts] = await Promise.all([
    ctx.db.get(occurrence.canonicalEventId),
    ctx.db.get(occurrence.sourceDocumentId),
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", occurrence.sourceIdentity)
          .eq("sourceOccurrenceKey", occurrence.sourceOccurrenceKey),
      )
      .take(2),
    ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", occurrence.sourceIdentity),
      )
      .take(2),
  ]);
  if (!event || !sourceDocument) {
    return { kind: "mismatch", reason: "canonical_or_source_missing" };
  }
  if (isCrossPostCampaignLineageEvent(event)) {
    return {
      kind: "quarantined",
      reason: "audited_lineage_requires_reattestation",
    };
  }
  if (links.length !== 1 || receipts.length !== 1) {
    return { kind: "mismatch", reason: "provenance_not_unique" };
  }
  const link = links[0]!;
  const receipt = receipts[0]!;
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return { kind: "mismatch", reason: "receipt_invalid" };
  }
  const expectedOccurrenceIndex = (receipt.expectedOccurrences ?? []).findIndex(
    (expected) => expected.key === occurrence.sourceOccurrenceKey,
  );
  const expected = receipt.expectedOccurrences?.[expectedOccurrenceIndex];
  const satisfactions = receipt.satisfiedOccurrences.filter(
    (item) => item.key === occurrence.sourceOccurrenceKey,
  );
  const structuredFacts = parseStructuredFactsJson(occurrence.factsJson);
  if (
    !expected ||
    expectedOccurrenceIndex < 0 ||
    expected.factsJson !== occurrence.factsJson ||
    !structuredFacts ||
    structuredFacts.policy.approvalDisposition !== event.status ||
    satisfactions.length !== 1 ||
    satisfactions[0]!.eventId !== event._id ||
    receipt.sourceFingerprint !== occurrence.sourceFingerprint ||
    link.eventId !== event._id ||
    link.sourceOccurrenceId !== occurrence._id ||
    link.sourceIdentity !== occurrence.sourceIdentity ||
    link.sourceOccurrenceKey !== occurrence.sourceOccurrenceKey ||
    link.sourceFingerprint !== occurrence.sourceFingerprint ||
    link.canonicalSourceUrl !== occurrence.canonicalSourceUrl ||
    link.instagramPostId !== sourceDocument.postId ||
    link.instagramPostUrl !== sourceDocument.instagramPostUrl ||
    normalizeHandle(link.sourceHandle ?? "") !==
      normalizeHandle(sourceDocument.handle) ||
    event.venueId !== occurrence.venueId ||
    occurrence.venueResolutionStatus !== "resolved" ||
    !sourceOccurrenceRepresentativeMatchesExpected(event, expected) ||
    !receiptExpectedMatchesOccurrenceFacts(expected, occurrence) ||
    !eventHasExactOccurrenceSignature(event, occurrence) ||
    !canonicalEventMatchesImmutableSource({
      event,
      occurrence,
      sourceDocument,
    })
  ) {
    return { kind: "mismatch", reason: "attested_binding_drifted" };
  }
  const canonicalEventJson = buildPayloadFromCanonicalEvent(event);
  if (!canonicalEventJson) {
    return { kind: "mismatch", reason: "canonical_payload_unrepresentable" };
  }
  const occurrencePayload = parseCanonicalEventPayload(
    occurrence.canonicalEventJson,
  );
  const receiptPayload = parseCanonicalEventPayload(expected.canonicalEventJson);
  if (
    (occurrence.canonicalEventJson !== undefined && !occurrencePayload) ||
    (expected.canonicalEventJson !== undefined && !receiptPayload) ||
    (occurrence.canonicalEventJson !== undefined &&
      occurrence.canonicalEventJson !== canonicalEventJson) ||
    (expected.canonicalEventJson !== undefined &&
      expected.canonicalEventJson !== canonicalEventJson)
  ) {
    return { kind: "mismatch", reason: "existing_payload_conflicted" };
  }
  const nextExpected = { ...expected, canonicalEventJson };
  const nextExpectedOccurrences = [...receipt.expectedOccurrences!];
  nextExpectedOccurrences[expectedOccurrenceIndex] = nextExpected;
  if (
    !sourceOccurrenceBindingWithinBounds(nextExpected) ||
    !sourceOccurrenceSerializedPayloadWithinBounds({
      ...receipt,
      expectedOccurrences: nextExpectedOccurrences,
    })
  ) {
    return { kind: "mismatch", reason: "canonical_payload_exceeds_bounds" };
  }
  return { canonicalEventJson, expectedOccurrenceIndex, receipt };
}

/**
 * Atomically attests the presentation/moderation payload on legacy normalized
 * occurrences and their compatibility receipt. No payload is synthesized from
 * an ambiguous, stale, rejected, or campaign-lineage binding.
 */
export async function backfillSourceOccurrenceCanonicalPayloadsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("sourceOccurrences")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: 0,
    quarantinedLineageMarkerCount: 0,
    scannedCount: page.page.length,
    skippedCount: 0,
    unchangedCount: 0,
    updatedCount: 0,
  };
  const reasonCounts: Record<string, number> = {};
  let topologyMutated = false;
  for (const occurrence of page.page) {
    const attestation = await attestOccurrencePayload(ctx, occurrence);
    if ("kind" in attestation) {
      reasonCounts[attestation.reason] =
        (reasonCounts[attestation.reason] ?? 0) + 1;
      if (attestation.kind === "quarantined") {
        counts.skippedCount! += 1;
        counts.quarantinedLineageMarkerCount! += 1;
      } else {
        counts.mismatchCount += 1;
      }
      continue;
    }
    const expected = attestation.receipt.expectedOccurrences![
      attestation.expectedOccurrenceIndex
    ]!;
    const occurrenceNeedsPatch =
      occurrence.canonicalEventJson !== attestation.canonicalEventJson;
    const receiptNeedsPatch =
      expected.canonicalEventJson !== attestation.canonicalEventJson;
    if (!occurrenceNeedsPatch && !receiptNeedsPatch) {
      counts.unchangedCount! += 1;
      continue;
    }
    counts.updatedCount += 1;
    if (dryRun) continue;
    const now = Date.now();
    if (occurrenceNeedsPatch) {
      await ctx.db.patch(occurrence._id, {
        canonicalEventJson: attestation.canonicalEventJson,
        updatedAt: Math.max(now, occurrence.updatedAt + 1),
      });
    }
    if (receiptNeedsPatch) {
      const expectedOccurrences = [
        ...attestation.receipt.expectedOccurrences!,
      ];
      expectedOccurrences[attestation.expectedOccurrenceIndex] = {
        ...expected,
        canonicalEventJson: attestation.canonicalEventJson,
      };
      await ctx.db.patch(attestation.receipt._id, {
        expectedOccurrences,
        updatedAt: Math.max(now, attestation.receipt.updatedAt + 1),
      });
    }
    topologyMutated = true;
  }
  if (!dryRun && topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    detailJson: JSON.stringify({ reasonCounts }),
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: SOURCE_OCCURRENCE_CANONICAL_PAYLOAD_MIGRATION_KEY,
    phase: "source_occurrence_canonical_payload",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
