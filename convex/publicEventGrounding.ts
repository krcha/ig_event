import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  hasCompleteSourceGroundedAutoApproval,
  hasCompleteSourceGroundingAttestation,
  hasEventEvidenceV2AutoApproval,
  hasHumanReviewedLegacySourceAttestation,
  hasHumanReviewedStructuredSourceAttestation,
  hasTrustedSourceEventAnnouncementAutoApproval,
} from "../lib/events/event-update-precondition";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import { normalizeHandle } from "../lib/pipeline/venue-normalization";
import {
  CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD,
  crossPostCampaignAggregateBindingMatchesEvent,
  readCrossPostCampaignAggregateAttestation,
  type CrossPostCampaignAggregateAttestation,
} from "../lib/events/cross-post-campaign-aggregate-attestation";
import { exactJsonValue } from "../lib/events/exact-json-value";
import { canonicalizeSourceUrl } from "../lib/domain/source-url";
import { loadVerifiedCampaignLineageReattestation } from "./internal/campaignLineageReattestationProof";

const MAX_CROSS_POST_CAMPAIGN_AUDIT_ROWS = 100;

function normalizeAggregateArtist(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("sr-Latn")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function aggregateArtistsFromSourceEvents(events: Doc<"events">[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const event of events) {
    const fields = parseObject(event.normalizedFieldsJson);
    const artists = readCrossPostCampaignAggregateAttestation(
      event.normalizedFieldsJson,
    )
      ? event.artists
      : fields?.artists;
    if (!Array.isArray(artists) || artists.some((artist) => typeof artist !== "string")) {
      return [];
    }
    for (const rawArtist of artists) {
      const artist = rawArtist.normalize("NFKC").trim();
      const key = normalizeAggregateArtist(artist);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(artist);
    }
  }
  return result;
}

function crossPostCampaignMarker(
  role: "primary" | "variant",
  attestation: CrossPostCampaignAggregateAttestation,
): string {
  return `[cross_post_campaign_${role}:v${attestation.policyVersion}] ${attestation.legacyOperationId ?? attestation.operationId} - `;
}

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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadExactCrossPostAuditPatch(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  action: string,
  operationId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await ctx.db
    .query("eventAuditLog")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(MAX_CROSS_POST_CAMPAIGN_AUDIT_ROWS + 1);
  if (rows.length > MAX_CROSS_POST_CAMPAIGN_AUDIT_ROWS) return null;
  const matches: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.action !== action || !row.patchJson) continue;
    try {
      const patch = JSON.parse(row.patchJson) as unknown;
      if (
        patch &&
        typeof patch === "object" &&
        !Array.isArray(patch) &&
        (patch as Record<string, unknown>).operationId === operationId
      ) {
        matches.push(patch as Record<string, unknown>);
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

async function isAuditBackedCrossPostCampaignAggregate(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  attestation: CrossPostCampaignAggregateAttestation,
  aggregateProofPath: Set<string>,
): Promise<boolean> {
  const proofNode = `${event._id}:${attestation.operationId}`;
  if (
    aggregateProofPath.has(proofNode) ||
    aggregateProofPath.size >= 7 ||
    !crossPostCampaignAggregateBindingMatchesEvent(attestation, event) ||
    !event.moderationNote?.startsWith(crossPostCampaignMarker("primary", attestation))
  ) {
    return false;
  }
  const nextAggregateProofPath = new Set(aggregateProofPath);
  nextAggregateProofPath.add(proofNode);
  const legacyMigration = attestation.legacyOperationId !== undefined;
  const primaryAudit = await loadExactCrossPostAuditPatch(
    ctx,
    event._id,
    legacyMigration
      ? "cross_post_campaign_attestation_migrated"
      : "cross_post_campaign_coalesced",
    attestation.operationId,
  );
  const versionedReattestation = primaryAudit
    ? await loadVerifiedCampaignLineageReattestation(ctx, event, attestation)
    : null;
  const auditedAttestation =
    versionedReattestation?.originalAttestation ?? attestation;
  if (
    !primaryAudit ||
    primaryAudit.policyVersion !== attestation.policyVersion ||
    !exactJsonValue(primaryAudit.aggregateAttestation, auditedAttestation)
  ) {
    return false;
  }

  const sourceEventsBefore: Doc<"events">[] = [];
  const sourceHandles = new Set<string>();
  for (let index = 0; index < attestation.sources.length; index += 1) {
    const source = attestation.sources[index]!;
    const auditedSource = auditedAttestation.sources[index]!;
    const primary = index === 0;
    const sourceEventId = ctx.db.normalizeId("events", source.eventId);
    const sourceLinkId = ctx.db.normalizeId(
      "instagramEventSources",
      source.sourceLinkId,
    );
    const receiptId = ctx.db.normalizeId(
      "instagramSourceOccurrenceReceipts",
      source.receiptId,
    );
    if (!sourceEventId || !sourceLinkId || !receiptId) {
      return false;
    }
    const audit = primary
      ? primaryAudit
      : await loadExactCrossPostAuditPatch(
          ctx,
          sourceEventId,
          legacyMigration
            ? "cross_post_campaign_attestation_migrated"
            : "cross_post_campaign_variant_rejected",
          attestation.operationId,
        );
    const eventBefore = readAuditedEventBefore(audit?.eventBefore);
    const currentEvent = primary
      ? event
      : await ctx.db.get(sourceEventId);
    const sourceLink = await ctx.db.get(sourceLinkId);
    const receipt = await ctx.db.get(receiptId);
    const expectedReceiptAfter = primary ? audit?.receiptBefore : audit?.receiptAfter;
    const canonicalLinkedSource = canonicalizeSourceUrl(
      "instagram",
      sourceLink?.instagramPostUrl,
    );
    const canonicalAttestedSource = canonicalizeSourceUrl(
      "instagram",
      source.instagramPostUrl,
    );
    const nestedAggregateAttestation = eventBefore
      ? readCrossPostCampaignAggregateAttestation(eventBefore.normalizedFieldsJson)
      : null;
    const eventBeforeFields = eventBefore
      ? parseObject(eventBefore.normalizedFieldsJson)
      : null;
    const auditedSourceHandle = normalizeHandle(
      readString(eventBeforeFields?.sourceGroundingInstagramHandle) ?? "",
    );
    const linkedSourceHandle = normalizeHandle(sourceLink?.sourceHandle ?? "");
    const effectiveSourceHandle =
      linkedSourceHandle ||
      (sourceLink?.sourceHandle === undefined ? auditedSourceHandle : "");
    if (
      !audit ||
      audit.sourceGroundingVerifiedAtCoalescing !== true ||
      (legacyMigration &&
        !exactJsonValue(audit.aggregateAttestation, auditedAttestation)) ||
      !eventBefore ||
      eventBefore._id !== source.eventId ||
      !currentEvent ||
      currentEvent.updatedAt !== source.eventUpdatedAt ||
      currentEvent.status !== (primary ? "approved" : "rejected") ||
      (!primary &&
        !currentEvent.moderationNote?.startsWith(
          crossPostCampaignMarker("variant", attestation),
        )) ||
      !sourceEvidenceFieldsRemainExact(currentEvent, eventBefore, primary) ||
      !sourceLink ||
      sourceLink._id !== source.sourceLinkId ||
      sourceLink.updatedAt !== source.sourceLinkUpdatedAt ||
      sourceLink.eventId !== source.eventId ||
      sourceLink.sourceIdentity !== source.sourceIdentity ||
      sourceLink.sourceFingerprint !== source.sourceFingerprint ||
      sourceLink.sourceOccurrenceKey !== source.sourceOccurrenceKey ||
      sourceLink.instagramPostId !== source.instagramPostId ||
      !canonicalLinkedSource.ok ||
      !canonicalAttestedSource.ok ||
      canonicalLinkedSource.value.canonicalUrl !==
        canonicalAttestedSource.value.canonicalUrl ||
      effectiveSourceHandle !== normalizeHandle(source.sourceHandle) ||
      (!versionedReattestation &&
        !exactJsonValue(audit.sourceLinkBefore, sourceLink)) ||
      (versionedReattestation &&
        (auditedSource.sourceLinkId !== source.sourceLinkId ||
          !versionedReattestation.sourceLinkIds.has(source.sourceLinkId))) ||
      !receipt ||
      receipt._id !== source.receiptId ||
      receipt.updatedAt !== source.receiptUpdatedAt ||
      receipt.sourceIdentity !== source.sourceIdentity ||
      receipt.sourceFingerprint !== source.sourceFingerprint ||
      !exactJsonValue(expectedReceiptAfter, receipt) ||
      receipt.expectedKeys.length !== 1 ||
      receipt.expectedKeys[0] !== source.sourceOccurrenceKey ||
      receipt.satisfiedKeys.length !== 1 ||
      receipt.satisfiedKeys[0] !== source.sourceOccurrenceKey ||
      receipt.expectedOccurrences?.length !== 1 ||
      receipt.expectedOccurrences[0]?.key !== source.sourceOccurrenceKey ||
      receipt.satisfiedOccurrences.length !== 1 ||
      receipt.satisfiedOccurrences[0]?.key !== source.sourceOccurrenceKey ||
      receipt.satisfiedOccurrences[0]?.eventId !== event._id ||
      (nestedAggregateAttestation !== null &&
        !(await isCanonicallyGroundedApprovedEventInternal(
          ctx,
          eventBefore,
          nextAggregateProofPath,
        )))
    ) {
      return false;
    }
    sourceHandles.add(normalizeHandle(source.sourceHandle));
    sourceEventsBefore.push(eventBefore);
  }

  const previousAggregateAttestation = readCrossPostCampaignAggregateAttestation(
    sourceEventsBefore[0]?.normalizedFieldsJson,
  );
  if (
    (attestation.lineageDepth === 1 &&
      (previousAggregateAttestation !== null ||
        attestation.totalSourceCount !== attestation.sources.length ||
        !exactJsonValue(
          attestation.campaignPostIds,
          attestation.sources.map((source) => source.instagramPostId),
        ))) ||
    (attestation.lineageDepth > 1 &&
      (!previousAggregateAttestation ||
        previousAggregateAttestation.primaryEventId !== attestation.primaryEventId ||
        previousAggregateAttestation.targetVenueId !== attestation.targetVenueId ||
        previousAggregateAttestation.lineageDepth + 1 !== attestation.lineageDepth ||
        previousAggregateAttestation.totalSourceCount + attestation.sources.length - 1 !==
          attestation.totalSourceCount ||
        !exactJsonValue(attestation.campaignPostIds, [
          ...previousAggregateAttestation.campaignPostIds,
          ...attestation.sources
            .slice(1)
            .map((source) => source.instagramPostId),
        ]) ||
        previousAggregateAttestation.automaticCampaignIdentity !==
          attestation.automaticCampaignIdentity ||
        !exactJsonValue(
          previousAggregateAttestation.campaignAnchors,
          attestation.campaignAnchors,
        )))
  ) {
    return false;
  }

  const aggregatedArtists = aggregateArtistsFromSourceEvents(sourceEventsBefore);
  return (
    sourceHandles.size === 1 &&
    aggregatedArtists.length === event.artists.length &&
    aggregatedArtists.every((artist, index) => artist === event.artists[index])
  );
}

/**
 * Reconstruct the public-approval decision from the canonical persisted
 * Instagram post. Event fields and normalized flags are necessary, but never
 * sufficient authority for public visibility.
 */
async function isCanonicallyGroundedApprovedEventInternal(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  aggregateProofPath: Set<string>,
): Promise<boolean> {
  if (event.status !== "approved") return false;
  const fields = parseObject(event.normalizedFieldsJson);
  if (!fields) return false;
  const aggregateAttestation = readCrossPostCampaignAggregateAttestation(
    event.normalizedFieldsJson,
  );
  const crossPostAggregateAuthorized = aggregateAttestation
    ? await isAuditBackedCrossPostCampaignAggregate(
        ctx,
        event,
        aggregateAttestation,
        aggregateProofPath,
      )
    : false;
  if (
    Object.hasOwn(fields, CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD) &&
    !crossPostAggregateAuthorized
  ) {
    return false;
  }
  const machineAuthorized = hasCompleteSourceGroundedAutoApproval(
    event.normalizedFieldsJson,
    {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    },
  );
  const trustedSourceAuthorized = hasTrustedSourceEventAnnouncementAutoApproval(
    event.normalizedFieldsJson,
    {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    },
  );
  const structuredEvidenceAuthorized = hasEventEvidenceV2AutoApproval(
    event.normalizedFieldsJson,
    event,
  );
  const hasHumanReviewMetadata =
    typeof event.reviewedAt === "number" &&
    Number.isFinite(event.reviewedAt) &&
    typeof event.reviewedBy === "string" &&
    Boolean(event.reviewedBy.trim());
  const humanReviewedLegacyAuthorized =
    hasHumanReviewMetadata &&
    event.humanReviewedLegacySourcePolicyVersion ===
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION &&
    typeof event.moderationNote === "string" &&
    event.moderationNote.trim().length >= 20 &&
    hasHumanReviewedLegacySourceAttestation(event.normalizedFieldsJson, event);
  const humanReviewedStructuredAuthorized =
    hasHumanReviewMetadata &&
    event.humanReviewedStructuredSourcePolicyVersion ===
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION &&
    typeof event.moderationNote === "string" &&
    event.moderationNote.trim().length >= 20 &&
    hasHumanReviewedStructuredSourceAttestation(event.normalizedFieldsJson, event);
  const humanAuthorized =
    hasHumanReviewMetadata &&
    (humanReviewedLegacyAuthorized ||
      humanReviewedStructuredAuthorized ||
      hasCompleteSourceGroundingAttestation(event.normalizedFieldsJson, {
        title: event.title,
        date: event.date,
        time: event.time,
        venue: event.venue,
        artists: event.artists,
        imageUrl: event.imageUrl,
        instagramPostId: event.instagramPostId,
        instagramPostUrl: event.instagramPostUrl,
        sourceCaption: event.sourceCaption,
        sourcePostedAt: event.sourcePostedAt,
        venueInstagramHandle: event.venueInstagramHandle,
      }));
  if (
    !machineAuthorized &&
    !trustedSourceAuthorized &&
    !structuredEvidenceAuthorized &&
    !humanAuthorized &&
    !crossPostAggregateAuthorized
  ) {
    return false;
  }

  if (crossPostAggregateAuthorized) {
    // Every source event was canonically checked in the same service-only
    // transaction that wrote the immutable audit snapshots above. Instagram
    // may later edit its mutable post row; that must not erase an already
    // audited occurrence or its receipt lineage.
    return true;
  }

  const sourceHandle = normalizeHandle(
    readString(fields.sourceGroundingInstagramHandle) ??
      event.venueInstagramHandle ??
      "",
  );
  const postId = event.instagramPostId?.trim();
  if (!sourceHandle || !postId) return false;
  const persistedPosts = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .take(2);
  const persistedPost = persistedPosts.length === 1 ? persistedPosts[0] : null;
  if (
    !persistedPost ||
    typeof persistedPost.handle !== "string" ||
    typeof persistedPost.username !== "string" ||
    normalizeHandle(persistedPost.handle) !== sourceHandle ||
    normalizeHandle(persistedPost.username) !== sourceHandle
  ) {
    return false;
  }

  const normalizeSourceCaption = (value: string | undefined) =>
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
  const persistedCaption = normalizeSourceCaption(persistedPost.caption);
  const persistedCanonical = canonicalizeSourceUrl(
    "instagram",
    persistedPost.instagramPostUrl,
  );
  const eventCanonical = canonicalizeSourceUrl("instagram", event.instagramPostUrl);
  const groundedCanonical = canonicalizeSourceUrl(
    "instagram",
    readString(fields.sourceGroundingInstagramPostUrl) ?? undefined,
  );
  if (
    normalizeSourceCaption(event.sourceCaption) !== persistedCaption ||
    normalizeSourceCaption(readString(fields.sourceGroundingSourceCaption) ?? undefined) !==
      persistedCaption ||
    persistedPost.postId !== postId ||
    readString(fields.sourceGroundingInstagramPostId) !== postId ||
    !persistedCanonical.ok ||
    !eventCanonical.ok ||
    !groundedCanonical.ok ||
    persistedCanonical.value.canonicalUrl !== eventCanonical.value.canonicalUrl ||
    persistedCanonical.value.canonicalUrl !== groundedCanonical.value.canonicalUrl ||
    !persistedPost.postedAt ||
    persistedPost.postedAt !== event.sourcePostedAt
  ) {
    return false;
  }

  if (structuredEvidenceAuthorized || humanReviewedStructuredAuthorized) {
    const posterAssets =
      fields.extractionMode === "poster"
        ? await ctx.db
            .query("mediaAssets")
            .withIndex("by_sourceKey", (q) =>
              q.eq("sourceKey", `instagram-post:${postId}`),
            )
            .take(2)
        : [];
    const posterAsset = posterAssets.length === 1 ? posterAssets[0] : null;
    return Boolean(
      event.rawExtractionJson &&
        event.rawExtractionJson === persistedPost.analysisResultJson &&
        persistedPost.analysisRevision === (persistedPost.sourceRevision ?? 1) &&
        persistedPost.analysisContractVersion === "event_evidence_v2" &&
        persistedPost.analysisIsEvent === true &&
        persistedPost.analysisModel?.startsWith("gpt-5-mini") &&
        (fields.extractionMode !== "poster" ||
          Boolean(
            persistedPost.analysisImageSourceUrl &&
              persistedPost.analysisImageChecksumSha256 &&
              persistedPost.imageStorageId &&
              posterAsset &&
              posterAsset.storageId === persistedPost.imageStorageId &&
              posterAsset.checksumSha256 === persistedPost.analysisImageChecksumSha256 &&
              ((event.imageUrl === undefined && event.imageStorageId === undefined) ||
                (event.imageUrl === posterAsset.url &&
                  event.imageStorageId === posterAsset.storageId)),
          )),
    );
  }

  if (humanReviewedLegacyAuthorized) {
    return true;
  }

  return isCaptionSourceCoherentWithEvent({
    title: event.title,
    date: event.date,
    time: event.time,
    venue: event.venue,
    artists: event.artists,
    sourceCaption: persistedCaption,
    sourcePostedAt: persistedPost.postedAt,
    instagramPostId: persistedPost.postId,
    instagramPostUrl: persistedPost.instagramPostUrl,
    sourceInstagramHandle: persistedPost.handle,
    venueInstagramHandle: event.venueInstagramHandle,
  });
}

export async function isCanonicallyGroundedApprovedEvent(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  return isCanonicallyGroundedApprovedEventInternal(ctx, event, new Set());
}
