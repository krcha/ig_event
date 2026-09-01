import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { canonicalizeSourceUrl } from "../../../lib/domain/source-url";
import { buildSourceDocumentIdentity } from "../../../lib/domain/source-documents";
import {
  isCrossPostCampaignAttestationEvent,
  isCrossPostCampaignLineageEvent,
} from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  readPersistedSourceOccurrenceBinding,
  sourceOccurrenceRepresentativeMatchesExpected,
} from "../../../lib/events/source-occurrence-representation";
import { loadVerifiedCampaignLineageForSourceEvent } from "../campaignLineageReattestationProof";
import {
  buildLegacySourceOccurrenceAdmissionDigest,
  findLegacyAdmissionSourceDocument,
  legacyAdmissionSourceIdentityMatches,
  LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY,
  loadVerifiedLegacySourceOccurrenceAdmission,
} from "../legacySourceOccurrenceAdmissionProof";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
} from "../sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { loadVerifiedRejectedReviewedFoldPrimary } from "./eventVenueBindings";
import {
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const LEGACY_SOURCE_IDENTITY_CANONICALIZATION_KEY =
  "legacy-source-identity-canonicalization-v1" as const;

type SourceIdentityGroupAssessment =
  | { kind: "invalid" }
  | { kind: "unchanged" }
  | {
      canonicalIdentity: string;
      kind: "repair";
      links: Doc<"instagramEventSources">[];
      occurrences: Doc<"sourceOccurrences">[];
      receipt: Doc<"instagramSourceOccurrenceReceipts">;
    };

async function assessSourceIdentityGroup(
  ctx: MutationCtx,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
): Promise<SourceIdentityGroupAssessment> {
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return { kind: "invalid" };
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) =>
      q.eq("sourceIdentity", receipt.sourceIdentity),
    )
    .take(MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE + 1);
  if (
    links.length === 0 ||
    links.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    new Set(links.map((link) => link.sourceOccurrenceKey)).size !== links.length
  ) {
    return { kind: "invalid" };
  }
  const reference = links[0]!;
  const sourceDocument = await findLegacyAdmissionSourceDocument(ctx, reference);
  const canonicalSource = sourceDocument
    ? canonicalizeSourceUrl("instagram", sourceDocument.instagramPostUrl)
    : null;
  if (!sourceDocument || !canonicalSource?.ok) return { kind: "invalid" };
  const canonicalIdentity = buildSourceDocumentIdentity(
    "instagram",
    canonicalSource.value,
  );
  const events = await Promise.all(links.map((link) => ctx.db.get(link.eventId)));
  if (
    links.some(
      (link) =>
        link.instagramPostId !== reference.instagramPostId ||
        link.instagramPostUrl !== reference.instagramPostUrl ||
        link.sourceFingerprint !== receipt.sourceFingerprint,
    ) ||
    events.some((event) => event && isCrossPostCampaignLineageEvent(event))
  ) {
    return { kind: "invalid" };
  }
  if (receipt.sourceIdentity === canonicalIdentity) return { kind: "unchanged" };
  const [destinationReceipts, destinationLinks, destinationOccurrences, oldOccurrences, oldAdmissions] =
    await Promise.all([
      ctx.db
        .query("instagramSourceOccurrenceReceipts")
        .withIndex("by_sourceIdentity", (q) =>
          q.eq("sourceIdentity", canonicalIdentity),
        )
        .take(1),
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", canonicalIdentity),
        )
        .take(1),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", canonicalIdentity),
        )
        .take(1),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", receipt.sourceIdentity),
        )
        .take(MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE + 1),
      ctx.db
        .query("legacySourceOccurrenceAdmissions")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
            .eq("sourceIdentity", receipt.sourceIdentity),
        )
        .take(1),
    ]);
  const linkKeys = new Set(links.map((link) => link.sourceOccurrenceKey));
  if (
    destinationReceipts.length > 0 ||
    destinationLinks.length > 0 ||
    destinationOccurrences.length > 0 ||
    oldAdmissions.length > 0 ||
    oldOccurrences.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    oldOccurrences.some(
      (occurrence) => !linkKeys.has(occurrence.sourceOccurrenceKey),
    )
  ) {
    return { kind: "invalid" };
  }
  return {
    canonicalIdentity,
    kind: "repair",
    links,
    occurrences: oldOccurrences,
    receipt,
  };
}

/** Canonicalizes a whole pre-occurrence receipt/link identity group only when
 * one exact source document proves the destination and no destination rows or
 * audited lineage can be displaced. */
export async function canonicalizeLegacySourceIdentitiesBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: 0,
    scannedCount: page.page.length,
    skippedCount: 0,
    unchangedCount: 0,
    updatedCount: 0,
  };
  let topologyMutated = false;
  for (const receipt of page.page) {
    const assessment = await assessSourceIdentityGroup(ctx, receipt);
    if (assessment.kind === "invalid") {
      counts.mismatchCount += 1;
      continue;
    }
    if (assessment.kind === "unchanged") {
      counts.unchangedCount! += 1;
      continue;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      const now = Date.now();
      await ctx.db.patch(assessment.receipt._id, {
        sourceIdentity: assessment.canonicalIdentity,
        updatedAt: Math.max(now, assessment.receipt.updatedAt + 1),
      });
      for (const link of assessment.links) {
        await ctx.db.patch(link._id, {
          sourceIdentity: assessment.canonicalIdentity,
          updatedAt: Math.max(now, link.updatedAt + 1),
        });
      }
      for (const occurrence of assessment.occurrences) {
        await ctx.db.patch(occurrence._id, {
          sourceIdentity: assessment.canonicalIdentity,
          updatedAt: Math.max(now, occurrence.updatedAt + 1),
        });
      }
      topologyMutated = true;
    }
  }
  if (!dryRun && topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: LEGACY_SOURCE_IDENTITY_CANONICALIZATION_KEY,
    phase: "legacy_source_identity_canonicalization",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}

type PreparedAdmission = {
  event: Doc<"events">;
  link: Doc<"instagramEventSources">;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
  sourceDocument: Doc<"scrapedPosts">;
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

function bindingForReceiptRepair(event: Doc<"events">) {
  const snapshot = readPersistedSourceOccurrenceBinding(
    parseObject(event.normalizedFieldsJson),
  );
  return snapshot ?? {
    artists: [...event.artists],
    date: event.date,
    ...(event.time ? { time: event.time } : {}),
    title: event.title,
    venue: event.venue,
  };
}

function receiptWithRepairedRepresentative(
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  event: Doc<"events">,
  sourceOccurrenceKey: string,
): Doc<"instagramSourceOccurrenceReceipts"> | null {
  const expectedIndex = receipt.expectedOccurrences?.findIndex(
    (item) => item.key === sourceOccurrenceKey,
  );
  if (expectedIndex === undefined || expectedIndex < 0) return null;
  const expected = receipt.expectedOccurrences![expectedIndex]!;
  if (sourceOccurrenceRepresentativeMatchesExpected(event, expected)) {
    return receipt;
  }
  const binding = bindingForReceiptRepair(event);
  const repairedExpected = {
    key: sourceOccurrenceKey,
    artists: [...binding.artists],
    date: binding.date,
    ...(binding.time ? { time: binding.time } : {}),
    title: binding.title,
    venue: binding.venue,
  };
  const expectedOccurrences = [...receipt.expectedOccurrences!];
  expectedOccurrences[expectedIndex] = repairedExpected;
  const repaired = { ...receipt, expectedOccurrences };
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(repaired);
  } catch {
    return null;
  }
  return sourceOccurrenceRepresentativeMatchesExpected(event, repairedExpected)
    ? repaired
    : null;
}

async function prepareAdmission(
  ctx: MutationCtx,
  event: Doc<"events">,
  link: Doc<"instagramEventSources">,
): Promise<PreparedAdmission | null> {
  const [sourceDocument, receipts] = await Promise.all([
    findLegacyAdmissionSourceDocument(ctx, link),
    ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", link.sourceIdentity),
      )
      .take(2),
  ]);
  const receipt = receipts.length === 1 ? receipts[0]! : null;
  if (
    !sourceDocument ||
    !receipt ||
    (event.status !== "approved" && event.status !== "pending") ||
    link.eventId !== event._id ||
    !legacyAdmissionSourceIdentityMatches(link, sourceDocument) ||
    receipt.sourceFingerprint !== link.sourceFingerprint
  ) {
    return null;
  }
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return null;
  }
  const satisfactions = receipt.satisfiedOccurrences.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  if (
    satisfactions.length !== 1 ||
    satisfactions[0]?.eventId !== event._id ||
    receipt.expectedKeys.filter((key) => key === link.sourceOccurrenceKey)
      .length !== 1 ||
    receipt.satisfiedKeys.filter((key) => key === link.sourceOccurrenceKey)
      .length !== 1
  ) {
    return null;
  }
  const repairedReceipt = receiptWithRepairedRepresentative(
    receipt,
    event,
    link.sourceOccurrenceKey,
  );
  const attestedEvent = {
    ...event,
    legacySourceOccurrenceAdmissionPolicyVersion: 1 as const,
  };
  return repairedReceipt
    ? { event: attestedEvent, link, receipt: repairedReceipt, sourceDocument }
    : null;
}

async function prepareReviewedFoldRewire(
  ctx: MutationCtx,
  rejectedEvent: Doc<"events">,
  link: Doc<"instagramEventSources">,
): Promise<{
  prepared: PreparedAdmission;
  primary: Doc<"events">;
  rejectedEventId: Doc<"events">["_id"];
} | null> {
  const primary = await loadVerifiedRejectedReviewedFoldPrimary(
    ctx,
    rejectedEvent,
  );
  if (!primary) return null;
  const rewiredLink = {
    ...link,
    eventId: primary._id,
    updatedAt: link.updatedAt + 1,
  };
  const prepared = await prepareAdmission(ctx, primary, rewiredLink);
  return prepared
    ? { prepared, primary, rejectedEventId: rejectedEvent._id }
    : null;
}

async function retireStaleLink(
  ctx: MutationCtx,
  link: Doc<"instagramEventSources">,
): Promise<boolean> {
  const [receipts, occurrences, admissions] = await Promise.all([
    ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", link.sourceIdentity),
      )
      .take(2),
    ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", link.sourceIdentity)
          .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
      )
      .take(2),
    ctx.db
      .query("legacySourceOccurrenceAdmissions")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
          .eq("sourceIdentity", link.sourceIdentity)
          .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
      )
      .take(2),
  ]);
  const receipt = receipts.length === 1 ? receipts[0]! : null;
  const occurrence = occurrences.length === 1 ? occurrences[0]! : null;
  if (!receipt || occurrences.length > 1 || admissions.length > 1) return false;
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return false;
  }
  const satisfactions = receipt.satisfiedOccurrences.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  if (
    receipt.sourceFingerprint !== link.sourceFingerprint ||
    satisfactions.length !== 1 ||
    satisfactions[0]?.eventId !== link.eventId ||
    receipt.expectedKeys.filter((key) => key === link.sourceOccurrenceKey)
      .length !== 1 ||
    receipt.satisfiedKeys.filter((key) => key === link.sourceOccurrenceKey)
      .length !== 1 ||
    (occurrence &&
      (occurrence.state !== "satisfied" ||
        occurrence.canonicalEventId !== link.eventId ||
        occurrence.sourceFingerprint !== link.sourceFingerprint))
  ) {
    return false;
  }
  const now = Date.now();
  await ctx.db.patch(receipt._id, {
    satisfiedKeys: receipt.satisfiedKeys.filter(
      (key) => key !== link.sourceOccurrenceKey,
    ),
    satisfiedOccurrences: receipt.satisfiedOccurrences.filter(
      (item) => item.key !== link.sourceOccurrenceKey,
    ),
    updatedAt: Math.max(now, receipt.updatedAt + 1),
  });
  if (occurrence) await ctx.db.delete(occurrence._id);
  if (admissions[0]) await ctx.db.delete(admissions[0]._id);
  await ctx.db.delete(link._id);
  return true;
}

async function upsertAdmission(
  ctx: MutationCtx,
  prepared: PreparedAdmission,
): Promise<void> {
  const rows = await ctx.db
    .query("legacySourceOccurrenceAdmissions")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
        .eq("sourceIdentity", prepared.link.sourceIdentity)
        .eq("sourceOccurrenceKey", prepared.link.sourceOccurrenceKey),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Legacy source-occurrence admission proof is not unique.");
  }
  const now = Date.now();
  const evidenceDigestSha256 =
    buildLegacySourceOccurrenceAdmissionDigest(prepared);
  const value = {
    eventId: prepared.event._id,
    evidenceDigestSha256,
    receiptId: prepared.receipt._id,
    sourceDocumentId: prepared.sourceDocument._id,
    sourceIdentity: prepared.link.sourceIdentity,
    sourceLinkId: prepared.link._id,
    sourceOccurrenceKey: prepared.link.sourceOccurrenceKey,
    updatedAt: now,
  } as const;
  if (rows[0]) {
    await ctx.db.patch(rows[0]._id, value);
  } else {
    await ctx.db.insert("legacySourceOccurrenceAdmissions", {
      ...value,
      createdAt: now,
      migrationKey: LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY,
    });
  }
}

/**
 * Establishes an explicit proof boundary for pre-SourceOccurrence data. Rows
 * whose canonical event is gone or rejected are retired from satisfied legacy
 * topology; live rows are re-attested without inventing missing source media.
 */
export async function admitLegacySourceOccurrencesBatchHandler(
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
    scannedCount: page.page.length,
    skippedCount: 0,
    unchangedCount: 0,
    updatedCount: 0,
  };
  const reasonCounts: Record<string, number> = {};
  let topologyMutated = false;
  for (const link of page.page) {
    const event = await ctx.db.get(link.eventId);
    if (
      event?.status === "rejected" &&
      !isCrossPostCampaignAttestationEvent(event)
    ) {
      const reviewedFold = await prepareReviewedFoldRewire(ctx, event, link);
      if (reviewedFold) {
        counts.updatedCount += 1;
        if (!dryRun) {
          const currentReceipt = await ctx.db.get(
            reviewedFold.prepared.receipt._id,
          );
          if (!currentReceipt) {
            throw new Error("Reviewed-fold receipt disappeared after validation.");
          }
          const receiptNeedsRepair =
            JSON.stringify(currentReceipt.expectedOccurrences) !==
            JSON.stringify(reviewedFold.prepared.receipt.expectedOccurrences);
          if (receiptNeedsRepair) {
            await ctx.db.patch(currentReceipt._id, {
              expectedOccurrences:
                reviewedFold.prepared.receipt.expectedOccurrences,
              updatedAt: Math.max(Date.now(), currentReceipt.updatedAt + 1),
            });
          }
          await ctx.db.patch(link._id, {
            eventId: reviewedFold.primary._id,
            updatedAt: reviewedFold.prepared.link.updatedAt,
          });
          if (
            reviewedFold.primary
              .legacySourceOccurrenceAdmissionPolicyVersion !== 1
          ) {
            await ctx.db.patch(reviewedFold.primary._id, {
              legacySourceOccurrenceAdmissionPolicyVersion: 1,
            });
          }
          await upsertAdmission(ctx, reviewedFold.prepared);
          await ctx.db.insert("eventAuditLog", {
            action: "legacy_reviewed_fold_source_rewired",
            actor: LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY,
            createdAt: Date.now(),
            eventId: reviewedFold.primary._id,
            patchJson: JSON.stringify({
              rejectedEventId: reviewedFold.rejectedEventId,
              sourceLinkId: link._id,
              sourceOccurrenceKey: link.sourceOccurrenceKey,
            }),
          });
          topologyMutated = true;
        }
        continue;
      }
    }
    if (event && isCrossPostCampaignAttestationEvent(event)) {
      const campaign = await loadVerifiedCampaignLineageForSourceEvent(
        ctx,
        event,
      );
      if (campaign && campaign.sourceLinkIds.has(String(link._id))) {
        counts.unchangedCount! += 1;
      } else {
        counts.mismatchCount += 1;
        reasonCounts.campaign_proof_invalid =
          (reasonCounts.campaign_proof_invalid ?? 0) + 1;
      }
      continue;
    }
    if (!event || event.status === "rejected") {
      const retirementReady = await retireStaleLinkDryRun(ctx, link);
      if (!retirementReady) {
        counts.mismatchCount += 1;
        reasonCounts.stale_retirement_invalid =
          (reasonCounts.stale_retirement_invalid ?? 0) + 1;
        continue;
      }
      counts.updatedCount += 1;
      if (!dryRun) {
        if (!(await retireStaleLink(ctx, link))) {
          throw new Error("Stale source-occurrence retirement drifted after validation.");
        }
        topologyMutated = true;
      }
      continue;
    }
    const prepared = await prepareAdmission(ctx, event, link);
    if (!prepared) {
      counts.mismatchCount += 1;
      reasonCounts.admission_invalid =
        (reasonCounts.admission_invalid ?? 0) + 1;
      continue;
    }
    const currentReceipt = await ctx.db.get(prepared.receipt._id);
    if (!currentReceipt) {
      counts.mismatchCount += 1;
      reasonCounts.receipt_disappeared =
        (reasonCounts.receipt_disappeared ?? 0) + 1;
      continue;
    }
    const receiptNeedsRepair =
      JSON.stringify(currentReceipt.expectedOccurrences) !==
      JSON.stringify(prepared.receipt.expectedOccurrences);
    const existingProof = receiptNeedsRepair
      ? null
      : await loadVerifiedLegacySourceOccurrenceAdmission(ctx, prepared);
    if (existingProof) {
      counts.unchangedCount! += 1;
      continue;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      if (event.legacySourceOccurrenceAdmissionPolicyVersion !== 1) {
        await ctx.db.patch(event._id, {
          legacySourceOccurrenceAdmissionPolicyVersion: 1,
        });
      }
      if (receiptNeedsRepair) {
        await ctx.db.patch(prepared.receipt._id, {
          expectedOccurrences: prepared.receipt.expectedOccurrences,
          updatedAt: Math.max(Date.now(), currentReceipt.updatedAt + 1),
        });
        topologyMutated = true;
      }
      await upsertAdmission(ctx, prepared);
    }
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
    key: LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY,
    phase: "legacy_source_occurrence_admission",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}

async function retireStaleLinkDryRun(
  ctx: MutationCtx,
  link: Doc<"instagramEventSources">,
): Promise<boolean> {
  const [receipts, occurrences, admissions] = await Promise.all([
    ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", link.sourceIdentity),
      )
      .take(2),
    ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", link.sourceIdentity)
          .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
      )
      .take(2),
    ctx.db
      .query("legacySourceOccurrenceAdmissions")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
          .eq("sourceIdentity", link.sourceIdentity)
          .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
      )
      .take(2),
  ]);
  const receipt = receipts.length === 1 ? receipts[0]! : null;
  const occurrence = occurrences.length === 1 ? occurrences[0]! : null;
  if (!receipt || occurrences.length > 1 || admissions.length > 1) return false;
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return false;
  }
  const satisfactions = receipt.satisfiedOccurrences.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  return Boolean(
    receipt.sourceFingerprint === link.sourceFingerprint &&
      satisfactions.length === 1 &&
      satisfactions[0]?.eventId === link.eventId &&
      receipt.expectedKeys.filter((key) => key === link.sourceOccurrenceKey)
        .length === 1 &&
      receipt.satisfiedKeys.filter((key) => key === link.sourceOccurrenceKey)
        .length === 1 &&
      (!occurrence ||
        (occurrence.state === "satisfied" &&
          occurrence.canonicalEventId === link.eventId &&
          occurrence.sourceFingerprint === link.sourceFingerprint)),
  );
}
