import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  buildCrossPostPromotionCoalescingPlan,
  captionsHaveExactCampaignHashtagAnchors,
  CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
  deriveAutomaticCrossPostCampaignIdentity,
  deriveExclusiveHashtagCrossPostCampaignIdentity,
  hasAutomaticCrossPostCanonicalVenueEvidence,
  MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY,
} from "../../lib/events/cross-post-promotion-coalescing";
import {
  CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD,
  hasCrossPostCampaignAggregateAttestationField,
  readCrossPostCampaignAggregateAttestation,
  type CrossPostCampaignAggregateAttestation,
} from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { exactJsonValue } from "../../lib/events/exact-json-value";
import { buildNormalizedEventVenueIdentity } from "../../lib/events/event-venue-identity";
import { nextEventUpdatedAt } from "../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { normalizeInstagramPostUrl } from "../../lib/images/apify-images";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { isVenuePublic } from "../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../authz";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../internal/sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../internal/sourceOccurrenceTopologyEpoch";
import { isCanonicallyGroundedApprovedEvent } from "../publicEventGrounding";
import {
  SavedEventRepositoryConflict,
  savedEventRepository,
} from "../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import { CLEARED_VENUE_DENORMALIZED_FIELDS } from "../venueResolver";
import { parseCoalescingJsonRecord } from "./coalescingSupport";
import type { CrossPostPromotionCandidateVersion } from "./contracts";
import {
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./persistence";
import { assertApprovalCandidatePolicy } from "./sourceApproval";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";
import { normalizedString } from "./valueNormalization";

const MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT = 100;
const MAX_CROSS_POST_PROMOTION_AUDIT_JSON_BYTES = 600_000;

function exactStringSetEquals(left: string[], right: string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

type CrossPostReceiptExpectedOccurrence = {
  key: string;
  date: string;
  time?: string;
  venue: string;
  title: string;
  artists: string[];
};

function exactCrossPostReceiptSemanticsEqual(
  left: CrossPostReceiptExpectedOccurrence | undefined,
  right: CrossPostReceiptExpectedOccurrence | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.date === right.date &&
    left.time === right.time &&
    left.venue === right.venue &&
    left.title === right.title &&
    left.artists.length === right.artists.length &&
    left.artists.every((artist, index) => artist === right.artists[index]),
  );
}

function crossPostReceiptHasExactSingleBinding(
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  sourceLink: Doc<"instagramEventSources">,
): boolean {
  return (
    receipt.sourceIdentity === sourceLink.sourceIdentity &&
    receipt.sourceFingerprint === sourceLink.sourceFingerprint &&
    receipt.expectedKeys.length === 1 &&
    receipt.expectedKeys[0] === sourceLink.sourceOccurrenceKey &&
    receipt.expectedOccurrences?.length === 1 &&
    receipt.expectedOccurrences[0]?.key === sourceLink.sourceOccurrenceKey &&
    receipt.satisfiedKeys.length === 1 &&
    receipt.satisfiedKeys[0] === sourceLink.sourceOccurrenceKey &&
    receipt.satisfiedOccurrences.length === 1 &&
    receipt.satisfiedOccurrences[0]?.key === sourceLink.sourceOccurrenceKey &&
    receipt.deferredChildCount === 0 &&
    receipt.deferredChildKeys.length === 0
  );
}

export function assertCrossPostPromotionAuditPayload(payload: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(payload)).byteLength >
    MAX_CROSS_POST_PROMOTION_AUDIT_JSON_BYTES
  ) {
    throw new Error(
      "Cross-post promotion rollback payload exceeds the safe audit bound.",
    );
  }
}

function buildCrossPostPromotionModerationMarker(
  role: "primary" | "variant",
  operationId: string,
): string {
  return (
    `[cross_post_campaign_${role}:v${CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION}] ` +
    `${operationId} - `
  );
}

type PreparedCrossPostPromotionCandidate = {
  event: Doc<"events">;
  fields: Record<string, unknown>;
  link: Doc<"instagramEventSources">;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
  canonicalPostUrl: string;
  savedEvents: Doc<"savedEvents">[];
  userSavedEvents: Doc<"userSavedEvents">[];
};

type LegacyCrossPostPromotionMigrationProof = {
  sourceEventsBefore: Doc<"events">[];
};

function readLegacyCrossPostApprovedEventBefore(
  value: unknown,
): Doc<"events"> | null {
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

function legacyCrossPostSourceEvidenceRemainsExact(
  current: Doc<"events">,
  before: Doc<"events">,
): boolean {
  return (
    current.normalizedFieldsJson === before.normalizedFieldsJson &&
    current.title === before.title &&
    current.date === before.date &&
    current.time === before.time &&
    current.instagramPostId === before.instagramPostId &&
    current.instagramPostUrl === before.instagramPostUrl &&
    current.sourceCaption === before.sourceCaption &&
    current.sourcePostedAt === before.sourcePostedAt &&
    current.rawExtractionJson === before.rawExtractionJson &&
    current.imageUrl === before.imageUrl &&
    current.imageStorageId === before.imageStorageId &&
    current.sourceOccurrenceKey === before.sourceOccurrenceKey
  );
}

async function loadExactCrossPostAuditPatchForOperation(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  action: string,
  operationId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await ctx.db
    .query("eventAuditLog")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(101);
  if (rows.length > 100) return null;
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

async function proveLegacyCrossPostPromotionMigration(
  ctx: QueryCtx | MutationCtx,
  args: {
    legacyOperationId: string;
    targetVenue: Doc<"venues">;
    prepared: PreparedCrossPostPromotionCandidate[];
    sharedEvidenceAnchors?: string[];
  },
): Promise<LegacyCrossPostPromotionMigrationProof | null> {
  const { legacyOperationId, targetVenue, prepared } = args;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(legacyOperationId) ||
    prepared.length < 2 ||
    prepared.length > 8
  ) {
    return null;
  }
  const primary = prepared[0]!;
  const variants = prepared.slice(1);
  const primaryMarker = buildCrossPostPromotionModerationMarker(
    "primary",
    legacyOperationId,
  );
  const variantMarker = buildCrossPostPromotionModerationMarker(
    "variant",
    legacyOperationId,
  );
  if (
    primary.event.status !== "approved" ||
    !primary.event.moderationNote?.startsWith(primaryMarker) ||
    hasCrossPostCampaignAggregateAttestationField(
      primary.event.normalizedFieldsJson,
    ) ||
    variants.some(
      ({ event }) =>
        event.status !== "rejected" ||
        !event.moderationNote?.startsWith(variantMarker) ||
        hasCrossPostCampaignAggregateAttestationField(
          event.normalizedFieldsJson,
        ),
    )
  ) {
    return null;
  }

  const primaryAudit = await loadExactCrossPostAuditPatchForOperation(
    ctx,
    primary.event._id,
    "cross_post_campaign_coalesced",
    legacyOperationId,
  );
  const primaryEventBefore = readLegacyCrossPostApprovedEventBefore(
    primaryAudit?.eventBefore,
  );
  const foldedVariantIds = Array.isArray(primaryAudit?.foldedVariantIds)
    ? primaryAudit.foldedVariantIds
    : [];
  const variantUpdatedAts = Array.isArray(primaryAudit?.variantUpdatedAts)
    ? primaryAudit.variantUpdatedAts
    : [];
  const variantReceiptUpdatedAts = Array.isArray(
    primaryAudit?.variantReceiptUpdatedAts,
  )
    ? primaryAudit.variantReceiptUpdatedAts
    : [];
  const auditedTargetVenue =
    primaryAudit?.targetVenue &&
    typeof primaryAudit.targetVenue === "object" &&
    !Array.isArray(primaryAudit.targetVenue)
      ? (primaryAudit.targetVenue as Record<string, unknown>)
      : null;
  if (
    !primaryAudit ||
    primaryAudit.policyVersion !==
      CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION ||
    primaryAudit.sourceGroundingVerifiedAtCoalescing === true ||
    primaryAudit.aggregateAttestation !== undefined ||
    !primaryEventBefore ||
    !legacyCrossPostSourceEvidenceRemainsExact(
      primary.event,
      primaryEventBefore,
    ) ||
    !exactJsonValue(primaryAudit.sourceLinkBefore, primary.link) ||
    !exactJsonValue(primaryAudit.receiptBefore, primary.receipt) ||
    primaryAudit.canonicalVenueName !== targetVenue.name ||
    normalizeHandle(normalizedString(primaryAudit.canonicalVenueHandle)) !==
      normalizeHandle(targetVenue.instagramHandle) ||
    auditedTargetVenue?._id !== targetVenue._id ||
    auditedTargetVenue.updatedAt !== targetVenue.updatedAt ||
    foldedVariantIds.length !== variants.length ||
    !foldedVariantIds.every(
      (eventId, index) => eventId === variants[index]?.event._id,
    ) ||
    variantUpdatedAts.length !== variants.length ||
    !variantUpdatedAts.every((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const transition = value as Record<string, unknown>;
      return (
        transition.id === variants[index]?.event._id &&
        transition.updatedAt === variants[index]?.event.updatedAt
      );
    }) ||
    variantReceiptUpdatedAts.length !== variants.length ||
    !variantReceiptUpdatedAts.every((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const transition = value as Record<string, unknown>;
      return (
        transition.eventId === variants[index]?.event._id &&
        transition.receiptId === variants[index]?.receipt._id &&
        transition.updatedAt === variants[index]?.receipt.updatedAt
      );
    }) ||
    (args.sharedEvidenceAnchors !== undefined &&
      (!Array.isArray(primaryAudit.sharedEvidenceAnchors) ||
        primaryAudit.sharedEvidenceAnchors.some(
          (value) => typeof value !== "string",
        ) ||
        !exactStringSetEquals(
          primaryAudit.sharedEvidenceAnchors as string[],
          args.sharedEvidenceAnchors,
        ))) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, primaryEventBefore))
  ) {
    return null;
  }

  const sourceEventsBefore = [primaryEventBefore];
  const primaryExpectedOccurrence = primary.receipt.expectedOccurrences?.[0];
  if (
    !crossPostReceiptHasExactSingleBinding(primary.receipt, primary.link) ||
    primary.receipt.satisfiedOccurrences[0]?.eventId !== primary.event._id ||
    !sourceOccurrenceRepresentativeMatchesExpected(
      primary.event,
      primaryExpectedOccurrence,
    )
  ) {
    return null;
  }
  for (let index = 0; index < variants.length; index += 1) {
    const item = variants[index]!;
    const audit = await loadExactCrossPostAuditPatchForOperation(
      ctx,
      item.event._id,
      "cross_post_campaign_variant_rejected",
      legacyOperationId,
    );
    const eventBefore = readLegacyCrossPostApprovedEventBefore(
      audit?.eventBefore,
    );
    const expectedOccurrence = item.receipt.expectedOccurrences?.[0];
    if (
      !audit ||
      audit.policyVersion !== CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION ||
      audit.sourceGroundingVerifiedAtCoalescing === true ||
      audit.primaryId !== primary.event._id ||
      audit.variantUpdatedAt !== item.event.updatedAt ||
      !eventBefore ||
      !legacyCrossPostSourceEvidenceRemainsExact(item.event, eventBefore) ||
      !exactJsonValue(audit.sourceLinkBefore, item.link) ||
      !exactJsonValue(audit.receiptAfter, item.receipt) ||
      !crossPostReceiptHasExactSingleBinding(item.receipt, item.link) ||
      !exactCrossPostReceiptSemanticsEqual(
        expectedOccurrence,
        primaryExpectedOccurrence,
      ) ||
      item.receipt.satisfiedOccurrences[0]?.eventId !== primary.event._id ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        primary.event,
        expectedOccurrence,
      ) ||
      !(await isCanonicallyGroundedApprovedEvent(ctx, eventBefore))
    ) {
      return null;
    }
    sourceEventsBefore.push(eventBefore);
  }
  return { sourceEventsBefore };
}

/**
 * Returns the exact bounded rows needed to construct a coalescing mutation.
 * Operators can call it again after an uncertain response: the same operation
 * then reports already_coalesced instead of encouraging a second mutation.
 */

export async function getCrossPostPromotionCoalescingContextHandler(
  ctx: QueryCtx,
  args: {
    operationId: string;
    legacyMigrationOperationId?: string;
    eventIds: Id<"events">[];
    targetVenueId: Id<"venues">;
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Cross-post promotion context requires service authentication.",
    );
  }
  const legacyMigrationOperationId = args.legacyMigrationOperationId?.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(args.operationId) ||
    (legacyMigrationOperationId !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(
        legacyMigrationOperationId,
      ) ||
        legacyMigrationOperationId === args.operationId ||
        !args.operationId.startsWith("auto-cross-post-v1:"))) ||
    args.eventIds.length < 2 ||
    args.eventIds.length > 8 ||
    new Set(args.eventIds.map(String)).size !== args.eventIds.length
  ) {
    throw new Error("Cross-post promotion context arguments are invalid.");
  }
  const targetVenue = await ctx.db.get(args.targetVenueId);
  if (!targetVenue) {
    throw new Error("Cross-post promotion context target venue is missing.");
  }
  const candidates: Array<{
    event: Doc<"events">;
    sourceLink: Doc<"instagramEventSources">;
    receipt: Doc<"instagramSourceOccurrenceReceipts">;
  }> = [];
  for (const eventId of args.eventIds) {
    const event = await ctx.db.get(eventId);
    if (!event) {
      throw new Error(
        `Cross-post promotion context event is missing: ${eventId}.`,
      );
    }
    const sourceLinks = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(2);
    const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
    const receipts = sourceLink
      ? await ctx.db
          .query("instagramSourceOccurrenceReceipts")
          .withIndex("by_sourceIdentity", (q) =>
            q.eq("sourceIdentity", sourceLink.sourceIdentity),
          )
          .take(2)
      : [];
    const receipt = receipts.length === 1 ? receipts[0] : null;
    if (
      !sourceLink ||
      !receipt ||
      sourceLink.eventId !== event._id ||
      sourceLink.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
      sourceLink.instagramPostId !== event.instagramPostId ||
      normalizeInstagramPostUrl(sourceLink.instagramPostUrl ?? "") !==
        normalizeInstagramPostUrl(event.instagramPostUrl ?? "") ||
      receipt.sourceIdentity !== sourceLink.sourceIdentity ||
      receipt.sourceFingerprint !== sourceLink.sourceFingerprint
    ) {
      throw new Error(
        `Cross-post promotion context requires one exact link and receipt: ${eventId}.`,
      );
    }
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    candidates.push({ event, sourceLink, receipt });
  }

  const primaryMarker = buildCrossPostPromotionModerationMarker(
    "primary",
    args.operationId,
  );
  const variantMarker = buildCrossPostPromotionModerationMarker(
    "variant",
    args.operationId,
  );
  const primaryCandidate = candidates[0]!;
  const primaryExpectedOccurrence =
    primaryCandidate.receipt.expectedOccurrences?.[0];
  const publiclyGrounded = await Promise.all(
    candidates.map(({ event }) =>
      isCanonicallyGroundedApprovedEvent(ctx, event),
    ),
  );
  const ready =
    publiclyGrounded.every(Boolean) &&
    candidates.every(({ event, sourceLink, receipt }) => {
      const expectedOccurrence = receipt.expectedOccurrences?.[0];
      return (
        event.status === "approved" &&
        crossPostReceiptHasExactSingleBinding(receipt, sourceLink) &&
        receipt.satisfiedOccurrences[0]?.eventId === event._id &&
        sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence)
      );
    });
  const exactReceiptAfterState =
    crossPostReceiptHasExactSingleBinding(
      primaryCandidate.receipt,
      primaryCandidate.sourceLink,
    ) &&
    primaryCandidate.receipt.satisfiedOccurrences[0]?.eventId ===
      primaryCandidate.event._id &&
    sourceOccurrenceRepresentativeMatchesExpected(
      primaryCandidate.event,
      primaryExpectedOccurrence,
    ) &&
    candidates.slice(1).every(({ event, sourceLink, receipt }) => {
      const expectedOccurrence = receipt.expectedOccurrences?.[0];
      return (
        sourceLink.eventId === event._id &&
        crossPostReceiptHasExactSingleBinding(receipt, sourceLink) &&
        exactCrossPostReceiptSemanticsEqual(
          expectedOccurrence,
          primaryExpectedOccurrence,
        ) &&
        receipt.satisfiedOccurrences[0]?.eventId ===
          primaryCandidate.event._id &&
        sourceOccurrenceRepresentativeMatchesExpected(
          primaryCandidate.event,
          expectedOccurrence,
        )
      );
    });
  const exactTargetAfterState =
    primaryCandidate.event.venueId === targetVenue._id &&
    primaryCandidate.event.venue === targetVenue.name &&
    normalizeHandle(primaryCandidate.event.venueInstagramHandle ?? "") ===
      normalizeHandle(targetVenue.instagramHandle);
  let exactPrimaryAudit = false;
  if (candidates[0]?.event.moderationNote?.startsWith(primaryMarker) === true) {
    const auditRows = await ctx.db
      .query("eventAuditLog")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventIds[0]!))
      .take(101);
    if (auditRows.length > 100) {
      throw new Error(
        "Cross-post promotion after-state audit exceeds the safe bound.",
      );
    }
    exactPrimaryAudit = auditRows.some((audit) => {
      if (
        audit.action !== "cross_post_campaign_coalesced" ||
        !audit.patchJson
      ) {
        return false;
      }
      try {
        const patch = JSON.parse(audit.patchJson) as Record<string, unknown>;
        const foldedVariantIds = Array.isArray(patch.foldedVariantIds)
          ? patch.foldedVariantIds
          : [];
        const variantReceiptUpdatedAts = Array.isArray(
          patch.variantReceiptUpdatedAts,
        )
          ? patch.variantReceiptUpdatedAts
          : [];
        const auditedTargetVenue =
          patch.targetVenue &&
          typeof patch.targetVenue === "object" &&
          !Array.isArray(patch.targetVenue)
            ? (patch.targetVenue as Record<string, unknown>)
            : null;
        return (
          patch.operationId === args.operationId &&
          patch.policyVersion ===
            CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION &&
          patch.canonicalVenueName === targetVenue.name &&
          normalizeHandle(normalizedString(patch.canonicalVenueHandle)) ===
            normalizeHandle(targetVenue.instagramHandle) &&
          auditedTargetVenue?._id === targetVenue._id &&
          auditedTargetVenue.updatedAt === targetVenue.updatedAt &&
          foldedVariantIds.length === candidates.length - 1 &&
          foldedVariantIds.every(
            (eventId, index) => eventId === candidates[index + 1]?.event._id,
          ) &&
          variantReceiptUpdatedAts.length === candidates.length - 1 &&
          variantReceiptUpdatedAts.every((value, index) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              return false;
            }
            const transition = value as Record<string, unknown>;
            const candidate = candidates[index + 1];
            return (
              transition.eventId === candidate?.event._id &&
              transition.receiptId === candidate?.receipt._id &&
              transition.updatedAt === candidate?.receipt.updatedAt
            );
          })
        );
      } catch {
        return false;
      }
    });
  }
  const alreadyCoalesced =
    exactPrimaryAudit &&
    exactReceiptAfterState &&
    exactTargetAfterState &&
    publiclyGrounded[0] === true &&
    candidates[0]?.event.status === "approved" &&
    candidates[0]?.event.moderationNote?.startsWith(primaryMarker) === true &&
    candidates
      .slice(1)
      .every(
        ({ event }) =>
          event.status === "rejected" &&
          event.moderationNote?.startsWith(variantMarker) === true,
      );
  const completedAttestation = readCrossPostCampaignAggregateAttestation(
    primaryCandidate.event.normalizedFieldsJson,
  );
  const alreadyMigrated = Boolean(
    completedAttestation?.operationId === args.operationId &&
    completedAttestation.legacyOperationId &&
    completedAttestation.primaryEventId === primaryCandidate.event._id &&
    completedAttestation.targetVenueId === targetVenue._id &&
    completedAttestation.sources.length === candidates.length &&
    completedAttestation.sources.every(
      (source, index) => source.eventId === candidates[index]?.event._id,
    ) &&
    exactReceiptAfterState &&
    exactTargetAfterState &&
    publiclyGrounded[0] === true &&
    primaryCandidate.event.status === "approved" &&
    primaryCandidate.event.moderationNote?.startsWith(
      buildCrossPostPromotionModerationMarker(
        "primary",
        completedAttestation.legacyOperationId,
      ),
    ) === true &&
    candidates
      .slice(1)
      .every(
        ({ event }) =>
          event.status === "rejected" &&
          event.moderationNote?.startsWith(
            buildCrossPostPromotionModerationMarker(
              "variant",
              completedAttestation.legacyOperationId!,
            ),
          ) === true,
      ),
  );
  const legacyMigrationProof = args.legacyMigrationOperationId
    ? await proveLegacyCrossPostPromotionMigration(ctx, {
        legacyOperationId: args.legacyMigrationOperationId,
        targetVenue,
        prepared: candidates.map(({ event, sourceLink, receipt }) => ({
          event,
          fields: parseCoalescingJsonRecord(
            event.normalizedFieldsJson ?? "{}",
            `Legacy cross-post migration normalized fields ${event._id}`,
          ),
          link: sourceLink,
          receipt,
          canonicalPostUrl: normalizeInstagramPostUrl(event.instagramPostUrl),
          savedEvents: [],
          userSavedEvents: [],
        })),
      })
    : null;
  if (
    !ready &&
    !alreadyCoalesced &&
    !alreadyMigrated &&
    !legacyMigrationProof
  ) {
    throw new Error(
      "Cross-post promotion context is neither ready nor an exact after-state.",
    );
  }
  return {
    state:
      alreadyCoalesced || alreadyMigrated
        ? ("already_coalesced" as const)
        : legacyMigrationProof
          ? ("legacy_migration_ready" as const)
          : ("ready" as const),
    targetVenue,
    candidates,
  };
}

export async function coalesceApprovedCrossPostPromotionOccurrencesHandler(
  ctx: MutationCtx,
  args: {
    operationId: string;
    legacyMigrationOperationId?: string;
    primary: CrossPostPromotionCandidateVersion;
    duplicates: CrossPostPromotionCandidateVersion[];
    targetVenueId: Id<"venues">;
    expectedTargetVenueUpdatedAt: number;
    sharedEvidenceAnchors: string[];
    automaticCampaignIdentity?: string;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Cross-post promotion coalescing requires service authentication.",
    );
  }
  const legacyMigrationOperationId = args.legacyMigrationOperationId?.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(args.operationId) ||
    (legacyMigrationOperationId !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(
        legacyMigrationOperationId,
      ) ||
        legacyMigrationOperationId === args.operationId ||
        !args.operationId.startsWith("auto-cross-post-v1:") ||
        !args.automaticCampaignIdentity?.trim())) ||
    args.moderationNote.trim().length < 24 ||
    args.moderationNote.trim().length > 1_000 ||
    args.duplicates.length < 1 ||
    args.duplicates.length > 7 ||
    args.sharedEvidenceAnchors.length < 2 ||
    args.sharedEvidenceAnchors.length > 6 ||
    !Number.isSafeInteger(args.expectedTargetVenueUpdatedAt)
  ) {
    throw new Error("Cross-post promotion coalescing arguments are invalid.");
  }

  const versions = [args.primary, ...args.duplicates];
  const eventIds = versions.map((item) => String(item.id));
  const expectedLinkIds = versions.map((item) =>
    String(item.expectedSourceLinkId),
  );
  const expectedReceiptIds = versions.map((item) =>
    String(item.expectedReceiptId),
  );
  if (
    new Set(eventIds).size !== eventIds.length ||
    new Set(expectedLinkIds).size !== expectedLinkIds.length ||
    new Set(expectedReceiptIds).size !== expectedReceiptIds.length
  ) {
    throw new Error(
      "Cross-post promotion coalescing requires unique events, links, and receipts.",
    );
  }

  const targetVenue = await ctx.db.get(args.targetVenueId);
  if (
    !targetVenue ||
    targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
    !isVenuePublic(targetVenue) ||
    !targetVenue.name.trim() ||
    !normalizeHandle(targetVenue.instagramHandle)
  ) {
    throw new Error("Cross-post promotion target venue precondition failed.");
  }

  const prepared: PreparedCrossPostPromotionCandidate[] = [];
  for (
    let versionIndex = 0;
    versionIndex < versions.length;
    versionIndex += 1
  ) {
    const version = versions[versionIndex]!;
    const legacyMigrationVariant =
      legacyMigrationOperationId !== undefined && versionIndex > 0;
    if (
      !Number.isSafeInteger(version.expectedUpdatedAt) ||
      !Number.isSafeInteger(version.expectedSourceLinkUpdatedAt) ||
      !Number.isSafeInteger(version.expectedReceiptUpdatedAt) ||
      !version.expectedSourceIdentity.trim() ||
      !version.expectedSourceFingerprint.trim() ||
      !version.expectedOccurrenceKey.trim()
    ) {
      throw new Error("Cross-post promotion version precondition is invalid.");
    }
    const event = await ctx.db.get(version.id);
    if (
      !event ||
      (event.status !== "approved" &&
        !(legacyMigrationVariant && event.status === "rejected")) ||
      event.updatedAt !== version.expectedUpdatedAt ||
      event.normalizedFieldsJson !== version.expectedNormalizedFieldsJson ||
      event.sourceOccurrenceKey !== version.expectedOccurrenceKey ||
      !event.instagramPostId ||
      !event.sourceCaption
    ) {
      throw new Error(
        `Cross-post promotion event precondition failed: ${version.id}.`,
      );
    }
    const canonicalPostUrl = requireCanonicalInstagramPostUrl(
      event.instagramPostUrl,
      `Cross-post promotion event source ${version.id}`,
    );
    const fields = parseCoalescingJsonRecord(
      event.normalizedFieldsJson,
      `Cross-post promotion normalized fields ${event._id}`,
    );
    const links = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .take(2);
    const link = links.length === 1 ? links[0] : null;
    const linkCanonicalPostUrl = link
      ? requireCanonicalInstagramPostUrl(
          link.instagramPostUrl,
          `Cross-post promotion source link ${version.id}`,
        )
      : "";
    if (
      !link ||
      link._id !== version.expectedSourceLinkId ||
      link.updatedAt !== version.expectedSourceLinkUpdatedAt ||
      link.sourceIdentity !== version.expectedSourceIdentity ||
      link.sourceFingerprint !== version.expectedSourceFingerprint ||
      link.sourceOccurrenceKey !== version.expectedOccurrenceKey ||
      link.instagramPostId !== event.instagramPostId ||
      linkCanonicalPostUrl !== canonicalPostUrl ||
      !normalizeHandle(
        normalizedString(fields.sourceGroundingInstagramHandle),
      ) ||
      (link.sourceHandle !== undefined &&
        normalizeHandle(link.sourceHandle) !==
          normalizeHandle(
            normalizedString(fields.sourceGroundingInstagramHandle),
          ))
    ) {
      throw new Error(
        `Cross-post promotion source-link precondition failed: ${version.id}.`,
      );
    }

    const receipts = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", version.expectedSourceIdentity),
      )
      .take(2);
    const receipt = receipts.length === 1 ? receipts[0] : null;
    if (receipt) assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    const expectedOccurrence = receipt?.expectedOccurrences?.[0];
    if (
      !receipt ||
      receipt._id !== version.expectedReceiptId ||
      receipt.updatedAt !== version.expectedReceiptUpdatedAt ||
      receipt.sourceFingerprint !== version.expectedSourceFingerprint ||
      receipt.deferredChildCount !== 0 ||
      receipt.deferredChildKeys.length !== 0 ||
      receipt.expectedKeys.length !== 1 ||
      receipt.expectedKeys[0] !== version.expectedOccurrenceKey ||
      receipt.expectedOccurrences?.length !== 1 ||
      expectedOccurrence?.key !== version.expectedOccurrenceKey ||
      receipt.satisfiedKeys.length !== 1 ||
      receipt.satisfiedKeys[0] !== version.expectedOccurrenceKey ||
      receipt.satisfiedOccurrences.length !== 1 ||
      receipt.satisfiedOccurrences[0]?.key !== version.expectedOccurrenceKey ||
      receipt.satisfiedOccurrences[0]?.eventId !==
        (legacyMigrationVariant ? args.primary.id : event._id) ||
      (!legacyMigrationVariant &&
        !sourceOccurrenceRepresentativeMatchesExpected(
          event,
          expectedOccurrence,
        ))
    ) {
      throw new Error(
        `Cross-post promotion receipt precondition failed: ${version.id}.`,
      );
    }

    let savedReferences;
    try {
      savedReferences = await savedEventRepository.loadEventReferences(
        ctx,
        event._id,
        { limit: MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT },
      );
    } catch (error) {
      if (error instanceof SavedEventRepositoryConflict) {
        throw new Error(
          `Cross-post promotion save cohort exceeds the safe bound: ${event._id}.`,
        );
      }
      throw error;
    }
    const savedEvents = savedReferences.canonical;
    const userSavedEvents = savedReferences.legacy;
    prepared.push({
      event,
      fields,
      link,
      receipt,
      canonicalPostUrl,
      savedEvents,
      userSavedEvents,
    });
  }
  const primaryHasAggregateField =
    hasCrossPostCampaignAggregateAttestationField(
      prepared[0]!.event.normalizedFieldsJson,
    );
  const previousAggregateAttestation =
    readCrossPostCampaignAggregateAttestation(
      prepared[0]!.event.normalizedFieldsJson,
    );
  const legacyMigrationProof = legacyMigrationOperationId
    ? await proveLegacyCrossPostPromotionMigration(ctx, {
        legacyOperationId: legacyMigrationOperationId,
        targetVenue,
        prepared,
        sharedEvidenceAnchors: args.sharedEvidenceAnchors,
      })
    : null;
  if (
    (legacyMigrationOperationId !== undefined && !legacyMigrationProof) ||
    (primaryHasAggregateField && !previousAggregateAttestation) ||
    prepared
      .slice(1)
      .some(({ event }) =>
        hasCrossPostCampaignAggregateAttestationField(
          event.normalizedFieldsJson,
        ),
      ) ||
    (!legacyMigrationProof &&
      !(
        await Promise.all(
          prepared.map(({ event }) =>
            isCanonicallyGroundedApprovedEvent(ctx, event),
          ),
        )
      ).every(Boolean))
  ) {
    throw new Error(
      "Cross-post promotion candidates must be individually source-grounded with at most one valid primary aggregate.",
    );
  }

  const automaticCampaignIdentity = args.automaticCampaignIdentity?.trim();
  const automaticOperation = args.operationId.startsWith("auto-cross-post-v1:");
  const candidateCaptions = prepared.map(
    ({ event }) => event.sourceCaption ?? "",
  );
  const sharedSourceHandle = normalizeHandle(
    prepared[0]!.link.sourceHandle ??
      normalizedString(prepared[0]!.fields.sourceGroundingInstagramHandle),
  );
  if (
    (automaticOperation || automaticCampaignIdentity !== undefined) &&
    !legacyMigrationProof &&
    prepared.some(({ event, fields, link }) => {
      const sourceHandle =
        link.sourceHandle ??
        normalizedString(fields.sourceGroundingInstagramHandle);
      return !hasAutomaticCrossPostCanonicalVenueEvidence({
        evidenceText: event.sourceCaption ?? "",
        sourceHandle,
        targetVenueId: String(targetVenue._id),
        canonicalVenueName: targetVenue.name,
        canonicalVenueHandle: targetVenue.instagramHandle,
        currentVenueId: event.venueId ? String(event.venueId) : undefined,
        currentVenueName: event.venue,
        currentVenueHandle: event.venueInstagramHandle,
      });
    })
  ) {
    throw new Error(
      "Automatic cross-post promotion canonical venue evidence is insufficient.",
    );
  }
  let derivedAutomaticCampaignIdentity =
    deriveAutomaticCrossPostCampaignIdentity(candidateCaptions);
  if (
    (automaticOperation || automaticCampaignIdentity !== undefined) &&
    !derivedAutomaticCampaignIdentity
  ) {
    const sourceHistory = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postedAtMs", (q) =>
        q.eq("handle", sharedSourceHandle),
      )
      .order("desc")
      .take(MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY + 1);
    const candidatePostIds = previousAggregateAttestation
      ? [
          ...previousAggregateAttestation.campaignPostIds,
          ...prepared.slice(1).map(({ event }) => event.instagramPostId ?? ""),
        ]
      : prepared.map(({ event }) => event.instagramPostId ?? "");
    derivedAutomaticCampaignIdentity =
      deriveExclusiveHashtagCrossPostCampaignIdentity({
        sourceHandle: sharedSourceHandle,
        targetVenueId: String(targetVenue._id),
        date: prepared[0]!.event.date,
        time: prepared[0]!.event.time ?? "",
        eventType: canonicalizeEventType(prepared[0]!.event.eventType),
        anchors: args.sharedEvidenceAnchors,
        candidatePostIds,
        historyPosts: sourceHistory
          .slice(0, MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY)
          .map((post) => ({
            handle: post.handle,
            postId: post.postId,
            caption: post.caption,
            postedAt: post.postedAt,
          })),
        historyComplete:
          sourceHistory.length <= MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY,
      });
  }
  if (
    (automaticOperation || automaticCampaignIdentity !== undefined) &&
    (!automaticCampaignIdentity ||
      automaticCampaignIdentity !== derivedAutomaticCampaignIdentity ||
      !captionsHaveExactCampaignHashtagAnchors(
        prepared.map(({ event }) => event.sourceCaption ?? ""),
        args.sharedEvidenceAnchors,
      ))
  ) {
    throw new Error(
      "Automatic cross-post promotion coalescing requires one exact shared ticket/event URL or one bounded source-exclusive hashtag campaign.",
    );
  }
  if (
    previousAggregateAttestation &&
    (previousAggregateAttestation.primaryEventId !==
      String(prepared[0]!.event._id) ||
      previousAggregateAttestation.targetVenueId !== String(targetVenue._id) ||
      !previousAggregateAttestation.automaticCampaignIdentity ||
      previousAggregateAttestation.automaticCampaignIdentity !==
        automaticCampaignIdentity ||
      !exactStringSetEquals(
        previousAggregateAttestation.campaignAnchors,
        args.sharedEvidenceAnchors,
      ) ||
      previousAggregateAttestation.totalSourceCount + prepared.length - 1 > 8 ||
      previousAggregateAttestation.lineageDepth >= 7)
  ) {
    throw new Error(
      "Cross-post promotion append does not match the bounded existing campaign attestation.",
    );
  }

  const plan = buildCrossPostPromotionCoalescingPlan({
    candidates: prepared.map(({ event, fields, link, canonicalPostUrl }) => ({
      id: String(event._id),
      sourceHandle:
        link.sourceHandle ??
        normalizedString(fields.sourceGroundingInstagramHandle),
      sourceIdentity: link.sourceIdentity,
      sourceOccurrenceKey: link.sourceOccurrenceKey,
      instagramPostId: event.instagramPostId ?? "",
      instagramPostUrl: canonicalPostUrl,
      title: event.title,
      date: event.date,
      time: event.time,
      timeStatus: event.timeStatus,
      timeEvidenceKind: event.timeEvidenceKind,
      timeConfidence: event.timeConfidence,
      dateEvidenceVerified: fields.dateEvidenceVerified === true,
      timeEvidenceVerified: fields.timeEvidenceVerified === true,
      venueEvidenceText: event.sourceCaption ?? "",
      eventType: canonicalizeEventType(event.eventType),
      sourceConflictFields: event.sourceConflictFields ?? [],
      artists: event.artists,
      description: event.description,
      ticketPrice: event.ticketPrice,
      imageUrl: event.imageUrl,
      imageStorageId: event.imageStorageId
        ? String(event.imageStorageId)
        : undefined,
    })),
    canonicalVenueName: targetVenue.name,
    canonicalVenueHandle: targetVenue.instagramHandle,
    sharedAnchors: args.sharedEvidenceAnchors,
  });
  if (
    !plan ||
    plan.policyVersion !== CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION ||
    plan.primaryId !== String(args.primary.id) ||
    !exactStringSetEquals(
      plan.duplicateIds,
      args.duplicates.map((item) => String(item.id)),
    )
  ) {
    throw new Error("Cross-post promotion occurrence proof failed.");
  }

  const primaryEvent = prepared[0]!.event;
  const primaryExpectedOccurrence =
    prepared[0]!.receipt.expectedOccurrences?.[0];
  if (!primaryExpectedOccurrence) {
    throw new Error("Cross-post promotion primary receipt binding is missing.");
  }
  if (
    !sourceOccurrenceRepresentativeMatchesExpected(primaryEvent, {
      key: primaryEvent.sourceOccurrenceKey!,
      date: plan.date,
      time: plan.time,
      venue: targetVenue.name,
      title: primaryEvent.title,
      artists: previousAggregateAttestation
        ? primaryExpectedOccurrence.artists
        : primaryEvent.artists,
    })
  ) {
    throw new Error(
      "Cross-post promotion primary occurrence must match its immutable snapshot.",
    );
  }
  const targetVenueFields = {
    ...CLEARED_VENUE_DENORMALIZED_FIELDS,
    ...buildNormalizedEventVenueIdentity({
      venue: targetVenue.name,
      venueInstagramHandle: targetVenue.instagramHandle,
    }),
    venueCategory: targetVenue.category,
    venueId: targetVenue._id,
    venueInstagramHandle: targetVenue.instagramHandle,
    ...(targetVenue.latitude !== undefined
      ? { venueLatitude: targetVenue.latitude }
      : {}),
    ...(targetVenue.location ? { venueLocation: targetVenue.location } : {}),
    ...(targetVenue.longitude !== undefined
      ? { venueLongitude: targetVenue.longitude }
      : {}),
  };
  const basePublicPatch = {
    venue: targetVenue.name,
    ...targetVenueFields,
    artists: plan.artists,
    ...(plan.description ? { description: plan.description } : {}),
    ...(plan.ticketPrice ? { ticketPrice: plan.ticketPrice } : {}),
    moderationNote: args.moderationNote.trim(),
  };
  if (
    legacyMigrationProof &&
    (!primaryEvent.moderationNote ||
      Object.entries(basePublicPatch).some(
        ([field, value]) =>
          field !== "moderationNote" &&
          !exactJsonValue(primaryEvent[field as keyof Doc<"events">], value),
      ))
  ) {
    throw new Error(
      "Legacy cross-post migration requires the exact existing public binding.",
    );
  }
  const prospectivePrimary = { ...primaryEvent, ...basePublicPatch };
  await assertApprovalCandidatePolicy(
    ctx,
    prospectivePrimary,
    versions.map((item) => item.id),
  );
  const now = Date.now();
  const variantReceiptTransitions = prepared.slice(1).map((item) => {
    if (legacyMigrationProof) {
      return {
        eventId: item.event._id,
        receiptId: item.receipt._id,
        updatedAt: item.receipt.updatedAt,
        expectedOccurrences: item.receipt.expectedOccurrences!,
        satisfiedOccurrences: item.receipt.satisfiedOccurrences,
        receiptAfter: item.receipt,
      };
    }
    const nextExpectedOccurrence = {
      key: item.link.sourceOccurrenceKey,
      date: primaryExpectedOccurrence.date,
      ...(primaryExpectedOccurrence.time !== undefined
        ? { time: primaryExpectedOccurrence.time }
        : {}),
      venue: primaryExpectedOccurrence.venue,
      title: primaryExpectedOccurrence.title,
      artists: [...primaryExpectedOccurrence.artists],
    };
    if (
      !sourceOccurrenceRepresentativeMatchesExpected(
        prospectivePrimary,
        nextExpectedOccurrence,
      )
    ) {
      throw new Error(
        `Cross-post promotion primary cannot satisfy variant receipt: ${item.event._id}.`,
      );
    }
    const nextSatisfiedOccurrences = [
      { key: item.link.sourceOccurrenceKey, eventId: primaryEvent._id },
    ];
    const receiptUpdatedAt = nextEventUpdatedAt(item.receipt.updatedAt, now);
    return {
      eventId: item.event._id,
      receiptId: item.receipt._id,
      updatedAt: receiptUpdatedAt,
      expectedOccurrences: [nextExpectedOccurrence],
      satisfiedOccurrences: nextSatisfiedOccurrences,
      receiptAfter: {
        ...item.receipt,
        expectedOccurrences: [nextExpectedOccurrence],
        satisfiedOccurrences: nextSatisfiedOccurrences,
        updatedAt: receiptUpdatedAt,
      },
    };
  });
  const primaryUpdatedAt = nextEventUpdatedAt(primaryEvent.updatedAt, now);
  const variantEventUpdatedAts = prepared
    .slice(1)
    .map((item) =>
      legacyMigrationProof
        ? item.event.updatedAt
        : nextEventUpdatedAt(item.event.updatedAt, now),
    );
  const aggregateAttestation: CrossPostCampaignAggregateAttestation = {
    policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
    operationId: args.operationId,
    primaryEventId: String(primaryEvent._id),
    targetVenueId: String(targetVenue._id),
    lineageDepth: previousAggregateAttestation
      ? previousAggregateAttestation.lineageDepth + 1
      : 1,
    totalSourceCount: previousAggregateAttestation
      ? previousAggregateAttestation.totalSourceCount + prepared.length - 1
      : prepared.length,
    campaignAnchors: [...plan.sharedAnchors],
    campaignPostIds: previousAggregateAttestation
      ? [
          ...previousAggregateAttestation.campaignPostIds,
          ...prepared.slice(1).map(({ event }) => event.instagramPostId!),
        ]
      : prepared.map(({ event }) => event.instagramPostId!),
    ...(automaticCampaignIdentity ? { automaticCampaignIdentity } : {}),
    ...(legacyMigrationOperationId
      ? { legacyOperationId: legacyMigrationOperationId }
      : {}),
    publicBinding: {
      title: primaryEvent.title,
      date: plan.date,
      time: plan.time,
      venue: targetVenue.name,
      artists: [...plan.artists],
    },
    sources: prepared.map((item, index) => ({
      eventId: String(item.event._id),
      eventUpdatedAt:
        index === 0 ? primaryUpdatedAt : variantEventUpdatedAts[index - 1]!,
      sourceLinkId: String(item.link._id),
      sourceLinkUpdatedAt: item.link.updatedAt,
      receiptId: String(item.receipt._id),
      receiptUpdatedAt:
        index === 0
          ? item.receipt.updatedAt
          : variantReceiptTransitions[index - 1]!.updatedAt,
      sourceIdentity: item.link.sourceIdentity,
      sourceFingerprint: item.link.sourceFingerprint,
      sourceOccurrenceKey: item.link.sourceOccurrenceKey,
      instagramPostId: item.link.instagramPostId!,
      instagramPostUrl: item.canonicalPostUrl,
      sourceHandle: normalizeHandle(
        item.link.sourceHandle ??
          normalizedString(item.fields.sourceGroundingInstagramHandle),
      ),
    })),
  };
  const primaryNormalizedFieldsJson = JSON.stringify({
    ...prepared[0]!.fields,
    [CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD]: aggregateAttestation,
  });
  const publicPatch = {
    ...basePublicPatch,
    normalizedFieldsJson: primaryNormalizedFieldsJson,
  };

  const primaryRollback = {
    policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
    operationId: args.operationId,
    sourceGroundingVerifiedAtCoalescing: true,
    eventBefore: primaryEvent,
    ...(legacyMigrationProof ? { legacyMigrationOperationId } : {}),
    sourceLinkBefore: prepared[0]!.link,
    receiptBefore: prepared[0]!.receipt,
    targetVenue,
  };
  assertCrossPostPromotionAuditPayload(primaryRollback);
  const duplicateRollbacks = prepared.slice(1).map((item, index) => {
    const rollback = {
      policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
      operationId: args.operationId,
      sourceGroundingVerifiedAtCoalescing: true,
      primaryId: primaryEvent._id,
      eventBefore:
        legacyMigrationProof?.sourceEventsBefore[index + 1] ?? item.event,
      ...(legacyMigrationProof
        ? { legacyMigrationEventBefore: item.event }
        : {}),
      sourceLinkBefore: item.link,
      receiptBefore: item.receipt,
      receiptAfter: variantReceiptTransitions[index]!.receiptAfter,
      savedEventsBefore: item.savedEvents,
      userSavedEventsBefore: item.userSavedEvents,
    };
    assertCrossPostPromotionAuditPayload(rollback);
    return rollback;
  });

  const primaryModerationNote = legacyMigrationProof
    ? primaryEvent.moderationNote!
    : buildCrossPostPromotionModerationMarker("primary", args.operationId) +
      args.moderationNote.trim();
  await ctx.db.patch(
    primaryEvent._id,
    legacyMigrationProof
      ? {
          normalizedFieldsJson: primaryNormalizedFieldsJson,
          updatedAt: primaryUpdatedAt,
        }
      : {
          ...publicPatch,
          reviewedAt: now,
          reviewedBy: authorization.actor,
          moderationNote: primaryModerationNote,
          updatedAt: primaryUpdatedAt,
        },
  );

  let movedSaveCount = 0;
  let dedupedSaveCount = 0;
  let topologyMutated = !legacyMigrationProof;
  const variantRows = prepared.slice(1);
  const variantUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }> = [];
  const variantReceiptUpdatedAts = variantReceiptTransitions.map(
    ({ eventId, receiptId, updatedAt }) => ({ eventId, receiptId, updatedAt }),
  );
  const variantModerationNote = legacyMigrationProof
    ? (variantRows[0]?.event.moderationNote ?? "")
    : buildCrossPostPromotionModerationMarker("variant", args.operationId) +
      args.moderationNote.trim();
  for (let index = 0; index < variantRows.length; index += 1) {
    const item = variantRows[index]!;
    const receiptTransition = variantReceiptTransitions[index]!;
    const variantUpdatedAt = variantEventUpdatedAts[index]!;
    if (!legacyMigrationProof) {
      const saveResult = await reassignSavedEventReferences(
        ctx,
        item.event._id,
        primaryEvent._id,
      );
      movedSaveCount += saveResult.movedCount;
      dedupedSaveCount += saveResult.dedupedCount;
      await ctx.db.patch(item.event._id, {
        status: "rejected",
        reviewedAt: now,
        reviewedBy: authorization.actor,
        moderationNote: variantModerationNote,
        updatedAt: variantUpdatedAt,
      });
      await ctx.db.patch(item.receipt._id, {
        expectedOccurrences: receiptTransition.expectedOccurrences,
        satisfiedOccurrences: receiptTransition.satisfiedOccurrences,
        updatedAt: receiptTransition.updatedAt,
      });
    }
    // Campaign variants intentionally remain represented by the audited
    // legacy aggregate until a dedicated atomic re-attestation migration can
    // rewrite its byte-for-byte source-link snapshots. Never leave a newer
    // first-class occurrence attached to the rejected variant meanwhile.
    const detachedOccurrenceCount =
      await sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(
        ctx,
        item.event._id,
        { topologyEpochVerified: false },
      );
    topologyMutated ||= detachedOccurrenceCount > 0;
    variantUpdatedAts.push({ id: item.event._id, updatedAt: variantUpdatedAt });
    await writeEventAuditLog(
      ctx,
      item.event._id,
      legacyMigrationProof
        ? "cross_post_campaign_attestation_migrated"
        : "cross_post_campaign_variant_rejected",
      {
        actor: authorization.actor,
        note: args.moderationNote.trim(),
        patch: {
          ...duplicateRollbacks[index],
          ...(legacyMigrationProof ? { aggregateAttestation } : {}),
          marker: "cross_post_campaign_variant",
          variantUpdatedAt,
        },
      },
    );
  }
  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  }
  await writeEventAuditLog(
    ctx,
    primaryEvent._id,
    legacyMigrationProof
      ? "cross_post_campaign_attestation_migrated"
      : "cross_post_campaign_coalesced",
    {
      actor: authorization.actor,
      note: args.moderationNote.trim(),
      patch: {
        ...primaryRollback,
        foldedVariantIds: variantRows.map((item) => item.event._id),
        sharedEvidenceAnchors: plan.sharedAnchors,
        canonicalVenueName: plan.canonicalVenueName,
        canonicalVenueHandle: plan.canonicalVenueHandle,
        aggregateAttestation,
        variantUpdatedAts,
        variantReceiptUpdatedAts,
        movedSaveCount,
        dedupedSaveCount,
      },
    },
  );
  await refreshCanonicalEventDerivedStates(ctx, [
    primaryEvent._id,
    ...variantRows.map((item) => item.event._id),
  ]);
  const finalizedPrimary = await ctx.db.get(primaryEvent._id);
  if (
    !finalizedPrimary ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, finalizedPrimary))
  ) {
    throw new Error(
      "Cross-post promotion aggregate failed its final public grounding proof.",
    );
  }

  return {
    operationId: args.operationId,
    primaryId: primaryEvent._id,
    primaryUpdatedAt,
    foldedVariantIds: variantRows.map((item) => item.event._id),
    variantUpdatedAts,
    variantReceiptUpdatedAts,
    movedSaveCount,
    dedupedSaveCount,
  };
}
