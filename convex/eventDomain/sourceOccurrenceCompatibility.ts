import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { nextEventUpdatedAt } from "../../lib/events/event-update-precondition";
import { requireAdminOrServiceSecret } from "../authz";
import {
  assertSourceProcessingFence,
  getLiveInstagramSourceOccurrenceReceipt,
  reconcileSourceOccurrenceReceiptAndSync,
  recordSourceOccurrenceSatisfaction,
  sourceProcessingFence,
  type SourceOccurrencePlan,
} from "../internal/sourceOccurrenceReceipts";
import { refreshEventPublicationStates } from "../publicationPolicy";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./persistence";

type SourceProcessingFence = Infer<typeof sourceProcessingFence>;

const executeLatestSourceOccurrenceShadowMutation =
  "reconciliation:executeLatestSourceOccurrenceShadow" as unknown as FunctionReference<
    "mutation",
    "internal"
  >;

export async function scheduleSourceOccurrenceShadow(
  ctx: MutationCtx,
  sourceOccurrenceId: Id<"sourceOccurrences">,
  legacyOutcome: "attach" | "create" | "update",
): Promise<void> {
  // Convex always supplies a scheduler. Direct handler characterization tests
  // intentionally use a minimal context, so scheduling is skipped there.
  const scheduler = (ctx as { scheduler?: MutationCtx["scheduler"] }).scheduler;
  if (!scheduler) return;
  await scheduler.runAfter(0, executeLatestSourceOccurrenceShadowMutation, {
    legacyOutcome,
    sourceOccurrenceId,
  });
}

export async function reconcileInstagramSourceOccurrenceReceiptHandler(
  ctx: MutationCtx,
  args: {
    plan: SourceOccurrencePlan;
    processingFence: SourceProcessingFence;
    serviceSecret?: string;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const sourceDocument = await assertSourceProcessingFence(
    ctx,
    args.processingFence,
  );
  const reconciliation = await reconcileSourceOccurrenceReceiptAndSync(
    ctx,
    args.plan,
    sourceDocument,
  );
  await refreshEventPublicationStates(
    ctx,
    reconciliation.affectedRepresentativeEventIds,
  );
  return { reconciled: reconciliation.reconciled };
}

export async function getInstagramSourceOccurrenceReceiptHandler(
  ctx: QueryCtx,
  args: { sourceIdentity: string; serviceSecret?: string },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  return getLiveInstagramSourceOccurrenceReceipt(ctx, args.sourceIdentity);
}

export async function recordInstagramSourceOccurrenceSatisfactionHandler(
  ctx: MutationCtx,
  args: {
    plan: SourceOccurrencePlan;
    satisfiedKey: string;
    representativeEventId: Id<"events">;
    supersededKey?: string;
    processingFence: SourceProcessingFence;
    serviceSecret?: string;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const sourceDocument = await assertSourceProcessingFence(
    ctx,
    args.processingFence,
  );
  const satisfaction = await recordSourceOccurrenceSatisfaction(
    ctx,
    args.plan,
    args.satisfiedKey,
    args.representativeEventId,
    sourceDocument,
    args.supersededKey,
  );
  await refreshEventPublicationStates(ctx, satisfaction.representativeEventIds);
  await scheduleSourceOccurrenceShadow(
    ctx,
    satisfaction.sourceOccurrenceId,
    "attach",
  );
  return { recorded: true };
}

export async function updateSourceOccurrenceExpectedCountHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    sourceOccurrenceKey: string;
    expectedCurrentCount: number;
    expectedCurrentKeys: string[];
    expectedCurrentDeferredChildCount: number;
    expectedCurrentSourceFingerprint?: string;
    nextExpectedCount: number;
    nextExpectedKeys: string[];
    nextDeferredChildCount: number;
    nextSourceFingerprint: string;
    confirmedPastKeys: string[];
    processingFence: SourceProcessingFence;
    serviceSecret?: string;
  },
) {
  const { actor } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  await assertSourceProcessingFence(ctx, args.processingFence);
  const currentKeySet = new Set(args.expectedCurrentKeys);
  const nextKeySet = new Set(args.nextExpectedKeys);
  const removedKeys = args.expectedCurrentKeys.filter(
    (key) => !nextKeySet.has(key),
  );
  const addedKeys = args.nextExpectedKeys.filter(
    (key) => !currentKeySet.has(key),
  );
  const safeSameSourceTransition =
    (removedKeys.length === 0 ||
      (addedKeys.length === 0 &&
        removedKeys.every((key) => args.confirmedPastKeys.includes(key)))) &&
    args.confirmedPastKeys.every((key) => removedKeys.includes(key));
  if (
    !Number.isInteger(args.expectedCurrentCount) ||
    !Number.isInteger(args.nextExpectedCount) ||
    !Number.isInteger(args.expectedCurrentDeferredChildCount) ||
    !Number.isInteger(args.nextDeferredChildCount) ||
    args.expectedCurrentCount < 1 ||
    args.nextExpectedCount < 1 ||
    args.expectedCurrentDeferredChildCount < 0 ||
    args.nextDeferredChildCount < 0 ||
    args.expectedCurrentKeys.length !== args.expectedCurrentCount ||
    args.nextExpectedKeys.length !== args.nextExpectedCount ||
    currentKeySet.size !== args.expectedCurrentKeys.length ||
    nextKeySet.size !== args.nextExpectedKeys.length ||
    new Set(args.confirmedPastKeys).size !== args.confirmedPastKeys.length ||
    !safeSameSourceTransition
  ) {
    throw new Error(
      "Source occurrence completeness metadata transition is not safe.",
    );
  }

  const existingEvent = await ctx.db.get(args.id);
  if (!existingEvent) {
    throw new Error("Event not found.");
  }
  if (existingEvent.sourceOccurrenceKey !== args.sourceOccurrenceKey) {
    throw new Error(
      "Source occurrence identity changed before metadata update.",
    );
  }

  let normalizedFields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(existingEvent.normalizedFieldsJson ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid normalized fields");
    }
    normalizedFields = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Source occurrence metadata is not valid JSON.");
  }

  if (normalizedFields.sourceOccurrenceKey !== args.sourceOccurrenceKey) {
    throw new Error(
      "Normalized source occurrence identity changed before metadata update.",
    );
  }
  if (
    normalizedFields.sourceOccurrenceExpectedCount === args.nextExpectedCount &&
    JSON.stringify(normalizedFields.sourceOccurrenceExpectedKeys) ===
      JSON.stringify(args.nextExpectedKeys) &&
    normalizedFields.sourceOccurrenceDeferredChildCount ===
      args.nextDeferredChildCount &&
    normalizedFields.sourceOccurrenceSourceFingerprint ===
      args.nextSourceFingerprint
  ) {
    return { updated: false };
  }
  if (isCrossPostCampaignLineageEvent(existingEvent)) {
    throw new Error(
      "Campaign occurrence completeness may only change through a dedicated re-attestation operation.",
    );
  }
  if (
    normalizedFields.sourceOccurrenceExpectedCount !==
      args.expectedCurrentCount ||
    JSON.stringify(normalizedFields.sourceOccurrenceExpectedKeys) !==
      JSON.stringify(args.expectedCurrentKeys) ||
    (normalizedFields.sourceOccurrenceDeferredChildCount ?? 0) !==
      args.expectedCurrentDeferredChildCount ||
    normalizedFields.sourceOccurrenceSourceFingerprint !==
      args.expectedCurrentSourceFingerprint
  ) {
    throw new Error(
      "Source occurrence completeness metadata changed before update.",
    );
  }

  const normalizedFieldsJson = JSON.stringify({
    ...normalizedFields,
    sourceOccurrenceExpectedCount: args.nextExpectedCount,
    sourceOccurrenceExpectedKeys: args.nextExpectedKeys,
    sourceOccurrenceDeferredChildCount: args.nextDeferredChildCount,
    sourceOccurrenceSourceFingerprint: args.nextSourceFingerprint,
  });
  await ctx.db.patch(args.id, {
    normalizedFieldsJson,
    updatedAt: nextEventUpdatedAt(existingEvent.updatedAt),
  });
  await writeEventAuditLog(
    ctx,
    args.id,
    "source_occurrence_completeness_updated",
    {
      actor,
      patch: {
        sourceOccurrenceKey: args.sourceOccurrenceKey,
        sourceOccurrenceExpectedCount: args.nextExpectedCount,
        sourceOccurrenceExpectedKeys: args.nextExpectedKeys,
        sourceOccurrenceDeferredChildCount: args.nextDeferredChildCount,
        sourceOccurrenceSourceFingerprint: args.nextSourceFingerprint,
      },
    },
  );
  await refreshCanonicalEventDerivedStates(ctx, [args.id]);
  return { updated: true };
}
