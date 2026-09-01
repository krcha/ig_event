import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  applyModerationDecision,
  isSkippableApprovalConflict,
  prepareModerationDecision,
  unwrapModerationResult,
  validateModerationDecision,
} from "../../lib/domain/moderation/index";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
} from "../../lib/events/event-update-precondition";
import { requireAdminIdentity } from "../authz";
import { markSourceOccurrenceTopologyMutation } from "../internal/sourceOccurrenceTopologyEpoch";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import {
  assertApprovalCandidatePolicy,
  assertPairwiseOccurrenceRelation,
} from "./sourceApproval";
import {
  assertHumanApprovalWithCanonicalVenueFallback,
  eventRejectionInvalidatesVerifiedReceiptTopology,
  prepareHumanApprovalCandidate,
  rebindHumanApprovalVenueProvenance,
} from "./moderationVenue";
import {
  buildPendingModerationUniquenessReview,
  type PendingModerationUniquenessReviewItem,
} from "./moderationUniqueness";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./persistence";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";

export async function approveUniquePendingEventsHandler(
  ctx: MutationCtx,
  args: {
    items: PendingModerationUniquenessReviewItem[];
    moderationNote: string;
  },
) {
  const identity = await requireAdminIdentity(ctx);
  const decision = unwrapModerationResult(
    prepareModerationDecision({
      kind: "human",
      entryPoint: "unique",
      targetStatus: "approved",
      moderationNote: args.moderationNote,
      trimModerationNote: true,
      noteConstraint: {
        minLength: 20,
        maxLength: 1_000,
        errorMessage:
          "Unique pending approval requires a moderation note of 20-1000 characters.",
      },
    }),
  );
  const moderationNote = decision.moderationNote ?? "";

  const now = Date.now();
  const review = await buildPendingModerationUniquenessReview(ctx, {
    items: args.items,
    asOfMs: now,
    moderationNote,
  });
  if (!review.result.complete) {
    return {
      complete: false,
      approvedIds: [],
      skipped: review.result.items.map((item) =>
        item.disposition === "unique"
          ? {
              ...item,
              disposition: "indeterminate" as const,
              reason: "indeterminate_batch_incomplete" as const,
              conflictIds: [],
            }
          : item,
      ),
    };
  }

  const approvedIds: Id<"events">[] = [];
  let topologyMutated = false;
  const skipped = review.result.items.filter(
    (item) => item.disposition !== "unique",
  );
  for (const item of review.result.items) {
    if (item.disposition !== "unique") continue;
    const event = review.reviewedEvents.get(item.id);
    const approval = review.approvals.get(item.id);
    if (!event || !approval) {
      throw new Error("Unique pending approval preparation is incomplete.");
    }
    requireCanonicalInstagramPostUrl(
      approval.prepared.candidate.instagramPostUrl,
      `Unique pending approval ${item.id}`,
    );
    const validatedDecision = unwrapModerationResult(
      validateModerationDecision(decision, {
        currentStatus: event.status,
        currentUpdatedAt: event.updatedAt,
        expectedUpdatedAt: item.expectedUpdatedAt,
      }),
    );
    const appliedDecision = unwrapModerationResult(
      applyModerationDecision(validatedDecision, {
        currentUpdatedAt: event.updatedAt,
        now,
        reviewedBy: identity.subject,
      }),
    );
    const provenanceRebind = await rebindHumanApprovalVenueProvenance(
      ctx,
      event,
      approval.prepared,
    );
    const affectedRepresentativeIds =
      provenanceRebind.affectedRepresentativeIds;
    topologyMutated ||= provenanceRebind.topologyMutated;
    await ctx.db.patch(item.id, {
      ...approval.prepared.venuePatch,
      ...approval.humanReviewPatch,
      ...buildEventOccurrenceIndexPatch(approval.prepared.candidate),
      ...appliedDecision.eventPatch,
    });
    await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
    await writeEventAuditLog(ctx, item.id, "approved", {
      actor: identity.subject,
      note: moderationNote,
      patch: {
        status: "approved",
        policy: "unique_pending",
      },
    });
    approvedIds.push(item.id);
  }

  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }

  return {
    complete: true,
    approvedIds,
    skipped,
  };
}

export async function setEventStatusHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    status: "approved" | "rejected";
    reviewedBy?: string;
    moderationNote?: string;
    expectedUpdatedAt?: number;
  },
) {
  const identity = await requireAdminIdentity(ctx);
  const existingEvent = await ctx.db.get(args.id);
  if (!existingEvent) {
    throw new Error("Event not found.");
  }

  const decision = unwrapModerationResult(
    prepareModerationDecision({
      kind: "human",
      entryPoint: "single",
      targetStatus: args.status,
      moderationNote: args.moderationNote,
    }),
  );
  const validatedDecision = unwrapModerationResult(
    validateModerationDecision(decision, {
      currentStatus: existingEvent.status,
      currentUpdatedAt: existingEvent.updatedAt,
      expectedUpdatedAt: args.expectedUpdatedAt,
    }),
  );
  const rejectionInvalidatesTopology =
    validatedDecision.targetStatus === "rejected" &&
    (await eventRejectionInvalidatesVerifiedReceiptTopology(
      ctx,
      existingEvent._id,
    ));

  let affectedRepresentativeIds: Id<"events">[] = [args.id];
  let topologyMutated = false;
  if (validatedDecision.targetStatus === "approved") {
    const prepared = await prepareHumanApprovalCandidate(ctx, existingEvent);
    requireCanonicalInstagramPostUrl(
      prepared.candidate.instagramPostUrl,
      `Human event approval ${args.id}`,
    );
    const humanReviewPatch =
      await assertHumanApprovalWithCanonicalVenueFallback(
        ctx,
        existingEvent,
        prepared,
        validatedDecision.moderationNote,
      );
    await assertApprovalCandidatePolicy(ctx, prepared.candidate, [args.id]);
    const provenanceRebind = await rebindHumanApprovalVenueProvenance(
      ctx,
      existingEvent,
      prepared,
    );
    affectedRepresentativeIds = provenanceRebind.affectedRepresentativeIds;
    topologyMutated = provenanceRebind.topologyMutated;
    await ctx.db.patch(args.id, {
      ...prepared.venuePatch,
      ...humanReviewPatch,
      ...buildEventOccurrenceIndexPatch(prepared.candidate),
    });
  }

  const now = Date.now();
  const appliedDecision = unwrapModerationResult(
    applyModerationDecision(validatedDecision, {
      currentUpdatedAt: existingEvent.updatedAt,
      now,
      reviewedBy: args.reviewedBy?.trim() || identity.subject,
    }),
  );
  await ctx.db.patch(args.id, appliedDecision.eventPatch);
  if (rejectionInvalidatesTopology) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  } else if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
  await writeEventAuditLog(ctx, args.id, validatedDecision.targetStatus, {
    actor: identity.subject,
    note: validatedDecision.moderationNote,
    patch: {
      status: validatedDecision.targetStatus,
    },
  });
  return null;
}

export async function setEventStatusesHandler(
  ctx: MutationCtx,
  args: {
    ids: Id<"events">[];
    expectedVersions?: Array<{
      id: Id<"events">;
      expectedUpdatedAt: number;
    }>;
    status: "approved" | "rejected";
    reviewedBy?: string;
    moderationNote?: string;
    approveAsDistinctSameVenueDateBatch?: boolean;
  },
) {
  const identity = await requireAdminIdentity(ctx);
  const decision = unwrapModerationResult(
    prepareModerationDecision({
      kind: "human",
      entryPoint: "batch",
      targetStatus: args.status,
      moderationNote: args.moderationNote,
    }),
  );
  const now = Date.now();
  const uniqueIds = [...new Set(args.ids)];
  if (uniqueIds.length === 0 || uniqueIds.length > 64) {
    throw new DomainError(
      "MODERATION_BATCH_INVALID",
      "Batch moderation requires 1-64 unique event IDs.",
    );
  }
  const preloadedEvents = new Map<Id<"events">, Doc<"events">>();
  if (args.expectedVersions !== undefined) {
    const expectedVersionById = new Map(
      args.expectedVersions.map(
        (item) => [item.id, item.expectedUpdatedAt] as const,
      ),
    );
    if (
      expectedVersionById.size !== args.expectedVersions.length ||
      expectedVersionById.size !== uniqueIds.length ||
      uniqueIds.some((id) => !expectedVersionById.has(id))
    ) {
      throw new DomainError(
        "MODERATION_BATCH_INVALID",
        "Expected versions must exactly match the moderated event IDs.",
      );
    }
    for (const id of uniqueIds) {
      const event = await ctx.db.get(id);
      if (!event || event.status !== "pending") {
        throw new DomainError(
          "STALE_EVENT_VERSION",
          `Event changed since the reviewed version: ${id} is missing or no longer pending.`,
        );
      }
      unwrapModerationResult(
        validateModerationDecision(decision, {
          currentStatus: event.status,
          currentUpdatedAt: event.updatedAt,
          expectedUpdatedAt: expectedVersionById.get(id),
        }),
      );
      preloadedEvents.set(id, event);
    }
  }
  if (
    args.approveAsDistinctSameVenueDateBatch &&
    (decision.targetStatus !== "approved" || uniqueIds.length < 2)
  ) {
    throw new DomainError(
      "MODERATION_BATCH_INVALID",
      "Distinct same-venue/date batch approval requires at least two approved event IDs.",
    );
  }
  const preparedApprovalCandidates = new Map<
    Id<"events">,
    Awaited<ReturnType<typeof prepareHumanApprovalCandidate>> & {
      humanReviewPatch: {
        normalizedFieldsJson?: string;
        humanReviewedLegacySourcePolicyVersion?: typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
        humanReviewedStructuredSourcePolicyVersion?: typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
      };
    }
  >();
  if (decision.targetStatus === "approved") {
    for (const id of uniqueIds) {
      const event = preloadedEvents.get(id) ?? (await ctx.db.get(id));
      if (!event || event.status !== "pending") {
        if (args.approveAsDistinctSameVenueDateBatch) {
          throw new Error("Every distinct-batch event must still be pending.");
        }
        continue;
      }
      const prepared = await prepareHumanApprovalCandidate(ctx, event);
      requireCanonicalInstagramPostUrl(
        prepared.candidate.instagramPostUrl,
        `Batch event approval ${id}`,
      );
      const humanReviewPatch =
        await assertHumanApprovalWithCanonicalVenueFallback(
          ctx,
          event,
          prepared,
          decision.moderationNote,
        );
      preparedApprovalCandidates.set(id, { ...prepared, humanReviewPatch });
    }
    if (args.approveAsDistinctSameVenueDateBatch) {
      assertPairwiseOccurrenceRelation(
        uniqueIds.map((id) => {
          const prepared = preparedApprovalCandidates.get(id);
          if (!prepared)
            throw new Error("Distinct-batch approval candidate is missing.");
          return prepared.candidate;
        }),
        "proven_distinct",
        "Distinct same-venue/date batch approval requires every pair to be proven distinct.",
      );
    }
  }
  let updatedCount = 0;
  let skippedCount = 0;
  let topologyMutated = false;
  let rejectionInvalidatesTopology = false;
  for (const id of uniqueIds) {
    const existingEvent = preloadedEvents.get(id) ?? (await ctx.db.get(id));
    if (!existingEvent || existingEvent.status !== "pending") {
      skippedCount += 1;
      continue;
    }

    let affectedRepresentativeIds: Id<"events">[] = [id];
    if (decision.targetStatus === "approved") {
      try {
        const prepared = preparedApprovalCandidates.get(id);
        if (!prepared) {
          throw new Error("Prepared approval candidate is missing.");
        }
        await assertApprovalCandidatePolicy(
          ctx,
          prepared.candidate,
          args.approveAsDistinctSameVenueDateBatch ? uniqueIds : [id],
        );
        const provenanceRebind = await rebindHumanApprovalVenueProvenance(
          ctx,
          existingEvent,
          prepared,
        );
        affectedRepresentativeIds = provenanceRebind.affectedRepresentativeIds;
        topologyMutated ||= provenanceRebind.topologyMutated;
        await ctx.db.patch(id, {
          ...prepared.venuePatch,
          ...prepared.humanReviewPatch,
          ...buildEventOccurrenceIndexPatch(prepared.candidate),
        });
      } catch (error) {
        if (!isSkippableApprovalConflict(error)) {
          throw error;
        }
        skippedCount += 1;
        continue;
      }
    }

    const validatedDecision = unwrapModerationResult(
      validateModerationDecision(decision, {
        currentStatus: existingEvent.status,
        currentUpdatedAt: existingEvent.updatedAt,
        ...(args.expectedVersions === undefined
          ? {}
          : { expectedUpdatedAt: existingEvent.updatedAt }),
      }),
    );
    if (
      validatedDecision.targetStatus === "rejected" &&
      (await eventRejectionInvalidatesVerifiedReceiptTopology(ctx, id))
    ) {
      rejectionInvalidatesTopology = true;
    }
    const appliedDecision = unwrapModerationResult(
      applyModerationDecision(validatedDecision, {
        currentUpdatedAt: existingEvent.updatedAt,
        now,
        reviewedBy: args.reviewedBy?.trim() || identity.subject,
      }),
    );
    await ctx.db.patch(id, appliedDecision.eventPatch);
    await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
    await writeEventAuditLog(ctx, id, validatedDecision.targetStatus, {
      actor: identity.subject,
      note: validatedDecision.moderationNote,
      patch: {
        status: validatedDecision.targetStatus,
      },
    });
    updatedCount += 1;
  }

  if (rejectionInvalidatesTopology) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: false });
  } else if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }

  return {
    updatedCount,
    skippedCount,
  };
}
