import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  adaptInstagramScrapedPostToSourceDocument,
  type SourceDocument,
} from "../../lib/domain/source-documents";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { normalizeInstagramPostUrl } from "../../lib/images/apify-images";
import { MAX_PUBLICATION_REFRESH_EVENTS } from "../publicationPolicy";
import { receiptExpectedMatchesOccurrenceFacts } from "../internal/reconciliationReceiptFacts";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
} from "../internal/sourceOccurrenceReceipts";

const APPLY_LEASE_SKEW_MS = 1_000;
const MAX_SOURCE_ACCOUNT_IDENTITIES_PER_EVENT = 12;

type ReadContext = Pick<MutationCtx, "db">;

export type ReconciliationCanonicalSourceFields = Readonly<{
  imageStorageId?: Id<"_storage">;
  imageUrl?: string;
  instagramPostId: string;
  instagramPostUrl: string;
  normalizedInstagramPostUrl: string;
  rawExtractionJson?: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
}>;

/**
 * Provider-neutral source-document view consumed by reconciliation. The
 * current adapter still projects compatibility event columns and persistence
 * coordinates for the physical Instagram tables, but canonical code neither
 * reads those rows nor performs provider normalization itself.
 */
export type ReconciliationSourceDocument = SourceDocument & {
  accountIdentity?: string;
  canonicalEventFields: ReconciliationCanonicalSourceFields;
  processingFence: Readonly<{
    leaseExpiresAt?: number;
    leaseOwner?: string;
    status?: string;
  }>;
  provenanceProjection: Readonly<{
    accountReference: string;
    externalDocumentId: string;
    externalDocumentUrl: string;
  }>;
};

export type ReconciliationProvenanceLink = Readonly<{
  eventId: Id<"events">;
  sourceAccountIdentity?: string;
  sourceFingerprint: string;
  sourceIdentity: string;
  sourceOccurrenceId?: Id<"sourceOccurrences">;
  sourceOccurrenceKey: string;
}>;

function normalizedProviderAccount(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^@+/u, "")
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/u.test(normalized) ? normalized : undefined;
}

/**
 * Compatibility projection for canonical rows written before venue identities
 * became provider-neutral. Reconciliation consumes only the returned account
 * identity; ownership of the physical Instagram column stays in this adapter.
 */
export function readReconciliationVenueAccountIdentity(
  event: Pick<Doc<"events">, "normalizedVenueInstagramHandle">,
): string | undefined {
  return normalizedProviderAccount(event.normalizedVenueInstagramHandle);
}

/**
 * Projects a provider-tagged unresolved venue identity onto the legacy event
 * compatibility columns. Canonical reconciliation receives only the returned
 * neutral event-field projection.
 */
export function projectUnresolvedVenueIdentityFields(
  occurrenceVenueIdentity: string,
): Readonly<{
  normalizedVenueIdentity?: string;
  normalizedVenueInstagramHandle?: string;
}> {
  if (occurrenceVenueIdentity.startsWith("instagram:")) {
    const handle = occurrenceVenueIdentity.slice("instagram:".length);
    return handle ? { normalizedVenueInstagramHandle: handle } : {};
  }
  if (occurrenceVenueIdentity.startsWith("name:")) {
    const name = occurrenceVenueIdentity.slice("name:".length);
    return name ? { normalizedVenueIdentity: name } : {};
  }
  return {};
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function adaptStoredSourceDocument(
  row: Doc<"scrapedPosts">,
): ReconciliationSourceDocument {
  const document = adaptInstagramScrapedPostToSourceDocument(row);
  const accountIdentity =
    normalizedProviderAccount(row.username) ??
    normalizedProviderAccount(row.handle);
  return {
    ...document,
    ...(accountIdentity ? { accountIdentity } : {}),
    canonicalEventFields: {
      ...(row.imageStorageId ? { imageStorageId: row.imageStorageId } : {}),
      ...((row.imageUrl ?? row.imageUrls[0])
        ? { imageUrl: row.imageUrl ?? row.imageUrls[0] }
        : {}),
      instagramPostId: row.postId,
      instagramPostUrl: row.instagramPostUrl,
      normalizedInstagramPostUrl: normalizeInstagramPostUrl(
        row.instagramPostUrl,
      ),
      ...(row.analysisResultJson
        ? { rawExtractionJson: row.analysisResultJson }
        : {}),
      ...(row.caption ? { sourceCaption: row.caption } : {}),
      ...(row.postedAt ? { sourcePostedAt: row.postedAt } : {}),
    },
    processingFence: {
      ...(row.processingLeaseExpiresAt === undefined
        ? {}
        : { leaseExpiresAt: row.processingLeaseExpiresAt }),
      ...(row.processingLeaseOwner
        ? { leaseOwner: row.processingLeaseOwner }
        : {}),
      ...(row.processingStatus ? { status: row.processingStatus } : {}),
    },
    provenanceProjection: {
      accountReference: row.handle,
      externalDocumentId: row.postId,
      externalDocumentUrl: row.instagramPostUrl,
    },
  };
}

export async function loadReconciliationSourceDocument(
  ctx: ReadContext,
  occurrence: Pick<Doc<"sourceOccurrences">, "sourceDocumentId">,
): Promise<ReconciliationSourceDocument | null> {
  const row = await ctx.db.get(occurrence.sourceDocumentId);
  return row ? adaptStoredSourceDocument(row) : null;
}

export function assertReconciliationSourceFence(
  sourceDocument: ReconciliationSourceDocument,
  occurrence: Pick<Doc<"sourceOccurrences">, "sourceRevision">,
  args: { mode: "shadow" | "apply"; processingOwner?: string },
): void {
  if (sourceDocument.sourceRevision !== occurrence.sourceRevision) {
    throw new DomainError(
      "SOURCE_REVISION_CHANGED",
      "Source document revision changed before reconciliation.",
    );
  }
  if (args.mode !== "apply") return;
  const now = Date.now();
  if (
    !args.processingOwner ||
    sourceDocument.processingFence.status !== "processing" ||
    sourceDocument.processingFence.leaseOwner !== args.processingOwner ||
    (sourceDocument.processingFence.leaseExpiresAt ?? 0) <=
      now + APPLY_LEASE_SKEW_MS
  ) {
    throw new DomainError(
      "PROCESSING_FENCE_INVALID",
      "Applying reconciliation requires the current unexpired source-processing lease.",
    );
  }
}

export function projectNormalizedFieldsForSource(
  sourceDocument: ReconciliationSourceDocument,
  normalizedFieldsJson: string | undefined,
): string {
  const normalized = parseObject(normalizedFieldsJson);
  return JSON.stringify({
    ...normalized,
    ...(sourceDocument.accountIdentity
      ? { sourceGroundingInstagramHandle: sourceDocument.accountIdentity }
      : {}),
  });
}

export function readSourceAccountIdentityFromNormalizedFields(
  normalizedFieldsJson: string | undefined,
): string | undefined {
  return normalizedProviderAccount(
    parseObject(normalizedFieldsJson).sourceGroundingInstagramHandle,
  );
}

function projectProvenanceLink(
  link: Doc<"instagramEventSources">,
): ReconciliationProvenanceLink {
  const sourceAccountIdentity = normalizedProviderAccount(link.sourceHandle);
  return {
    eventId: link.eventId,
    ...(sourceAccountIdentity ? { sourceAccountIdentity } : {}),
    sourceFingerprint: link.sourceFingerprint,
    sourceIdentity: link.sourceIdentity,
    ...(link.sourceOccurrenceId
      ? { sourceOccurrenceId: link.sourceOccurrenceId }
      : {}),
    sourceOccurrenceKey: link.sourceOccurrenceKey,
  };
}

export async function loadExactReconciliationProvenanceLink(
  ctx: ReadContext,
  occurrence: Pick<
    Doc<"sourceOccurrences">,
    "sourceIdentity" | "sourceOccurrenceKey"
  >,
): Promise<ReconciliationProvenanceLink | null> {
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", occurrence.sourceIdentity)
        .eq("sourceOccurrenceKey", occurrence.sourceOccurrenceKey),
    )
    .take(2);
  if (links.length > 1) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Source occurrence has multiple provenance links.",
    );
  }
  return links[0] ? projectProvenanceLink(links[0]) : null;
}

export async function loadCandidateSourceAccountIdentity(
  ctx: ReadContext,
  eventId: Id<"events">,
  incomingSourceAccountIdentity: string | undefined,
): Promise<string | undefined> {
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(MAX_SOURCE_ACCOUNT_IDENTITIES_PER_EVENT + 1);
  if (links.length > MAX_SOURCE_ACCOUNT_IDENTITIES_PER_EVENT) {
    return undefined;
  }
  const identities = [
    ...new Set(
      links
        .map((link) => normalizedProviderAccount(link.sourceHandle))
        .filter((identity): identity is string => Boolean(identity)),
    ),
  ];
  if (
    incomingSourceAccountIdentity &&
    identities.includes(incomingSourceAccountIdentity)
  ) {
    return incomingSourceAccountIdentity;
  }
  return identities.length === 1 ? identities[0] : undefined;
}

export async function getReconciliationLineageQuarantineReason(
  ctx: ReadContext,
  occurrence: Doc<"sourceOccurrences">,
  sourceLink: ReconciliationProvenanceLink | null,
): Promise<string | null> {
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", occurrence.sourceIdentity),
    )
    .take(2);
  if (receipts.length !== 1) return "legacy_source_receipt_not_unique";
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipts[0]!);
  } catch {
    return "legacy_source_receipt_exceeds_bound";
  }
  if (receipts[0]!.sourceFingerprint !== occurrence.sourceFingerprint) {
    return "legacy_source_receipt_fingerprint_changed";
  }
  if (
    sourceLink &&
    (sourceLink.sourceFingerprint !== occurrence.sourceFingerprint ||
      (sourceLink.sourceOccurrenceId !== undefined &&
        sourceLink.sourceOccurrenceId !== occurrence._id))
  ) {
    return "legacy_source_link_fingerprint_changed";
  }
  const matchingSatisfactions = receipts[0]!.satisfiedOccurrences.filter(
    (item) => item.key === occurrence.sourceOccurrenceKey,
  );
  if (matchingSatisfactions.length > 1) {
    return "legacy_source_receipt_satisfaction_not_unique";
  }
  if (sourceLink && matchingSatisfactions.length === 0) {
    return "legacy_source_link_missing_receipt_satisfaction";
  }
  const involvedEventIds = [
    occurrence.canonicalEventId,
    sourceLink?.eventId,
    matchingSatisfactions[0]?.eventId,
  ].filter((eventId): eventId is Id<"events"> => eventId !== undefined);
  const involvedEvents = await Promise.all(
    [...new Set(involvedEventIds)].map((eventId) => ctx.db.get(eventId)),
  );
  if (
    involvedEvents.some(
      (event) => event !== null && isCrossPostCampaignLineageEvent(event),
    )
  ) {
    return "audited_lineage_requires_reattestation";
  }
  if (
    sourceLink &&
    matchingSatisfactions.length === 1 &&
    matchingSatisfactions[0]!.eventId !== sourceLink.eventId
  ) {
    return "legacy_receipt_representative_differs_from_source_link";
  }
  return null;
}

export async function assertReconciliationReceiptSatisfiable(options: {
  ctx: ReadContext;
  occurrence: Doc<"sourceOccurrences">;
  targetEventId?: Id<"events">;
}): Promise<void> {
  const { ctx, occurrence, targetEventId } = options;
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", occurrence.sourceIdentity),
    )
    .take(2);
  if (receipts.length !== 1) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Source occurrence does not have exactly one current receipt.",
    );
  }
  const receipt = receipts[0]!;
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch (cause) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Source occurrence receipt is invalid or exceeds its hard bounds.",
      { cause },
    );
  }
  const matchingExpected = (receipt.expectedOccurrences ?? []).filter(
    (expected) => expected.key === occurrence.sourceOccurrenceKey,
  );
  const matchingSatisfaction = receipt.satisfiedOccurrences.filter(
    (satisfaction) => satisfaction.key === occurrence.sourceOccurrenceKey,
  );
  if (
    receipt.sourceFingerprint !== occurrence.sourceFingerprint ||
    receipt.expectedKeys.filter((key) => key === occurrence.sourceOccurrenceKey)
      .length !== 1 ||
    matchingExpected.length !== 1 ||
    !receiptExpectedMatchesOccurrenceFacts(matchingExpected[0]!, occurrence) ||
    matchingSatisfaction.length > 1 ||
    receipt.satisfiedKeys.filter(
      (key) => key === occurrence.sourceOccurrenceKey,
    ).length !== matchingSatisfaction.length ||
    (matchingSatisfaction[0] &&
      (!targetEventId || matchingSatisfaction[0].eventId !== targetEventId))
  ) {
    throw new DomainError(
      "RECONCILIATION_PLAN_INVALID",
      "Source occurrence receipt cannot satisfy the generated plan.",
    );
  }
}

export async function upsertReconciliationProvenance(options: {
  ctx: MutationCtx;
  eventId: Id<"events">;
  occurrence: Doc<"sourceOccurrences">;
  sourceDocument: ReconciliationSourceDocument;
}): Promise<Id<"events">[]> {
  const { ctx, eventId, occurrence, sourceDocument } = options;
  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", occurrence.sourceIdentity)
        .eq("sourceOccurrenceKey", occurrence.sourceOccurrenceKey),
    )
    .take(2);
  if (sourceLinks.length > 1) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Source occurrence has multiple provenance links.",
    );
  }
  const sourceLink = sourceLinks[0] ?? null;
  if (sourceLink && sourceLink.eventId !== eventId) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Source occurrence is already attached to another canonical event.",
    );
  }
  const now = Date.now();
  const linkPatch = {
    canonicalSourceUrl: occurrence.canonicalSourceUrl,
    eventId,
    instagramPostId: sourceDocument.provenanceProjection.externalDocumentId,
    instagramPostUrl: sourceDocument.provenanceProjection.externalDocumentUrl,
    sourceFingerprint: occurrence.sourceFingerprint,
    sourceHandle: sourceDocument.provenanceProjection.accountReference,
    sourceIdentity: occurrence.sourceIdentity,
    sourceOccurrenceId: occurrence._id,
    sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
    updatedAt: now,
  };
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", occurrence.sourceIdentity),
    )
    .take(2);
  if (receipts.length !== 1) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Applying reconciliation requires one current legacy occurrence receipt.",
    );
  }
  const receipt = receipts[0]!;
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expectedMatches = (receipt.expectedOccurrences ?? []).filter(
    (item) => item.key === occurrence.sourceOccurrenceKey,
  );
  if (
    receipt.sourceFingerprint !== occurrence.sourceFingerprint ||
    receipt.expectedKeys.filter((key) => key === occurrence.sourceOccurrenceKey)
      .length !== 1 ||
    expectedMatches.length !== 1 ||
    !receiptExpectedMatchesOccurrenceFacts(expectedMatches[0]!, occurrence)
  ) {
    throw new DomainError(
      "SOURCE_REVISION_CHANGED",
      "Occurrence receipt generation does not match the source occurrence.",
    );
  }
  const existingSatisfaction = receipt.satisfiedOccurrences.filter(
    (item) => item.key === occurrence.sourceOccurrenceKey,
  );
  if (
    existingSatisfaction.length > 1 ||
    (existingSatisfaction[0] && existingSatisfaction[0].eventId !== eventId)
  ) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Occurrence receipt is already satisfied by another canonical event.",
    );
  }
  const nextSatisfiedOccurrences = existingSatisfaction.length
    ? receipt.satisfiedOccurrences
    : [
        ...receipt.satisfiedOccurrences,
        { eventId, key: occurrence.sourceOccurrenceKey },
      ];
  if (nextSatisfiedOccurrences.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Occurrence receipt satisfaction set exceeds the hard occurrence bound.",
    );
  }
  const representativeEventIds = [
    ...new Set(nextSatisfiedOccurrences.map((item) => item.eventId)),
  ];
  if (representativeEventIds.length > MAX_PUBLICATION_REFRESH_EVENTS) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Occurrence receipt representative set exceeds the safe publication refresh bound.",
    );
  }
  if (sourceLink) {
    await ctx.db.patch(sourceLink._id, linkPatch);
  } else {
    await ctx.db.insert("instagramEventSources", {
      ...linkPatch,
      linkedAt: now,
    });
  }
  await ctx.db.patch(receipt._id, {
    satisfiedKeys: [
      ...new Set([...receipt.satisfiedKeys, occurrence.sourceOccurrenceKey]),
    ],
    satisfiedOccurrences: nextSatisfiedOccurrences,
    updatedAt: now,
  });
  return representativeEventIds;
}

export async function sourceOccurrenceHasFinalProvenance(options: {
  ctx: ReadContext;
  eventId: Id<"events">;
  occurrence: Doc<"sourceOccurrences">;
}): Promise<boolean> {
  const { ctx, eventId, occurrence } = options;
  const [links, receipts] = await Promise.all([
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
  return (
    links.length === 1 &&
    links[0]!.eventId === eventId &&
    links[0]!.sourceOccurrenceId === occurrence._id &&
    links[0]!.sourceFingerprint === occurrence.sourceFingerprint &&
    receipts.length === 1 &&
    receipts[0]!.sourceFingerprint === occurrence.sourceFingerprint &&
    receipts[0]!.satisfiedOccurrences.filter(
      (item) =>
        item.key === occurrence.sourceOccurrenceKey && item.eventId === eventId,
    ).length === 1
  );
}

export async function hasReconciliationProvenanceForEvent(
  ctx: ReadContext,
  eventId: Id<"events">,
): Promise<boolean> {
  return Boolean(
    await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .first(),
  );
}

export async function hasSourceDocumentWriteSince(
  ctx: ReadContext,
  startedAt: number,
): Promise<boolean> {
  return Boolean(
    await ctx.db
      .query("scrapedPosts")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", startedAt))
      .first(),
  );
}
