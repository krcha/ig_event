import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
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
import { assertCrossPostPromotionAuditPayload } from "../../eventDomain/crossPostPromotion";
import { resolveVenueDenormalizedFieldsFromPublicVenues } from "../../eventDomain/moderationVenue";
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
} from "../../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";

const MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT = 100;

function exactStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function foldReviewedStructuredSameSourceContinuationHandler(
  ctx: MutationCtx,
  args: {
    operationId: string;
    primaryId: Id<"events">;
    expectedPrimaryUpdatedAt: number;
    expectedPrimaryNormalizedFieldsJson: string;
    expectedPrimarySourceLinkId: Id<"instagramEventSources">;
    expectedPrimarySourceLinkUpdatedAt: number;
    continuationId: Id<"events">;
    expectedContinuationUpdatedAt: number;
    expectedContinuationNormalizedFieldsJson: string;
    expectedContinuationSourceLinkId: Id<"instagramEventSources">;
    expectedContinuationSourceLinkUpdatedAt: number;
    independentId: Id<"events">;
    expectedIndependentUpdatedAt: number;
    expectedIndependentNormalizedFieldsJson: string;
    expectedIndependentSourceLinkId: Id<"instagramEventSources">;
    expectedIndependentSourceLinkUpdatedAt: number;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceHandle: string;
    expectedSourceIdentity: string;
    expectedSourceFingerprint: string;
    primaryScheduleSourceText: string;
    continuationScheduleSourceText: string;
    nextIndependentTime: string;
    independentPosterVenueEvidence: string;
    independentPosterTimeEvidence: string;
    independentPosterArtistEvidence: string[];
    nextVenue: string;
    targetVenueId: Id<"venues">;
    expectedTargetVenueUpdatedAt: number;
    expectedTargetVenueHandle: string;
    nextArtists: string[];
    nextDescription: string;
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
      "Reviewed continuation folding requires service authentication.",
    );
  }
  const operationId = args.operationId.trim();
  const moderationNote = args.moderationNote
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const expectedSourceHandle = normalizeHandle(args.expectedSourceHandle);
  const expectedSourceIdentity = args.expectedSourceIdentity.trim();
  const expectedSourceFingerprint = args.expectedSourceFingerprint.trim();
  const primaryScheduleSourceText = args.primaryScheduleSourceText
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const continuationScheduleSourceText = args.continuationScheduleSourceText
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextIndependentTime = args.nextIndependentTime
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const independentPosterVenueEvidence = args.independentPosterVenueEvidence
    .normalize("NFKC")
    .trim();
  const independentPosterTimeEvidence = args.independentPosterTimeEvidence
    .normalize("NFKC")
    .trim();
  const independentPosterArtistEvidence =
    args.independentPosterArtistEvidence.map((value) =>
      value.normalize("NFKC").trim(),
    );
  const nextVenue = args.nextVenue
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextArtists = args.nextArtists.map((artist) =>
    artist.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  const nextDescription = args.nextDescription
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const ids = [args.primaryId, args.continuationId, args.independentId];
  const sourceLinkIds = [
    args.expectedPrimarySourceLinkId,
    args.expectedContinuationSourceLinkId,
    args.expectedIndependentSourceLinkId,
  ];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(operationId) ||
    moderationNote.length < 24 ||
    !expectedSourceHandle ||
    !expectedSourceIdentity ||
    !expectedSourceFingerprint ||
    !primaryScheduleSourceText ||
    !continuationScheduleSourceText ||
    primaryScheduleSourceText === continuationScheduleSourceText ||
    !nextIndependentTime ||
    !independentPosterVenueEvidence ||
    !independentPosterTimeEvidence ||
    independentPosterArtistEvidence.length < 1 ||
    independentPosterArtistEvidence.some((value) => !value) ||
    !nextVenue ||
    !nextDescription ||
    nextArtists.length < 2 ||
    nextArtists.some((artist) => !artist) ||
    new Set(nextArtists.map(normalizeLookup)).size !== nextArtists.length ||
    new Set(ids.map(String)).size !== ids.length ||
    new Set(sourceLinkIds.map(String)).size !== sourceLinkIds.length
  ) {
    throw new Error("Reviewed continuation folding arguments are invalid.");
  }
  for (const value of [
    args.expectedPrimaryUpdatedAt,
    args.expectedPrimarySourceLinkUpdatedAt,
    args.expectedContinuationUpdatedAt,
    args.expectedContinuationSourceLinkUpdatedAt,
    args.expectedIndependentUpdatedAt,
    args.expectedIndependentSourceLinkUpdatedAt,
    args.expectedReceiptUpdatedAt,
    args.expectedTargetVenueUpdatedAt,
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "Reviewed continuation folding requires safe optimistic revisions.",
      );
    }
  }

  const [primary, continuation, independent] = await Promise.all(
    ids.map((id) => ctx.db.get(id)),
  );
  if (
    !primary ||
    !continuation ||
    !independent ||
    primary.status !== "approved" ||
    continuation.status !== "approved" ||
    independent.status !== "approved" ||
    primary.updatedAt !== args.expectedPrimaryUpdatedAt ||
    continuation.updatedAt !== args.expectedContinuationUpdatedAt ||
    independent.updatedAt !== args.expectedIndependentUpdatedAt ||
    primary.normalizedFieldsJson !== args.expectedPrimaryNormalizedFieldsJson ||
    continuation.normalizedFieldsJson !==
      args.expectedContinuationNormalizedFieldsJson ||
    independent.normalizedFieldsJson !==
      args.expectedIndependentNormalizedFieldsJson ||
    primary.date !== continuation.date ||
    independent.date === primary.date ||
    primary.eventType !== continuation.eventType ||
    primary.eventType !== independent.eventType ||
    [primary, continuation, independent].some(isCrossPostCampaignLineageEvent)
  ) {
    throw new Error("Reviewed continuation folding event precondition failed.");
  }
  const publiclyGrounded = await Promise.all(
    [primary, continuation, independent].map((event) =>
      isCanonicallyGroundedApprovedEvent(ctx, event),
    ),
  );
  if (!publiclyGrounded.every(Boolean)) {
    throw new Error(
      "Reviewed continuation folding requires grounded approved events.",
    );
  }

  const sharedReceiptArgs = {
    expectedReceiptId: args.expectedReceiptId,
    expectedReceiptUpdatedAt: args.expectedReceiptUpdatedAt,
  };
  const [primaryContext, continuationContext, independentContext] =
    await Promise.all([
      loadReviewedStructuredCorrectionContext(ctx, primary, {
        expectedSourceLinkId: args.expectedPrimarySourceLinkId,
        expectedSourceLinkUpdatedAt: args.expectedPrimarySourceLinkUpdatedAt,
        ...sharedReceiptArgs,
      }),
      loadReviewedStructuredCorrectionContext(ctx, continuation, {
        expectedSourceLinkId: args.expectedContinuationSourceLinkId,
        expectedSourceLinkUpdatedAt:
          args.expectedContinuationSourceLinkUpdatedAt,
        ...sharedReceiptArgs,
      }),
      loadReviewedStructuredCorrectionContext(ctx, independent, {
        expectedSourceLinkId: args.expectedIndependentSourceLinkId,
        expectedSourceLinkUpdatedAt:
          args.expectedIndependentSourceLinkUpdatedAt,
        ...sharedReceiptArgs,
      }),
    ]);
  const contexts = [primaryContext, continuationContext, independentContext];
  const receipt = primaryContext.receipt;
  const sourceLinks = contexts.map((item) => item.sourceLink);
  const occurrenceKeys = sourceLinks.map((item) => item.sourceOccurrenceKey);
  const normalizedSourceHandles = contexts.map((item) =>
    normalizeHandle(
      String(item.currentFields.sourceGroundingInstagramHandle ?? ""),
    ),
  );
  const exactPostUrl = requireCanonicalInstagramPostUrl(
    primary.instagramPostUrl,
    "Reviewed continuation fold primary source",
  );
  const continuationPostUrl = requireCanonicalInstagramPostUrl(
    continuation.instagramPostUrl,
    "Reviewed continuation fold continuation source",
  );
  const independentPostUrl = requireCanonicalInstagramPostUrl(
    independent.instagramPostUrl,
    "Reviewed continuation fold independent source",
  );
  if (
    contexts.some((item) => item.receipt._id !== receipt._id) ||
    receipt.sourceIdentity !== expectedSourceIdentity ||
    receipt.sourceFingerprint !== expectedSourceFingerprint ||
    sourceLinks.some(
      (link) =>
        link.sourceIdentity !== expectedSourceIdentity ||
        link.sourceFingerprint !== expectedSourceFingerprint,
    ) ||
    normalizedSourceHandles.some((handle) => handle !== expectedSourceHandle) ||
    !primary.instagramPostId ||
    continuation.instagramPostId !== primary.instagramPostId ||
    independent.instagramPostId !== primary.instagramPostId ||
    continuationPostUrl !== exactPostUrl ||
    independentPostUrl !== exactPostUrl ||
    continuation.sourceCaption !== primary.sourceCaption ||
    independent.sourceCaption !== primary.sourceCaption ||
    continuation.sourcePostedAt !== primary.sourcePostedAt ||
    independent.sourcePostedAt !== primary.sourcePostedAt ||
    continuation.rawExtractionJson !== primary.rawExtractionJson ||
    independent.rawExtractionJson !== primary.rawExtractionJson ||
    receipt.expectedKeys.length !== 3 ||
    receipt.expectedOccurrences.length !== 3 ||
    receipt.satisfiedKeys.length !== 3 ||
    receipt.satisfiedOccurrences.length !== 3 ||
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    new Set(occurrenceKeys).size !== 3 ||
    !exactStringArray(
      [...receipt.expectedKeys].sort(),
      [...occurrenceKeys].sort(),
    ) ||
    !exactStringArray(
      [...receipt.satisfiedKeys].sort(),
      [...occurrenceKeys].sort(),
    )
  ) {
    throw new Error(
      "Reviewed continuation folding source topology is not exact.",
    );
  }

  const primaryFields = primaryContext.currentFields;
  const continuationFields = continuationContext.currentFields;
  if (
    primary.time !== "20:00" ||
    primaryFields.timeStatus !== "confirmed" ||
    primaryFields.timeEvidenceKind !== "start_time_stated" ||
    ![undefined, "", "TBD"].includes(continuation.time) ||
    !["unreadable", "not_stated"].includes(
      String(continuationFields.timeEvidenceKind ?? ""),
    )
  ) {
    throw new Error(
      "Reviewed continuation folding time evidence is not exact.",
    );
  }
  const scheduleEntries = primaryContext.rawExtraction.schedule_entries;
  if (!Array.isArray(scheduleEntries) || scheduleEntries.length !== 3) {
    throw new Error(
      "Reviewed continuation folding requires the exact three-row schedule.",
    );
  }
  const findScheduleEntry = (sourceText: string) =>
    scheduleEntries.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
      const raw = entry as Record<string, unknown>;
      return (
        typeof raw.source_text === "string" &&
        raw.source_text.normalize("NFKC").replace(/\s+/gu, " ").trim() ===
          sourceText
      );
    });
  const primaryScheduleEntries = findScheduleEntry(primaryScheduleSourceText);
  const continuationScheduleEntries = findScheduleEntry(
    continuationScheduleSourceText,
  );
  const primarySchedule = primaryScheduleEntries[0] as
    | Record<string, unknown>
    | undefined;
  const continuationSchedule = continuationScheduleEntries[0] as
    | Record<string, unknown>
    | undefined;
  const primaryScheduleArtists = Array.isArray(primarySchedule?.artists)
    ? primarySchedule.artists
    : [];
  const continuationScheduleArtists = Array.isArray(
    continuationSchedule?.artists,
  )
    ? continuationSchedule.artists
    : [];
  if (
    primaryScheduleEntries.length !== 1 ||
    continuationScheduleEntries.length !== 1 ||
    primarySchedule?.time !== "20:00" ||
    continuationSchedule?.time !== "" ||
    !exactStringArray(primaryScheduleArtists as string[], primary.artists) ||
    !exactStringArray(
      continuationScheduleArtists as string[],
      continuation.artists,
    ) ||
    !normalizeLookup(continuationScheduleSourceText).includes("after midnight")
  ) {
    throw new Error(
      "Reviewed continuation folding schedule evidence is not exact.",
    );
  }
  const stableArtistUnion: string[] = [];
  const seenArtistKeys = new Set<string>();
  for (const artist of [...primary.artists, ...continuation.artists]) {
    const key = normalizeLookup(artist);
    if (!key || seenArtistKeys.has(key)) continue;
    seenArtistKeys.add(key);
    stableArtistUnion.push(artist);
  }
  const deterministicDescription = [
    primary.description,
    continuation.description,
  ]
    .map((value) => value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (
    !exactStringArray(nextArtists, stableArtistUnion) ||
    nextDescription !== deterministicDescription
  ) {
    throw new Error(
      "Reviewed continuation folding final lineup is not deterministic.",
    );
  }

  const targetVenue = await ctx.db.get(args.targetVenueId);
  if (
    !targetVenue ||
    targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
    normalizeHandle(targetVenue.instagramHandle) !==
      normalizeHandle(args.expectedTargetVenueHandle) ||
    !isVenuePublic(targetVenue) ||
    targetVenue.name !== nextVenue
  ) {
    throw new Error(
      "Reviewed continuation fold target venue is not exact and public.",
    );
  }
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
    [targetVenue],
    nextVenue,
  );
  if (venueFields.venueId !== targetVenue._id) {
    throw new Error(
      "Reviewed continuation fold target venue did not resolve exactly.",
    );
  }

  const reviewedAt = Date.now();
  const independentTimePatch = normalizeEventTimeWritePatch({
    time: nextIndependentTime,
    timeSource: "poster",
    timeEvidenceText: independentPosterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
  });
  const foldLineage = {
    policyVersion: 1,
    operationId,
    primaryEventId: primary._id,
    continuationEventId: continuation._id,
    independentEventId: independent._id,
    sourceHandle: expectedSourceHandle,
    sourceIdentity: expectedSourceIdentity,
    sourceFingerprint: expectedSourceFingerprint,
    primarySourceOccurrenceKey: primaryContext.sourceLink.sourceOccurrenceKey,
    continuationSourceOccurrenceKey:
      continuationContext.sourceLink.sourceOccurrenceKey,
    independentSourceOccurrenceKey:
      independentContext.sourceLink.sourceOccurrenceKey,
    primaryScheduleSourceText,
    continuationScheduleSourceText,
    targetVenueId: targetVenue._id,
  };
  const currentPendingReasons = Array.isArray(
    primaryFields.moderationPendingReasons,
  )
    ? primaryFields.moderationPendingReasons.map(String)
    : [];
  const currentSignals = Array.isArray(primaryFields.moderationSignals)
    ? primaryFields.moderationSignals.map(String)
    : [];
  const nextFields = {
    ...primaryFields,
    normalizedVenue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: [
      ...new Set([...currentPendingReasons, "requires_human_approval"]),
    ],
    moderationSignals: [
      ...new Set([...currentSignals, "requires_human_approval"]),
    ],
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedSameSourceContinuationFold: {
      ...foldLineage,
      role: "primary",
    },
  };
  const nextNormalizedFieldsJson = JSON.stringify(nextFields);
  const effectivePrimary: Doc<"events"> = {
    ...primary,
    ...venueFields,
    venue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
  };
  const independentPendingReasons = Array.isArray(
    independentContext.currentFields.moderationPendingReasons,
  )
    ? independentContext.currentFields.moderationPendingReasons.map(String)
    : [];
  const independentSignals = Array.isArray(
    independentContext.currentFields.moderationSignals,
  )
    ? independentContext.currentFields.moderationSignals.map(String)
    : [];
  const nextIndependentFields = {
    ...independentContext.currentFields,
    time: nextIndependentTime,
    normalizedVenue: nextVenue,
    timeSource: "poster",
    timeEvidenceText: independentPosterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: [
      ...new Set([...independentPendingReasons, "requires_human_approval"]),
    ],
    moderationSignals: [
      ...new Set([
        ...independentSignals.filter((signal) => signal !== "time_tbd"),
        "requires_human_approval",
      ]),
    ],
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedPosterCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: authorization.actor,
      venueEvidence: independentPosterVenueEvidence,
      timeEvidence: independentPosterTimeEvidence,
      artistEvidence: independentPosterArtistEvidence,
    },
    reviewedSameSourceContinuationFold: {
      ...foldLineage,
      role: "independent",
    },
  };
  const nextIndependentNormalizedFieldsJson = JSON.stringify(
    nextIndependentFields,
  );
  const effectiveIndependent: Doc<"events"> = {
    ...independent,
    ...independentTimePatch,
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson: nextIndependentNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
  };
  if (
    !hasHumanReviewableStructuredSourceAttestation(
      nextNormalizedFieldsJson,
      effectivePrimary,
    ) ||
    !hasHumanReviewableStructuredSourceAttestation(
      nextIndependentNormalizedFieldsJson,
      effectiveIndependent,
    )
  ) {
    throw new Error(
      "Reviewed continuation fold did not bind its final public events.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, {
    allowHumanReviewedStructured: true,
  });
  await assertPersistedServiceSourcePolicy(ctx, effectiveIndependent, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, ids);
  await assertApprovalCandidatePolicy(ctx, effectiveIndependent, ids);
  if (
    !(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary)) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, effectiveIndependent))
  ) {
    throw new Error(
      "Reviewed continuation fold would not remain publicly grounded.",
    );
  }

  const primaryKey = primaryContext.sourceLink.sourceOccurrenceKey;
  const continuationKey = continuationContext.sourceLink.sourceOccurrenceKey;
  const independentKey = independentContext.sourceLink.sourceOccurrenceKey;
  const bindingForPrimary = (key: string) => ({
    key,
    date: effectivePrimary.date,
    ...(effectivePrimary.time ? { time: effectivePrimary.time } : {}),
    venue: effectivePrimary.venue,
    title: effectivePrimary.title,
    artists: effectivePrimary.artists,
  });
  const independentExpected = {
    key: independentKey,
    date: effectiveIndependent.date,
    ...(effectiveIndependent.time ? { time: effectiveIndependent.time } : {}),
    venue: effectiveIndependent.venue,
    title: effectiveIndependent.title,
    artists: effectiveIndependent.artists,
  };
  const nextExpectedOccurrences = receipt.expectedOccurrences.map(
    (occurrence) =>
      occurrence.key === primaryKey || occurrence.key === continuationKey
        ? bindingForPrimary(occurrence.key)
        : occurrence.key === independentKey
          ? independentExpected
          : occurrence,
  );
  const nextSatisfiedOccurrences = receipt.satisfiedOccurrences.map(
    (occurrence) =>
      occurrence.key === primaryKey || occurrence.key === continuationKey
        ? { key: occurrence.key, eventId: primary._id }
        : occurrence,
  );
  if (
    nextExpectedOccurrences.filter((item) => item.key === independentKey)
      .length !== 1 ||
    nextSatisfiedOccurrences.filter(
      (item) => item.key === independentKey && item.eventId === independent._id,
    ).length !== 1
  ) {
    throw new Error(
      "Reviewed continuation fold lost the independent occurrence.",
    );
  }
  for (const satisfied of nextSatisfiedOccurrences) {
    const matchingExpected = nextExpectedOccurrences.filter(
      (item) => item.key === satisfied.key,
    );
    const representative =
      satisfied.eventId === primary._id
        ? effectivePrimary
        : satisfied.eventId === independent._id
          ? effectiveIndependent
          : await ctx.db.get(satisfied.eventId);
    if (
      matchingExpected.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        matchingExpected[0],
      )
    ) {
      throw new Error(
        "Reviewed continuation fold would invalidate its receipt.",
      );
    }
  }

  try {
    await savedEventRepository.loadEventReferences(ctx, continuation._id, {
      limit: MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT,
    });
  } catch (error) {
    if (error instanceof SavedEventRepositoryConflict) {
      throw new Error(
        "Reviewed continuation fold save cohort exceeds the safe bound.",
      );
    }
    throw error;
  }
  const continuationSourceTopology =
    await prepareInstagramOccurrenceTopologyForDedicatedReattestation(
      ctx,
      continuation._id,
    );

  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, reviewedAt);
  const continuationUpdatedAt = nextEventUpdatedAt(
    continuation.updatedAt,
    reviewedAt,
  );
  const independentUpdatedAt = nextEventUpdatedAt(
    independent.updatedAt,
    reviewedAt,
  );
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, reviewedAt);
  const continuationModerationNote = `[reviewed_same_source_continuation:v1] ${operationId} - ${moderationNote}`;
  const receiptAfter = {
    ...receipt,
    expectedOccurrences: nextExpectedOccurrences,
    satisfiedOccurrences: nextSatisfiedOccurrences,
    updatedAt: receiptUpdatedAt,
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
    sourceLinksBefore: sourceLinks,
    receiptBefore: receipt,
    receiptAfter,
    continuationId: continuation._id,
    independentId: independent._id,
    primaryScheduleSourceText,
    continuationScheduleSourceText,
  };
  const independentAuditPatch = {
    operationId,
    policyVersion: 1,
    eventBefore: independent,
    eventAfter: {
      title: effectiveIndependent.title,
      date: effectiveIndependent.date,
      time: effectiveIndependent.time,
      venue: effectiveIndependent.venue,
      artists: effectiveIndependent.artists,
      description: effectiveIndependent.description,
      updatedAt: independentUpdatedAt,
    },
    sourceLinkBefore: independentContext.sourceLink,
    receiptBefore: receipt,
    receiptAfter,
    reviewedPosterCorrection: nextIndependentFields.reviewedPosterCorrection,
  };
  const continuationAuditPatch = {
    operationId,
    policyVersion: 1,
    eventBefore: continuation,
    sourceLinkBefore: continuationContext.sourceLink,
    receiptBefore: receipt,
    receiptAfter,
    primaryId: primary._id,
    independentId: independent._id,
    continuationUpdatedAt,
  };
  assertCrossPostPromotionAuditPayload(primaryAuditPatch);
  assertCrossPostPromotionAuditPayload(continuationAuditPatch);
  assertCrossPostPromotionAuditPayload(independentAuditPatch);

  const saveResult = await reassignSavedEventReferences(
    ctx,
    continuation._id,
    primary._id,
  );
  await ctx.db.patch(primary._id, {
    ...venueFields,
    venue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
    updatedAt: primaryUpdatedAt,
  });
  await ctx.db.patch(independent._id, {
    ...independentTimePatch,
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson: nextIndependentNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote,
    updatedAt: independentUpdatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    satisfiedOccurrences: nextSatisfiedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  await ctx.db.patch(continuation._id, {
    status: "rejected",
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote: continuationModerationNote,
    updatedAt: continuationUpdatedAt,
  });
  await reassignInstagramOccurrenceReferences(
    ctx,
    continuation._id,
    primary._id,
    continuationSourceTopology,
    { preserveLegacyLinks: true },
  );
  const primaryExpected = nextExpectedOccurrences.find(
    (occurrence) => occurrence.key === primaryKey,
  );
  const continuationExpected = nextExpectedOccurrences.find(
    (occurrence) => occurrence.key === continuationKey,
  );
  if (!primaryExpected || !continuationExpected) {
    throw new Error(
      "Reviewed continuation fold lost its retained occurrence bindings.",
    );
  }
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: primaryExpected,
      representative: effectivePrimary,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink: primaryContext.sourceLink,
      topologyEpochVerified: false,
    },
  );
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: continuationExpected,
      representative: effectivePrimary,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink: continuationContext.sourceLink,
      topologyEpochVerified: false,
    },
  );
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: independentExpected,
      representative: effectiveIndependent,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink: independentContext.sourceLink,
      topologyEpochVerified: false,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  await refreshCanonicalEventDerivedStates(ctx, [
    primary._id,
    continuation._id,
    independent._id,
  ]);
  await writeEventAuditLog(
    ctx,
    continuation._id,
    "reviewed_same_source_continuation_rejected",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: continuationAuditPatch,
    },
  );
  await writeEventAuditLog(
    ctx,
    independent._id,
    "reviewed_same_source_independent_corrected",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: independentAuditPatch,
    },
  );
  const primaryAuditPatchWithSaves = {
    ...primaryAuditPatch,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
  assertCrossPostPromotionAuditPayload(primaryAuditPatchWithSaves);
  await writeEventAuditLog(
    ctx,
    primary._id,
    "reviewed_same_source_continuation_folded",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: primaryAuditPatchWithSaves,
    },
  );
  const [finalizedPrimary, finalizedIndependent] = await Promise.all([
    ctx.db.get(primary._id),
    ctx.db.get(independent._id),
  ]);
  if (
    !finalizedPrimary ||
    !finalizedIndependent ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, finalizedPrimary)) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, finalizedIndependent))
  ) {
    throw new Error(
      "Reviewed continuation fold failed its final grounding proof.",
    );
  }
  return {
    operationId,
    primaryId: primary._id,
    primaryUpdatedAt,
    continuationId: continuation._id,
    continuationUpdatedAt,
    independentId: independent._id,
    independentUpdatedAt,
    receiptUpdatedAt,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
}
