import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { isSensibleEventTitleForApproval } from "../../../lib/events/event-title-approval";
import { normalizeEventTimeWritePatch } from "../../../lib/events/event-time-write";
import {
  assertExpectedEventUpdatedAt,
  hasHumanReviewedStructuredSourceAttestation,
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

function retainedModerationNote(existing: string | undefined, correctionNote: string): string {
  if (!existing?.trim()) return correctionNote;
  return existing.trim().length >= 20
    ? existing
    : `${existing}\n${correctionNote}`;
}

/**
 * An already-approved v2 event can age out of the machine policy's future-date
 * gate. For a reviewed repair, prove its unchanged source through the stricter
 * persisted human-reviewed public predicate before modifying its public fields.
 */
export async function isReviewablySourceGroundedApprovedEvent(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  actor: string,
  correctionNote: string,
): Promise<boolean> {
  if (await isCanonicallyGroundedApprovedEvent(ctx, event)) return true;
  if (event.status !== "approved" || event.date >= new Date().toISOString().slice(0, 10)) {
    return false;
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(event.normalizedFieldsJson ?? "null") as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  if (
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.extractionIsEvent !== true ||
    fields.dateEvidenceVerified !== true ||
    fields.dateEvidenceResolvedDate !== event.date ||
    fields.normalizedIsValid !== true
  ) return false;
  const reviewedFieldsJson = JSON.stringify({
    ...fields,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  });
  const reviewedEvent: Doc<"events"> = {
    ...event,
    normalizedFieldsJson: reviewedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: event.reviewedAt ?? Date.now(),
    reviewedBy: event.reviewedBy || actor,
    moderationNote: retainedModerationNote(event.moderationNote, correctionNote),
  };
  return hasHumanReviewedStructuredSourceAttestation(reviewedFieldsJson, reviewedEvent) &&
    await isCanonicallyGroundedApprovedEvent(ctx, reviewedEvent);
}

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
  if (!(await isReviewablySourceGroundedApprovedEvent(
    ctx,
    event,
    authorization.actor,
    "Reviewed source correction planning with exact persisted evidence.",
  ))) {
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
    preserveExistingModerationNote?: boolean;
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
  if (!(await isReviewablySourceGroundedApprovedEvent(ctx, event, actor, moderationNote))) {
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
  const persistedModerationNote = args.preserveExistingModerationNote
    ? retainedModerationNote(event.moderationNote, moderationNote)
    : moderationNote;
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
      previousReviewedAt: event.reviewedAt ?? null,
      previousReviewedBy: event.reviewedBy ?? null,
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
    moderationNote: persistedModerationNote,
  };
  if (
    !hasHumanReviewedStructuredSourceAttestation(
      nextNormalizedFieldsJson,
      effectiveEvent,
    )
  ) {
    throw new Error(
      "Reviewed structured venue correction did not bind all public fields.",
    );
  }
  // Approved past events remain repairable. The public grounding check below
  // performs the same persisted source and analysis comparison for them.
  if (hasHumanReviewableStructuredSourceAttestation(nextNormalizedFieldsJson, effectiveEvent)) {
    await assertPersistedServiceSourcePolicy(ctx, effectiveEvent, {
      allowHumanReviewedStructured: true,
    });
  }
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
    moderationNote: persistedModerationNote,
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

/**
 * Corrects a source-attested title without changing the scheduled occurrence.
 * The source link, receipt and first-class occurrence advance together.
 */
export function reviewedTitleEvidenceMatchesBoundScheduleRow(args: {
  currentFields: Record<string, unknown>;
  rawExtraction: Record<string, unknown>;
  eventDate: string;
  nextTitle: string;
  titleEvidence: string;
}): boolean {
  const rowIndex = args.currentFields.splitEventIndex;
  const scheduleEntries = args.rawExtraction.schedule_entries;
  const row = Number.isSafeInteger(rowIndex) && Number(rowIndex) >= 1 && Array.isArray(scheduleEntries)
    ? scheduleEntries[(rowIndex as number) - 1]
    : null;
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const sourceText = (row as Record<string, unknown>).source_text;
  const sourceDate = (row as Record<string, unknown>).date;
  if (typeof sourceText !== "string" || sourceDate !== args.eventDate) return false;
  const normalizeWhitespace = (value: string) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const foldLetters = (value: string) =>
    normalizeWhitespace(value).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("sr-Latn");
  return (
    sourceText === args.currentFields.rowSourceText &&
    normalizeWhitespace(sourceText) === args.titleEvidence &&
    foldLetters(sourceText).includes(foldLetters(args.nextTitle))
  );
}

export async function repairReviewedStructuredEventTitleHandler(
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
    titleEvidence: string;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service") {
    throw new Error("Reviewed structured title correction requires service authentication.");
  }
  const moderationNote = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const nextTitle = args.nextTitle.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const titleEvidence = args.titleEvidence.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    moderationNote.length < 20 ||
    !nextTitle ||
    nextTitle !== args.nextTitle ||
    !titleEvidence ||
    [args.expectedUpdatedAt, args.expectedSourceLinkUpdatedAt, args.expectedReceiptUpdatedAt]
      .some((value) => !Number.isSafeInteger(value))
  ) {
    throw new Error("Reviewed structured title correction requires exact evidence and revisions.");
  }
  const event = await ctx.db.get(args.id);
  if (!event || event.status !== "approved" || isCrossPostCampaignLineageEvent(event)) {
    throw new Error("Reviewed structured title correction requires an approved non-lineage event.");
  }
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
    throw new Error("Normalized event evidence changed before reviewed title correction.");
  }
  if (!(await isReviewablySourceGroundedApprovedEvent(ctx, event, actor, moderationNote))) {
    throw new Error("Current approved event is not publicly source-grounded.");
  }
  const { currentFields, rawExtraction, sourceLink, receipt, occurrenceIndex } =
    await loadReviewedStructuredCorrectionContext(ctx, event, args);
  if (!reviewedTitleEvidenceMatchesBoundScheduleRow({
    currentFields,
    rawExtraction,
    eventDate: event.date,
    nextTitle,
    titleEvidence,
  })) {
    throw new Error("Reviewed title evidence must match the exact event schedule row.");
  }
  if (event.title === nextTitle || !isSensibleEventTitleForApproval({ title: nextTitle, venue: event.venue })) {
    throw new Error("Reviewed structured title correction requires a different sensible title.");
  }
  const reviewedAt = Date.now();
  const persistedModerationNote = retainedModerationNote(event.moderationNote, moderationNote);
  const nextFields = {
    ...currentFields,
    title: nextTitle,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: [
      ...new Set([
        ...(Array.isArray(currentFields.moderationPendingReasons)
          ? currentFields.moderationPendingReasons.map(String)
          : []),
        "requires_human_approval",
      ]),
    ],
    moderationSignals: [
      ...new Set([
        ...(Array.isArray(currentFields.moderationSignals)
          ? currentFields.moderationSignals.map(String)
          : []),
        "requires_human_approval",
      ]),
    ],
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedTitleCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: actor,
      previousReviewedAt: event.reviewedAt ?? null,
      previousReviewedBy: event.reviewedBy ?? null,
      previousTitle: event.title,
      title: nextTitle,
      evidence: titleEvidence,
    },
  };
  const normalizedFieldsJson = JSON.stringify(nextFields);
  const effectiveEvent = {
    ...event,
    title: nextTitle,
    normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION as 1,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: persistedModerationNote,
  };
  if (!hasHumanReviewedStructuredSourceAttestation(normalizedFieldsJson, effectiveEvent)) {
    throw new Error("Reviewed title correction did not bind all public fields.");
  }
  if (hasHumanReviewableStructuredSourceAttestation(normalizedFieldsJson, effectiveEvent)) {
    await assertPersistedServiceSourcePolicy(ctx, effectiveEvent, {
      allowHumanReviewedStructured: true,
    });
  }
  await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
    throw new Error("Reviewed title correction would not remain publicly grounded.");
  }
  const nextExpectedOccurrences = receipt.expectedOccurrences.map((occurrence, index) =>
    index === occurrenceIndex ? { ...occurrence, title: nextTitle } : occurrence,
  );
  for (const satisfied of receipt.satisfiedOccurrences) {
    const expected = nextExpectedOccurrences.filter((item) => item.key === satisfied.key);
    const representative = satisfied.eventId === event._id
      ? effectiveEvent
      : await ctx.db.get(satisfied.eventId);
    if (expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(representative, expected[0])) {
      throw new Error("Reviewed title correction would invalidate a receipt occurrence.");
    }
  }
  const updatedAt = nextEventUpdatedAt(event.updatedAt, reviewedAt);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, reviewedAt);
  await ctx.db.patch(event._id, {
    title: nextTitle,
    normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: persistedModerationNote,
    updatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, {
    expected: nextExpectedOccurrences[occurrenceIndex]!,
    representative: effectiveEvent,
    sourceFingerprint: receipt.sourceFingerprint,
    sourceLink,
    topologyEpochVerified: true,
  });
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  await writeEventAuditLog(ctx, event._id, "reviewed_structured_title_corrected", {
    actor,
    note: moderationNote,
    patch: {
      previousTitle: event.title,
      title: nextTitle,
      evidence: titleEvidence,
      sourceLinkId: sourceLink._id,
      receiptId: receipt._id,
      receiptUpdatedAt,
    },
  });
  return { updated: true, updatedAt, receiptUpdatedAt, status: "approved" as const };
}

/**
 * Reviewed physical venue correction for a single canonical event that may
 * have more than one source post. Every source link and receipt is fenced, and
 * the compatibility receipts and first-class occurrences move atomically.
 */
export async function repairReviewedMultiSourceEventVenueHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    expectedSources: Array<{
      sourceLinkId: Id<"instagramEventSources">;
      sourceLinkUpdatedAt: number;
      receiptId: Id<"instagramSourceOccurrenceReceipts">;
      receiptUpdatedAt: number;
    }>;
    nextVenue: string;
    targetVenueId: Id<"venues">;
    expectedTargetVenueUpdatedAt: number;
    expectedTargetVenueHandle: string;
    venueEvidence: string;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (kind !== "service") {
    throw new Error("Reviewed multi-source venue correction requires service authentication.");
  }
  const nextVenue = args.nextVenue.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const venueEvidence = args.venueEvidence.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const moderationNote = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !nextVenue || nextVenue !== args.nextVenue ||
    !venueEvidence || moderationNote.length < 20 ||
    !Number.isSafeInteger(args.expectedUpdatedAt) ||
    !Number.isSafeInteger(args.expectedTargetVenueUpdatedAt) ||
    args.expectedSources.length < 1 ||
    args.expectedSources.length > 8 ||
    new Set(args.expectedSources.map((source) => source.sourceLinkId)).size !== args.expectedSources.length ||
    args.expectedSources.some((source) =>
      !Number.isSafeInteger(source.sourceLinkUpdatedAt) ||
      !Number.isSafeInteger(source.receiptUpdatedAt))
  ) {
    throw new Error("Reviewed multi-source venue correction requires exact revisions and evidence.");
  }
  const event = await ctx.db.get(args.id);
  if (!event || event.status !== "approved" || isCrossPostCampaignLineageEvent(event)) {
    throw new Error("Reviewed multi-source venue correction requires an approved non-lineage event.");
  }
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
    throw new Error("Normalized event evidence changed before reviewed venue correction.");
  }
  if (!(await isReviewablySourceGroundedApprovedEvent(ctx, event, actor, moderationNote))) {
    throw new Error("Current approved event is not publicly source-grounded.");
  }
  let currentFields: Record<string, unknown>;
  let rawExtraction: Record<string, unknown>;
  try {
    currentFields = JSON.parse(event.normalizedFieldsJson ?? "null") as Record<string, unknown>;
    rawExtraction = JSON.parse(event.rawExtractionJson ?? "null") as Record<string, unknown>;
  } catch {
    throw new Error("Reviewed venue correction requires valid structured evidence JSON.");
  }
  if (
    !currentFields || typeof currentFields !== "object" || Array.isArray(currentFields) ||
    !rawExtraction || typeof rawExtraction !== "object" || Array.isArray(rawExtraction) ||
    currentFields.extractionContractVersion !== "event_evidence_v2" ||
    currentFields.extractionIsEvent !== true ||
    currentFields.sourceGroundingVersion !== 5 ||
    currentFields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2" ||
    rawExtraction.extraction_contract_version !== "event_evidence_v2" ||
    rawExtraction.is_event !== true
  ) {
    throw new Error("Reviewed venue correction requires eligible v2 source evidence.");
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(9);
  const expectedById = new Map(args.expectedSources.map((source) => [source.sourceLinkId, source]));
  if (links.length !== args.expectedSources.length) {
    throw new Error("Reviewed venue correction source-link set changed.");
  }
  const occurrenceIds = new Map<Id<"instagramEventSources">, Id<"sourceOccurrences">>();
  for (const link of links) {
    const expected = expectedById.get(link._id);
    if (!expected || link.updatedAt !== expected.sourceLinkUpdatedAt) {
      throw new Error("Reviewed venue correction source-link revision changed.");
    }
    const receipts = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", link.sourceIdentity))
      .take(2);
    if (
      receipts.length !== 1 ||
      receipts[0]._id !== expected.receiptId ||
      receipts[0].updatedAt !== expected.receiptUpdatedAt ||
      receipts[0].sourceFingerprint !== link.sourceFingerprint
    ) {
      throw new Error("Reviewed venue correction source receipt changed.");
    }
    const occurrence = link.sourceOccurrenceId
      ? await ctx.db.get(link.sourceOccurrenceId)
      : await ctx.db
          .query("sourceOccurrences")
          .withIndex("by_source_occurrence", (q) =>
            q.eq("sourceIdentity", link.sourceIdentity)
              .eq("sourceOccurrenceKey", link.sourceOccurrenceKey))
          .unique();
    if (
      !occurrence ||
      occurrence.sourceIdentity !== link.sourceIdentity ||
      occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
      occurrence.sourceFingerprint !== link.sourceFingerprint ||
      occurrence.state !== "satisfied" ||
      occurrence.canonicalEventId !== event._id ||
      occurrence.venueId !== event.venueId
    ) {
      throw new Error("Reviewed venue correction first-class source occurrence changed.");
    }
    occurrenceIds.set(link._id, occurrence._id);
  }
  const targetVenue = await ctx.db.get(args.targetVenueId);
  if (
    !targetVenue ||
    !isVenuePublic(targetVenue) ||
    targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
    targetVenue.name !== nextVenue ||
    normalizeHandle(targetVenue.instagramHandle) !== normalizeHandle(args.expectedTargetVenueHandle)
  ) {
    throw new Error("Reviewed venue correction target venue changed or is not public.");
  }
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues([targetVenue], nextVenue);
  if (venueFields.venueId !== targetVenue._id) {
    throw new Error("Reviewed venue correction target venue did not resolve exactly.");
  }
  const reviewedAt = Date.now();
  const persistedModerationNote = retainedModerationNote(event.moderationNote, moderationNote);
  const nextFields = {
    ...currentFields,
    normalizedVenue: nextVenue,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    moderationPendingReasons: [
      ...new Set([
        ...(Array.isArray(currentFields.moderationPendingReasons)
          ? currentFields.moderationPendingReasons.map(String)
          : []),
        "requires_human_approval",
      ]),
    ],
    moderationSignals: [
      ...new Set([
        ...(Array.isArray(currentFields.moderationSignals)
          ? currentFields.moderationSignals.map(String)
          : []),
        "requires_human_approval",
      ]),
    ],
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedVenueCorrection: {
      policyVersion: 1,
      reviewedAt,
      reviewedBy: actor,
      previousReviewedAt: event.reviewedAt ?? null,
      previousReviewedBy: event.reviewedBy ?? null,
      previousVenue: event.venue,
      venue: nextVenue,
      evidence: venueEvidence,
    },
  };
  const normalizedFieldsJson = JSON.stringify(nextFields);
  const effectiveEvent: Doc<"events"> = {
    ...event,
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: persistedModerationNote,
  };
  if (!hasHumanReviewedStructuredSourceAttestation(normalizedFieldsJson, effectiveEvent)) {
    throw new Error("Reviewed venue correction did not bind all public fields.");
  }
  if (hasHumanReviewableStructuredSourceAttestation(normalizedFieldsJson, effectiveEvent)) {
    await assertPersistedServiceSourcePolicy(ctx, effectiveEvent, {
      allowHumanReviewedStructured: true,
    });
  }
  await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
    throw new Error("Reviewed venue correction would not remain publicly grounded.");
  }
  const affected = await sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(
    ctx,
    event,
    effectiveEvent,
    { topologyEpochVerified: true },
  );
  const updatedAt = nextEventUpdatedAt(event.updatedAt, reviewedAt);
  await ctx.db.patch(event._id, {
    ...venueFields,
    venue: nextVenue,
    normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: persistedModerationNote,
    updatedAt,
  });
  const persistedEvent = await ctx.db.get(event._id);
  if (!persistedEvent || !(await isCanonicallyGroundedApprovedEvent(ctx, persistedEvent))) {
    throw new Error("Reviewed venue correction lost public source grounding after write.");
  }
  for (const link of links) {
    const expected = expectedById.get(link._id);
    const occurrenceId = occurrenceIds.get(link._id);
    if (!expected || !occurrenceId) {
      throw new Error("Reviewed venue correction lost its expected source plan.");
    }
    const receipt = await ctx.db.get(expected.receiptId);
    const occurrence = await ctx.db.get(occurrenceId);
    const receiptExpected = receipt?.expectedOccurrences?.filter(
      (item) => item.key === link.sourceOccurrenceKey,
    );
    let normalizedOccurrence: Record<string, unknown> | null = null;
    try {
      normalizedOccurrence = occurrence?.normalizedOccurrenceJson
        ? JSON.parse(occurrence.normalizedOccurrenceJson) as Record<string, unknown>
        : null;
    } catch {
      normalizedOccurrence = null;
    }
    if (
      receiptExpected?.length !== 1 ||
      receiptExpected[0].venue !== nextVenue ||
      !receipt?.satisfiedOccurrences.some((item) =>
        item.key === link.sourceOccurrenceKey && item.eventId === event._id) ||
      !occurrence ||
      occurrence.state !== "satisfied" ||
      occurrence.canonicalEventId !== event._id ||
      occurrence.venueId !== targetVenue._id ||
      occurrence.venueResolutionStatus !== "resolved" ||
      normalizedOccurrence?.venue !== nextVenue ||
      normalizedOccurrence.venueId !== targetVenue._id
    ) {
      throw new Error("Reviewed venue correction did not rebind every source occurrence.");
    }
  }
  await refreshCanonicalEventDerivedStates(ctx, affected);
  await writeEventAuditLog(ctx, event._id, "reviewed_multi_source_venue_corrected", {
    actor,
    note: moderationNote,
    patch: {
      previousVenue: event.venue,
      venue: nextVenue,
      venueId: targetVenue._id,
      venueEvidence,
      sourceLinkIds: links.map((link) => link._id),
      expectedSources: args.expectedSources,
    },
  });
  return { updated: true, updatedAt, sourceCount: links.length, status: "approved" as const };
}
