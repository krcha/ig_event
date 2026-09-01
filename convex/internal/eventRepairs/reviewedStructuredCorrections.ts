import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { isSensibleEventTitleForApproval } from "../../../lib/events/event-title-approval";
import { normalizeEventTimeWritePatch } from "../../../lib/events/event-time-write";
import {
  assertExpectedEventUpdatedAt,
  hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  type SourceOccurrencePlan,
} from "../sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import type { VenueDenormalizedFields } from "../../venueResolver";
import {
  resolveVenueDenormalizedFields,
  resolveVenueDenormalizedFieldsFromPublicVenues,
} from "../../eventDomain/moderationVenue";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "../../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";

export type ReviewedStructuredCorrectionVersionArgs = {
  expectedSourceLinkId: Id<"instagramEventSources">;
  expectedSourceLinkUpdatedAt: number;
  expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
  expectedReceiptUpdatedAt: number;
};

export type ReviewedStructuredReceipt =
  Doc<"instagramSourceOccurrenceReceipts"> & {
    expectedOccurrences: SourceOccurrencePlan["expectedOccurrences"];
  };

export async function loadReviewedStructuredCorrectionContext(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  args: ReviewedStructuredCorrectionVersionArgs,
): Promise<{
  currentFields: Record<string, unknown>;
  rawExtraction: Record<string, unknown>;
  sourceLink: Doc<"instagramEventSources">;
  receipt: ReviewedStructuredReceipt;
  occurrenceIndex: number;
}> {
  let currentFields: Record<string, unknown>;
  let rawExtraction: Record<string, unknown>;
  try {
    const parsedFields = JSON.parse(
      event.normalizedFieldsJson ?? "null",
    ) as unknown;
    const parsedRaw = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    if (
      !parsedFields ||
      typeof parsedFields !== "object" ||
      Array.isArray(parsedFields) ||
      !parsedRaw ||
      typeof parsedRaw !== "object" ||
      Array.isArray(parsedRaw)
    ) {
      throw new Error("invalid structured evidence");
    }
    currentFields = parsedFields as Record<string, unknown>;
    rawExtraction = parsedRaw as Record<string, unknown>;
  } catch {
    throw new Error(
      "Reviewed structured correction requires valid v2 evidence JSON.",
    );
  }
  if (
    currentFields.extractionContractVersion !== "event_evidence_v2" ||
    currentFields.extractionIsEvent !== true ||
    currentFields.sourceGroundingVersion !== 5 ||
    currentFields.sourceGroundingEvidence !==
      "persisted_openai_event_evidence_v2" ||
    rawExtraction.extraction_contract_version !== "event_evidence_v2" ||
    rawExtraction.is_event !== true
  ) {
    throw new Error("Event is not eligible structured v2 evidence.");
  }

  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
  const sourceHandle = normalizeHandle(
    typeof currentFields.sourceGroundingInstagramHandle === "string"
      ? currentFields.sourceGroundingInstagramHandle
      : "",
  );
  const postId = event.instagramPostId?.trim() ?? "";
  const postUrl = requireCanonicalInstagramPostUrl(
    event.instagramPostUrl,
    "Reviewed structured correction event source",
  );
  const sourceLinkPostUrl = sourceLink
    ? requireCanonicalInstagramPostUrl(
        sourceLink.instagramPostUrl,
        "Reviewed structured correction source link",
      )
    : "";
  if (
    !sourceLink ||
    sourceLink._id !== args.expectedSourceLinkId ||
    sourceLink.updatedAt !== args.expectedSourceLinkUpdatedAt ||
    sourceLink.eventId !== event._id ||
    !sourceLink.sourceIdentity.trim() ||
    !sourceLink.sourceFingerprint.trim() ||
    !sourceLink.sourceOccurrenceKey.trim() ||
    sourceLink.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    sourceLink.sourceOccurrenceKey !== currentFields.sourceOccurrenceKey ||
    sourceLink.sourceFingerprint !==
      currentFields.sourceOccurrenceSourceFingerprint ||
    sourceLink.instagramPostId !== event.instagramPostId ||
    sourceLinkPostUrl !== postUrl ||
    !postId ||
    !postUrl ||
    !sourceHandle ||
    (sourceLink.sourceHandle !== undefined &&
      normalizeHandle(sourceLink.sourceHandle) !== sourceHandle)
  ) {
    throw new Error(
      "Reviewed structured correction source link changed or is inconsistent.",
    );
  }

  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", sourceLink.sourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (
    !receipt ||
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceIdentity !== sourceLink.sourceIdentity ||
    receipt.sourceFingerprint !== sourceLink.sourceFingerprint ||
    !Array.isArray(receipt.expectedOccurrences)
  ) {
    throw new Error(
      "Reviewed structured correction receipt changed or is missing.",
    );
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expectedKeys = receipt.expectedOccurrences.map((item) => item.key);
  const satisfiedOccurrenceKeys = receipt.satisfiedOccurrences.map(
    (item) => item.key,
  );
  const matchingOccurrenceIndexes = receipt.expectedOccurrences
    .map((item, index) =>
      item.key === sourceLink.sourceOccurrenceKey ? index : -1,
    )
    .filter((index) => index >= 0);
  const matchingSatisfiedOccurrences = receipt.satisfiedOccurrences.filter(
    (item) => item.key === sourceLink.sourceOccurrenceKey,
  );
  if (
    receipt.expectedKeys.length !== receipt.expectedOccurrences.length ||
    new Set(receipt.expectedKeys).size !== receipt.expectedKeys.length ||
    new Set(expectedKeys).size !== expectedKeys.length ||
    receipt.expectedKeys.some((key) => !expectedKeys.includes(key)) ||
    new Set(receipt.satisfiedKeys).size !== receipt.satisfiedKeys.length ||
    new Set(satisfiedOccurrenceKeys).size !== satisfiedOccurrenceKeys.length ||
    receipt.satisfiedKeys.length !== receipt.satisfiedOccurrences.length ||
    receipt.satisfiedKeys.some(
      (key) => !satisfiedOccurrenceKeys.includes(key),
    ) ||
    receipt.satisfiedKeys.some((key) => !receipt.expectedKeys.includes(key)) ||
    matchingOccurrenceIndexes.length !== 1 ||
    receipt.expectedKeys.filter((key) => key === sourceLink.sourceOccurrenceKey)
      .length !== 1 ||
    receipt.satisfiedKeys.filter(
      (key) => key === sourceLink.sourceOccurrenceKey,
    ).length !== 1 ||
    matchingSatisfiedOccurrences.length !== 1 ||
    matchingSatisfiedOccurrences[0].eventId !== event._id ||
    receipt.satisfiedOccurrences.filter((item) => item.eventId === event._id)
      .length !== 1
  ) {
    throw new Error(
      "Reviewed structured correction receipt is ambiguous or incomplete.",
    );
  }

  for (const satisfied of receipt.satisfiedOccurrences) {
    const matchingExpected = receipt.expectedOccurrences.filter(
      (item) => item.key === satisfied.key,
    );
    const representative =
      satisfied.eventId === event._id
        ? event
        : await ctx.db.get(satisfied.eventId);
    if (
      matchingExpected.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        matchingExpected[0],
      )
    ) {
      throw new Error(
        "Reviewed structured correction receipt has a stale occurrence representative.",
      );
    }
  }

  return {
    currentFields,
    rawExtraction,
    sourceLink,
    receipt: receipt as ReviewedStructuredReceipt,
    occurrenceIndex: matchingOccurrenceIndexes[0],
  };
}

export async function getReviewedStructuredEvidenceCorrectionContextHandler(
  ctx: QueryCtx,
  args: { id: Id<"events">; serviceSecret: string },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Reviewed structured correction context requires service authentication.",
    );
  }
  const event = await ctx.db.get(args.id);
  if (!event) throw new Error("Event not found.");
  if (event.status !== "approved" || isCrossPostCampaignLineageEvent(event)) {
    throw new Error(
      "Reviewed structured correction context requires an eligible approved event.",
    );
  }
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
    throw new Error(
      "Reviewed structured correction context is not publicly source-grounded.",
    );
  }
  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  if (sourceLinks.length !== 1) {
    throw new Error(
      "Reviewed structured correction requires one exact source link.",
    );
  }
  const sourceLink = sourceLinks[0];
  const receipt = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", sourceLink.sourceIdentity),
    )
    .unique();
  if (!receipt) {
    throw new Error(
      "Reviewed structured correction source receipt is missing.",
    );
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const exact = await loadReviewedStructuredCorrectionContext(ctx, event, {
    expectedSourceLinkId: sourceLink._id,
    expectedSourceLinkUpdatedAt: sourceLink.updatedAt,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
  });
  return { event, sourceLink: exact.sourceLink, receipt: exact.receipt };
}

export async function repairReviewedStructuredEventEvidenceHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    expectedSourceLinkId: Id<"instagramEventSources">;
    expectedSourceLinkUpdatedAt: number;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
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
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service") {
    throw new Error(
      "Reviewed structured correction requires service authentication.",
    );
  }
  const moderationNote = args.moderationNote
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (moderationNote.length < 20) {
    throw new Error(
      "Reviewed structured correction requires a substantive audit note.",
    );
  }
  for (const value of [
    args.expectedUpdatedAt,
    args.expectedSourceLinkUpdatedAt,
    args.expectedReceiptUpdatedAt,
    ...(args.expectedTargetVenueUpdatedAt !== undefined
      ? [args.expectedTargetVenueUpdatedAt]
      : []),
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "Reviewed structured correction requires safe optimistic revisions.",
      );
    }
  }

  const event = await ctx.db.get(args.id);
  if (!event) throw new Error("Event not found.");
  if (event.status !== "approved") {
    throw new Error(
      "Reviewed structured correction only accepts an approved event.",
    );
  }
  if (isCrossPostCampaignLineageEvent(event)) {
    throw new Error(
      "Campaign lineage events require their dedicated re-attestation operation.",
    );
  }
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
    throw new Error(
      "Normalized event evidence changed before reviewed correction.",
    );
  }
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
    throw new Error("Current approved event is not publicly source-grounded.");
  }

  const { currentFields, sourceLink, receipt, occurrenceIndex } =
    await loadReviewedStructuredCorrectionContext(ctx, event, args);

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
    nextArtists.some((artist, index) => artist !== args.nextArtists[index])
  ) {
    throw new Error(
      "Reviewed structured correction public fields are not canonical.",
    );
  }
  const posterVenueEvidence = args.posterVenueEvidence.normalize("NFKC").trim();
  const posterTimeEvidence = args.posterTimeEvidence.normalize("NFKC").trim();
  const posterArtistEvidence = args.posterArtistEvidence.map((value) =>
    value.normalize("NFKC").trim(),
  );
  if (
    !posterVenueEvidence ||
    !posterTimeEvidence ||
    posterArtistEvidence.length < 1 ||
    posterArtistEvidence.some((value) => !value)
  ) {
    throw new Error(
      "Reviewed structured correction requires exact poster evidence.",
    );
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
        "Reviewed structured correction target venue is not exact and public.",
      );
    }
    venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
      [targetVenue],
      nextVenue,
    );
    if (venueFields.venueId !== targetVenue._id) {
      throw new Error(
        "Reviewed structured correction target venue did not resolve exactly.",
      );
    }
  } else {
    if (
      args.expectedTargetVenueUpdatedAt !== undefined ||
      args.expectedTargetVenueHandle !== undefined
    ) {
      throw new Error(
        "Noncanonical venue correction cannot carry target venue revisions.",
      );
    }
    venueFields = await resolveVenueDenormalizedFields(ctx, nextVenue);
    if (venueFields.venueId !== undefined) {
      throw new Error(
        "A known public venue correction must bind its exact venueId.",
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
    currentFields.moderationPendingReasons,
  )
    ? currentFields.moderationPendingReasons.map(String)
    : [];
  const currentSignals = Array.isArray(currentFields.moderationSignals)
    ? currentFields.moderationSignals.map(String)
    : [];
  const nextPendingReasons = [
    ...new Set([...currentPendingReasons, "requires_human_approval"]),
  ];
  const nextSignals = [
    ...new Set([
      ...currentSignals.filter((signal) => signal !== "time_tbd"),
      "requires_human_approval",
    ]),
  ];
  const reviewedAt = Date.now();
  const nextFields = {
    ...currentFields,
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
    moderationPendingReasons: nextPendingReasons,
    moderationSignals: nextSignals,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedPosterCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: actor,
      venueEvidence: posterVenueEvidence,
      timeEvidence: posterTimeEvidence,
      artistEvidence: posterArtistEvidence,
    },
  };
  const nextNormalizedFieldsJson = JSON.stringify(nextFields);
  const effectiveEvent = {
    ...event,
    title: nextTitle,
    ...timePatch,
    venue: nextVenue,
    artists: nextArtists,
    description: args.nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION as 1,
    reviewedAt,
    reviewedBy: actor,
    moderationNote,
    ...venueFields,
  };
  if (!isSensibleEventTitleForApproval(effectiveEvent)) {
    throw new Error(
      "Reviewed structured correction title is not suitable for approval.",
    );
  }
  if (
    !hasHumanReviewableStructuredSourceAttestation(
      nextNormalizedFieldsJson,
      effectiveEvent,
    )
  ) {
    throw new Error(
      "Reviewed structured correction did not bind all public fields.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, effectiveEvent, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
    throw new Error(
      "Reviewed structured correction would not remain publicly grounded.",
    );
  }

  const nextExpectedOccurrences = receipt.expectedOccurrences.map(
    (occurrence, index) =>
      index === occurrenceIndex
        ? {
            ...occurrence,
            date: event.date,
            time: nextTime,
            venue: nextVenue,
            title: nextTitle,
            artists: nextArtists,
          }
        : occurrence,
  );
  for (const satisfied of receipt.satisfiedOccurrences) {
    const matchingExpected = nextExpectedOccurrences.filter(
      (item) => item.key === satisfied.key,
    );
    const representative =
      satisfied.eventId === event._id
        ? effectiveEvent
        : await ctx.db.get(satisfied.eventId);
    if (
      matchingExpected.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        matchingExpected[0],
      )
    ) {
      throw new Error(
        "Reviewed structured correction would invalidate a receipt occurrence.",
      );
    }
  }
  const updatedAt = nextEventUpdatedAt(event.updatedAt, reviewedAt);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, reviewedAt);
  await ctx.db.patch(event._id, {
    title: nextTitle,
    ...timePatch,
    venue: nextVenue,
    artists: nextArtists,
    description: args.nextDescription,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote,
    ...venueFields,
    updatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: nextExpectedOccurrences[occurrenceIndex]!,
      representative: effectiveEvent,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink,
      topologyEpochVerified: true,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  await writeEventAuditLog(
    ctx,
    event._id,
    "reviewed_structured_evidence_corrected",
    {
      actor,
      note: moderationNote,
      patch: {
        policyVersion: 1,
        eventBefore: {
          title: event.title,
          time: event.time,
          venue: event.venue,
          artists: event.artists,
          description: event.description,
          updatedAt: event.updatedAt,
        },
        eventAfter: {
          title: nextTitle,
          time: nextTime,
          venue: nextVenue,
          artists: nextArtists,
          description: args.nextDescription,
          updatedAt,
        },
        sourceLink: {
          id: sourceLink._id,
          updatedAt: sourceLink.updatedAt,
          sourceIdentity: sourceLink.sourceIdentity,
          sourceOccurrenceKey: sourceLink.sourceOccurrenceKey,
        },
        receiptBeforeUpdatedAt: receipt.updatedAt,
        receiptAfterUpdatedAt: receiptUpdatedAt,
        reviewedPosterCorrection: nextFields.reviewedPosterCorrection,
      },
    },
  );
  return { updated: true, updatedAt, receiptUpdatedAt, status: event.status };
}

export async function repairReviewedStructuredEventVenueHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    expectedSourceLinkId: Id<"instagramEventSources">;
    expectedSourceLinkUpdatedAt: number;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    nextVenue: string;
    targetVenueId?: Id<"venues">;
    expectedTargetVenueUpdatedAt?: number;
    expectedTargetVenueHandle?: string;
    venueEvidence: string;
    moderationNote: string;
    expectedAmbiguousApprovedEventVersions?: Array<{
      id: Id<"events">;
      updatedAt: number;
    }>;
    serviceSecret: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service") {
    throw new Error(
      "Reviewed structured venue correction requires service authentication.",
    );
  }
  const moderationNote = args.moderationNote
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextVenue = args.nextVenue
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const venueEvidence = args.venueEvidence
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (moderationNote.length < 20 || !nextVenue || !venueEvidence) {
    throw new Error(
      "Reviewed structured venue correction requires exact evidence and an audit note.",
    );
  }
  for (const value of [
    args.expectedUpdatedAt,
    args.expectedSourceLinkUpdatedAt,
    args.expectedReceiptUpdatedAt,
    ...(args.expectedTargetVenueUpdatedAt !== undefined
      ? [args.expectedTargetVenueUpdatedAt]
      : []),
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "Reviewed structured venue correction requires safe optimistic revisions.",
      );
    }
  }

  const event = await ctx.db.get(args.id);
  if (!event) throw new Error("Event not found.");
  if (event.status !== "approved") {
    throw new Error(
      "Reviewed structured venue correction only accepts an approved event.",
    );
  }
  if (isCrossPostCampaignLineageEvent(event)) {
    throw new Error(
      "Campaign lineage events require their dedicated re-attestation operation.",
    );
  }
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
    throw new Error(
      "Normalized event evidence changed before reviewed venue correction.",
    );
  }
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
    throw new Error("Current approved event is not publicly source-grounded.");
  }

  const { currentFields, sourceLink, receipt, occurrenceIndex } =
    await loadReviewedStructuredCorrectionContext(ctx, event, args);

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
        "Reviewed structured venue target is not exact and public.",
      );
    }
    venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
      [targetVenue],
      nextVenue,
    );
    if (venueFields.venueId !== targetVenue._id) {
      throw new Error(
        "Reviewed structured venue target did not resolve exactly.",
      );
    }
  } else {
    if (
      args.expectedTargetVenueUpdatedAt !== undefined ||
      args.expectedTargetVenueHandle !== undefined
    ) {
      throw new Error(
        "Noncanonical venue correction cannot carry target venue revisions.",
      );
    }
    venueFields = await resolveVenueDenormalizedFields(ctx, nextVenue);
    if (venueFields.venueId !== undefined) {
      throw new Error(
        "A known public venue correction must bind its exact venueId.",
      );
    }
  }

  const currentPendingReasons = Array.isArray(
    currentFields.moderationPendingReasons,
  )
    ? currentFields.moderationPendingReasons.map(String)
    : [];
  const currentSignals = Array.isArray(currentFields.moderationSignals)
    ? currentFields.moderationSignals.map(String)
    : [];
  const reviewedAt = Date.now();
  const nextFields = {
    ...currentFields,
    normalizedVenue: nextVenue,
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
    reviewedVenueCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: actor,
      previousVenue: event.venue,
      venue: nextVenue,
      evidence: venueEvidence,
    },
  };
  const nextNormalizedFieldsJson = JSON.stringify(nextFields);
  const effectiveEvent: Doc<"events"> = {
    ...event,
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote,
  };
  if (
    !hasHumanReviewableStructuredSourceAttestation(
      nextNormalizedFieldsJson,
      effectiveEvent,
    )
  ) {
    throw new Error(
      "Reviewed structured venue correction did not bind all public fields.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, effectiveEvent, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id], {
    expectedAmbiguousApprovedEventVersions:
      args.expectedAmbiguousApprovedEventVersions,
  });
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
    throw new Error(
      "Reviewed structured venue correction would not remain publicly grounded.",
    );
  }

  const nextExpectedOccurrences = receipt.expectedOccurrences.map(
    (occurrence, index) =>
      index === occurrenceIndex
        ? { ...occurrence, venue: nextVenue }
        : occurrence,
  );
  for (const satisfied of receipt.satisfiedOccurrences) {
    const matchingExpected = nextExpectedOccurrences.filter(
      (item) => item.key === satisfied.key,
    );
    const representative =
      satisfied.eventId === event._id
        ? effectiveEvent
        : await ctx.db.get(satisfied.eventId);
    if (
      matchingExpected.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        matchingExpected[0],
      )
    ) {
      throw new Error(
        "Reviewed structured venue correction would invalidate a receipt occurrence.",
      );
    }
  }

  const updatedAt = nextEventUpdatedAt(event.updatedAt, reviewedAt);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, reviewedAt);
  await ctx.db.patch(event._id, {
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote,
    updatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: nextExpectedOccurrences[occurrenceIndex]!,
      representative: effectiveEvent,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink,
      topologyEpochVerified: true,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  await writeEventAuditLog(
    ctx,
    event._id,
    "reviewed_structured_venue_corrected",
    {
      actor,
      note: moderationNote,
      patch: {
        policyVersion: 1,
        previousVenue: event.venue,
        receiptId: receipt._id,
        sourceIdentity: sourceLink.sourceIdentity,
        sourceOccurrenceKey: sourceLink.sourceOccurrenceKey,
        venue: nextVenue,
        venueEvidence,
        venueId: venueFields.venueId,
      },
    },
  );
  return {
    updated: true,
    updatedAt,
    receiptUpdatedAt,
    status: "approved" as const,
  };
}
