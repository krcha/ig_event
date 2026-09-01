import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  areCompatibleTitleFamilySlugs,
  buildTitleFamilySlug,
} from "../../../lib/events/deduplication-shared";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
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
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import {
  SavedEventRepositoryConflict,
  savedEventRepository,
} from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
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

const REVIEWED_CROSS_POST_SCHEDULE_FOLD_POLICY_VERSION = 1;
const MAX_REVIEWED_CROSS_POST_SOURCE_LINKS = 8;
const MAX_REVIEWED_CROSS_POST_SAVES = 100;
const MAX_REVIEWED_CROSS_POST_AUDITS = 100;

function parseReviewedCrossPostFields(
  value: string | undefined,
  label: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} normalized evidence is invalid.`);
  }
}

function readReviewedCrossPostRow(fields: Record<string, unknown>): string {
  for (const key of ["rowSourceText", "splitSourceLine"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    }
  }
  return "";
}

function normalizedReviewedCrossPostSourceVersions(
  values: Array<{
    id?: Id<"instagramEventSources">;
    _id?: Id<"instagramEventSources">;
    updatedAt: number;
  }>,
) {
  return values
    .map((value) => {
      const id = value.id ?? value._id;
      if (!id) {
        throw new Error(
          "Reviewed cross-post source version is missing its ID.",
        );
      }
      return { id, updatedAt: value.updatedAt };
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function getReviewedCrossPostScheduleFoldContextState(
  ctx: QueryCtx | MutationCtx,
  args: {
    operationId: string;
    primaryId: Id<"events">;
    duplicateId: Id<"events">;
  },
) {
  const [primary, duplicate] = await Promise.all([
    ctx.db.get(args.primaryId),
    ctx.db.get(args.duplicateId),
  ]);
  const loadSourceContexts = async (eventId: Id<"events">) => {
    const links = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(MAX_REVIEWED_CROSS_POST_SOURCE_LINKS + 1);
    if (links.length > MAX_REVIEWED_CROSS_POST_SOURCE_LINKS) {
      throw new Error(
        "Reviewed cross-post schedule source-link bound exceeded.",
      );
    }
    return Promise.all(
      links.map(async (link) => {
        const receipts = await ctx.db
          .query("instagramSourceOccurrenceReceipts")
          .withIndex("by_sourceIdentity", (q) =>
            q.eq("sourceIdentity", link.sourceIdentity),
          )
          .take(2);
        if (receipts.length > 1) {
          throw new Error("Reviewed cross-post schedule receipt is ambiguous.");
        }
        if (receipts[0]) {
          assertExistingSourceOccurrenceReceiptWithinBounds(receipts[0]);
        }
        return { link, receipt: receipts[0] ?? null };
      }),
    );
  };
  const loadSaveState = async (eventId: Id<"events">) => {
    try {
      const references = await savedEventRepository.loadEventReferences(
        ctx,
        eventId,
        { limit: MAX_REVIEWED_CROSS_POST_SAVES },
      );
      return {
        savedEvents: references.canonical,
        userSavedEvents: references.legacy,
      };
    } catch (error) {
      if (error instanceof SavedEventRepositoryConflict) {
        throw new Error("Reviewed cross-post schedule save bound exceeded.");
      }
      throw error;
    }
  };
  const loadAudits = async (eventId: Id<"events">) => {
    const rows = await ctx.db
      .query("eventAuditLog")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(MAX_REVIEWED_CROSS_POST_AUDITS + 1);
    if (rows.length > MAX_REVIEWED_CROSS_POST_AUDITS) {
      throw new Error("Reviewed cross-post schedule audit bound exceeded.");
    }
    return rows.filter((row) => {
      if (
        !new Set([
          "reviewed_cross_post_schedule_folded",
          "reviewed_cross_post_schedule_duplicate_rejected",
        ]).has(row.action) ||
        !row.patchJson
      ) {
        return false;
      }
      try {
        const patch = JSON.parse(row.patchJson) as Record<string, unknown>;
        return patch.operationId === args.operationId;
      } catch {
        return false;
      }
    });
  };

  const [
    primarySources,
    duplicateSources,
    primarySaves,
    duplicateSaves,
    primaryAudits,
    duplicateAudits,
  ] = await Promise.all([
    loadSourceContexts(args.primaryId),
    loadSourceContexts(args.duplicateId),
    loadSaveState(args.primaryId),
    loadSaveState(args.duplicateId),
    loadAudits(args.primaryId),
    loadAudits(args.duplicateId),
  ]);
  return {
    primary,
    duplicate,
    primarySources,
    duplicateSources,
    primarySaves,
    duplicateSaves,
    primaryAudits,
    duplicateAudits,
  };
}

/**
 * Returns the complete bounded before/after state for one human-reviewed
 * cross-post schedule-row fold. The operator uses this for immutable planning,
 * optimistic preconditions, and lost-acknowledgement recovery.
 */

export async function getReviewedCrossPostScheduleFoldContextHandler(
  ctx: QueryCtx,
  args: {
    operationId: string;
    primaryId: Id<"events">;
    duplicateId: Id<"events">;
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Reviewed cross-post schedule context requires service authentication.",
    );
  }
  return getReviewedCrossPostScheduleFoldContextState(ctx, args);
}

export async function foldReviewedCrossPostScheduleDuplicateHandler(
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
    duplicateId: Id<"events">;
    expectedDuplicateUpdatedAt: number;
    expectedDuplicateNormalizedFieldsJson: string;
    expectedDuplicateSourceVersions: Array<{
      id: Id<"instagramEventSources">;
      updatedAt: number;
    }>;
    targetVenueId: Id<"venues">;
    expectedTargetVenueUpdatedAt: number;
    expectedTargetVenueHandle: string;
    occurrenceAnchors: string[];
    primaryVenueEvidence: string;
    duplicateVenueEvidence: string;
    nextTitle: string;
    nextTime: string;
    nextVenue: string;
    nextArtists: string[];
    nextDescription: string;
    timeEvidenceText: string;
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
      "Reviewed cross-post schedule folding requires service authentication.",
    );
  }
  const operationId = args.operationId.trim();
  const moderationNote = args.moderationNote
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const occurrenceAnchors = args.occurrenceAnchors.map((value) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim(),
  );
  const primaryVenueEvidence = args.primaryVenueEvidence
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const duplicateVenueEvidence = args.duplicateVenueEvidence
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextTitle = args.nextTitle
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const nextTime = args.nextTime.normalize("NFKC").replace(/\s+/gu, " ").trim();
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
  const timeEvidenceText = args.timeEvidenceText
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(operationId) ||
    args.primaryId === args.duplicateId ||
    moderationNote.length < 24 ||
    occurrenceAnchors.length < 1 ||
    occurrenceAnchors.length > 4 ||
    occurrenceAnchors.some((value) => !value) ||
    new Set(occurrenceAnchors.map(normalizeLookup)).size !==
      occurrenceAnchors.length ||
    !primaryVenueEvidence ||
    !duplicateVenueEvidence ||
    !nextTitle ||
    !nextTime ||
    nextTime === "TBD" ||
    !nextVenue ||
    nextArtists.some((artist) => !artist) ||
    new Set(nextArtists).size !== nextArtists.length ||
    !nextDescription ||
    !timeEvidenceText ||
    nextTitle !== args.nextTitle ||
    nextTime !== args.nextTime ||
    nextVenue !== args.nextVenue ||
    nextDescription !== args.nextDescription ||
    timeEvidenceText !== args.timeEvidenceText ||
    nextArtists.some((artist, index) => artist !== args.nextArtists[index]) ||
    args.expectedDuplicateSourceVersions.length >
      MAX_REVIEWED_CROSS_POST_SOURCE_LINKS
  ) {
    throw new Error(
      "Reviewed cross-post schedule folding arguments are invalid.",
    );
  }
  for (const value of [
    args.expectedPrimaryUpdatedAt,
    args.expectedPrimarySourceLinkUpdatedAt,
    args.expectedPrimaryReceiptUpdatedAt,
    args.expectedDuplicateUpdatedAt,
    args.expectedTargetVenueUpdatedAt,
    ...args.expectedDuplicateSourceVersions.map((version) => version.updatedAt),
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        "Reviewed cross-post schedule folding requires safe optimistic revisions.",
      );
    }
  }
  if (
    new Set(
      args.expectedDuplicateSourceVersions.map((version) => String(version.id)),
    ).size !== args.expectedDuplicateSourceVersions.length
  ) {
    throw new Error(
      "Reviewed cross-post duplicate source versions are ambiguous.",
    );
  }

  const primary = await ctx.db.get(args.primaryId);
  const duplicate = await ctx.db.get(args.duplicateId);
  if (
    !primary ||
    !duplicate ||
    primary.status !== "approved" ||
    duplicate.status !== "approved" ||
    isCrossPostCampaignLineageEvent(primary) ||
    isCrossPostCampaignLineageEvent(duplicate) ||
    primary.updatedAt !== args.expectedPrimaryUpdatedAt ||
    duplicate.updatedAt !== args.expectedDuplicateUpdatedAt ||
    primary.normalizedFieldsJson !== args.expectedPrimaryNormalizedFieldsJson ||
    duplicate.normalizedFieldsJson !==
      args.expectedDuplicateNormalizedFieldsJson
  ) {
    throw new Error("Reviewed cross-post schedule event precondition failed.");
  }
  const primaryPostId = primary.instagramPostId?.trim() ?? "";
  const duplicatePostId = duplicate.instagramPostId?.trim() ?? "";
  const primaryPostUrl = requireCanonicalInstagramPostUrl(
    primary.instagramPostUrl,
    "Reviewed schedule fold primary source",
  );
  const duplicatePostUrl = requireCanonicalInstagramPostUrl(
    duplicate.instagramPostUrl,
    "Reviewed schedule fold duplicate source",
  );
  const matchingPostIds = Boolean(
    primaryPostId && duplicatePostId && primaryPostId === duplicatePostId,
  );
  const matchingPostUrls = Boolean(
    primaryPostUrl && duplicatePostUrl && primaryPostUrl === duplicatePostUrl,
  );
  const distinctPostIds = Boolean(
    primaryPostId && duplicatePostId && primaryPostId !== duplicatePostId,
  );
  const distinctPostUrls = Boolean(
    primaryPostUrl && duplicatePostUrl && primaryPostUrl !== duplicatePostUrl,
  );
  if (
    matchingPostIds ||
    matchingPostUrls ||
    (!distinctPostIds && !distinctPostUrls)
  ) {
    throw new Error(
      "Reviewed cross-post schedule folding requires two distinct Instagram posts.",
    );
  }
  if (
    primary.date !== duplicate.date ||
    !primary.time ||
    !duplicate.time ||
    primary.time === "TBD" ||
    duplicate.time === "TBD" ||
    primary.time !== duplicate.time ||
    primary.time !== nextTime ||
    !areCompatibleTitleFamilySlugs(
      buildTitleFamilySlug(primary.title),
      buildTitleFamilySlug(duplicate.title),
    ) ||
    !areCompatibleTitleFamilySlugs(
      buildTitleFamilySlug(primary.title),
      buildTitleFamilySlug(nextTitle),
    ) ||
    !exactJsonValue(primary.artists, duplicate.artists) ||
    !exactJsonValue(primary.artists, nextArtists)
  ) {
    throw new Error(
      "Reviewed cross-post schedule occurrence identity is not exact.",
    );
  }

  const primaryFields = parseReviewedCrossPostFields(
    primary.normalizedFieldsJson,
    "Primary",
  );
  const duplicateFields = parseReviewedCrossPostFields(
    duplicate.normalizedFieldsJson,
    "Duplicate",
  );
  const primaryRow = readReviewedCrossPostRow(primaryFields);
  const duplicateRow = readReviewedCrossPostRow(duplicateFields);
  const normalizedPrimaryRow = normalizeLookup(primaryRow);
  const normalizedDuplicateRow = normalizeLookup(duplicateRow);
  const normalizedNextTime = normalizeLookup(nextTime);
  const normalizedTimeEvidenceText = normalizeLookup(timeEvidenceText);
  if (
    primaryFields.multiEventSplitDetected !== true ||
    duplicateFields.multiEventSplitDetected !== true ||
    !primaryRow ||
    !duplicateRow ||
    occurrenceAnchors.some((anchor) => {
      const normalizedAnchor = normalizeLookup(anchor);
      return (
        !normalizedAnchor ||
        !normalizedPrimaryRow.includes(normalizedAnchor) ||
        !normalizedDuplicateRow.includes(normalizedAnchor)
      );
    }) ||
    !normalizedNextTime ||
    !normalizedPrimaryRow.includes(normalizedNextTime) ||
    !normalizedDuplicateRow.includes(normalizedNextTime) ||
    !normalizedTimeEvidenceText ||
    !normalizedPrimaryRow.includes(normalizedTimeEvidenceText) ||
    !normalizeLookup(primary.sourceCaption ?? "").includes(
      normalizeLookup(primaryVenueEvidence),
    ) ||
    !normalizeLookup(duplicate.sourceCaption ?? "").includes(
      normalizeLookup(duplicateVenueEvidence),
    )
  ) {
    throw new Error(
      "Reviewed cross-post schedule row-local evidence is incomplete.",
    );
  }

  const duplicateSourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", duplicate._id))
    .take(MAX_REVIEWED_CROSS_POST_SOURCE_LINKS + 1);
  if (
    duplicateSourceLinks.length > MAX_REVIEWED_CROSS_POST_SOURCE_LINKS ||
    !exactJsonValue(
      normalizedReviewedCrossPostSourceVersions(duplicateSourceLinks),
      normalizedReviewedCrossPostSourceVersions(
        args.expectedDuplicateSourceVersions,
      ),
    )
  ) {
    throw new Error(
      "Reviewed cross-post duplicate source links changed after review.",
    );
  }

  const { currentFields, sourceLink, receipt, occurrenceIndex } =
    await loadReviewedStructuredCorrectionContext(ctx, primary, {
      expectedSourceLinkId: args.expectedPrimarySourceLinkId,
      expectedSourceLinkUpdatedAt: args.expectedPrimarySourceLinkUpdatedAt,
      expectedReceiptId: args.expectedPrimaryReceiptId,
      expectedReceiptUpdatedAt: args.expectedPrimaryReceiptUpdatedAt,
    });
  if (
    receipt.satisfiedOccurrences.some(
      (occurrence) => occurrence.eventId === duplicate._id,
    )
  ) {
    throw new Error(
      "Reviewed cross-post duplicate already represents a primary receipt sibling.",
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
      "Reviewed cross-post schedule target venue is not exact and public.",
    );
  }
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
    [targetVenue],
    nextVenue,
  );
  if (venueFields.venueId !== targetVenue._id) {
    throw new Error(
      "Reviewed cross-post schedule target venue did not resolve exactly.",
    );
  }

  const reviewedAt = Date.now();
  const marker = {
    policyVersion: REVIEWED_CROSS_POST_SCHEDULE_FOLD_POLICY_VERSION,
    operationId,
    reviewedAt,
    reviewedBy: authorization.actor,
    primaryEventId: primary._id,
    duplicateEventId: duplicate._id,
    primarySourceIdentity: sourceLink.sourceIdentity,
    primarySourceOccurrenceKey: sourceLink.sourceOccurrenceKey,
    occurrenceAnchors,
    primaryRowSourceText: primaryRow,
    duplicateRowSourceText: duplicateRow,
    primaryVenueEvidence,
    duplicateVenueEvidence,
    targetVenueId: targetVenue._id,
  };
  const currentPendingReasons = Array.isArray(
    currentFields.moderationPendingReasons,
  )
    ? currentFields.moderationPendingReasons.map(String)
    : [];
  const currentSignals = Array.isArray(currentFields.moderationSignals)
    ? currentFields.moderationSignals.map(String)
    : [];
  const nextPrimaryFields = {
    ...currentFields,
    title: nextTitle,
    time: nextTime,
    normalizedVenue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    timeSource: "schedule_entry",
    timeEvidenceText,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
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
    reviewedCrossPostScheduleFold: marker,
  };
  const nextPrimaryNormalizedFieldsJson = JSON.stringify(nextPrimaryFields);
  const timePatch = normalizeEventTimeWritePatch({
    time: nextTime,
    timeSource: "schedule_entry",
    timeEvidenceText,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
  });
  const primaryModerationNote =
    `[reviewed_cross_post_schedule_primary:v${REVIEWED_CROSS_POST_SCHEDULE_FOLD_POLICY_VERSION}] ` +
    `${operationId} - ${moderationNote}`;
  const duplicateModerationNote =
    `[reviewed_cross_post_schedule_duplicate:v${REVIEWED_CROSS_POST_SCHEDULE_FOLD_POLICY_VERSION}] ` +
    `${operationId} - ${moderationNote}`;
  const effectivePrimary: Doc<"events"> = {
    ...primary,
    ...timePatch,
    ...venueFields,
    title: nextTitle,
    venue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    normalizedFieldsJson: nextPrimaryNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote: primaryModerationNote,
  };
  if (
    !isSensibleEventTitleForApproval(effectivePrimary) ||
    !hasHumanReviewableStructuredSourceAttestation(
      nextPrimaryNormalizedFieldsJson,
      effectivePrimary,
    )
  ) {
    throw new Error(
      "Reviewed cross-post schedule fold did not bind the representative.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, [
    primary._id,
    duplicate._id,
  ]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) {
    throw new Error(
      "Reviewed cross-post schedule representative is not publicly grounded.",
    );
  }

  const nextExpectedOccurrences = receipt.expectedOccurrences.map(
    (occurrence, index) =>
      index === occurrenceIndex
        ? {
            ...occurrence,
            date: effectivePrimary.date,
            time: effectivePrimary.time,
            venue: effectivePrimary.venue,
            title: effectivePrimary.title,
            artists: effectivePrimary.artists,
          }
        : occurrence,
  );
  for (const satisfied of receipt.satisfiedOccurrences) {
    const matchingExpected = nextExpectedOccurrences.filter(
      (occurrence) => occurrence.key === satisfied.key,
    );
    const representative =
      satisfied.eventId === primary._id
        ? effectivePrimary
        : await ctx.db.get(satisfied.eventId);
    if (
      matchingExpected.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        matchingExpected[0],
      )
    ) {
      throw new Error(
        "Reviewed cross-post schedule fold would alter a sibling receipt row.",
      );
    }
  }
  const duplicateSourceTopology =
    await prepareInstagramOccurrenceTopologyForDedicatedReattestation(
      ctx,
      duplicate._id,
    );

  const duplicateNextFields = {
    ...duplicateFields,
    reviewedCrossPostScheduleDuplicate: marker,
  };
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, reviewedAt);
  const duplicateUpdatedAt = nextEventUpdatedAt(
    duplicate.updatedAt,
    reviewedAt,
  );
  const primaryReceiptUpdatedAt = nextEventUpdatedAt(
    receipt.updatedAt,
    reviewedAt,
  );
  await ctx.db.patch(primary._id, {
    ...timePatch,
    ...venueFields,
    title: nextTitle,
    venue: nextVenue,
    artists: nextArtists,
    description: nextDescription,
    normalizedFieldsJson: nextPrimaryNormalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote: primaryModerationNote,
    updatedAt: primaryUpdatedAt,
  });
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: primaryReceiptUpdatedAt,
  });
  await ctx.db.patch(duplicate._id, {
    status: "rejected",
    normalizedFieldsJson: JSON.stringify(duplicateNextFields),
    reviewedAt,
    reviewedBy: authorization.actor,
    moderationNote: duplicateModerationNote,
    updatedAt: duplicateUpdatedAt,
  });
  await reassignInstagramOccurrenceReferences(
    ctx,
    duplicate._id,
    primary._id,
    duplicateSourceTopology,
    { preserveLegacyLinks: true },
  );
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: nextExpectedOccurrences[occurrenceIndex]!,
      representative: effectivePrimary,
      sourceFingerprint: receipt.sourceFingerprint,
      sourceLink,
      topologyEpochVerified: false,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  await refreshCanonicalEventDerivedStates(ctx, [primary._id, duplicate._id]);
  const saveResult = await reassignSavedEventReferences(
    ctx,
    duplicate._id,
    primary._id,
  );
  await writeEventAuditLog(
    ctx,
    primary._id,
    "reviewed_cross_post_schedule_folded",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: {
        ...marker,
        previous: {
          title: primary.title,
          time: primary.time ?? null,
          venue: primary.venue,
          artists: primary.artists,
          description: primary.description ?? null,
        },
        next: {
          title: nextTitle,
          time: nextTime,
          venue: nextVenue,
          artists: nextArtists,
          description: nextDescription,
        },
        primaryReceiptId: receipt._id,
        primaryReceiptBeforeUpdatedAt: receipt.updatedAt,
        primaryReceiptAfterUpdatedAt: primaryReceiptUpdatedAt,
        movedSaveCount: saveResult.movedCount,
        dedupedSaveCount: saveResult.dedupedCount,
      },
    },
  );
  await writeEventAuditLog(
    ctx,
    duplicate._id,
    "reviewed_cross_post_schedule_duplicate_rejected",
    {
      actor: authorization.actor,
      note: moderationNote,
      patch: {
        ...marker,
        duplicateSourceVersions:
          normalizedReviewedCrossPostSourceVersions(duplicateSourceLinks),
      },
    },
  );
  return {
    operationId,
    primaryId: primary._id,
    primaryUpdatedAt,
    primaryReceiptUpdatedAt,
    duplicateId: duplicate._id,
    duplicateUpdatedAt,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
}
