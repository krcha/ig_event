import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { refreshEventPublicationStates } from "../../publicationPolicy";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import {
  resolveVenueForWrite,
  type ConvexVenueResolution,
} from "../../venueResolver";
import { DomainError } from "../../../lib/domain/errors";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { canonicalizeSourceUrlOrEmpty } from "../../../lib/domain/source-url";
import { normalizeHandle } from "../../../lib/domain/venues/normalization";
import { loadVerifiedCampaignLineageForSourceEvent } from "../campaignLineageReattestationProof";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import {
  assertCleanCompletedEventDomainMigration,
  eventDomainMigrationPatchDiffers,
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

const MIN_AUDITED_LEGACY_VENUE_CONFIDENCE = 0.8;
const MAX_REVIEWED_FOLD_AUDIT_ROWS = 100;

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type AuditedLegacyVenueResolution = {
  displayVenue: string;
  resolution: ConvexVenueResolution;
  sourcePolicy:
    | "exact_schedule_entry_event_evidence_v2"
    | "trusted_venue_account_provider_identity"
    | "verified_event_evidence_v2";
};

function parseNormalizedFields(
  event: Doc<"events">,
): Record<string, unknown> | null {
  if (!event.normalizedFieldsJson) return null;
  try {
    return readObject(JSON.parse(event.normalizedFieldsJson));
  } catch {
    return null;
  }
}

function readExactScheduleEntryVenue(
  event: Doc<"events">,
  fields: Record<string, unknown>,
): string | null {
  const rowSourceText = fields.rowSourceText;
  if (typeof rowSourceText !== "string" || !rowSourceText.trim()) return null;
  let raw: Record<string, unknown> | null = null;
  try {
    raw = readObject(JSON.parse(event.rawExtractionJson ?? "null"));
  } catch {
    return null;
  }
  const entries = Array.isArray(raw?.schedule_entries)
    ? raw.schedule_entries.map(readObject).filter(Boolean)
    : [];
  const matchingEntries = entries.filter(
    (entry) => entry?.source_text === rowSourceText,
  );
  if (matchingEntries.length !== 1) return null;
  const venue = matchingEntries[0]?.venue;
  return typeof venue === "string" && venue.trim() ? venue.trim() : null;
}

async function hasVerifiedAbsentVenueEvidence(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  const fields = parseNormalizedFields(event);
  const fieldConfirmation = readObject(fields?.fieldConfirmation);
  const locationConfirmation = readObject(fieldConfirmation?.location_name);
  const sharedSchedule = readObject(fields?.sharedScheduleContext);
  const sharedVenue = readObject(sharedSchedule?.venue);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = readObject(JSON.parse(event.rawExtractionJson ?? "null"));
  } catch {
    return false;
  }
  const rowSourceText = fields?.rowSourceText;
  const matchingEntries = Array.isArray(raw?.schedule_entries)
    ? raw.schedule_entries
        .map(readObject)
        .filter((entry) => entry?.source_text === rowSourceText)
    : [];
  if (
    !fields ||
    event.venue.trim() ||
    event.venueInstagramHandle ||
    event.venueId ||
    event.normalizedVenueIdentity ||
    event.occurrenceVenueIdentity !== "unknown-venue" ||
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.venueEvidenceVerified !== true ||
    fields.rawVenue !== "" ||
    fields.normalizedVenue !== "" ||
    locationConfirmation?.confidence !== 0 ||
    locationConfirmation.evidence !== "" ||
    !exactJsonValue(locationConfirmation.found_in, []) ||
    sharedVenue?.applies_to_all !== false ||
    sharedVenue.value !== "" ||
    sharedVenue.evidence !== "" ||
    sharedVenue.source !== "unknown" ||
    typeof rowSourceText !== "string" ||
    !rowSourceText.trim() ||
    raw?.extraction_contract_version !== "event_evidence_v2" ||
    raw.is_event !== true ||
    raw.venue !== "" ||
    matchingEntries.length !== 1 ||
    matchingEntries[0]?.venue !== ""
  ) {
    return false;
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const link = links.length === 1 ? links[0]! : null;
  if (
    !link ||
    link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    fields.sourceOccurrenceSourceFingerprint !== link.sourceFingerprint
  ) {
    return false;
  }
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", link.sourceIdentity),
    )
    .take(2);
  const receipt = receipts.length === 1 ? receipts[0]! : null;
  const expected = receipt?.expectedOccurrences?.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  const satisfied = receipt?.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  return Boolean(
    receipt &&
      receipt.sourceFingerprint === link.sourceFingerprint &&
      expected?.length === 1 &&
      expected[0]!.venue === "" &&
      sourceOccurrenceRepresentativeMatchesExpected(event, expected[0]) &&
      satisfied?.length === 1 &&
      satisfied[0]!.eventId === event._id,
  );
}

function readAuditedLegacyVenueClaims(
  event: Doc<"events">,
  fields: Record<string, unknown>,
): string[] {
  if (
    event.venue.trim() ||
    event.venueInstagramHandle ||
    event.venueId
  ) {
    return [];
  }
  if (
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.venueEvidenceVerified !== true
  ) {
    return [];
  }
  const fieldConfirmation = readObject(fields.fieldConfirmation);
  const locationConfirmation = readObject(fieldConfirmation?.location_name);
  const locationConfidence = locationConfirmation?.confidence;
  const foundIn = Array.isArray(locationConfirmation?.found_in)
    ? locationConfirmation.found_in.filter(
        (source): source is string => typeof source === "string",
      )
    : [];
  if (
    typeof locationConfidence !== "number" ||
    !Number.isFinite(locationConfidence) ||
    locationConfidence < MIN_AUDITED_LEGACY_VENUE_CONFIDENCE ||
    !foundIn.some((source) => source === "poster" || source === "caption")
  ) {
    return [];
  }
  const sharedSchedule = readObject(fields.sharedScheduleContext);
  const sharedVenue = readObject(sharedSchedule?.venue);
  const sharedVenueClaim =
    sharedVenue?.applies_to_all === true &&
    (sharedVenue.source === "poster" || sharedVenue.source === "caption") &&
    typeof sharedVenue.evidence === "string" &&
    sharedVenue.evidence.trim()
      ? sharedVenue.value
      : undefined;
  return [
    fields.rawVenue,
    sharedVenueClaim,
    locationConfirmation?.evidence,
  ].filter(
    (claim, index, all): claim is string =>
      typeof claim === "string" &&
      Boolean(claim.trim()) &&
      all.findIndex(
        (candidate) =>
          typeof candidate === "string" &&
          candidate.trim() === claim.trim(),
      ) === index,
  );
}

async function resolveAuditedLegacyVenueClaim(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<AuditedLegacyVenueResolution | null> {
  const fields = parseNormalizedFields(event);
  if (
    !fields ||
    event.venue.trim() ||
    event.venueInstagramHandle ||
    event.venueId ||
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.venueEvidenceVerified !== true
  ) {
    return null;
  }

  // A row-bound schedule entry is the strongest persisted physical-place
  // claim. It deliberately wins over the posting account because promoters
  // frequently advertise events at a different venue.
  const exactScheduleVenue = readExactScheduleEntryVenue(event, fields);
  if (exactScheduleVenue) {
    const resolution = await resolveVenueForWrite(ctx, exactScheduleVenue, {
      includePending: true,
    });
    if (resolution.resolution.status === "ambiguous") return null;
    return {
      displayVenue: resolution.canonicalVenueName ?? exactScheduleVenue,
      resolution,
      sourcePolicy: "exact_schedule_entry_event_evidence_v2",
    };
  }

  const claims = readAuditedLegacyVenueClaims(event, fields);
  if (claims.length === 0) {
    const sourceHandle =
      typeof fields.sourceGroundingInstagramHandle === "string"
        ? normalizeHandle(fields.sourceGroundingInstagramHandle)
        : "";
    if (
      fields.trustedVenueSource !== true ||
      fields.venueSource !== "handle_map" ||
      !sourceHandle
    ) {
      return null;
    }
    const resolution = await resolveVenueForWrite(ctx, sourceHandle, {
      includePending: true,
    });
    if (
      resolution.resolution.status !== "resolved" ||
      !resolution.venueFields.venueId ||
      !resolution.canonicalVenueName ||
      normalizeHandle(resolution.venueFields.venueInstagramHandle ?? "") !==
        sourceHandle
    ) {
      return null;
    }
    return {
      displayVenue: resolution.canonicalVenueName,
      resolution,
      sourcePolicy: "trusted_venue_account_provider_identity",
    };
  }
  const resolutions = await Promise.all(
    claims.map((claim) =>
      resolveVenueForWrite(ctx, claim, { includePending: true }),
    ),
  );
  if (
    resolutions.some(
      (resolution) => resolution.resolution.status === "ambiguous",
    )
  ) {
    return null;
  }
  const resolved = resolutions.filter(
    (resolution) =>
      resolution.resolution.status === "resolved" &&
      resolution.venueFields.venueId,
  );
  const venueIds = new Set(
    resolved.map((resolution) => resolution.venueFields.venueId),
  );
  if (venueIds.size === 1 && resolved[0]?.canonicalVenueName) {
    return {
      displayVenue: resolved[0].canonicalVenueName,
      resolution: resolved[0],
      sourcePolicy: "verified_event_evidence_v2",
    };
  }
  const unresolved = resolutions.filter(
    (resolution) => resolution.resolution.status === "unresolved",
  );
  const normalizedIdentities = new Set(
    unresolved
      .map((resolution) => resolution.venueFields.normalizedVenueIdentity)
      .filter(Boolean),
  );
  if (
    resolved.length === 0 &&
    unresolved.length === resolutions.length &&
    normalizedIdentities.size === 1
  ) {
    return {
      displayVenue: claims[0]!.trim(),
      resolution: unresolved[0]!,
      sourcePolicy: "verified_event_evidence_v2",
    };
  }
  return null;
}

function buildAuditedLegacyNormalizedFields(
  event: Doc<"events">,
  audited: AuditedLegacyVenueResolution,
): string | null {
  const { displayVenue, resolution, sourcePolicy } = audited;
  let fields: Record<string, unknown> | null = null;
  try {
    fields = readObject(JSON.parse(event.normalizedFieldsJson ?? "null"));
  } catch {
    return null;
  }
  if (!fields) return null;
  return JSON.stringify({
    ...fields,
    normalizedVenue: displayVenue,
    ...(resolution.venueFields.venueId
      ? {
          auditedLegacyVenueCanonicalization: {
            policyVersion: 1,
            sourcePolicy,
            targetVenueId: resolution.venueFields.venueId,
          },
        }
      : {
          auditedLegacyVenueNormalization: {
            normalizedVenueIdentity:
              resolution.venueFields.normalizedVenueIdentity,
            policyVersion: 1,
            sourcePolicy,
          },
        }),
  });
}

type ReviewedRejectedFoldMarker = {
  action:
    | "reviewed_promotion_variant_rejected"
    | "reviewed_same_source_continuation_rejected";
  operationId: string;
  updatedAtField: "variantUpdatedAt" | "continuationUpdatedAt";
};

function readReviewedRejectedFoldMarker(
  moderationNote: string | undefined,
): ReviewedRejectedFoldMarker | null {
  const match = moderationNote?.match(
    /^\[(reviewed_promotion_variant|reviewed_same_source_continuation):v1\] ([A-Za-z0-9][A-Za-z0-9._:-]{15,159}) - /u,
  );
  if (!match) return null;
  return match[1] === "reviewed_promotion_variant"
    ? {
        action: "reviewed_promotion_variant_rejected",
        operationId: match[2]!,
        updatedAtField: "variantUpdatedAt",
      }
    : {
        action: "reviewed_same_source_continuation_rejected",
        operationId: match[2]!,
        updatedAtField: "continuationUpdatedAt",
      };
}

function rejectedFoldEvidenceRemainsExact(
  current: Doc<"events">,
  before: Record<string, unknown>,
): boolean {
  const immutableFields = [
    "_creationTime",
    "_id",
    "artists",
    "date",
    "description",
    "eventType",
    "imageStorageId",
    "imageUrl",
    "instagramPostId",
    "instagramPostUrl",
    "normalizedFieldsJson",
    "normalizedVenueIdentity",
    "normalizedVenueInstagramHandle",
    "rawExtractionJson",
    "sourceCaption",
    "sourceOccurrenceKey",
    "sourcePostedAt",
    "time",
    "title",
    "venue",
    "venueId",
    "venueInstagramHandle",
  ] as const;
  return (
    before.status === "approved" &&
    reviewedFoldCanonicalSourceFieldsRemainExact(current, before) &&
    immutableFields.every((field) => exactJsonValue(current[field], before[field]))
  );
}

function reviewedFoldCanonicalSourceFieldsRemainExact(
  current: Doc<"events">,
  before: Record<string, unknown>,
): boolean {
  const canonicalSourceUrl = canonicalizeSourceUrlOrEmpty(
    "instagram",
    typeof before.instagramPostUrl === "string"
      ? before.instagramPostUrl
      : current.instagramPostUrl,
  );
  return ["canonicalSourceUrl", "normalizedInstagramPostUrl"].every(
    (field) => {
      if (Object.hasOwn(before, field)) {
        return exactJsonValue(
          current[field as keyof Doc<"events">],
          before[field],
        );
      }
      const value = current[field as keyof Doc<"events">];
      return value === undefined ||
        (Boolean(canonicalSourceUrl) && value === canonicalSourceUrl);
    },
  );
}

function reviewedFoldLinkMatchesAudit(
  current: Doc<"instagramEventSources">,
  before: unknown,
): boolean {
  const audited = readObject(before);
  if (!audited) return false;
  const comparable = { ...current } as Record<string, unknown>;
  for (const additiveField of [
    "canonicalSourceUrl",
    "sourceOccurrenceId",
  ] as const) {
    if (!Object.hasOwn(audited, additiveField)) delete comparable[additiveField];
  }
  return exactJsonValue(comparable, audited);
}

async function hasVerifiedRejectedReviewedFold(
  ctx: MutationCtx,
  event: Doc<"events">,
  expectedPrimaryId?: string,
): Promise<boolean> {
  if (event.status !== "rejected") return false;
  const marker = readReviewedRejectedFoldMarker(event.moderationNote);
  if (!marker) return false;
  const auditRows = await ctx.db
    .query("eventAuditLog")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(MAX_REVIEWED_FOLD_AUDIT_ROWS + 1);
  if (auditRows.length > MAX_REVIEWED_FOLD_AUDIT_ROWS) return false;
  const matchingAudits = auditRows.filter(
    (audit) => audit.action === marker.action && audit.patchJson,
  );
  if (matchingAudits.length !== 1) return false;
  let patch: Record<string, unknown> | null = null;
  try {
    patch = readObject(JSON.parse(matchingAudits[0]!.patchJson!));
  } catch {
    return false;
  }
  const eventBefore = readObject(patch?.eventBefore);
  const primaryId = patch?.primaryId;
  if (
    !patch ||
    patch.operationId !== marker.operationId ||
    patch.policyVersion !== 1 ||
    patch[marker.updatedAtField] !== event.updatedAt ||
    typeof primaryId !== "string" ||
    (expectedPrimaryId !== undefined && primaryId !== expectedPrimaryId) ||
    !eventBefore ||
    !rejectedFoldEvidenceRemainsExact(event, eventBefore)
  ) {
    return false;
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const link = links.length === 1 ? links[0]! : null;
  if (!link || !reviewedFoldLinkMatchesAudit(link, patch.sourceLinkBefore)) {
    return false;
  }
  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", link.sourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0]! : null;
  const expected = receipt?.expectedOccurrences?.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  const satisfied = receipt?.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  const normalizedPrimaryId = ctx.db.normalizeId("events", primaryId);
  if (!normalizedPrimaryId) return false;
  const primary = await ctx.db.get(normalizedPrimaryId);
  if (
    !receipt ||
    !exactJsonValue(receipt, patch.receiptAfter) ||
    expected?.length !== 1 ||
    satisfied?.length !== 1 ||
    satisfied[0]!.eventId !== primaryId ||
    !primary ||
    primary.status !== "approved" ||
    !sourceOccurrenceRepresentativeMatchesExpected(primary, expected[0])
  ) {
    return false;
  }
  const occurrences = await ctx.db
    .query("sourceOccurrences")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", link.sourceIdentity)
        .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
    )
    .take(2);
  return (
    occurrences.length === 0 ||
    (occurrences.length === 1 &&
      occurrences[0]!.canonicalEventId === primaryId &&
      occurrences[0]!.state === "satisfied")
  );
}

function approvedReviewedFoldEventAfterMatches(
  event: Doc<"events">,
  eventAfter: unknown,
): boolean {
  const audited = readObject(eventAfter);
  return Boolean(
    audited &&
      [
        "artists",
        "date",
        "description",
        "time",
        "title",
        "updatedAt",
        "venue",
      ].every((field) =>
        exactJsonValue(
          event[field as keyof Doc<"events">],
          audited[field],
        ),
      ),
  );
}

async function hasVerifiedApprovedReviewedFold(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  if (event.status !== "approved" || !event.normalizedFieldsJson) return false;
  let fields: Record<string, unknown> | null = null;
  try {
    fields = readObject(JSON.parse(event.normalizedFieldsJson));
  } catch {
    return false;
  }
  if (!fields) return false;
  const promotion = readObject(fields.reviewedPromotionVariantFold);
  const continuation = readObject(fields.reviewedSameSourceContinuationFold);
  let action: string;
  let counterpartId: string;
  let expectedPrimaryId: string;
  let operationId: string;
  let targetVenueId: string | null;
  let auditIdentityMatches: (patch: Record<string, unknown>) => boolean;
  if (promotion) {
    if (
      promotion.policyVersion !== 1 ||
      promotion.primaryEventId !== event._id ||
      typeof promotion.variantEventId !== "string" ||
      typeof promotion.operationId !== "string" ||
      (promotion.targetVenueId !== null &&
        typeof promotion.targetVenueId !== "string")
    ) {
      return false;
    }
    action = "reviewed_promotion_variant_folded";
    counterpartId = promotion.variantEventId;
    expectedPrimaryId = event._id;
    operationId = promotion.operationId;
    targetVenueId = promotion.targetVenueId;
    auditIdentityMatches = (patch) =>
      patch.variantId === counterpartId &&
      (targetVenueId === null
        ? patch.targetVenueId === undefined || patch.targetVenueId === null
        : patch.targetVenueId === targetVenueId);
  } else if (continuation) {
    const role = continuation.role;
    if (
      continuation.policyVersion !== 1 ||
      (role !== "primary" && role !== "independent") ||
      typeof continuation.primaryEventId !== "string" ||
      typeof continuation.independentEventId !== "string" ||
      typeof continuation.continuationEventId !== "string" ||
      typeof continuation.operationId !== "string" ||
      typeof continuation.targetVenueId !== "string" ||
      (role === "primary" && continuation.primaryEventId !== event._id) ||
      (role === "independent" && continuation.independentEventId !== event._id)
    ) {
      return false;
    }
    action =
      role === "primary"
        ? "reviewed_same_source_continuation_folded"
        : "reviewed_same_source_independent_corrected";
    counterpartId = continuation.continuationEventId;
    expectedPrimaryId = continuation.primaryEventId;
    operationId = continuation.operationId;
    targetVenueId = continuation.targetVenueId;
    auditIdentityMatches = (patch) =>
      role === "primary"
        ? patch.continuationId === counterpartId &&
          patch.independentId === continuation.independentEventId
        : true;
  } else {
    return false;
  }
  if (
    targetVenueId === null
      ? event.venueId !== undefined
      : event.venueId !== targetVenueId
  ) {
    return false;
  }
  const auditRows = await ctx.db
    .query("eventAuditLog")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(MAX_REVIEWED_FOLD_AUDIT_ROWS + 1);
  if (auditRows.length > MAX_REVIEWED_FOLD_AUDIT_ROWS) return false;
  const matchingPatches: Record<string, unknown>[] = [];
  for (const audit of auditRows) {
    if (audit.action !== action || !audit.patchJson) continue;
    try {
      const patch = readObject(JSON.parse(audit.patchJson));
      if (patch?.operationId === operationId) matchingPatches.push(patch);
    } catch {
      return false;
    }
  }
  const auditPatch = matchingPatches.length === 1 ? matchingPatches[0]! : null;
  if (
    !auditPatch ||
    auditPatch.policyVersion !== 1 ||
    !auditIdentityMatches(auditPatch) ||
    !approvedReviewedFoldEventAfterMatches(event, auditPatch.eventAfter)
  ) {
    return false;
  }
  const normalizedCounterpartId = ctx.db.normalizeId("events", counterpartId);
  if (!normalizedCounterpartId) return false;
  const counterpart = await ctx.db.get(normalizedCounterpartId);
  if (
    !counterpart ||
    !(await hasVerifiedRejectedReviewedFold(
      ctx,
      counterpart,
      expectedPrimaryId,
    ))
  ) {
    return false;
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const link = links.length === 1 ? links[0]! : null;
  if (!link) return false;
  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", link.sourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0]! : null;
  const expected = receipt?.expectedOccurrences?.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  const satisfied = receipt?.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === link.sourceOccurrenceKey,
  );
  return Boolean(
    receipt &&
      expected?.length === 1 &&
      satisfied?.length === 1 &&
      satisfied[0]!.eventId === event._id &&
      sourceOccurrenceRepresentativeMatchesExpected(event, expected[0]),
  );
}

async function hasVerifiedReviewedFold(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  return event.status === "rejected"
    ? hasVerifiedRejectedReviewedFold(ctx, event)
    : hasVerifiedApprovedReviewedFold(ctx, event);
}

/**
 * Attests legacy event venue text after identity claims are complete. Exact
 * claims bind to canonical venue IDs; unknown claims retain an explicit,
 * normalized unresolved identity; ambiguous claims fail closed. Existing
 * source provenance is re-attested through the same receipt-fenced adapter
 * used by moderation, while campaign lineage stays in its dedicated
 * quarantine.
 */
export async function backfillEventVenueBindingsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  await assertCleanCompletedEventDomainMigration(ctx, "venue-identities-v1");
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("events")
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
  for (const event of page.page) {
    if (isCrossPostCampaignLineageEvent(event)) {
      const campaignProof = await loadVerifiedCampaignLineageForSourceEvent(
        ctx,
        event,
      );
      if (
        campaignProof &&
        event.venueId === campaignProof.currentAttestation.targetVenueId
      ) {
        // The receipt-fenced campaign proof binds every source event to the
        // canonical target venue ID. Rejected source variants intentionally
        // retain their source-specific venue text as immutable evidence, so a
        // textual denormalization difference is not a binding mismatch.
        counts.unchangedCount! += 1;
        continue;
      }
      if (await hasVerifiedReviewedFold(ctx, event)) {
        counts.unchangedCount! += 1;
        continue;
      }
      counts.skippedCount! += 1;
      counts.quarantinedLineageMarkerCount! += 1;
      continue;
    }
    const rawVenueClaim = (event.venueInstagramHandle ?? event.venue).trim();
    const auditedLegacyResolution = rawVenueClaim
      ? null
      : await resolveAuditedLegacyVenueClaim(ctx, event);
    const resolution =
      auditedLegacyResolution?.resolution ??
      (rawVenueClaim
        ? await resolveVenueForWrite(ctx, rawVenueClaim)
        : null);
    const auditedLegacyNormalizedFields = auditedLegacyResolution
      ? buildAuditedLegacyNormalizedFields(event, auditedLegacyResolution)
      : null;
    // A nonempty legacy venue claim does not become invalid merely because the
    // canonical directory has not learned it yet. Unresolved venue identity is
    // a first-class state throughout occurrence construction and
    // reconciliation; this migration must normalize and attest that state
    // instead of requiring every historical event to acquire a guessed venue
    // record. Ambiguity remains a hard mismatch, as does the impossible shape
    // of a "resolved" result without its canonical venue ID. A receipt-fenced
    // event-evidence-v2 extraction that explicitly attests no venue is the one
    // valid missing-claim state: it retains the domain's unknown-venue identity
    // rather than inventing a place. Every other missing claim, or an already-
    // bound event that no longer resolves, remains a mismatch.
    if (
      !resolution &&
      (await hasVerifiedAbsentVenueEvidence(ctx, event))
    ) {
      counts.unchangedCount! += 1;
      continue;
    }
    const explicitUnresolvedClaim =
      resolution?.resolution.status === "unresolved" &&
      (rawVenueClaim.length > 0 || Boolean(auditedLegacyResolution)) &&
      Boolean(resolution.venueFields.normalizedVenueIdentity) &&
      event.venueId === undefined;
    if (
      !resolution ||
      resolution.resolution.status === "ambiguous" ||
      (resolution.resolution.status === "resolved" &&
        !resolution.venueFields.venueId) ||
      (resolution.resolution.status === "unresolved" &&
        !explicitUnresolvedClaim)
    ) {
      counts.mismatchCount += 1;
      continue;
    }
    const effectiveEvent: Doc<"events"> = {
      ...event,
      ...resolution.venueFields,
      ...(auditedLegacyResolution
        ? { venue: auditedLegacyResolution.displayVenue }
        : {}),
      ...(auditedLegacyNormalizedFields
        ? { normalizedFieldsJson: auditedLegacyNormalizedFields }
        : {}),
    };
    const patch = {
      ...resolution.venueFields,
      ...(auditedLegacyResolution
        ? { venue: auditedLegacyResolution.displayVenue }
        : {}),
      ...(auditedLegacyNormalizedFields
        ? { normalizedFieldsJson: auditedLegacyNormalizedFields }
        : {}),
      ...buildEventOccurrenceIndexPatch(effectiveEvent),
    };
    if (!eventDomainMigrationPatchDiffers(event, patch)) {
      counts.unchangedCount! += 1;
      continue;
    }
    let affectedRepresentativeIds: Doc<"events">["_id"][];
    try {
      affectedRepresentativeIds =
        await sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(
          ctx,
          event,
          effectiveEvent,
          { dryRun, topologyEpochVerified: true },
        );
    } catch (error) {
      if (error instanceof DomainError) {
        counts.mismatchCount += 1;
        continue;
      }
      throw error;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      await ctx.db.patch(event._id, patch);
      await refreshEventPublicationStates(ctx, affectedRepresentativeIds);
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
    key: "event-venue-bindings-v1",
    phase: "event_venue_bindings",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
