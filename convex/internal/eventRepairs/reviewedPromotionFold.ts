import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { isSensibleEventTitleForApproval } from "../../../lib/events/event-title-approval";
import { normalizeEventTimeWritePatch } from "../../../lib/events/event-time-write";
import {
  hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import {
  SavedEventRepositoryConflict,
  savedEventRepository,
} from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import type { VenueDenormalizedFields } from "../../venueResolver";
import { assertCrossPostPromotionAuditPayload } from "../../eventDomain/crossPostPromotion";
import {
  resolveVenueDenormalizedFields,
  resolveVenueDenormalizedFieldsFromPublicVenues,
} from "../../eventDomain/moderationVenue";
import {
  prepareInstagramOccurrenceTopologyForDedicatedReattestation,
  reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { loadReviewedStructuredCorrectionContext } from "./reviewedStructuredCorrections";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
  normalizeLookup,
  normalizeSourceCaption,
} from "../../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";

const MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT = 100;

export async function foldReviewedStructuredPromotionVariantHandler(
  ctx: MutationCtx,
  args: {
    operationId: string;
    primaryId: Id<"events">;
    expectedPrimaryUpdatedAt: number;
    expectedPrimaryNormalizedFieldsJson: string;
    expectedPrimarySourceLinkId: Id<"instagramEventSources">;
    expectedPrimarySourceLinkUpdatedAt: number;
    expectedPrimaryReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedPrimaryReceiptUpdatedAt: number;
    variantId: Id<"events">;
    expectedVariantUpdatedAt: number;
    expectedVariantNormalizedFieldsJson: string;
    expectedVariantSourceLinkId: Id<"instagramEventSources">;
    expectedVariantSourceLinkUpdatedAt: number;
    expectedVariantReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedVariantReceiptUpdatedAt: number;
    expectedSourceHandle: string;
    campaignAnchors: string[];
    primaryDuplicateEvidence: string[];
    variantDuplicateEvidence: string[];
    nextTitle: string;
    nextTime: string;
    nextVenue: string;
    targetVenueId?: Id<"venues">;
    expectedTargetVenueUpdatedAt?: number;
    expectedTargetVenueHandle?: string;
    nextArtists: string[];
    nextDescription: string;
    posterVenueEvidence: string;
    posterTimeEvidence: string;
    posterArtistEvidence: string[];
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
      "Reviewed promotion folding requires service authentication.",
    );
  }
  const operationId = args.operationId.trim();
  const moderationNote = args.moderationNote
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const expectedSourceHandle = normalizeHandle(args.expectedSourceHandle);
  const campaignAnchors = args.campaignAnchors.map((anchor) =>
    anchor.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  const primaryDuplicateEvidence = args.primaryDuplicateEvidence.map((value) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  const variantDuplicateEvidence = args.variantDuplicateEvidence.map((value) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(operationId) ||
    moderationNote.length < 24 ||
    !expectedSourceHandle ||
    campaignAnchors.length < 1 ||
    campaignAnchors.length > 6 ||
    campaignAnchors.some((anchor) => !anchor) ||
    new Set(campaignAnchors.map(normalizeLookup)).size !==
      campaignAnchors.length ||
    primaryDuplicateEvidence.length < 1 ||
    primaryDuplicateEvidence.length > 4 ||
    primaryDuplicateEvidence.some((value) => !value) ||
    new Set(primaryDuplicateEvidence.map(normalizeLookup)).size !==
      primaryDuplicateEvidence.length ||
    variantDuplicateEvidence.length < 1 ||
    variantDuplicateEvidence.length > 4 ||
    variantDuplicateEvidence.some((value) => !value) ||
    new Set(variantDuplicateEvidence.map(normalizeLookup)).size !==
      variantDuplicateEvidence.length ||
    args.primaryId === args.variantId ||
    args.expectedPrimarySourceLinkId === args.expectedVariantSourceLinkId ||
    args.expectedPrimaryReceiptId === args.expectedVariantReceiptId
  ) {
    throw new Error("Reviewed promotion folding arguments are invalid.");
  }
  for (const value of [
    args.expectedPrimaryUpdatedAt,
    args.expectedPrimarySourceLinkUpdatedAt,
    args.expectedPrimaryReceiptUpdatedAt,
    args.expectedVariantUpdatedAt,
    args.expectedVariantSourceLinkUpdatedAt,
    args.expectedVariantReceiptUpdatedAt,
    ...(args.expectedTargetVenueUpdatedAt !== undefined
      ? [args.expectedTargetVenueUpdatedAt]
      : []),
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "Reviewed promotion folding requires safe optimistic revisions.",
      );
    }
  }

  const primary = await ctx.db.get(args.primaryId);
  const variant = await ctx.db.get(args.variantId);
  if (
    !primary ||
    !variant ||
    primary.status !== "approved" ||
    variant.status !== "approved" ||
    primary.updatedAt !== args.expectedPrimaryUpdatedAt ||
    variant.updatedAt !== args.expectedVariantUpdatedAt ||
    primary.normalizedFieldsJson !== args.expectedPrimaryNormalizedFieldsJson ||
    variant.normalizedFieldsJson !== args.expectedVariantNormalizedFieldsJson ||
    primary.date !== variant.date ||
    primary.eventType !== variant.eventType ||
    isCrossPostCampaignLineageEvent(primary) ||
    isCrossPostCampaignLineageEvent(variant)
  ) {
    throw new Error("Reviewed promotion folding event precondition failed.");
  }
  if (
    !(await isCanonicallyGroundedApprovedEvent(ctx, primary)) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, variant))
  ) {
    throw new Error(
      "Reviewed promotion folding requires two grounded approved events.",
    );
  }

  const primaryContext = await loadReviewedStructuredCorrectionContext(
    ctx,
    primary,
    {
      expectedSourceLinkId: args.expectedPrimarySourceLinkId,
      expectedSourceLinkUpdatedAt: args.expectedPrimarySourceLinkUpdatedAt,
      expectedReceiptId: args.expectedPrimaryReceiptId,
      expectedReceiptUpdatedAt: args.expectedPrimaryReceiptUpdatedAt,
    },
  );
  const variantContext = await loadReviewedStructuredCorrectionContext(
    ctx,
    variant,
    {
      expectedSourceLinkId: args.expectedVariantSourceLinkId,
      expectedSourceLinkUpdatedAt: args.expectedVariantSourceLinkUpdatedAt,
      expectedReceiptId: args.expectedVariantReceiptId,
      expectedReceiptUpdatedAt: args.expectedVariantReceiptUpdatedAt,
    },
  );
  const primarySourceHandle = normalizeHandle(
    String(primaryContext.currentFields.sourceGroundingInstagramHandle ?? ""),
  );
  const variantSourceHandle = normalizeHandle(
    String(variantContext.currentFields.sourceGroundingInstagramHandle ?? ""),
  );
  const primaryCaption = normalizeSourceCaption(primary.sourceCaption);
  const variantCaption = normalizeSourceCaption(variant.sourceCaption);
  const normalizedPrimaryCaption = normalizeLookup(primaryCaption);
  const normalizedVariantCaption = normalizeLookup(variantCaption);
  const normalizedCampaignAnchors = campaignAnchors.map(normalizeLookup);
  const primaryPostUrl = requireCanonicalInstagramPostUrl(
    primary.instagramPostUrl,
    "Reviewed promotion fold primary source",
  );
  const variantPostUrl = requireCanonicalInstagramPostUrl(
    variant.instagramPostUrl,
    "Reviewed promotion fold variant source",
  );
  if (
    primarySourceHandle !== expectedSourceHandle ||
    variantSourceHandle !== expectedSourceHandle ||
    primary.instagramPostId === variant.instagramPostId ||
    primaryPostUrl === variantPostUrl ||
    primaryContext.receipt.expectedKeys.length !== 1 ||
    primaryContext.receipt.satisfiedKeys.length !== 1 ||
    primaryContext.receipt.deferredChildCount !== 0 ||
    primaryContext.receipt.deferredChildKeys.length !== 0 ||
    variantContext.receipt.expectedKeys.length !== 1 ||
    variantContext.receipt.satisfiedKeys.length !== 1 ||
    variantContext.receipt.deferredChildCount !== 0 ||
    variantContext.receipt.deferredChildKeys.length !== 0 ||
    ![undefined, "", "TBD"].includes(variant.time) ||
    !["not_stated", "unreadable", "doors_open_only"].includes(
      String(variantContext.currentFields.timeEvidenceKind ?? ""),
    ) ||
    normalizedCampaignAnchors.some(
      (anchor) =>
        !normalizedPrimaryCaption.includes(anchor) ||
        !normalizedVariantCaption.includes(anchor),
    ) ||
    primaryDuplicateEvidence.some(
      (value) => !normalizedPrimaryCaption.includes(normalizeLookup(value)),
    ) ||
    variantDuplicateEvidence.some(
      (value) => !normalizedVariantCaption.includes(normalizeLookup(value)),
    )
  ) {
    throw new Error("Reviewed promotion folding source/campaign proof failed.");
  }

  const nextTitle = args.nextTitle
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextVenue = args.nextVenue
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextTime = args.nextTime.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const nextArtists = args.nextArtists.map((artist) =>
    artist.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  const posterVenueEvidence = args.posterVenueEvidence.normalize("NFKC").trim();
  const posterTimeEvidence = args.posterTimeEvidence.normalize("NFKC").trim();
  const posterArtistEvidence = args.posterArtistEvidence.map((value) =>
    value.normalize("NFKC").trim(),
  );
  if (
    !nextTitle ||
    !nextVenue ||
    !nextTime ||
    nextArtists.length < 1 ||
    nextArtists.some((artist) => !artist) ||
    new Set(nextArtists).size !== nextArtists.length ||
    nextTitle !== args.nextTitle ||
    nextVenue !== args.nextVenue ||
    nextTime !== args.nextTime ||
    nextArtists.some((artist, index) => artist !== args.nextArtists[index]) ||
    !posterVenueEvidence ||
    !posterTimeEvidence ||
    posterArtistEvidence.length < 1 ||
    posterArtistEvidence.some((value) => !value)
  ) {
    throw new Error("Reviewed promotion folding public evidence is invalid.");
  }
  let venueFields: VenueDenormalizedFields;
  if (args.targetVenueId) {
    const targetVenue = await ctx.db.get(args.targetVenueId);
    if (
      !targetVenue ||
      targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
      normalizeHandle(targetVenue.instagramHandle) !==
        normalizeHandle(args.expectedTargetVenueHandle ?? "") ||
      !isVenuePublic(targetVenue) ||
      targetVenue.name !== nextVenue
    ) {
      throw new Error(
        "Reviewed promotion fold target venue is not exact and public.",
      );
    }
    venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
      [targetVenue],
      nextVenue,
    );
    if (venueFields.venueId !== targetVenue._id) {
      throw new Error(
        "Reviewed promotion fold target venue did not resolve exactly.",
      );
    }
  } else {
    if (
      args.expectedTargetVenueUpdatedAt !== undefined ||
      args.expectedTargetVenueHandle !== undefined
    ) {
      throw new Error(
        "Noncanonical promotion fold cannot carry target venue revisions.",
      );
    }
    venueFields = await resolveVenueDenormalizedFields(ctx, nextVenue);
    if (venueFields.venueId !== undefined) {
      throw new Error(
        "A known public promotion venue must bind its exact venueId.",
      );
    }
  }
  const timePatch = normalizeEventTimeWritePatch({
    time: nextTime,
    timeSource: "poster",
    timeEvidenceText: posterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
  });
  const currentPendingReasons = Array.isArray(
    primaryContext.currentFields.moderationPendingReasons,
  )
    ? primaryContext.currentFields.moderationPendingReasons.map(String)
    : [];
  const currentSignals = Array.isArray(
    primaryContext.currentFields.moderationSignals,
  )
    ? primaryContext.currentFields.moderationSignals.map(String)
    : [];
  const reviewedAt = Date.now();
  const nextFields = {
    ...primaryContext.currentFields,
    title: nextTitle,
    time: nextTime,
    normalizedVenue: nextVenue,
    artists: nextArtists,
    description: args.nextDescription,
    timeSource: "poster",
    timeEvidenceText: posterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: [
      ...new Set([...currentPendingReasons, "requires_human_approval"]),
    ],
    moderationSignals: [
      ...new Set([
        ...currentSignals.filter((signal) => signal !== "time_tbd"),
        "requires_human_approval",
      ]),
    ],
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedPosterCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: authorization.actor,
      venueEvidence: posterVenueEvidence,
      timeEvidence: posterTimeEvidence,
      artistEvidence: posterArtistEvidence,
    },
    reviewedPromotionVariantFold: {
      policyVersion: 1,
      operationId,
      primaryEventId: primary._id,
      variantEventId: variant._id,
      sourceHandle: expectedSourceHandle,
      campaignAnchors,
      primaryDuplicateEvidence,
      variantDuplicateEvidence,
      targetVenueId: venueFields.venueId ?? null,
      variantSourceIdentity: variantContext.sourceLink.sourceIdentity,
      variantSourceOccurrenceKey: variantContext.sourceLink.sourceOccurrenceKey,
    },
  };
  const nextNormalizedFieldsJson = JSON.stringify(nextFields);
  const effectivePrimary: Doc<"events"> = {
    ...primary,
    ...timePatch,
    ...venueFields,
    title: nextTitle,
    venue: nextVenue,
    artists: nextArtists,
    description: args.nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
  };
  if (
    !isSensibleEventTitleForApproval(effectivePrimary) ||
    !hasHumanReviewableStructuredSourceAttestation(
      nextNormalizedFieldsJson,
      effectivePrimary,
    )
  ) {
    throw new Error(
      "Reviewed promotion folding did not bind the corrected event.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, [
    primary._id,
    variant._id,
  ]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) {
    throw new Error(
      "Reviewed promotion fold would not remain publicly grounded.",
    );
  }

  const bindingForKey = (key: string) => ({
    key,
    date: effectivePrimary.date,
    time: effectivePrimary.time,
    venue: effectivePrimary.venue,
    title: effectivePrimary.title,
    artists: effectivePrimary.artists,
  });
  const primaryExpected = bindingForKey(
    primaryContext.sourceLink.sourceOccurrenceKey,
  );
  const variantExpected = bindingForKey(
    variantContext.sourceLink.sourceOccurrenceKey,
  );
  if (
    !sourceOccurrenceRepresentativeMatchesExpected(
      effectivePrimary,
      primaryExpected,
    ) ||
    !sourceOccurrenceRepresentativeMatchesExpected(
      effectivePrimary,
      variantExpected,
    )
  ) {
    throw new Error(
      "Reviewed promotion fold would not satisfy both source receipts.",
    );
  }

  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, reviewedAt);
  const variantUpdatedAt = nextEventUpdatedAt(variant.updatedAt, reviewedAt);
  const primaryReceiptUpdatedAt = nextEventUpdatedAt(
    primaryContext.receipt.updatedAt,
    reviewedAt,
  );
  const variantReceiptUpdatedAt = nextEventUpdatedAt(
    variantContext.receipt.updatedAt,
    reviewedAt,
  );
  try {
    await savedEventRepository.loadEventReferences(ctx, variant._id, {
      limit: MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT,
    });
  } catch (error) {
    if (error instanceof SavedEventRepositoryConflict) {
      throw new Error(
        "Reviewed promotion folding save cohort exceeds the safe bound.",
      );
    }
    throw error;
  }
  const variantSourceTopology =
    await prepareInstagramOccurrenceTopologyForDedicatedReattestation(
      ctx,
      variant._id,
    );
  const saveResult = await reassignSavedEventReferences(
    ctx,
    variant._id,
    primary._id,
  );
  await ctx.db.patch(primary._id, {
    ...timePatch,
    ...venueFields,
    title: nextTitle,
    venue: nextVenue,
    artists: nextArtists,
    description: args.nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
    updatedAt: primaryUpdatedAt,
  });
  await ctx.db.patch(primaryContext.receipt._id, {
    expectedOccurrences: [primaryExpected],
    satisfiedOccurrences: [{ key: primaryExpected.key, eventId: primary._id }],
    updatedAt: primaryReceiptUpdatedAt,
  });
  const variantModerationNote = `[reviewed_promotion_variant:v1] ${operationId} - ${moderationNote}`;
  await ctx.db.patch(variant._id, {
    status: "rejected",
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote: variantModerationNote,
    updatedAt: variantUpdatedAt,
  });
  await ctx.db.patch(variantContext.receipt._id, {
    expectedOccurrences: [variantExpected],
    satisfiedOccurrences: [{ key: variantExpected.key, eventId: primary._id }],
    updatedAt: variantReceiptUpdatedAt,
  });
  await reassignInstagramOccurrenceReferences(
    ctx,
    variant._id,
    primary._id,
    variantSourceTopology,
    { preserveLegacyLinks: true },
  );
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: primaryExpected,
      representative: effectivePrimary,
      sourceFingerprint: primaryContext.receipt.sourceFingerprint,
      sourceLink: primaryContext.sourceLink,
      topologyEpochVerified: false,
    },
  );
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: variantExpected,
      representative: effectivePrimary,
      sourceFingerprint: variantContext.receipt.sourceFingerprint,
      sourceLink: variantContext.sourceLink,
      topologyEpochVerified: false,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  await refreshCanonicalEventDerivedStates(ctx, [primary._id, variant._id]);
  const variantAuditPatch = {
    operationId,
    policyVersion: 1,
    eventBefore: variant,
    sourceLinkBefore: variantContext.sourceLink,
    receiptBefore: variantContext.receipt,
    receiptAfter: {
      ...variantContext.receipt,
      expectedOccurrences: [variantExpected],
      satisfiedOccurrences: [
        { key: variantExpected.key, eventId: primary._id },
      ],
      updatedAt: variantReceiptUpdatedAt,
    },
    primaryId: primary._id,
    variantUpdatedAt,
  };
  const primaryAuditPatch = {
    operationId,
    policyVersion: 1,
    eventBefore: primary,
    eventAfter: {
      title: effectivePrimary.title,
      date: effectivePrimary.date,
      time: effectivePrimary.time,
      venue: effectivePrimary.venue,
      artists: effectivePrimary.artists,
      description: effectivePrimary.description,
      updatedAt: primaryUpdatedAt,
    },
    sourceLinkBefore: primaryContext.sourceLink,
    receiptBefore: primaryContext.receipt,
    primaryReceiptUpdatedAt,
    variantId: variant._id,
    variantReceiptUpdatedAt,
    campaignAnchors,
    primaryDuplicateEvidence,
    variantDuplicateEvidence,
    targetVenueId: venueFields.venueId,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
  assertCrossPostPromotionAuditPayload(variantAuditPatch);
  assertCrossPostPromotionAuditPayload(primaryAuditPatch);
  await writeEventAuditLog(
    ctx,
    variant._id,
    "reviewed_promotion_variant_rejected",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: variantAuditPatch,
    },
  );
  await writeEventAuditLog(
    ctx,
    primary._id,
    "reviewed_promotion_variant_folded",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: primaryAuditPatch,
    },
  );
  const finalizedPrimary = await ctx.db.get(primary._id);
  if (
    !finalizedPrimary ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, finalizedPrimary))
  ) {
    throw new Error(
      "Reviewed promotion fold failed its final grounding proof.",
    );
  }
  return {
    operationId,
    primaryId: primary._id,
    primaryUpdatedAt,
    primaryReceiptUpdatedAt,
    variantId: variant._id,
    variantUpdatedAt,
    variantReceiptUpdatedAt,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
}
