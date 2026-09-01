import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { v, type Infer } from "convex/values";
import { buildNormalizedEventVenueIdentity } from "../../../lib/events/event-venue-identity";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  assertExpectedEventUpdatedAt,
  hasHumanReviewedLegacySourceAttestation,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import {
  normalizeHandle,
  toSearchableText,
} from "../../../lib/pipeline/venue-normalization";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import {
  CLEARED_VENUE_DENORMALIZED_FIELDS,
  type VenueDenormalizedFields,
} from "../../venueResolver";

/**
 * Frozen command contract for the historical address-as-venue repair.
 *
 * Keeping this validator beside the implementation prevents the compatibility
 * export in `convex/events.ts` from drifting away from the transaction it
 * invokes.
 */
export const approvedLegacyVenueRepairArgs = {
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedCurrentVenue: v.string(),
  expectedNormalizedFieldsJson: v.string(),
  targetVenueId: v.id("venues"),
  expectedTargetVenueUpdatedAt: v.number(),
  expectedSourceId: v.id("instagramSources"),
  expectedSourceUpdatedAt: v.number(),
  expectedScrapedPostId: v.id("scrapedPosts"),
  expectedScrapedPostSourceRevision: v.number(),
  expectedScrapedPostAnalysisRevision: v.number(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
  expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
  expectedSourceIdentity: v.string(),
  expectedSourceFingerprint: v.string(),
  expectedSourceOccurrenceKey: v.string(),
  moderationNote: v.string(),
  serviceSecret: v.string(),
};

export const approvedLegacyVenueRepairResult = v.object({
  receiptUpdatedAt: v.number(),
  status: v.literal("approved"),
  updated: v.boolean(),
  updatedAt: v.number(),
});

type ApprovedLegacyVenueRepairArgs = {
  [Field in keyof typeof approvedLegacyVenueRepairArgs]: Infer<
    (typeof approvedLegacyVenueRepairArgs)[Field]
  >;
};

type ApprovedLegacyVenueRepairDependencies = {
  assertApprovalCandidatePolicy: (
    ctx: MutationCtx,
    candidate: Doc<"events">,
    excludeEventIds?: Id<"events">[],
  ) => Promise<void>;
  rebindCanonicalVenue: (
    ctx: MutationCtx,
    currentEvent: Doc<"events">,
    nextEvent: Doc<"events">,
  ) => Promise<Id<"events">[]>;
  refreshCanonicalEventDerivedStates: (
    ctx: MutationCtx,
    eventIds: readonly Id<"events">[],
  ) => Promise<void>;
  writeEventAuditLog: (
    ctx: MutationCtx,
    eventId: Id<"events">,
    action: string,
    options?: {
      actor?: string;
      note?: string;
      patch?: unknown;
    },
  ) => Promise<void>;
};

function normalizeLookup(value: string): string {
  return toSearchableText(value).replace(/\s+/g, " ").trim();
}

function normalizeSourceCaption(value: string | undefined): string {
  return value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
}

/**
 * Atomically repairs the historical address-as-venue extraction shape for an
 * already-approved event and its immutable source-occurrence receipt.
 *
 * This remains deliberately narrow: every event, source, venue, extraction,
 * link, and receipt revision is revalidated before either document is patched.
 */
export async function repairApprovedLegacyEventVenueAndOccurrenceHandler(
  ctx: MutationCtx,
  args: ApprovedLegacyVenueRepairArgs,
  dependencies: ApprovedLegacyVenueRepairDependencies,
) {
  const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (kind !== "service") {
    throw new Error("Approved legacy venue repair requires service authentication.");
  }
  const moderationNote = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (moderationNote.length < 20) {
    throw new Error("Approved legacy venue repair requires a substantive audit note.");
  }
  if (
    !Number.isSafeInteger(args.expectedUpdatedAt) ||
    !Number.isSafeInteger(args.expectedTargetVenueUpdatedAt) ||
    !Number.isSafeInteger(args.expectedSourceUpdatedAt) ||
    !Number.isSafeInteger(args.expectedScrapedPostSourceRevision) ||
    !Number.isSafeInteger(args.expectedScrapedPostAnalysisRevision) ||
    !Number.isSafeInteger(args.expectedSourceLinkUpdatedAt) ||
    !Number.isSafeInteger(args.expectedReceiptUpdatedAt)
  ) {
    throw new Error("Approved legacy venue repair requires valid optimistic versions.");
  }

  const event = await ctx.db.get(args.id);
  if (!event) {
    throw new Error("Event not found.");
  }
  if (event.status !== "approved") {
    throw new Error("Approved legacy venue repair only accepts an approved event.");
  }
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (
    event.venue !== args.expectedCurrentVenue ||
    event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson
  ) {
    throw new Error("Approved legacy event venue evidence changed before repair.");
  }
  if (
    event.humanReviewedLegacySourcePolicyVersion !==
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION ||
    !hasHumanReviewedLegacySourceAttestation(event.normalizedFieldsJson, event)
  ) {
    throw new Error("Event is not an eligible human-reviewed legacy source event.");
  }
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
    throw new Error("Current approved event is not publicly source-grounded.");
  }

  let currentFields: Record<string, unknown>;
  let rawExtraction: Record<string, unknown> | null = null;
  try {
    const parsedFields = JSON.parse(args.expectedNormalizedFieldsJson) as unknown;
    if (!parsedFields || typeof parsedFields !== "object" || Array.isArray(parsedFields)) {
      throw new Error("invalid normalized fields");
    }
    currentFields = parsedFields as Record<string, unknown>;
    if (event.rawExtractionJson) {
      const parsedRawExtraction = JSON.parse(event.rawExtractionJson) as unknown;
      rawExtraction =
        parsedRawExtraction &&
        typeof parsedRawExtraction === "object" &&
        !Array.isArray(parsedRawExtraction)
          ? (parsedRawExtraction as Record<string, unknown>)
          : null;
    }
  } catch {
    throw new Error("Approved legacy venue repair requires valid persisted evidence JSON.");
  }
  if (
    (currentFields.sourceGroundingVersion !== 3 &&
      currentFields.sourceGroundingVersion !== 4) ||
    currentFields.sourceGroundingEvidence !== "instagram_caption" ||
    currentFields.extractionContractVersion === "event_evidence_v2" ||
    rawExtraction?.extraction_contract_version === "event_evidence_v2" ||
    normalizeLookup(String(currentFields.rawVenue ?? "")) !==
      normalizeLookup(event.venue) ||
    normalizeLookup(String(currentFields.normalizedVenue ?? "")) !==
      normalizeLookup(event.venue)
  ) {
    throw new Error("Persisted evidence is not the eligible legacy address-as-venue shape.");
  }

  const sourceHandle = normalizeHandle(
    typeof currentFields.sourceGroundingInstagramHandle === "string"
      ? currentFields.sourceGroundingInstagramHandle
      : "",
  );
  const postId = event.instagramPostId?.trim() ?? "";
  const postUrl = requireCanonicalInstagramPostUrl(
    event.instagramPostUrl,
    "Approved legacy venue repair event source",
  );
  if (
    !sourceHandle ||
    !postId ||
    !postUrl ||
    event.sourceOccurrenceKey !== args.expectedSourceOccurrenceKey ||
    !args.expectedSourceIdentity.trim() ||
    !args.expectedSourceFingerprint.trim()
  ) {
    throw new Error("Approved legacy venue repair requires exact source identity fields.");
  }

  const targetVenue = await ctx.db.get(args.targetVenueId);
  if (
    !targetVenue ||
    targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
    !isVenuePublic(targetVenue) ||
    normalizeHandle(targetVenue.instagramHandle) !== sourceHandle ||
    !targetVenue.location ||
    normalizeLookup(targetVenue.location) !== normalizeLookup(event.venue) ||
    normalizeLookup(targetVenue.name) === normalizeLookup(event.venue)
  ) {
    throw new Error("Target venue is not the exact public source venue for this address.");
  }

  const sourceRows = await ctx.db
    .query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
    .take(2);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  if (
    !source ||
    source._id !== args.expectedSourceId ||
    source.updatedAt !== args.expectedSourceUpdatedAt ||
    !source.active ||
    source.role !== "venue" ||
    source.venueId !== targetVenue._id
  ) {
    throw new Error("Instagram source no longer owns the target venue.");
  }

  const persistedCandidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .take(2);
  const persisted = persistedCandidates.length === 1 ? persistedCandidates[0] : null;
  if (
    !persisted ||
    persisted._id !== args.expectedScrapedPostId ||
    persisted.sourceRevision !== args.expectedScrapedPostSourceRevision ||
    persisted.analysisRevision !== args.expectedScrapedPostAnalysisRevision ||
    normalizeHandle(persisted.handle) !== sourceHandle ||
    normalizeHandle(persisted.username) !== sourceHandle ||
    persisted.postId !== postId ||
    requireCanonicalInstagramPostUrl(
      persisted.instagramPostUrl,
      "Approved legacy venue repair persisted source",
    ) !== postUrl ||
    normalizeSourceCaption(persisted.caption) !== normalizeSourceCaption(event.sourceCaption) ||
    persisted.postedAt !== event.sourcePostedAt ||
    persisted.analysisResultJson !== event.rawExtractionJson
  ) {
    throw new Error("Persisted Instagram extraction changed before venue repair.");
  }

  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
  if (
    !sourceLink ||
    sourceLink._id !== args.expectedSourceLinkId ||
    sourceLink.updatedAt !== args.expectedSourceLinkUpdatedAt ||
    sourceLink.sourceIdentity !== args.expectedSourceIdentity ||
    sourceLink.sourceFingerprint !== args.expectedSourceFingerprint ||
    sourceLink.sourceOccurrenceKey !== args.expectedSourceOccurrenceKey ||
    sourceLink.instagramPostId !== event.instagramPostId ||
    requireCanonicalInstagramPostUrl(
      sourceLink.instagramPostUrl,
      "Approved legacy venue repair source link",
    ) !== postUrl ||
    (sourceLink.sourceHandle !== undefined &&
      normalizeHandle(sourceLink.sourceHandle) !== sourceHandle)
  ) {
    throw new Error("Event source link changed before venue repair.");
  }

  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", args.expectedSourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (!receipt) {
    throw new Error("Source occurrence receipt changed or is not represented by this event.");
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expectedOccurrences = receipt.expectedOccurrences ?? [];
  const matchingOccurrences = expectedOccurrences.filter(
    (occurrence) => occurrence.key === args.expectedSourceOccurrenceKey,
  );
  const matchingSatisfiedOccurrences = receipt.satisfiedOccurrences.filter(
    (occurrence) => occurrence.key === args.expectedSourceOccurrenceKey,
  );
  const satisfiedOccurrencesForEvent = receipt.satisfiedOccurrences.filter(
    (occurrence) => occurrence.eventId === event._id,
  );
  const expectedOccurrence = matchingOccurrences[0];
  if (
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceFingerprint !== args.expectedSourceFingerprint ||
    matchingOccurrences.length !== 1 ||
    matchingSatisfiedOccurrences.length !== 1 ||
    satisfiedOccurrencesForEvent.length !== 1 ||
    matchingSatisfiedOccurrences[0].eventId !== event._id ||
    receipt.expectedKeys.filter((key) => key === args.expectedSourceOccurrenceKey).length !== 1 ||
    receipt.satisfiedKeys.filter((key) => key === args.expectedSourceOccurrenceKey).length !== 1 ||
    !sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence)
  ) {
    throw new Error("Source occurrence receipt changed or is not represented by this event.");
  }

  const nextFields = {
    ...currentFields,
    canonicalVenueLocation: targetVenue.location,
    manualVenueCanonicalizationPreviousVenue: event.venue,
    manualVenueCanonicalizationReason: "source_location_matches_canonical_venue",
    manualVenueCanonicalizationSourceHandle: sourceHandle,
    manualVenueCanonicalizationVersion: 1,
    normalizedVenue: targetVenue.name,
    rawVenueMatchesCanonicalLocation: true,
  };
  const nextNormalizedFieldsJson = JSON.stringify(nextFields);
  const venueFields: VenueDenormalizedFields = {
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
  const nextModerationNote = [event.moderationNote?.trim(), moderationNote]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const effectiveEvent: Doc<"events"> = {
    ...event,
    ...venueFields,
    venue: targetVenue.name,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    moderationNote: nextModerationNote,
  };
  const nextExpectedOccurrence = {
    ...expectedOccurrence,
    venue: targetVenue.name,
  };
  if (
    !sourceOccurrenceRepresentativeMatchesExpected(
      effectiveEvent,
      nextExpectedOccurrence,
    )
  ) {
    throw new Error("Repaired event would not represent its source occurrence.");
  }
  await dependencies.assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
    throw new Error("Repaired event would no longer be publicly source-grounded.");
  }

  const affectedRepresentativeIds = await dependencies.rebindCanonicalVenue(
    ctx,
    event,
    effectiveEvent,
  );

  const updatedAt = nextEventUpdatedAt(event.updatedAt);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt);
  await ctx.db.patch(event._id, {
    ...venueFields,
    venue: targetVenue.name,
    normalizedFieldsJson: nextNormalizedFieldsJson,
    moderationNote: nextModerationNote,
    updatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: expectedOccurrences.map((occurrence) =>
      occurrence.key === args.expectedSourceOccurrenceKey
        ? nextExpectedOccurrence
        : occurrence,
    ),
    updatedAt: receiptUpdatedAt,
  });
  await dependencies.refreshCanonicalEventDerivedStates(
    ctx,
    affectedRepresentativeIds,
  );
  await dependencies.writeEventAuditLog(
    ctx,
    event._id,
    "approved_legacy_venue_repaired",
    {
      actor,
      note: moderationNote,
      patch: {
        previousVenue: event.venue,
        receiptId: receipt._id,
        sourceHandle,
        sourceIdentity: receipt.sourceIdentity,
        sourceOccurrenceKey: args.expectedSourceOccurrenceKey,
        targetVenue: targetVenue.name,
        targetVenueId: targetVenue._id,
      },
    },
  );
  return {
    receiptUpdatedAt,
    status: "approved" as const,
    updated: true,
    updatedAt,
  };
}
