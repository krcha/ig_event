import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  MAX_PUBLICATION_REFRESH_EVENTS,
  refreshEventPublicationStates,
} from "../../publicationPolicy";
import {
  buildSatisfiedSourceOccurrenceRow,
  syncSourceOccurrencePlan,
} from "../../sourceOccurrences";
import {
  canonicalizeSourceUrl,
  canonicalizeSourceUrlOrEmpty,
} from "../../../lib/domain/source-url";
import { isCrossPostCampaignAttestationEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { loadVerifiedCampaignLineageForSourceEvent } from "../campaignLineageReattestationProof";
import { loadVerifiedLegacySourceOccurrenceAdmission } from "../legacySourceOccurrenceAdmissionProof";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  assertSourceOccurrencePlanWithinBounds,
} from "../sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import {
  eventDomainMigrationPatchDiffers,
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

const MAX_SOURCE_DOCUMENT_MATCHES = 10;

function readEventAttestedSourceFingerprint(
  event: Doc<"events">,
): string | null {
  if (!event.normalizedFieldsJson) return null;
  try {
    const fields = JSON.parse(event.normalizedFieldsJson) as unknown;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return null;
    }
    const value = (fields as Record<string, unknown>)
      .sourceOccurrenceSourceFingerprint;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

async function findSourceDocument(
  ctx: MutationCtx,
  link: Doc<"instagramEventSources">,
): Promise<Doc<"scrapedPosts"> | null> {
  if (!link.instagramPostId) return null;
  const candidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_postId", (q) => q.eq("postId", link.instagramPostId!))
    .take(MAX_SOURCE_DOCUMENT_MATCHES + 1);
  if (candidates.length > MAX_SOURCE_DOCUMENT_MATCHES) return null;
  const expectedHandle = normalizeHandle(link.sourceHandle ?? "");
  const expectedCanonicalUrl = canonicalizeSourceUrlOrEmpty(
    "instagram",
    link.instagramPostUrl,
  );
  const matching = candidates.filter(
    (candidate) =>
      (!expectedHandle ||
        normalizeHandle(candidate.handle) === expectedHandle) &&
      (!link.instagramPostUrl ||
        (expectedCanonicalUrl &&
          canonicalizeSourceUrlOrEmpty(
            "instagram",
            candidate.instagramPostUrl,
          ) === expectedCanonicalUrl)),
  );
  return matching.length === 1 ? matching[0]! : null;
}

async function hasCurrentSourceExtractionBinding(
  ctx: MutationCtx,
  event: Doc<"events">,
  sourceDocument: Doc<"scrapedPosts">,
): Promise<boolean> {
  if (
    !event.rawExtractionJson ||
    event.rawExtractionJson !== sourceDocument.analysisResultJson
  ) {
    return false;
  }
  let normalizedFields: Record<string, unknown>;
  try {
    const parsed = event.normalizedFieldsJson
      ? (JSON.parse(event.normalizedFieldsJson) as unknown)
      : null;
    normalizedFields =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return false;
  }
  if (normalizedFields.extractionMode !== "poster") return true;
  if (
    !sourceDocument.postId ||
    !sourceDocument.analysisImageSourceUrl ||
    !sourceDocument.analysisImageChecksumSha256 ||
    !sourceDocument.imageStorageId
  ) {
    return false;
  }
  const mediaAssets = await ctx.db
    .query("mediaAssets")
    .withIndex("by_sourceKey", (q) =>
      q.eq("sourceKey", `instagram-post:${sourceDocument.postId}`),
    )
    .take(2);
  const asset = mediaAssets.length === 1 ? mediaAssets[0] : null;
  return Boolean(
    asset &&
    asset.storageId === sourceDocument.imageStorageId &&
    asset.checksumSha256 === sourceDocument.analysisImageChecksumSha256 &&
    ((event.imageUrl === undefined && event.imageStorageId === undefined) ||
      (event.imageUrl === asset.url &&
        event.imageStorageId === asset.storageId)),
  );
}

/**
 * Builds first-class occurrences from proven legacy receipt/link bindings.
 * Audited campaign lineage is intentionally skipped for dedicated re-attestation.
 */
export async function backfillSourceOccurrencesBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("instagramEventSources")
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
  for (const link of page.page) {
    const event = await ctx.db.get(link.eventId);
    if (!event) {
      counts.mismatchCount += 1;
      continue;
    }
    if (isCrossPostCampaignAttestationEvent(event)) {
      const campaignProof = await loadVerifiedCampaignLineageForSourceEvent(
        ctx,
        event,
      );
      if (campaignProof && campaignProof.sourceLinkIds.has(String(link._id))) {
        counts.unchangedCount! += 1;
        continue;
      }
      counts.skippedCount! += 1;
      counts.quarantinedLineageMarkerCount! += 1;
      continue;
    }
    const [sourceDocument, receipts] = await Promise.all([
      findSourceDocument(ctx, link),
      ctx.db
        .query("instagramSourceOccurrenceReceipts")
        .withIndex("by_sourceIdentity", (q) =>
          q.eq("sourceIdentity", link.sourceIdentity),
        )
        .take(2),
    ]);
    const receipt = receipts.length === 1 ? receipts[0]! : null;
    let receiptWithinBounds = false;
    if (receipt) {
      try {
        assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
        receiptWithinBounds = true;
      } catch {
        receiptWithinBounds = false;
      }
    }
    if (!receipt || !receiptWithinBounds) {
      counts.mismatchCount += 1;
      continue;
    }
    const expectedOccurrence = receipt.expectedOccurrences?.find(
      (occurrence) => occurrence.key === link.sourceOccurrenceKey,
    );
    const satisfied = receipt.satisfiedOccurrences.filter(
      (occurrence) => occurrence.key === link.sourceOccurrenceKey,
    );
    const sourceRevision = sourceDocument?.sourceRevision ?? 1;
    const attestedSourceFingerprint = readEventAttestedSourceFingerprint(event);
    const currentExtractionBound = sourceDocument
      ? await hasCurrentSourceExtractionBinding(ctx, event, sourceDocument)
      : false;
    const currentBindingStrict = Boolean(
      sourceDocument &&
        sourceDocument.processingStatus === "completed" &&
        sourceDocument.analysisRevision === sourceRevision &&
        sourceDocument.analysisResultJson &&
        currentExtractionBound &&
        receipt.sourceFingerprint === link.sourceFingerprint &&
        attestedSourceFingerprint === link.sourceFingerprint &&
        expectedOccurrence &&
        satisfied.length === 1 &&
        satisfied[0]?.eventId === event._id &&
        sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence),
    );
    const legacyAdmission =
      !currentBindingStrict && sourceDocument && expectedOccurrence
        ? await loadVerifiedLegacySourceOccurrenceAdmission(ctx, {
            event,
            link,
            receipt,
            sourceDocument,
          })
        : null;
    if (
      !sourceDocument ||
      !expectedOccurrence ||
      (!currentBindingStrict && !legacyAdmission)
    ) {
      counts.mismatchCount += 1;
      continue;
    }
    const affectedRepresentativeEventIds = [
      ...new Set(receipt.satisfiedOccurrences.map((item) => item.eventId)),
    ];
    if (
      affectedRepresentativeEventIds.length > MAX_PUBLICATION_REFRESH_EVENTS
    ) {
      counts.mismatchCount += 1;
      continue;
    }
    const existingRows = await ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", link.sourceIdentity)
          .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
      )
      .take(2);
    if (existingRows.length > 1) {
      counts.mismatchCount += 1;
      continue;
    }
    const existing = existingRows[0] ?? null;
    const canonical = canonicalizeSourceUrl(
      "instagram",
      sourceDocument.instagramPostUrl,
    );
    if (!canonical.ok) {
      counts.mismatchCount += 1;
      continue;
    }
    const plan = {
      deferredChildKeys: receipt.deferredChildKeys,
      expectedKeys: receipt.expectedKeys,
      expectedOccurrences: receipt.expectedOccurrences ?? [],
      sourceFingerprint: receipt.sourceFingerprint,
      sourceIdentity: receipt.sourceIdentity,
    };
    try {
      assertSourceOccurrencePlanWithinBounds({
        ...plan,
        deferredChildCount: receipt.deferredChildCount,
        observedChildKeys: [
          ...new Set([...receipt.expectedKeys, ...receipt.deferredChildKeys]),
        ],
      });
    } catch {
      counts.mismatchCount += 1;
      continue;
    }
    const expectedRow = buildSatisfiedSourceOccurrenceRow({
      canonicalSourceUrl: canonical.value.canonicalUrl,
      plan,
      representativeEvent: event,
      sourceDocument,
      sourceOccurrenceKey: link.sourceOccurrenceKey,
    });
    if (
      existing &&
      (existing.sourceDocumentId !== expectedRow.sourceDocumentId ||
        existing.sourceRevision > expectedRow.sourceRevision ||
        (existing.canonicalEventId !== undefined &&
          existing.canonicalEventId !== event._id) ||
        existing.state === "superseded")
    ) {
      counts.mismatchCount += 1;
      continue;
    }
    const alreadyComplete = Boolean(
      existing &&
      !eventDomainMigrationPatchDiffers(existing, expectedRow) &&
      existing.venueId === expectedRow.venueId &&
      link.sourceOccurrenceId === existing?._id &&
      link.canonicalSourceUrl === canonical.value.canonicalUrl,
    );
    if (alreadyComplete) {
      counts.unchangedCount! += 1;
      continue;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      const synced = await syncSourceOccurrencePlan({
        ctx,
        plan,
        representativeEvent: event,
        satisfiedKey: link.sourceOccurrenceKey,
        sourceDocument,
        topologyEpochVerified: true,
      });
      if (!synced) {
        throw new Error(
          "Source-occurrence migration did not return the satisfied row.",
        );
      }
      if (expectedRow.venueId === undefined) {
        await ctx.db.patch(synced.sourceOccurrenceId, { venueId: undefined });
      }
      // Preserve link.updatedAt: audited non-campaign consumers may still bind
      // that version, and these fields are strictly additive.
      await ctx.db.patch(link._id, {
        canonicalSourceUrl: synced.canonicalSourceUrl,
        sourceOccurrenceId: synced.sourceOccurrenceId,
      });
      await refreshEventPublicationStates(ctx, affectedRepresentativeEventIds);
    }
  }
  if (!dryRun && counts.updatedCount > 0) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "source-occurrences-generic-v2",
    phase: "source_occurrences_generic",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
