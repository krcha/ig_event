import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import {
  evaluateEventPublication,
  isEventPubliclyVisible,
} from "../../publicationPolicy";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { savedEventRepository } from "../../repositories/savedEvents";
import { resolveVenueDenormalizedFieldsFromPublicVenues } from "../../eventDomain/moderationVenue";
import {
  prepareInstagramOccurrenceTopologyForDedicatedReattestation,
  reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "../../eventDomain/sourceApproval";
import {
  loadReviewedStructuredCorrectionContext,
  type ReviewedStructuredReceipt,
} from "./reviewedStructuredCorrections";
import {
  reviewedTitleEvidenceMatchesBoundScheduleRow,
  supersedeReviewedAccountVenueFallback,
} from "./reviewedCaptionEvidence";

const POLICY_VERSION = 1;
const MAX_REVIEWED_SAVES = 100;
const MAX_REVIEWED_AUDITS = 100;
// Publication must refresh inline in this transaction, without deferred holds.
const MAX_AFFECTED_REPRESENTATIVES = 4;

export type ReviewedPromoterScheduleSourceVersion = {
  sourceLinkId: Id<"instagramEventSources">;
  sourceLinkUpdatedAt: number;
  receiptId: Id<"instagramSourceOccurrenceReceipts">;
  receiptUpdatedAt: number;
  sourceOccurrenceId: Id<"sourceOccurrences">;
  sourceOccurrenceUpdatedAt: number;
};

export type ReviewedPromoterScheduleFoldArgs = {
  operationId: string;
  primaryId: Id<"events">;
  expectedPrimaryUpdatedAt: number;
  expectedPrimaryNormalizedFieldsJson: string;
  primarySource: ReviewedPromoterScheduleSourceVersion;
  duplicateId: Id<"events">;
  expectedDuplicateUpdatedAt: number;
  expectedDuplicateNormalizedFieldsJson: string;
  duplicateSource: ReviewedPromoterScheduleSourceVersion;
  expectedPrimarySourceHandle: string;
  expectedScheduleSourceHandle: string;
  targetVenueId: Id<"venues">;
  expectedTargetVenueUpdatedAt: number;
  expectedTargetVenueHandle: string;
  nextVenue: string;
  programTitle: string;
  nextTitle: string;
  expectedScheduleRow: string;
  expectedScheduleCaptionLine: string;
  nextDescription: string;
  moderationNote: string;
  serviceSecret: string;
};

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function comparable(value: string): string {
  return clean(value).toLocaleLowerCase("sr-Latn");
}

function containsWholeText(haystack: string, needle: string): boolean {
  const escaped = comparable(needle).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    Boolean(escaped) &&
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}._])${escaped}(?=$|[^\\p{L}\\p{N}._])`,
      "u",
    ).test(comparable(haystack))
  );
}

function hasExplicitDayMonth(text: string, isoDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)) return false;
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== isoDate
  )
    return false;
  const [, month, day] = isoDate.split("-");
  return new RegExp(
    `(?:^|[^0-9])0?${Number(day)}\\.0?${Number(month)}(?:\\.|(?=$|[^0-9]))`,
    "u",
  ).test(text);
}

async function serviceActor(
  ctx: QueryCtx | MutationCtx,
  secret: string,
): Promise<string> {
  const authorization = await requireAdminOrServiceSecret(ctx, secret);
  if (authorization.kind !== "service")
    throw new Error(
      "Reviewed promoter schedule folding requires service authentication.",
    );
  return authorization.actor;
}

async function exactSourceContext(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  version: ReviewedPromoterScheduleSourceVersion,
) {
  const context = await loadReviewedStructuredCorrectionContext(ctx, event, {
    expectedSourceLinkId: version.sourceLinkId,
    expectedSourceLinkUpdatedAt: version.sourceLinkUpdatedAt,
    expectedReceiptId: version.receiptId,
    expectedReceiptUpdatedAt: version.receiptUpdatedAt,
  });
  const topology =
    await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
      ctx,
      event._id,
    );
  const occurrence = topology.currentOccurrences[0];
  if (
    topology.links.length !== 1 ||
    topology.occurrences.length !== 1 ||
    topology.currentOccurrences.length !== 1 ||
    topology.receipts.length !== 1 ||
    topology.links[0]?._id !== context.sourceLink._id ||
    !occurrence ||
    occurrence._id !== version.sourceOccurrenceId ||
    occurrence.updatedAt !== version.sourceOccurrenceUpdatedAt ||
    context.sourceLink.sourceOccurrenceId !== occurrence._id ||
    occurrence.canonicalEventId !== event._id ||
    occurrence.state !== "satisfied"
  )
    throw new Error(
      "Reviewed promoter schedule first-class occurrence changed or is incomplete.",
    );
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(
    ctx,
    event._id,
    event,
  );
  return { ...context, topology, occurrence };
}

/** Complete bounded operator context, including first-class CAS revisions and audit recovery. */
export async function getReviewedPromoterScheduleFoldContextHandler(
  ctx: QueryCtx,
  args: {
    operationId: string;
    primaryId: Id<"events">;
    duplicateId: Id<"events">;
    targetVenueId: Id<"venues">;
    serviceSecret: string;
  },
) {
  await serviceActor(ctx, args.serviceSecret);
  const load = async (id: Id<"events">) => {
    const event = await ctx.db.get(id);
    const links = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", id))
      .take(3);
    if (links.length > 2)
      throw new Error(
        "Reviewed promoter schedule context source bound exceeded.",
      );
    const sources = await Promise.all(
      links.map(async (link) => {
        const receipts = await ctx.db
          .query("instagramSourceOccurrenceReceipts")
          .withIndex("by_sourceIdentity", (q) =>
            q.eq("sourceIdentity", link.sourceIdentity),
          )
          .take(2);
        if (receipts.length > 1)
          throw new Error(
            "Reviewed promoter schedule context receipt is ambiguous.",
          );
        return {
          link,
          receipt: receipts[0] ?? null,
          occurrence: link.sourceOccurrenceId
            ? await ctx.db.get(link.sourceOccurrenceId)
            : null,
        };
      }),
    );
    const saves = await savedEventRepository.loadEventReferences(ctx, id, {
      limit: MAX_REVIEWED_SAVES,
    });
    const audits = await ctx.db
      .query("eventAuditLog")
      .withIndex("by_event", (q) => q.eq("eventId", id))
      .take(MAX_REVIEWED_AUDITS + 1);
    if (audits.length > MAX_REVIEWED_AUDITS)
      throw new Error("Reviewed promoter schedule audit bound exceeded.");
    return {
      event,
      sources,
      saves,
      audits: audits.filter((audit) => {
        if (
          !audit.action.startsWith("reviewed_promoter_schedule_") ||
          !audit.patchJson
        )
          return false;
        try {
          return (
            (JSON.parse(audit.patchJson) as Record<string, unknown>)
              .operationId === args.operationId
          );
        } catch {
          return false;
        }
      }),
    };
  };
  const [primary, duplicate, targetVenue] = await Promise.all([
    load(args.primaryId),
    load(args.duplicateId),
    ctx.db.get(args.targetVenueId),
  ]);
  return { primary, duplicate, targetVenue };
}

/**
 * Human-reviewed bridge between a promoter announcement and one exact venue
 * schedule row. It preserves unknown time and the promoter's complete artist
 * set, without relaxing automatic or general duplicate/venue repair rules.
 */
export async function foldReviewedPromoterScheduleDuplicateHandler(
  ctx: MutationCtx,
  args: ReviewedPromoterScheduleFoldArgs,
) {
  const actor = await serviceActor(ctx, args.serviceSecret);
  const primaryHandle = normalizeHandle(args.expectedPrimarySourceHandle);
  const scheduleHandle = normalizeHandle(args.expectedScheduleSourceHandle);
  const targetHandle = normalizeHandle(args.expectedTargetVenueHandle);
  const revisions = [
    args.expectedPrimaryUpdatedAt,
    args.expectedDuplicateUpdatedAt,
    args.expectedTargetVenueUpdatedAt,
    ...[args.primarySource, args.duplicateSource].flatMap((source) => [
      source.sourceLinkUpdatedAt,
      source.receiptUpdatedAt,
      source.sourceOccurrenceUpdatedAt,
    ]),
  ];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(args.operationId) ||
    args.primaryId === args.duplicateId ||
    args.primarySource.sourceLinkId === args.duplicateSource.sourceLinkId ||
    args.primarySource.receiptId === args.duplicateSource.receiptId ||
    args.primarySource.sourceOccurrenceId ===
      args.duplicateSource.sourceOccurrenceId ||
    !primaryHandle ||
    !scheduleHandle ||
    primaryHandle === scheduleHandle ||
    scheduleHandle !== targetHandle ||
    revisions.some(
      (revision) => !Number.isSafeInteger(revision) || revision < 0,
    ) ||
    [
      args.nextVenue,
      args.programTitle,
      args.nextTitle,
      args.expectedScheduleRow,
      args.expectedScheduleCaptionLine,
      args.nextDescription,
      args.moderationNote,
    ].some(
      (value) => !value || value !== clean(value) || value.length > 2000,
    ) ||
    args.moderationNote.length < 24
  )
    throw new Error(
      "Reviewed promoter schedule folding arguments are invalid.",
    );

  const [primary, duplicate, targetVenue] = await Promise.all([
    ctx.db.get(args.primaryId),
    ctx.db.get(args.duplicateId),
    ctx.db.get(args.targetVenueId),
  ]);
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
      args.expectedDuplicateNormalizedFieldsJson ||
    primary.date !== duplicate.date ||
    primary.time !== "TBD" ||
    duplicate.time !== "TBD" ||
    primary.instagramPostId === duplicate.instagramPostId ||
    primary.instagramPostUrl === duplicate.instagramPostUrl ||
    !targetVenue ||
    targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
    normalizeHandle(targetVenue.instagramHandle) !== targetHandle ||
    targetVenue.name !== args.nextVenue ||
    !isVenuePublic(targetVenue) ||
    duplicate.venueId !== targetVenue._id ||
    duplicate.venue !== targetVenue.name ||
    normalizeHandle(duplicate.venueInstagramHandle ?? "") !== targetHandle
  )
    throw new Error(
      "Reviewed promoter schedule event or venue precondition failed.",
    );
  if (
    !(await isCanonicallyGroundedApprovedEvent(ctx, primary)) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, duplicate))
  ) {
    throw new Error(
      "Reviewed promoter schedule folding requires two source-grounded approved events.",
    );
  }
  const [primaryContext, duplicateContext] = await Promise.all([
    exactSourceContext(ctx, primary, args.primarySource),
    exactSourceContext(ctx, duplicate, args.duplicateSource),
  ]);
  if (
    normalizeHandle(
      String(primaryContext.currentFields.sourceGroundingInstagramHandle ?? ""),
    ) !== primaryHandle ||
    normalizeHandle(
      String(
        duplicateContext.currentFields.sourceGroundingInstagramHandle ?? "",
      ),
    ) !== scheduleHandle ||
    primaryContext.sourceLink.sourceIdentity ===
      duplicateContext.sourceLink.sourceIdentity ||
    primaryContext.receipt.satisfiedOccurrences.some(
      (row) => row.eventId === duplicate._id,
    ) ||
    duplicateContext.receipt.satisfiedOccurrences.some(
      (row) => row.eventId === primary._id,
    ) ||
    primaryContext.currentFields.multiEventSplitDetected !== false ||
    duplicateContext.currentFields.multiEventSplitDetected !== true ||
    args.programTitle !== duplicate.title ||
    (args.nextTitle !== args.programTitle &&
      args.nextTitle !== primary.title) ||
    !containsWholeText(primary.sourceCaption ?? "", args.programTitle) ||
    duplicateContext.currentFields.rowSourceText !== args.expectedScheduleRow ||
    !reviewedTitleEvidenceMatchesBoundScheduleRow({
      currentFields: duplicateContext.currentFields,
      rawExtraction: duplicateContext.rawExtraction,
      eventDate: duplicate.date,
      nextTitle: args.programTitle,
      titleEvidence: args.expectedScheduleRow,
    }) ||
    !hasExplicitDayMonth(args.expectedScheduleRow, primary.date) ||
    !(duplicate.sourceCaption ?? "")
      .split(/\r?\n/u)
      .some((line) => clean(line) === args.expectedScheduleCaptionLine) ||
    !hasExplicitDayMonth(args.expectedScheduleCaptionLine, primary.date) ||
    !containsWholeText(args.expectedScheduleCaptionLine, `@${primaryHandle}`)
  )
    throw new Error(
      "Reviewed promoter schedule row-local cross-source evidence is incomplete.",
    );

  // Bound saved references before the first write, including deduplicated legacy references.
  await Promise.all(
    [primary._id, duplicate._id].map((id) =>
      savedEventRepository.loadEventReferences(ctx, id, {
        limit: MAX_REVIEWED_SAVES,
      }),
    ),
  );
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
    [targetVenue],
    args.nextVenue,
  );
  if (venueFields.venueId !== targetVenue._id)
    throw new Error(
      "Reviewed promoter schedule target venue did not resolve exactly.",
    );
  const reviewedAt = Date.now();
  const marker = {
    policyVersion: POLICY_VERSION,
    operationId: args.operationId,
    reviewedAt,
    reviewedBy: actor,
    primaryEventId: primary._id,
    duplicateEventId: duplicate._id,
    primarySource: args.primarySource,
    duplicateSource: args.duplicateSource,
    primarySourceIdentity: primaryContext.sourceLink.sourceIdentity,
    scheduleSourceIdentity: duplicateContext.sourceLink.sourceIdentity,
    primarySourceHandle: primaryHandle,
    scheduleSourceHandle: scheduleHandle,
    targetVenueId: targetVenue._id,
    targetVenueUpdatedAt: targetVenue.updatedAt,
    programTitle: args.programTitle,
    scheduleRow: args.expectedScheduleRow,
    scheduleCaptionLine: args.expectedScheduleCaptionLine,
    preservedPrimaryArtists: primary.artists,
    preservedPrimaryTime: primary.time,
  };
  const fallback = supersedeReviewedAccountVenueFallback({
    currentFields: primaryContext.currentFields,
    event: primary,
    venueFields,
    nextVenue: args.nextVenue,
    reviewedAt,
    actor,
    evidence: `${args.expectedScheduleCaptionLine}; ${args.expectedScheduleRow}`,
  });
  const nextFields = {
    ...fallback.fields,
    title: args.nextTitle,
    normalizedVenue: args.nextVenue,
    artists: primary.artists,
    description: args.nextDescription,
    moderationAutoApproved: false,
    moderationAutoApproveRule: null,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedPromoterScheduleFold: marker,
  };
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, reviewedAt);
  const duplicateUpdatedAt = nextEventUpdatedAt(
    duplicate.updatedAt,
    reviewedAt,
  );
  const effectivePrimary: Doc<"events"> = {
    ...primary,
    ...venueFields,
    title: args.nextTitle,
    venue: args.nextVenue,
    description: args.nextDescription,
    normalizedFieldsJson: JSON.stringify(nextFields),
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: `[reviewed_promoter_schedule_primary:v${POLICY_VERSION}] ${args.operationId} - ${args.moderationNote}`,
    updatedAt: primaryUpdatedAt,
  };
  if (
    !hasHumanReviewableStructuredSourceAttestation(
      effectivePrimary.normalizedFieldsJson,
      effectivePrimary,
    )
  )
    throw new Error(
      "Reviewed promoter schedule representative is not source-attested.",
    );
  await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, {
    allowHumanReviewedStructured: true,
  });
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, [
    primary._id,
    duplicate._id,
  ]);
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary)))
    throw new Error(
      "Reviewed promoter schedule representative is not publicly grounded.",
    );

  const plans = [primaryContext, duplicateContext].map((context) => ({
    context,
    expectedOccurrences: context.receipt.expectedOccurrences.map(
      (row, index) =>
        index === context.occurrenceIndex
          ? {
              ...row,
              date: effectivePrimary.date,
              time: effectivePrimary.time,
              venue: effectivePrimary.venue,
              title: effectivePrimary.title,
              artists: effectivePrimary.artists,
            }
          : row,
    ),
  }));
  const affectedIds = new Set<Id<"events">>([primary._id, duplicate._id]);
  for (const plan of plans) {
    for (const satisfaction of plan.context.receipt.satisfiedOccurrences) {
      affectedIds.add(satisfaction.eventId);
      const expected = plan.expectedOccurrences.filter(
        (row) => row.key === satisfaction.key,
      );
      const representative =
        satisfaction.eventId === primary._id ||
        satisfaction.eventId === duplicate._id
          ? effectivePrimary
          : await ctx.db.get(satisfaction.eventId);
      if (
        expected.length !== 1 ||
        !sourceOccurrenceRepresentativeMatchesExpected(
          representative,
          expected[0],
        ) ||
        !representative ||
        !(await isCanonicallyGroundedApprovedEvent(ctx, representative))
      ) {
        throw new Error(
          "Reviewed promoter schedule folding would alter an unrelated receipt sibling.",
        );
      }
    }
  }
  if (affectedIds.size > MAX_AFFECTED_REPRESENTATIVES)
    throw new Error(
      "Reviewed promoter schedule representative bound exceeded.",
    );
  const siblingPublicationBefore = new Map<
    Id<"events">,
    {
      decision: Awaited<ReturnType<typeof evaluateEventPublication>>;
      visible: boolean;
    }
  >();
  for (const id of affectedIds) {
    if (id === primary._id || id === duplicate._id) continue;
    const sibling = await ctx.db.get(id);
    if (!sibling)
      throw new Error("Reviewed promoter schedule sibling disappeared.");
    siblingPublicationBefore.set(id, {
      decision: await evaluateEventPublication(ctx, sibling),
      visible: await isEventPubliclyVisible(ctx, sibling, {
        allowNeverMigratedApproved: true,
      }),
    });
  }
  // The duplicate topology must be captured while both events/receipts still agree.
  const duplicateTopology =
    await prepareInstagramOccurrenceTopologyForDedicatedReattestation(
      ctx,
      duplicate._id,
    );

  await ctx.db.patch(primary._id, {
    ...venueFields,
    title: effectivePrimary.title,
    venue: effectivePrimary.venue,
    description: effectivePrimary.description,
    normalizedFieldsJson: effectivePrimary.normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion:
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt,
    reviewedBy: actor,
    moderationNote: effectivePrimary.moderationNote,
    updatedAt: primaryUpdatedAt,
  });
  for (const plan of plans)
    await ctx.db.patch(plan.context.receipt._id, {
      expectedOccurrences: plan.expectedOccurrences,
      updatedAt: nextEventUpdatedAt(plan.context.receipt.updatedAt, reviewedAt),
    });
  await ctx.db.patch(duplicate._id, {
    status: "rejected",
    normalizedFieldsJson: JSON.stringify({
      ...duplicateContext.currentFields,
      reviewedPromoterScheduleDuplicate: marker,
    }),
    reviewedAt,
    reviewedBy: actor,
    moderationNote: `[reviewed_promoter_schedule_duplicate:v${POLICY_VERSION}] ${args.operationId} - ${args.moderationNote}`,
    updatedAt: duplicateUpdatedAt,
  });
  await reassignInstagramOccurrenceReferences(
    ctx,
    duplicate._id,
    primary._id,
    duplicateTopology,
  );
  for (const plan of plans)
    await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
      ctx,
      {
        expected: plan.expectedOccurrences[plan.context.occurrenceIndex]!,
        representative: effectivePrimary,
        sourceFingerprint: plan.context.receipt.sourceFingerprint,
        sourceLink: plan.context.sourceLink,
        topologyEpochVerified: true,
      },
    );

  // Certify all surviving compatibility and first-class bindings before the transaction can commit.
  const finalPrimaryTopology =
    await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
      ctx,
      primary._id,
    );
  const finalDuplicateTopology =
    await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
      ctx,
      duplicate._id,
    );
  if (
    finalPrimaryTopology.links.length !== 2 ||
    finalPrimaryTopology.currentOccurrences.length !== 2 ||
    finalDuplicateTopology.links.length !== 0 ||
    finalDuplicateTopology.occurrences.length !== 0 ||
    finalDuplicateTopology.receipts.length !== 0
  ) {
    throw new Error(
      "Reviewed promoter schedule folding left incomplete provenance.",
    );
  }
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(
    ctx,
    primary._id,
    effectivePrimary,
  );
  for (const plan of plans) {
    const receipt = await ctx.db.get(plan.context.receipt._id);
    if (
      !receipt ||
      !exactJsonValue(receipt.expectedOccurrences, plan.expectedOccurrences)
    )
      throw new Error(
        "Reviewed promoter schedule receipt changed unexpectedly.",
      );
    await assertFinalReceiptBindings(ctx, receipt);
  }
  for (const before of [
    primaryContext.occurrence,
    duplicateContext.occurrence,
  ]) {
    const after = await ctx.db.get(before._id);
    if (
      !after ||
      after.factsJson !== before.factsJson ||
      after.canonicalEventJson !== before.canonicalEventJson ||
      after.sourceDocumentId !== before.sourceDocumentId ||
      after.sourceRevision !== before.sourceRevision
    )
      throw new Error(
        "Reviewed promoter schedule folding changed immutable observed source evidence.",
      );
  }
  const saveResult = await reassignSavedEventReferences(
    ctx,
    duplicate._id,
    primary._id,
  );
  await refreshCanonicalEventDerivedStates(ctx, [...affectedIds]);
  const publishedPrimary = await ctx.db.get(primary._id);
  if (
    !publishedPrimary ||
    (await evaluateEventPublication(ctx, publishedPrimary)).state !==
      "publishable" ||
    !(await isEventPubliclyVisible(ctx, publishedPrimary))
  ) {
    throw new Error(
      "Reviewed promoter schedule publication is incomplete for the retained primary.",
    );
  }
  for (const [id, before] of siblingPublicationBefore) {
    const sibling = await ctx.db.get(id);
    if (
      !sibling ||
      !exactJsonValue(
        await evaluateEventPublication(ctx, sibling),
        before.decision,
      ) ||
      (before.visible && !(await isEventPubliclyVisible(ctx, sibling)))
    ) {
      throw new Error(
        "Reviewed promoter schedule publication would hide or alter an unrelated sibling.",
      );
    }
  }
  for (const id of [primary._id, duplicate._id])
    await writeEventAuditLog(
      ctx,
      id,
      id === primary._id
        ? "reviewed_promoter_schedule_folded"
        : "reviewed_promoter_schedule_duplicate_rejected",
      {
        actor,
        note: args.moderationNote,
        patch: {
          ...marker,
          before: id === primary._id ? primary : duplicate,
          next: {
            title: effectivePrimary.title,
            venue: effectivePrimary.venue,
            artists: effectivePrimary.artists,
            time: effectivePrimary.time,
            description: effectivePrimary.description,
          },
          movedSaveCount: saveResult.movedCount,
          dedupedSaveCount: saveResult.dedupedCount,
        },
      },
    );
  const [primaryReceipt, duplicateReceipt] = await Promise.all([
    ctx.db.get(primaryContext.receipt._id),
    ctx.db.get(duplicateContext.receipt._id),
  ]);
  if (!primaryReceipt || !duplicateReceipt)
    throw new Error("Reviewed promoter schedule receipt disappeared.");
  return {
    operationId: args.operationId,
    primaryId: primary._id,
    primaryUpdatedAt,
    primaryReceiptUpdatedAt: primaryReceipt.updatedAt,
    duplicateId: duplicate._id,
    duplicateUpdatedAt,
    duplicateReceiptUpdatedAt: duplicateReceipt.updatedAt,
    movedSaveCount: saveResult.movedCount,
    dedupedSaveCount: saveResult.dedupedCount,
  };
}

async function assertFinalReceiptBindings(
  ctx: MutationCtx,
  receipt: ReviewedStructuredReceipt | Doc<"instagramSourceOccurrenceReceipts">,
): Promise<void> {
  for (const satisfaction of receipt.satisfiedOccurrences) {
    const expected = (receipt.expectedOccurrences ?? []).filter(
      (row) => row.key === satisfaction.key,
    );
    const representative = await ctx.db.get(satisfaction.eventId);
    if (
      expected.length !== 1 ||
      !representative ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        representative,
        expected[0],
      ) ||
      !(await isCanonicallyGroundedApprovedEvent(ctx, representative))
    ) {
      throw new Error(
        "Reviewed promoter schedule final receipt binding is not grounded.",
      );
    }
  }
}
