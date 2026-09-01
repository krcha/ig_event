import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canonicalizeSourceUrl } from "../../lib/domain/source-url";
import {
  parseStructuredFactsJson,
} from "../../lib/domain/occurrences/facts";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../../lib/domain/occurrences/signature";
import {
  buildCampaignLineageEvidenceDigest,
  CAMPAIGN_LINEAGE_REATTESTATION_KEY,
  isExactCampaignLineageReattestationTransition,
} from "../../lib/events/campaign-lineage-reattestation";
import {
  CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD,
  crossPostCampaignAggregateBindingMatchesEvent,
  parseCrossPostCampaignAggregateAttestation,
  readCrossPostCampaignAggregateAttestation,
  type CrossPostCampaignAggregateAttestation,
} from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { exactJsonValue } from "../../lib/events/exact-json-value";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";

const MAX_CAMPAIGN_SOURCES = 8;
const MAX_CAMPAIGN_AUDIT_ROWS = 100;

type CampaignAuditPatch = Record<string, unknown>;

export type VerifiedCampaignLineageReattestation = {
  currentAttestation: CrossPostCampaignAggregateAttestation;
  originalAttestation: CrossPostCampaignAggregateAttestation;
  primaryEventId: Id<"events">;
  sourceLinkIds: ReadonlySet<string>;
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

async function loadExactAuditPatch(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  action: string,
  operationId: string,
): Promise<CampaignAuditPatch | null> {
  const rows = await ctx.db
    .query("eventAuditLog")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(MAX_CAMPAIGN_AUDIT_ROWS + 1);
  if (rows.length > MAX_CAMPAIGN_AUDIT_ROWS) return null;
  const matches: CampaignAuditPatch[] = [];
  for (const row of rows) {
    if (row.action !== action || !row.patchJson) continue;
    try {
      const patch = JSON.parse(row.patchJson) as unknown;
      if (
        patch &&
        typeof patch === "object" &&
        !Array.isArray(patch) &&
        (patch as CampaignAuditPatch).operationId === operationId
      ) {
        matches.push(patch as CampaignAuditPatch);
      }
    } catch {
      return null;
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function readAuditedEventBefore(value: unknown): Doc<"events"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<Doc<"events">>;
  return typeof event._id === "string" &&
      typeof event._creationTime === "number" &&
      typeof event.updatedAt === "number" &&
      typeof event.normalizedFieldsJson === "string" &&
      event.status === "approved"
    ? (event as Doc<"events">)
    : null;
}

function sourceEvidenceFieldsRemainExact(
  current: Doc<"events">,
  before: Doc<"events">,
  primary: boolean,
): boolean {
  const currentFields = parseObject(current.normalizedFieldsJson);
  const beforeFields = parseObject(before.normalizedFieldsJson);
  if (!currentFields || !beforeFields) return false;
  if (primary) {
    delete currentFields[CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD];
    delete beforeFields[CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD];
  }
  return (
    exactJsonValue(currentFields, beforeFields) &&
    current.title === before.title &&
    current.date === before.date &&
    current.time === before.time &&
    current.instagramPostId === before.instagramPostId &&
    current.instagramPostUrl === before.instagramPostUrl &&
    current.sourceCaption === before.sourceCaption &&
    current.sourcePostedAt === before.sourcePostedAt &&
    current.rawExtractionJson === before.rawExtractionJson &&
    current.imageUrl === before.imageUrl &&
    current.imageStorageId === before.imageStorageId
  );
}

function linkMatchesAdditiveReattestation(
  current: Doc<"instagramEventSources">,
  auditedBefore: unknown,
  originalUpdatedAt: number,
): boolean {
  if (!auditedBefore || typeof auditedBefore !== "object" || Array.isArray(auditedBefore)) {
    return false;
  }
  const before = auditedBefore as Record<string, unknown>;
  if (before.updatedAt !== originalUpdatedAt) return false;
  const comparable = {
    ...current,
    updatedAt: originalUpdatedAt,
  } as Record<string, unknown>;
  for (const additiveField of ["canonicalSourceUrl", "sourceOccurrenceId"] as const) {
    if (Object.hasOwn(before, additiveField)) {
      if (before[additiveField] !== comparable[additiveField]) return false;
    } else {
      delete comparable[additiveField];
    }
  }
  return exactJsonValue(before, comparable);
}

function eventMarker(
  role: "primary" | "variant",
  attestation: CrossPostCampaignAggregateAttestation,
): string {
  return `[cross_post_campaign_${role}:v${attestation.policyVersion}] ${attestation.legacyOperationId ?? attestation.operationId} - `;
}

/**
 * Validates the complete versioned proof created by the dedicated campaign
 * migration. The row alone is never authority: the immutable campaign audit,
 * current receipts, source documents, links, and first-class occurrences must
 * all agree exactly.
 */
export async function loadVerifiedCampaignLineageReattestation(
  ctx: QueryCtx | MutationCtx,
  primary: Doc<"events">,
  currentAttestation = readCrossPostCampaignAggregateAttestation(
    primary.normalizedFieldsJson,
  ),
): Promise<VerifiedCampaignLineageReattestation | null> {
  if (
    !currentAttestation ||
    !crossPostCampaignAggregateBindingMatchesEvent(currentAttestation, primary) ||
    currentAttestation.sources.length < 2 ||
    currentAttestation.sources.length > MAX_CAMPAIGN_SOURCES ||
    primary.status !== "approved" ||
    !primary.moderationNote?.startsWith(eventMarker("primary", currentAttestation))
  ) {
    return null;
  }
  const primaryId = ctx.db.normalizeId("events", currentAttestation.primaryEventId);
  if (!primaryId || primaryId !== primary._id) return null;
  const proofRows = await ctx.db
    .query("campaignLineageReattestations")
    .withIndex("by_migration_event", (q) =>
      q
        .eq("migrationKey", CAMPAIGN_LINEAGE_REATTESTATION_KEY)
        .eq("eventId", primary._id),
    )
    .take(2);
  const proofRow = proofRows.length === 1 ? proofRows[0]! : null;
  if (
    !proofRow ||
    proofRow.outcome !== "reattested" ||
    proofRow.attestationOperationId !== currentAttestation.operationId ||
    proofRow.sourceCount !== currentAttestation.sources.length ||
    !/^[0-9a-f]{16}$/u.test(proofRow.evidenceDigest)
  ) {
    return null;
  }

  const legacyMigration = currentAttestation.legacyOperationId !== undefined;
  const primaryAudit = await loadExactAuditPatch(
    ctx,
    primary._id,
    legacyMigration
      ? "cross_post_campaign_attestation_migrated"
      : "cross_post_campaign_coalesced",
    currentAttestation.operationId,
  );
  const originalAttestation = parseCrossPostCampaignAggregateAttestation(
    primaryAudit?.aggregateAttestation,
  );
  if (
    !primaryAudit ||
    primaryAudit.policyVersion !== currentAttestation.policyVersion ||
    !originalAttestation ||
    !isExactCampaignLineageReattestationTransition(
      originalAttestation,
      currentAttestation,
    )
  ) {
    return null;
  }

  const digestSources = [];
  const sourceLinkIds = new Set<string>();
  for (let index = 0; index < currentAttestation.sources.length; index += 1) {
    const currentSource = currentAttestation.sources[index]!;
    const originalSource = originalAttestation.sources[index]!;
    const isPrimary = index === 0;
    const eventId = ctx.db.normalizeId("events", currentSource.eventId);
    const linkId = ctx.db.normalizeId(
      "instagramEventSources",
      currentSource.sourceLinkId,
    );
    const receiptId = ctx.db.normalizeId(
      "instagramSourceOccurrenceReceipts",
      currentSource.receiptId,
    );
    if (!eventId || !linkId || !receiptId) return null;
    const audit = isPrimary
      ? primaryAudit
      : await loadExactAuditPatch(
          ctx,
          eventId,
          legacyMigration
            ? "cross_post_campaign_attestation_migrated"
            : "cross_post_campaign_variant_rejected",
          currentAttestation.operationId,
        );
    const eventBefore = readAuditedEventBefore(audit?.eventBefore);
    const [currentEvent, link, receipt] = await Promise.all([
      isPrimary ? Promise.resolve(primary) : ctx.db.get(eventId),
      ctx.db.get(linkId),
      ctx.db.get(receiptId),
    ]);
    if (
      !audit ||
      audit.sourceGroundingVerifiedAtCoalescing !== true ||
      (legacyMigration &&
        !exactJsonValue(audit.aggregateAttestation, originalAttestation)) ||
      !eventBefore ||
      eventBefore._id !== currentSource.eventId ||
      !currentEvent ||
      currentEvent.updatedAt !== currentSource.eventUpdatedAt ||
      currentEvent.status !== (isPrimary ? "approved" : "rejected") ||
      (!isPrimary &&
        !currentEvent.moderationNote?.startsWith(
          eventMarker("variant", currentAttestation),
        )) ||
      !sourceEvidenceFieldsRemainExact(currentEvent, eventBefore, isPrimary) ||
      !link ||
      link._id !== currentSource.sourceLinkId ||
      link.updatedAt !== currentSource.sourceLinkUpdatedAt ||
      link.eventId !== currentSource.eventId ||
      link.sourceIdentity !== currentSource.sourceIdentity ||
      link.sourceFingerprint !== currentSource.sourceFingerprint ||
      link.sourceOccurrenceKey !== currentSource.sourceOccurrenceKey ||
      link.instagramPostId !== currentSource.instagramPostId ||
      normalizeHandle(link.sourceHandle ?? "") !==
        normalizeHandle(currentSource.sourceHandle) ||
      !linkMatchesAdditiveReattestation(
        link,
        audit.sourceLinkBefore,
        originalSource.sourceLinkUpdatedAt,
      ) ||
      !receipt ||
      receipt._id !== currentSource.receiptId ||
      receipt.updatedAt !== currentSource.receiptUpdatedAt ||
      receipt.sourceIdentity !== currentSource.sourceIdentity ||
      receipt.sourceFingerprint !== currentSource.sourceFingerprint ||
      !exactJsonValue(isPrimary ? audit.receiptBefore : audit.receiptAfter, receipt)
    ) {
      return null;
    }
    const expectedMatches = receipt.expectedOccurrences?.filter(
      (item) => item.key === currentSource.sourceOccurrenceKey,
    );
    const occurrenceOrdinal =
      receipt.expectedOccurrences?.findIndex(
        (item) => item.key === currentSource.sourceOccurrenceKey,
      ) ?? -1;
    const satisfiedMatches = receipt.satisfiedOccurrences.filter(
      (item) => item.key === currentSource.sourceOccurrenceKey,
    );
    if (
      expectedMatches?.length !== 1 ||
      occurrenceOrdinal < 0 ||
      receipt.expectedKeys.filter(
        (key) => key === currentSource.sourceOccurrenceKey,
      ).length !== 1 ||
      satisfiedMatches.length !== 1 ||
      satisfiedMatches[0]!.eventId !== primary._id ||
      receipt.satisfiedKeys.filter(
        (key) => key === currentSource.sourceOccurrenceKey,
      ).length !== 1
    ) {
      return null;
    }
    const sourceDocuments = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postId", (q) =>
        q
          .eq("handle", currentSource.sourceHandle)
          .eq("postId", currentSource.instagramPostId),
      )
      .take(2);
    const sourceDocument =
      sourceDocuments.length === 1 ? sourceDocuments[0]! : null;
    const canonicalSource = sourceDocument
      ? canonicalizeSourceUrl("instagram", sourceDocument.instagramPostUrl)
      : null;
    const attestedCanonicalSource = canonicalizeSourceUrl(
      "instagram",
      currentSource.instagramPostUrl,
    );
    const sourceRevision = sourceDocument?.sourceRevision ?? 1;
    if (
      !sourceDocument ||
      !canonicalSource?.ok ||
      !attestedCanonicalSource.ok ||
      canonicalSource.value.canonicalUrl !==
        attestedCanonicalSource.value.canonicalUrl ||
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1
    ) {
      return null;
    }
    const occurrences = await ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", currentSource.sourceIdentity)
          .eq("sourceOccurrenceKey", currentSource.sourceOccurrenceKey),
      )
      .take(2);
    const occurrence = occurrences.length === 1 ? occurrences[0]! : null;
    const expected = expectedMatches[0]!;
    const typedOccurrenceFacts = occurrence
      ? parseStructuredFactsJson(occurrence.factsJson)
      : null;
    const occurrenceFactsValid = Boolean(
      occurrence &&
        (occurrence.factsJson === JSON.stringify(expected) ||
          typedOccurrenceFacts),
    );
    const signature = toOccurrenceCandidateIndexFields(
      buildOccurrenceSignature({
        artists: expected.artists,
        eventType: primary.eventType,
        localDate: expected.date,
        normalizedVenueIdentity: primary.normalizedVenueIdentity,
        time: expected.time,
        title: expected.title,
        venueId: primary.venueId,
        venueInstagramHandle: primary.normalizedVenueInstagramHandle,
      }),
    );
    if (
      !occurrence ||
      occurrence.provider !== "instagram" ||
      occurrence.sourceDocumentId !== sourceDocument._id ||
      occurrence.sourceIdentity !== currentSource.sourceIdentity ||
      occurrence.canonicalSourceUrl !== canonicalSource.value.canonicalUrl ||
      occurrence.sourceFingerprint !== currentSource.sourceFingerprint ||
      occurrence.sourceRevision !== sourceRevision ||
      occurrence.sourceOccurrenceKey !== currentSource.sourceOccurrenceKey ||
      occurrence.occurrenceOrdinal !== occurrenceOrdinal ||
      !occurrenceFactsValid ||
      occurrence.normalizedOccurrenceJson !==
        JSON.stringify({
          artists: expected.artists,
          date: expected.date,
          eventType: primary.eventType,
          time: expected.time ?? null,
          title: expected.title,
          venue: expected.venue,
          venueId: primary.venueId ?? null,
        }) ||
      occurrence.venueResolutionStatus !== "resolved" ||
      occurrence.venueId !== primary.venueId ||
      occurrence.canonicalEventId !== primary._id ||
      occurrence.state !== "satisfied" ||
      Object.entries(signature).some(
        ([field, value]) =>
          occurrence[field as keyof Doc<"sourceOccurrences">] !== value,
      ) ||
      link.sourceOccurrenceId !== occurrence._id ||
      link.canonicalSourceUrl !== canonicalSource.value.canonicalUrl
    ) {
      return null;
    }
    sourceLinkIds.add(String(link._id));
    digestSources.push({
      canonicalSourceUrl: canonicalSource.value.canonicalUrl,
      expected,
      occurrenceOrdinal,
      receiptId: currentSource.receiptId,
      sourceDocumentId: String(sourceDocument._id),
      sourceFingerprint: currentSource.sourceFingerprint,
      sourceIdentity: currentSource.sourceIdentity,
      sourceLinkId: currentSource.sourceLinkId,
      sourceOccurrenceKey: currentSource.sourceOccurrenceKey,
      sourceRevision,
    });
  }
  const evidenceDigest = buildCampaignLineageEvidenceDigest({
    operationId: currentAttestation.operationId,
    primaryEventId: currentAttestation.primaryEventId,
    sources: digestSources,
    targetVenueId: currentAttestation.targetVenueId,
  });
  if (evidenceDigest !== proofRow.evidenceDigest) return null;
  return {
    currentAttestation,
    originalAttestation,
    primaryEventId: primary._id,
    sourceLinkIds,
  };
}

/** Resolves a primary campaign proof from either its primary or one of its
 * rejected source variants. This is bounded by the campaign source limit. */
export async function loadVerifiedCampaignLineageForSourceEvent(
  ctx: QueryCtx | MutationCtx,
  sourceEvent: Doc<"events">,
): Promise<VerifiedCampaignLineageReattestation | null> {
  const directAttestation = readCrossPostCampaignAggregateAttestation(
    sourceEvent.normalizedFieldsJson,
  );
  if (directAttestation) {
    return loadVerifiedCampaignLineageReattestation(
      ctx,
      sourceEvent,
      directAttestation,
    );
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", sourceEvent._id))
    .take(MAX_CAMPAIGN_SOURCES + 1);
  if (links.length === 0 || links.length > MAX_CAMPAIGN_SOURCES) return null;
  const verifiedByPrimary = new Map<
    string,
    VerifiedCampaignLineageReattestation
  >();
  for (const link of links) {
    const receipts = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", link.sourceIdentity),
      )
      .take(2);
    const receipt = receipts.length === 1 ? receipts[0]! : null;
    if (
      !receipt ||
      receipt.satisfiedOccurrences.length > MAX_CAMPAIGN_SOURCES
    ) {
      continue;
    }
    for (const primaryCandidateId of new Set(
      receipt.satisfiedOccurrences.map((item) => item.eventId),
    )) {
      const primary = await ctx.db.get(primaryCandidateId);
      if (!primary) continue;
      const attestation = readCrossPostCampaignAggregateAttestation(
        primary.normalizedFieldsJson,
      );
      if (
        !attestation ||
        !attestation.sources.some(
          (source) =>
            source.eventId === sourceEvent._id &&
            source.sourceLinkId === link._id,
        )
      ) {
        continue;
      }
      const verified = await loadVerifiedCampaignLineageReattestation(
        ctx,
        primary,
        attestation,
      );
      if (verified) verifiedByPrimary.set(String(primary._id), verified);
    }
  }
  return verifiedByPrimary.size === 1
    ? [...verifiedByPrimary.values()][0]!
    : null;
}
