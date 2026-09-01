import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { buildInstagramSourceOccurrenceFingerprint } from "../../lib/domain/occurrences/source-fingerprint";
import { adaptInstagramScrapedPostToSourceDocument } from "../../lib/domain/source-documents";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { markSourceOccurrenceTopologyMutation } from "./sourceOccurrenceTopologyEpoch";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { syncSourceOccurrencePlan } from "../sourceOccurrences";
import {
  assertSourceOccurrenceSyncPlanWithinBounds,
  isSourceOccurrenceBoundedString,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
  sourceOccurrenceArrayHasUniqueBoundedStrings,
  sourceOccurrenceBindingWithinBounds,
  sourceOccurrenceSerializedPayloadWithinBounds,
} from "./sourceOccurrenceLimits";

export {
  MAX_SOURCE_OCCURRENCE_ARTISTS,
  MAX_STRUCTURED_FACTS_JSON_LENGTH,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
  MAX_SOURCE_OCCURRENCE_SERIALIZED_PAYLOAD_LENGTH,
  MAX_SOURCE_OCCURRENCE_STRING_LENGTH,
} from "./sourceOccurrenceLimits";

const MAX_RECONCILED_RECEIPT_REPRESENTATIVES =
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE;

export const sourceProcessingFence = v.object({
  handle: v.string(),
  scrapedPostId: v.optional(v.id("scrapedPosts")),
  postId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
  owner: v.string(),
  sourceRevision: v.number(),
});

export type SourceProcessingFence = {
  handle: string;
  scrapedPostId?: Id<"scrapedPosts">;
  postId?: string;
  instagramPostUrl?: string;
  owner: string;
  sourceRevision: number;
};

export const sourceOccurrencePlan = v.object({
  sourceIdentity: v.string(),
  sourceFingerprint: v.string(),
  expectedKeys: v.array(v.string()),
  expectedOccurrences: v.array(
    v.object({
      key: v.string(),
      date: v.string(),
      time: v.optional(v.string()),
      venue: v.string(),
      title: v.string(),
      artists: v.array(v.string()),
      factsJson: v.optional(v.string()),
      canonicalEventJson: v.optional(v.string()),
    }),
  ),
  deferredChildCount: v.number(),
  deferredChildKeys: v.array(v.string()),
  observedChildKeys: v.array(v.string()),
  previousSourceFingerprint: v.optional(v.union(v.string(), v.null())),
  confirmedPastKeys: v.optional(v.array(v.string())),
});

export type SourceOccurrencePlan = {
  sourceIdentity: string;
  sourceFingerprint: string;
  expectedKeys: string[];
  expectedOccurrences: Array<{
    key: string;
    date: string;
    time?: string;
    venue: string;
    title: string;
    artists: string[];
    factsJson?: string;
    canonicalEventJson?: string;
  }>;
  deferredChildCount: number;
  deferredChildKeys: string[];
  observedChildKeys: string[];
  previousSourceFingerprint?: string | null;
  confirmedPastKeys?: string[];
};

/**
 * Hard resource and shape fence shared by satisfaction, reconciliation and
 * migration callers before any first-class occurrence synchronization.
 */
export function assertSourceOccurrencePlanWithinBounds(
  plan: SourceOccurrencePlan,
): void {
  assertSourceOccurrenceSyncPlanWithinBounds(plan);
  if (
    !plan ||
    (plan.previousSourceFingerprint !== undefined &&
      plan.previousSourceFingerprint !== null &&
      !isSourceOccurrenceBoundedString(plan.previousSourceFingerprint)) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(plan.observedChildKeys) ||
    (plan.confirmedPastKeys !== undefined &&
      !sourceOccurrenceArrayHasUniqueBoundedStrings(plan.confirmedPastKeys)) ||
    !Number.isInteger(plan.deferredChildCount) ||
    plan.deferredChildCount < 0 ||
    plan.deferredChildCount > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    !sourceOccurrenceSerializedPayloadWithinBounds(plan)
  ) {
    throw new Error("Source occurrence receipt plan exceeds its hard bounds.");
  }
  const allKeys = new Set([
    ...plan.expectedKeys,
    ...plan.expectedOccurrences.map((occurrence) => occurrence.key),
    ...plan.deferredChildKeys,
    ...plan.observedChildKeys,
    ...(plan.confirmedPastKeys ?? []),
  ]);
  if (allKeys.size > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE) {
    throw new Error("Source occurrence receipt plan exceeds its total key bound.");
  }
}

/** Fails closed before iterating any persisted legacy receipt arrays. */
export function assertExistingSourceOccurrenceReceiptWithinBounds(
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
): void {
  const expectedOccurrences = receipt.expectedOccurrences ?? [];
  if (
    !isSourceOccurrenceBoundedString(receipt.sourceIdentity) ||
    !isSourceOccurrenceBoundedString(receipt.sourceFingerprint) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(receipt.expectedKeys) ||
    !Array.isArray(expectedOccurrences) ||
    expectedOccurrences.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    !expectedOccurrences.every(sourceOccurrenceBindingWithinBounds) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(receipt.satisfiedKeys) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(receipt.deferredChildKeys) ||
    !Number.isInteger(receipt.deferredChildCount) ||
    receipt.deferredChildCount < 0 ||
    receipt.deferredChildCount > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    !Array.isArray(receipt.satisfiedOccurrences) ||
    receipt.satisfiedOccurrences.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    receipt.satisfiedOccurrences.some(
      (occurrence) => !isSourceOccurrenceBoundedString(occurrence.key),
    ) ||
    !sourceOccurrenceSerializedPayloadWithinBounds(receipt)
  ) {
    throw new Error("Source occurrence receipt exceeds its hard bounds.");
  }
  const expectedOccurrenceKeys = expectedOccurrences.map(
    (occurrence) => occurrence.key,
  );
  const satisfiedOccurrenceKeys = receipt.satisfiedOccurrences.map(
    (occurrence) => occurrence.key,
  );
  const allKeys = new Set([
    ...receipt.expectedKeys,
    ...expectedOccurrenceKeys,
    ...receipt.satisfiedKeys,
    ...satisfiedOccurrenceKeys,
    ...receipt.deferredChildKeys,
  ]);
  const expectedKeySet = new Set(receipt.expectedKeys);
  if (
    allKeys.size > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    expectedOccurrenceKeys.length !== receipt.expectedKeys.length ||
    new Set(expectedOccurrenceKeys).size !== expectedOccurrenceKeys.length ||
    expectedOccurrenceKeys.some((key) => !expectedKeySet.has(key)) ||
    new Set(satisfiedOccurrenceKeys).size !== satisfiedOccurrenceKeys.length ||
    receipt.satisfiedKeys.length !== satisfiedOccurrenceKeys.length ||
    receipt.satisfiedKeys.some((key) => !satisfiedOccurrenceKeys.includes(key)) ||
    satisfiedOccurrenceKeys.some((key) => !expectedKeySet.has(key)) ||
    receipt.deferredChildCount !== receipt.deferredChildKeys.length ||
    receipt.deferredChildKeys.some((key) => expectedKeySet.has(key))
  ) {
    throw new Error("Source occurrence receipt is internally inconsistent.");
  }
}

function assertSourceOccurrencePlan(plan: SourceOccurrencePlan, satisfiedKey: string): void {
  assertSourceOccurrencePlanWithinBounds(plan);
  if (
    plan.expectedKeys.length < 1 ||
    new Set(plan.expectedKeys).size !== plan.expectedKeys.length ||
    plan.expectedOccurrences.length !== plan.expectedKeys.length ||
    new Set(plan.expectedOccurrences.map((item) => item.key)).size !==
      plan.expectedOccurrences.length ||
    plan.expectedOccurrences.some(
      (item) =>
        !plan.expectedKeys.includes(item.key),
    ) ||
    !plan.expectedKeys.includes(satisfiedKey) ||
    !Number.isInteger(plan.deferredChildCount) ||
    plan.deferredChildCount < 0 ||
    plan.deferredChildCount !== plan.deferredChildKeys.length ||
    new Set(plan.deferredChildKeys).size !== plan.deferredChildKeys.length ||
    new Set(plan.observedChildKeys).size !== plan.observedChildKeys.length ||
    plan.deferredChildKeys.some((key) => !plan.observedChildKeys.includes(key)) ||
    (plan.confirmedPastKeys !== undefined &&
      new Set(plan.confirmedPastKeys).size !== plan.confirmedPastKeys.length)
  ) {
    throw new Error("Source occurrence receipt plan is invalid.");
  }
}

export function eventRepresentsExpectedOccurrenceForTesting(
  event:
    | Pick<
        Doc<"events">,
        | "title"
        | "date"
        | "time"
        | "venue"
        | "artists"
        | "status"
        | "sourceOccurrenceKey"
        | "normalizedFieldsJson"
      >
    | null,
  expected: SourceOccurrencePlan["expectedOccurrences"][number] | undefined,
  options: { allowUnverifiedPending?: boolean } = {},
): boolean {
  return sourceOccurrenceRepresentativeMatchesExpected(event, expected, options);
}

export const eventRepresentsExpectedOccurrence = eventRepresentsExpectedOccurrenceForTesting;

export async function assertSourceProcessingFence(
  ctx: MutationCtx,
  fence: SourceProcessingFence,
): Promise<Doc<"scrapedPosts">> {
  if (
    !fence ||
    !fence.handle ||
    !fence.owner ||
    (!fence.scrapedPostId && !fence.postId && !fence.instagramPostUrl)
  ) {
    throw new Error("Invalid scraped-post processing fence.");
  }
  const exact = fence.scrapedPostId ? await ctx.db.get(fence.scrapedPostId) : null;
  if (
    fence.scrapedPostId &&
    (!exact ||
      exact.handle !== fence.handle ||
      (fence.postId && exact.postId !== fence.postId) ||
      (fence.instagramPostUrl && exact.instagramPostUrl !== fence.instagramPostUrl))
  ) {
    throw new Error("Exact scraped-post processing fence identity is absent or mismatched.");
  }
  const byPostId = !fence.scrapedPostId && fence.postId
    ? await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postId", (q) =>
          q.eq("handle", fence.handle).eq("postId", fence.postId as string),
        )
        .take(2)
    : [];
  const byPostUrl = !fence.scrapedPostId && fence.instagramPostUrl
    ? await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postUrl", (q) =>
          q
            .eq("handle", fence.handle)
            .eq("instagramPostUrl", fence.instagramPostUrl as string),
        )
        .take(2)
    : [];
  const candidates = exact
    ? [exact]
    : [...new Map([...byPostId, ...byPostUrl].map((post) => [post._id, post])).values()];
  if (candidates.length !== 1) {
    throw new Error("Scraped-post processing fence identity is absent or ambiguous.");
  }
  const source = candidates[0];
  if (
    !source ||
    source.processingStatus !== "processing" ||
    source.processingLeaseOwner !== fence.owner ||
    (source.processingLeaseExpiresAt ?? 0) <= Date.now() ||
    (source.sourceRevision ?? 1) !== fence.sourceRevision
  ) {
    throw new Error("Scraped-post processing fence is stale.");
  }
  return source;
}

export async function assertSourceOccurrenceGenerationCurrent(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
): Promise<void> {
  assertSourceOccurrencePlanWithinBounds(plan);
  const existing = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", plan.sourceIdentity))
    .unique();
  if (
    existing &&
    existing.sourceFingerprint !== plan.sourceFingerprint &&
    plan.previousSourceFingerprint !== existing.sourceFingerprint
  ) {
    throw new Error("Source occurrence receipt plan is stale.");
  }
}

/**
 * Binds a worker-produced plan to the exact durable SourceDocument protected
 * by the processing lease. Without this assertion, a stale or buggy service
 * caller could persist one post's identity/fingerprint beside another post's
 * canonical URL while still presenting a valid lease for the latter.
 */
export function assertSourceOccurrencePlanMatchesSourceDocument(
  plan: SourceOccurrencePlan,
  sourceDocument: Doc<"scrapedPosts">,
): void {
  const canonicalSourceDocument =
    adaptInstagramScrapedPostToSourceDocument(sourceDocument);
  const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({
    altText: sourceDocument.altText,
    caption: sourceDocument.caption,
    locationName: sourceDocument.locationName,
  });
  if (
    plan.sourceIdentity !== canonicalSourceDocument.sourceIdentity ||
    plan.sourceFingerprint !== sourceFingerprint
  ) {
    throw new Error(
      "Source occurrence plan identity or fingerprint does not match the fenced source document.",
    );
  }
}

/**
 * Materializes one complete, currently leased source plan before the generic
 * executor chooses any CanonicalEvent. This is the cutover ingress equivalent
 * of the legacy receipt-first invariant: every expected child exists before
 * the first child can be satisfied, and no legacy event matcher participates.
 */
export async function prepareSourceOccurrencePlanForReconciliation(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  sourceDocument: Doc<"scrapedPosts">,
): Promise<Id<"sourceOccurrences">[]> {
  assertSourceOccurrencePlanWithinBounds(plan);
  assertSourceOccurrencePlanMatchesSourceDocument(plan, sourceDocument);
  if (
    plan.expectedKeys.length === 0 ||
    plan.expectedOccurrences.length !== plan.expectedKeys.length
  ) {
    throw new Error(
      "Reconciliation ingress requires at least one complete expected occurrence.",
    );
  }
  await assertSourceOccurrenceGenerationCurrent(ctx, plan);
  const existingRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", plan.sourceIdentity),
    )
    .take(2);
  if (existingRows.length > 1) {
    throw new Error("Source occurrence receipt is duplicated.");
  }
  const existing = existingRows[0] ?? null;
  const now = Date.now();
  if (!existing) {
    await ctx.db.insert("instagramSourceOccurrenceReceipts", {
      createdAt: now,
      deferredChildCount: plan.deferredChildCount,
      deferredChildKeys: plan.deferredChildKeys,
      expectedKeys: plan.expectedKeys,
      expectedOccurrences: plan.expectedOccurrences,
      satisfiedKeys: [],
      satisfiedOccurrences: [],
      sourceFingerprint: plan.sourceFingerprint,
      sourceIdentity: plan.sourceIdentity,
      updatedAt: now,
    });
  } else {
    assertExistingSourceOccurrenceReceiptWithinBounds(existing);
    if (await isReceiptBoundToCrossPostCampaign(ctx, existing)) {
      throw new Error(
        "Campaign occurrence receipts require dedicated re-attestation before generic ingestion.",
      );
    }
    const expectedByKey = new Map(
      (existing.expectedOccurrences ?? []).map((occurrence) => [
        occurrence.key,
        occurrence,
      ]),
    );
    const semanticPlanMatches =
      existing.sourceFingerprint === plan.sourceFingerprint &&
      JSON.stringify([...existing.expectedKeys].sort()) ===
        JSON.stringify([...plan.expectedKeys].sort()) &&
      existing.deferredChildCount === plan.deferredChildCount &&
      JSON.stringify([...existing.deferredChildKeys].sort()) ===
        JSON.stringify([...plan.deferredChildKeys].sort()) &&
      plan.expectedOccurrences.every((expected) => {
        const current = expectedByKey.get(expected.key);
        return Boolean(
          current &&
            current.date === expected.date &&
            current.time === expected.time &&
            current.venue === expected.venue &&
            current.title === expected.title &&
            JSON.stringify(current.artists) === JSON.stringify(expected.artists) &&
            current.factsJson === expected.factsJson,
        );
      });
    if (!semanticPlanMatches) {
      throw new Error(
        "Existing source occurrence generation differs from the generic ingestion plan.",
      );
    }
    const expectedOccurrences = plan.expectedOccurrences.map((expected) => ({
      ...expectedByKey.get(expected.key)!,
      ...(expected.canonicalEventJson
        ? { canonicalEventJson: expected.canonicalEventJson }
        : {}),
    }));
    if (
      JSON.stringify(existing.expectedOccurrences ?? []) !==
      JSON.stringify(expectedOccurrences)
    ) {
      await ctx.db.patch(existing._id, {
        expectedOccurrences,
        updatedAt: now,
      });
    }
  }

  await syncSourceOccurrencePlan({
    ctx,
    plan,
    sourceDocument,
    topologyEpochVerified: true,
  });
  const occurrenceIds: Id<"sourceOccurrences">[] = [];
  for (const expectedKey of plan.expectedKeys) {
    const occurrence = await ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", plan.sourceIdentity)
          .eq("sourceOccurrenceKey", expectedKey),
      )
      .unique();
    if (!occurrence) {
      throw new Error(
        "Generic ingestion did not materialize every expected source occurrence.",
      );
    }
    occurrenceIds.push(occurrence._id);
  }
  return occurrenceIds;
}

async function upsertInstagramEventSourceLink(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  satisfiedKey: string,
  representativeEvent: Doc<"events">,
  supersededKey?: string,
  options: {
    canonicalSourceUrl?: string;
    rejectMaterialCampaignChange?: boolean;
    sourceOccurrenceId?: Id<"sourceOccurrences">;
  } = {},
): Promise<void> {
  const existingTarget = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", plan.sourceIdentity)
        .eq("sourceOccurrenceKey", satisfiedKey),
    )
    .unique();
  if (existingTarget && existingTarget.eventId !== representativeEvent._id) {
    throw new Error("Instagram occurrence source is already linked to another event.");
  }

  const supersededLink = supersededKey
    ? await ctx.db
        .query("instagramEventSources")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", plan.sourceIdentity)
            .eq("sourceOccurrenceKey", supersededKey),
        )
        .unique()
    : null;
  if (supersededLink && supersededLink.eventId !== representativeEvent._id) {
    throw new Error("Superseded Instagram occurrence source is linked to another event.");
  }

  const patch = {
    eventId: representativeEvent._id,
    sourceIdentity: plan.sourceIdentity,
    sourceFingerprint: plan.sourceFingerprint,
    sourceOccurrenceKey: satisfiedKey,
    ...(representativeEvent.instagramPostId
      ? { instagramPostId: representativeEvent.instagramPostId }
      : {}),
    ...(representativeEvent.instagramPostUrl
      ? { instagramPostUrl: representativeEvent.instagramPostUrl }
      : {}),
    ...(options.canonicalSourceUrl
      ? { canonicalSourceUrl: options.canonicalSourceUrl }
      : {}),
    ...(options.sourceOccurrenceId
      ? { sourceOccurrenceId: options.sourceOccurrenceId }
      : {}),
  };
  const targetNeedsPatch = Boolean(
    existingTarget &&
      Object.entries(patch).some(
        ([key, value]) =>
          JSON.stringify(existingTarget[key as keyof typeof existingTarget]) !==
          JSON.stringify(value),
      ),
  );
  const supersededNeedsDelete = Boolean(
    supersededLink && supersededLink._id !== existingTarget?._id,
  );
  if (
    options.rejectMaterialCampaignChange &&
    ((!existingTarget && !supersededLink) || targetNeedsPatch || supersededNeedsDelete)
  ) {
    throw new Error(
      "Campaign source links may only change through a dedicated re-attestation operation.",
    );
  }
  if (existingTarget && !targetNeedsPatch && !supersededNeedsDelete) {
    return;
  }
  const now = Date.now();
  const versionedPatch = { ...patch, updatedAt: now };

  if (existingTarget) {
    await ctx.db.patch(existingTarget._id, versionedPatch);
    if (supersededLink && supersededLink._id !== existingTarget._id) {
      await ctx.db.delete(supersededLink._id);
    }
    return;
  }
  if (supersededLink) {
    await ctx.db.patch(supersededLink._id, versionedPatch);
    return;
  }
  await ctx.db.insert("instagramEventSources", {
    ...versionedPatch,
    linkedAt: now,
  });
}

export type SourceOccurrenceSatisfactionResult = {
  receiptComplete: boolean;
  representativeEventIds: Id<"events">[];
  sourceOccurrenceId: Id<"sourceOccurrences">;
};

type ValidatedRetiredOccurrenceBindings = {
  legacyLinkIds: Id<"instagramEventSources">[];
  representativeEventIds: Id<"events">[];
};

async function validateRetiredOccurrenceBindings(
  ctx: MutationCtx,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  retiredKeys: readonly string[],
): Promise<ValidatedRetiredOccurrenceBindings> {
  const uniqueRetiredKeys = [...new Set(retiredKeys)];
  if (uniqueRetiredKeys.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE) {
    throw new Error("Retired source occurrence set exceeds the hard bound.");
  }
  const legacyLinkIds: Id<"instagramEventSources">[] = [];
  const representativeEventIds: Id<"events">[] = [];
  for (const retiredKey of uniqueRetiredKeys) {
    const satisfaction = receipt.satisfiedOccurrences.find(
      (occurrence) => occurrence.key === retiredKey,
    );
    const links = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", receipt.sourceIdentity)
          .eq("sourceOccurrenceKey", retiredKey),
      )
      .take(2);
    if (links.length > 1) {
      throw new Error("Retired source occurrence has multiple legacy links.");
    }
    const link = links[0];
    if (
      satisfaction &&
      (!link ||
        link.eventId !== satisfaction.eventId ||
        link.sourceFingerprint !== receipt.sourceFingerprint)
    ) {
      throw new Error(
        "Retired source occurrence legacy link does not match its receipt satisfaction.",
      );
    }
    if (!satisfaction && link) {
      throw new Error(
        "Retired source occurrence has a legacy link without receipt satisfaction.",
      );
    }
    if (link) legacyLinkIds.push(link._id);
    if (satisfaction) representativeEventIds.push(satisfaction.eventId);
  }
  return {
    legacyLinkIds,
    representativeEventIds: [...new Set(representativeEventIds)],
  };
}

async function deleteValidatedRetiredOccurrenceLinks(
  ctx: MutationCtx,
  bindings: ValidatedRetiredOccurrenceBindings,
): Promise<void> {
  for (const linkId of bindings.legacyLinkIds) {
    await ctx.db.delete(linkId);
  }
}

export async function recordSourceOccurrenceSatisfaction(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  satisfiedKey: string,
  representativeEventId: Id<"events">,
  sourceDocument: Doc<"scrapedPosts">,
  supersededKey?: string,
): Promise<SourceOccurrenceSatisfactionResult> {
  const representativeEvent = await ctx.db.get(representativeEventId);
  if (!representativeEvent) {
    throw new Error("Representative event does not exist.");
  }
  if (isCrossPostCampaignLineageEvent(representativeEvent)) {
    throw new Error(
      "Campaign lineage events may only change through a dedicated re-attestation operation.",
    );
  }
  if (!Array.isArray(plan.expectedOccurrences)) {
    // Direct handler QA bypasses Convex argument validation. Deployed callers must
    // provide explicit bindings because sourceOccurrencePlan requires this field.
    plan.expectedOccurrences = plan.expectedKeys.map((key) => ({
      key,
      date: representativeEvent?.date ?? "",
      ...(representativeEvent?.time ? { time: representativeEvent.time } : {}),
      venue: representativeEvent?.venue ?? "",
      title: representativeEvent?.title ?? "",
      artists: representativeEvent?.artists ?? [],
    }));
  }
  assertSourceOccurrencePlan(plan, satisfiedKey);
  const expectedOccurrence = plan.expectedOccurrences.find(
    (occurrence) => occurrence.key === satisfiedKey,
  );
  if (
    !eventRepresentsExpectedOccurrence(representativeEvent, expectedOccurrence, {
      allowUnverifiedPending: true,
    })
  ) {
    throw new Error("Representative event does not match the source occurrence.");
  }
  const existing = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", plan.sourceIdentity))
    .unique();
  if (existing) {
    assertExistingSourceOccurrenceReceiptWithinBounds(existing);
  }
  const now = Date.now();
  if (!existing) {
    if (supersededKey) {
      throw new Error("A source occurrence key cannot be superseded without an existing receipt.");
    }
    await ctx.db.insert("instagramSourceOccurrenceReceipts", {
      sourceIdentity: plan.sourceIdentity,
      sourceFingerprint: plan.sourceFingerprint,
      expectedKeys: plan.expectedKeys,
      expectedOccurrences: plan.expectedOccurrences,
      deferredChildCount: plan.deferredChildCount,
      deferredChildKeys: plan.deferredChildKeys,
      satisfiedKeys: [satisfiedKey],
      satisfiedOccurrences: [{ key: satisfiedKey, eventId: representativeEventId }],
      createdAt: now,
      updatedAt: now,
    });
    const syncedOccurrence = await syncSourceOccurrencePlan({
      ctx,
      plan,
      representativeEvent,
      satisfiedKey,
      sourceDocument,
      supersededKey,
      topologyEpochVerified: true,
    });
    if (!syncedOccurrence) {
      throw new Error("Satisfied source occurrence was not materialized.");
    }
    await upsertInstagramEventSourceLink(
      ctx,
      plan,
      satisfiedKey,
      representativeEvent,
      supersededKey,
      {
        canonicalSourceUrl: syncedOccurrence?.canonicalSourceUrl,
        sourceOccurrenceId: syncedOccurrence?.sourceOccurrenceId,
      },
    );
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
    return {
      receiptComplete:
        plan.deferredChildCount === 0 &&
        plan.expectedKeys.length === 1 &&
        plan.expectedKeys[0] === satisfiedKey,
      representativeEventIds: [representativeEventId],
      sourceOccurrenceId: syncedOccurrence.sourceOccurrenceId,
    };
  }

  const aggregateBound = await isReceiptBoundToCrossPostCampaign(ctx, existing);
  if (
    aggregateBound &&
    new Set(existing.satisfiedOccurrences.map((item) => String(item.eventId))).size !==
      existing.satisfiedOccurrences.length
  ) {
    throw new Error(
      "Reviewed folded occurrence receipts may only change through a dedicated re-attestation operation.",
    );
  }

  const sourceChanged = existing.sourceFingerprint !== plan.sourceFingerprint;
  if (
    sourceChanged &&
    plan.previousSourceFingerprint !== existing.sourceFingerprint
  ) {
    throw new Error("Source occurrence receipt plan is stale.");
  }
  const supersededOccurrence = supersededKey
    ? existing.satisfiedOccurrences.find(
        (occurrence) => occurrence.key === supersededKey,
      )
    : undefined;
  if (
    supersededKey &&
    (!sourceChanged ||
      supersededKey === satisfiedKey ||
      plan.expectedKeys.includes(supersededKey) ||
      !existing.expectedKeys.includes(supersededKey) ||
      supersededOccurrence?.eventId !== representativeEventId)
  ) {
    throw new Error("Source occurrence key migration is invalid.");
  }
  const confirmedPastKeys = new Set(plan.confirmedPastKeys ?? []);
  const retainedExistingExpectedKeys = existing.expectedKeys.filter(
    (key) => !confirmedPastKeys.has(key) && key !== supersededKey,
  );
  const expectedKeys = [
    ...new Set([
      ...retainedExistingExpectedKeys,
      ...plan.expectedKeys,
    ]),
  ];
  const expectedOccurrencesByKey = new Map(
    [
      ...(existing.expectedOccurrences ?? []),
      ...plan.expectedOccurrences,
    ]
      .filter((item) => expectedKeys.includes(item.key))
      .map((item) => [item.key, item] as const),
  );
  const expectedOccurrences = expectedKeys
    .map((key) => expectedOccurrencesByKey.get(key))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (expectedOccurrences.length !== expectedKeys.length) {
    throw new Error("Source occurrence receipt is missing semantic bindings for expected children.");
  }
  const retainedOccurrences = existing.satisfiedOccurrences.filter(
    (occurrence) =>
      expectedKeys.includes(occurrence.key) && occurrence.key !== satisfiedKey,
  );
  // A source revision changes the receipt-wide fingerprint. The current
  // single-child write can re-attest only its target link/occurrence; retained
  // satisfied siblings still carry the prior fingerprint until their own
  // fenced writes run. Keep the global topology frontier dirty in that window
  // instead of certifying a receipt/link mismatch as audit-clean.
  const topologyEpochVerified = !sourceChanged || retainedOccurrences.length === 0;
  const retainedRepresentativeChecks = await Promise.all(
    retainedOccurrences.map(async (occurrence) => ({
      occurrence,
      representative: await ctx.db.get(occurrence.eventId),
      expected: expectedOccurrencesByKey.get(occurrence.key),
    })),
  );
  if (
    retainedRepresentativeChecks.some(
      ({ representative, expected }) =>
        !eventRepresentsExpectedOccurrence(representative, expected, {
          allowUnverifiedPending: true,
        }),
    )
  ) {
    // Abort before changing the receipt or source-link tables. Repairing a
    // stale event key is an explicit provenance operation, not a side effect
    // of recording a different valid sibling.
    throw new Error(
      "Retained source occurrence representative does not match the proposed binding.",
    );
  }
  if (
    retainedOccurrences.some(
      (occurrence) => occurrence.eventId === representativeEventId,
    )
  ) {
    throw new Error("Distinct source occurrences require distinct representative events.");
  }
  const satisfiedOccurrences = [
    ...retainedOccurrences,
    { key: satisfiedKey, eventId: representativeEventId },
  ];
  const satisfiedKeys = [
    ...new Set(satisfiedOccurrences.map((occurrence) => occurrence.key)),
  ];
  const resolvedObservedChildKeys = new Set(
    plan.observedChildKeys.filter((key) => !plan.deferredChildKeys.includes(key)),
  );
  const deferredChildKeys = [
    ...new Set([
      ...existing.deferredChildKeys,
      ...plan.deferredChildKeys,
    ]),
  ].filter((key) => !resolvedObservedChildKeys.has(key));
  const deferredChildCount = deferredChildKeys.length;
  const receiptPatch = {
    sourceFingerprint: plan.sourceFingerprint,
    expectedKeys,
    expectedOccurrences,
    satisfiedKeys,
    deferredChildCount,
    deferredChildKeys,
    satisfiedOccurrences,
  };
  const receiptNeedsPatch = Object.entries(receiptPatch).some(
    ([key, value]) =>
      JSON.stringify(existing[key as keyof typeof existing]) !== JSON.stringify(value),
  );
  if (receiptNeedsPatch && aggregateBound) {
    throw new Error(
      "Campaign occurrence receipts may only change through a dedicated re-attestation operation.",
    );
  }
  const retiredBindings = await validateRetiredOccurrenceBindings(ctx, existing, [
    ...confirmedPastKeys,
    ...(supersededKey ? [supersededKey] : []),
  ]);
  const affectedRepresentativeEventIds = [
    ...new Set([
      ...retiredBindings.representativeEventIds,
      ...satisfiedOccurrences.map((occurrence) => occurrence.eventId),
    ]),
  ];
  if (affectedRepresentativeEventIds.length > MAX_RECONCILED_RECEIPT_REPRESENTATIVES) {
    throw new Error("Source occurrence representative refresh set exceeds the safe bound.");
  }
  await deleteValidatedRetiredOccurrenceLinks(ctx, retiredBindings);
  if (receiptNeedsPatch) {
    await ctx.db.patch(existing._id, { ...receiptPatch, updatedAt: now });
  }
  const syncedOccurrence = await syncSourceOccurrencePlan({
    ctx,
    plan,
    representativeEvent,
    satisfiedKey,
    sourceDocument,
    supersededKey,
    topologyEpochVerified,
  });
  if (!syncedOccurrence) {
    throw new Error("Satisfied source occurrence was not materialized.");
  }
  await upsertInstagramEventSourceLink(
    ctx,
    plan,
    satisfiedKey,
    representativeEvent,
    supersededKey,
    {
      canonicalSourceUrl: syncedOccurrence?.canonicalSourceUrl,
      rejectMaterialCampaignChange: aggregateBound,
      sourceOccurrenceId: syncedOccurrence?.sourceOccurrenceId,
    },
  );
  await markSourceOccurrenceTopologyMutation(ctx, {
    verified: topologyEpochVerified,
  });
  const satisfiedKeySet = new Set(satisfiedKeys);
  return {
    receiptComplete:
      deferredChildCount === 0 &&
      expectedKeys.every((key) => satisfiedKeySet.has(key)),
    representativeEventIds: affectedRepresentativeEventIds,
    sourceOccurrenceId: syncedOccurrence.sourceOccurrenceId,
  };
}

async function isReceiptBoundToCrossPostCampaign(
  ctx: MutationCtx,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
): Promise<boolean> {
  const satisfiedRepresentatives = await Promise.all(
    receipt.satisfiedOccurrences.map((occurrence) => ctx.db.get(occurrence.eventId)),
  );
  return satisfiedRepresentatives.some(
    (event) => event !== null && isCrossPostCampaignLineageEvent(event),
  );
}

export async function reconcileExistingSourceOccurrenceReceipt(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  topologyEpochVerified: boolean,
): Promise<{
  affectedRepresentativeEventIds: Id<"events">[];
  reconciled: boolean;
}> {
  if (typeof topologyEpochVerified !== "boolean") {
    throw new Error("Receipt reconciliation requires an explicit topology epoch classification.");
  }
  assertSourceOccurrencePlanWithinBounds(plan);
  if (
    plan.expectedKeys.length !== 0 ||
    plan.expectedOccurrences.length !== 0 ||
    plan.deferredChildCount !== plan.deferredChildKeys.length ||
    new Set(plan.deferredChildKeys).size !== plan.deferredChildKeys.length ||
    new Set(plan.observedChildKeys).size !== plan.observedChildKeys.length ||
    plan.deferredChildKeys.some((key) => !plan.observedChildKeys.includes(key))
  ) {
    throw new Error("Source occurrence reconciliation plan is invalid.");
  }
  const existing = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", plan.sourceIdentity))
    .unique();
  if (!existing) {
    const now = Date.now();
    await ctx.db.insert("instagramSourceOccurrenceReceipts", {
      sourceIdentity: plan.sourceIdentity,
      sourceFingerprint: plan.sourceFingerprint,
      expectedKeys: [],
      expectedOccurrences: [],
      satisfiedKeys: [],
      deferredChildCount: plan.deferredChildKeys.length,
      deferredChildKeys: plan.deferredChildKeys,
      satisfiedOccurrences: [],
      createdAt: now,
      updatedAt: now,
    });
    await markSourceOccurrenceTopologyMutation(ctx, {
      verified: topologyEpochVerified,
    });
    return { affectedRepresentativeEventIds: [], reconciled: true };
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(existing);
  if (
    existing.satisfiedOccurrences.length >
    MAX_RECONCILED_RECEIPT_REPRESENTATIVES
  ) {
    throw new Error("Source occurrence receipt representative set exceeds the safe bound.");
  }
  if (await isReceiptBoundToCrossPostCampaign(ctx, existing)) {
    throw new Error(
      "Campaign occurrence receipts may only change through a dedicated re-attestation operation.",
    );
  }
  if (
    existing.sourceFingerprint !== plan.sourceFingerprint &&
    plan.previousSourceFingerprint !== existing.sourceFingerprint
  ) {
    throw new Error("Source occurrence receipt plan is stale.");
  }
  const confirmedPastKeys = new Set(plan.confirmedPastKeys ?? []);
  const expectedKeys = existing.expectedKeys.filter((key) => !confirmedPastKeys.has(key));
  if (expectedKeys.length !== 0) {
    throw new Error("Source occurrence receipt still has unresolved expected children.");
  }
  const resolvedObservedChildKeys = new Set(
    plan.observedChildKeys.filter((key) => !plan.deferredChildKeys.includes(key)),
  );
  const deferredChildKeys = [
    ...new Set([
      ...existing.deferredChildKeys,
      ...plan.deferredChildKeys,
    ]),
  ].filter((key) => !resolvedObservedChildKeys.has(key));
  const retiredBindings = await validateRetiredOccurrenceBindings(
    ctx,
    existing,
    plan.confirmedPastKeys ?? [],
  );
  const affectedRepresentativeEventIds = [
    ...new Set([
      ...existing.satisfiedOccurrences.map((occurrence) => occurrence.eventId),
      ...retiredBindings.representativeEventIds,
    ]),
  ];
  if (affectedRepresentativeEventIds.length > MAX_RECONCILED_RECEIPT_REPRESENTATIVES) {
    throw new Error("Source occurrence representative refresh set exceeds the safe bound.");
  }
  await deleteValidatedRetiredOccurrenceLinks(ctx, retiredBindings);
  await ctx.db.patch(existing._id, {
    sourceFingerprint: plan.sourceFingerprint,
    expectedKeys: [],
    expectedOccurrences: [],
    satisfiedKeys: [],
    satisfiedOccurrences: [],
    deferredChildCount: deferredChildKeys.length,
    deferredChildKeys,
    updatedAt: Date.now(),
  });
  await markSourceOccurrenceTopologyMutation(ctx, {
    verified: topologyEpochVerified,
  });
  return { affectedRepresentativeEventIds, reconciled: true };
}

export async function reconcileSourceOccurrenceReceiptAndSync(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  sourceDocument: Doc<"scrapedPosts">,
): Promise<{
  affectedRepresentativeEventIds: Id<"events">[];
  reconciled: boolean;
}> {
  assertSourceOccurrencePlanMatchesSourceDocument(plan, sourceDocument);
  const result = await reconcileExistingSourceOccurrenceReceipt(ctx, plan, true);
  await syncSourceOccurrencePlan({
    ctx,
    plan,
    sourceDocument,
    topologyEpochVerified: true,
  });
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  return result;
}

export async function getLiveInstagramSourceOccurrenceReceipt(
  ctx: QueryCtx,
  sourceIdentity: string,
) {
  const receipt = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceIdentity))
    .unique();
  if (!receipt) {
    return null;
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const representedOccurrences = await Promise.all(
    receipt.satisfiedOccurrences.map(async (occurrence) => ({
      ...occurrence,
      exists: eventRepresentsExpectedOccurrence(
        await ctx.db.get(occurrence.eventId),
        receipt.expectedOccurrences?.find((item) => item.key === occurrence.key),
      ),
    })),
  );
  const representedKeys = new Set(
    representedOccurrences
      .filter((occurrence) => occurrence.exists)
      .map((occurrence) => occurrence.key),
  );
  const liveSatisfiedOccurrences = representedOccurrences
    .filter((occurrence) => occurrence.exists)
    .map(({ eventId, key }) => ({ eventId, key }));
  return {
    ...receipt,
    satisfiedKeys: receipt.satisfiedKeys.filter((key) => representedKeys.has(key)),
    satisfiedOccurrences: liveSatisfiedOccurrences,
  };
}
