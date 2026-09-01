import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  formatMinutesSinceMidnight,
  getConfiguredEventTimezone,
  getEventExpiryCutoff,
  isEventExpiredAtCutoff,
} from "../../lib/events/event-retention";
import { normalizeEventTimeWritePatch } from "../../lib/events/event-time-write";
import {
  assertExpectedEventUpdatedAt,
  assertServiceUpdateEventPolicy,
  nextEventUpdatedAt,
} from "../../lib/events/event-update-precondition";
import { assertPublicEventImageWrite } from "../../lib/images/public-event-image";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "../authz";
import { assertCompleteReceiptTopologyCoverage } from "../internal/receiptTopologyCoverage";
import { markSourceOccurrenceTopologyMutation } from "../internal/sourceOccurrenceTopologyEpoch";
import { type EventOccurrenceTopology } from "../repositories/sourceOccurrenceProvenance";
import { resolveVenueDenormalizedFields } from "./moderationVenue";
import {
  assertInstagramOccurrenceReferencesCanBeReassigned,
  deleteEventWithSavedReferences,
  normalizeExpiredEventDeleteBatchSize,
  reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./persistence";
import {
  assertApprovalCandidatePolicy,
  assertPairwiseOccurrenceRelation,
} from "./sourceApproval";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";
import { dateKeyToUtcMs } from "./publicReads";

const MAX_GENERIC_MERGE_DUPLICATES = 16;
const EVENT_RETENTION_CURSOR_KEY = "expired-events-v1";

type MergeDateEvidencePatch = {
  date?: string;
  dateEvidenceText?: string | null;
  dateEvidenceSource?: "caption" | "poster" | "alt_text" | "unknown";
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string | null;
  sourceConflictFields?: string[];
};

function normalizeMergeDateEvidencePatch(
  patch: MergeDateEvidencePatch,
  existingDate: string,
): {
  dateEvidenceText?: string;
  dateEvidenceSource?: "caption" | "poster" | "alt_text" | "unknown";
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  sourceConflictFields?: string[];
} {
  const evidenceKeys = [
    "dateEvidenceText",
    "dateEvidenceSource",
    "dateEvidenceIsRelative",
    "dateEvidenceResolvedDate",
    "sourceConflictFields",
  ] as const;
  const suppliedKeys = evidenceKeys.filter((key) => Object.hasOwn(patch, key));
  const dateChanged = patch.date !== undefined && patch.date !== existingDate;
  if (suppliedKeys.length === 0) {
    return dateChanged
      ? {
          dateEvidenceText: undefined,
          dateEvidenceSource: undefined,
          dateEvidenceIsRelative: undefined,
          dateEvidenceResolvedDate: undefined,
          sourceConflictFields: undefined,
        }
      : {};
  }
  if (suppliedKeys.length !== evidenceKeys.length) {
    throw new Error(
      "Date evidence text, source, relative flag, resolved date, and source conflicts must be replaced or cleared together.",
    );
  }
  const cleared =
    patch.dateEvidenceText === null && patch.dateEvidenceResolvedDate === null;
  if (cleared) {
    if (
      patch.dateEvidenceSource !== "unknown" ||
      patch.dateEvidenceIsRelative !== false ||
      patch.sourceConflictFields?.length !== 0
    ) {
      throw new Error(
        "Cleared date evidence must use unknown/non-relative/empty-conflict metadata.",
      );
    }
    return {
      dateEvidenceText: undefined,
      dateEvidenceSource: undefined,
      dateEvidenceIsRelative: undefined,
      dateEvidenceResolvedDate: undefined,
      sourceConflictFields: undefined,
    };
  }
  const text = patch.dateEvidenceText?.trim() ?? "";
  const resolvedDate = patch.dateEvidenceResolvedDate?.trim() ?? "";
  const effectiveDate = patch.date ?? existingDate;
  if (
    !text ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(resolvedDate) ||
    resolvedDate !== effectiveDate
  ) {
    throw new Error(
      "Replacement date evidence must bind exactly to the effective event date.",
    );
  }
  return {
    dateEvidenceText: text,
    dateEvidenceSource: patch.dateEvidenceSource,
    dateEvidenceIsRelative: patch.dateEvidenceIsRelative,
    dateEvidenceResolvedDate: resolvedDate,
    sourceConflictFields: patch.sourceConflictFields,
  };
}

type MergeApprovedEventsPatch = MergeDateEvidencePatch & {
  title?: string;
  time?: string;
  timeSource?:
    | "alt_text"
    | "caption"
    | "description"
    | "model"
    | "poster"
    | "schedule_entry"
    | "unknown";
  timeEvidenceText?: string | null;
  timeConfidence?: number;
  timeStatus?: "confirmed" | "inferred" | "unknown";
  timeEvidenceKind?:
    | "start_time_stated"
    | "not_stated"
    | "unreadable"
    | "doors_open_only";
  venue?: string;
  artists?: string[];
  description?: string;
  imageUrl?: string;
  imageStorageId?: Id<"_storage">;
  ticketPrice?: string;
  eventType?: string;
};

export async function deleteApprovedEventHandler(
  ctx: MutationCtx,
  args: { id: Id<"events">; expectedUpdatedAt?: number },
) {
  const identity = await requireAdminIdentity(ctx);
  const existingEvent = await ctx.db.get(args.id);
  if (!existingEvent) {
    throw new Error("Event not found.");
  }

  if (existingEvent.status !== "approved") {
    throw new Error("Only approved events can be removed.");
  }
  if (isCrossPostCampaignLineageEvent(existingEvent)) {
    throw new Error(
      "Campaign aggregates are retained with their audited source lineage and cannot be hard-deleted.",
    );
  }
  assertExpectedEventUpdatedAt(existingEvent.updatedAt, args.expectedUpdatedAt);

  const deletion = await deleteEventWithSavedReferences(ctx, args.id);
  if (deletion.topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  await writeEventAuditLog(ctx, args.id, "deleted", {
    actor: identity.subject,
    patch: { status: existingEvent.status },
  });
}

export async function mergeApprovedEventsHandler(
  ctx: MutationCtx,
  args: {
    primaryId: Id<"events">;
    duplicateIds: Id<"events">[];
    expectedPrimaryUpdatedAt?: number;
    expectedDuplicateVersions?: Array<{
      id: Id<"events">;
      expectedUpdatedAt: number;
    }>;
    patch: MergeApprovedEventsPatch;
    serviceSecret?: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (args.duplicateIds.length > MAX_GENERIC_MERGE_DUPLICATES) {
    throw new Error(
      `Approved-event merge supports at most ${MAX_GENERIC_MERGE_DUPLICATES} duplicates per transaction.`,
    );
  }
  const primaryEvent = await ctx.db.get(args.primaryId);
  if (!primaryEvent) {
    throw new Error("Primary event not found.");
  }
  if (primaryEvent.status !== "approved") {
    throw new Error("Only approved events can be merged.");
  }
  requireCanonicalInstagramPostUrl(
    primaryEvent.instagramPostUrl,
    `Approved-event merge primary ${primaryEvent._id}`,
  );
  assertExpectedEventUpdatedAt(
    primaryEvent.updatedAt,
    args.expectedPrimaryUpdatedAt,
  );
  if (kind === "service") {
    assertServiceUpdateEventPolicy(primaryEvent.status, args.patch);
  }

  const duplicateIds = [...new Set(args.duplicateIds)].filter(
    (id) => id !== args.primaryId,
  );
  let expectedDuplicateVersionById: Map<string, number> | undefined;
  if (args.expectedDuplicateVersions !== undefined) {
    expectedDuplicateVersionById = new Map<string, number>();
    for (const item of args.expectedDuplicateVersions) {
      const key = String(item.id);
      if (expectedDuplicateVersionById.has(key)) {
        throw new Error(
          "Expected duplicate versions contain a duplicate event ID.",
        );
      }
      expectedDuplicateVersionById.set(key, item.expectedUpdatedAt);
    }
    if (
      expectedDuplicateVersionById.size !== duplicateIds.length ||
      duplicateIds.some((id) => !expectedDuplicateVersionById?.has(String(id)))
    ) {
      throw new Error(
        "Expected duplicate versions must exactly match the duplicate event IDs.",
      );
    }
  }
  const duplicateEvents: Doc<"events">[] = [];
  let topologyMutated = false;
  for (const duplicateId of duplicateIds) {
    const duplicateEvent = await ctx.db.get(duplicateId);
    if (!duplicateEvent) {
      throw new Error("Duplicate event not found.");
    }
    if (duplicateEvent.status !== "approved") {
      throw new Error("Only approved duplicate events can be removed.");
    }
    requireCanonicalInstagramPostUrl(
      duplicateEvent.instagramPostUrl,
      `Approved-event merge duplicate ${duplicateEvent._id}`,
    );
    assertExpectedEventUpdatedAt(
      duplicateEvent.updatedAt,
      expectedDuplicateVersionById?.get(String(duplicateId)),
    );
    duplicateEvents.push(duplicateEvent);
  }
  if (
    [primaryEvent, ...duplicateEvents].some((event) =>
      isCrossPostCampaignLineageEvent(event),
    )
  ) {
    throw new Error(
      "Campaign aggregates require their dedicated receipt-aware coalescing path.",
    );
  }
  if (duplicateIds.length > 0) {
    await assertCompleteReceiptTopologyCoverage(ctx);
  }

  let effectivePrimaryEvent: Doc<"events"> = primaryEvent;
  let applyPrimaryPatch: (() => Promise<void>) | undefined;
  if (Object.keys(args.patch).length > 0) {
    assertPublicEventImageWrite(args.patch.imageUrl, args.patch.imageStorageId);
    const venueFields =
      args.patch.venue !== undefined
        ? await resolveVenueDenormalizedFields(ctx, args.patch.venue)
        : {};
    const dateEvidencePatch = normalizeMergeDateEvidencePatch(
      args.patch,
      primaryEvent.date,
    );
    const {
      dateEvidenceText: _dateEvidenceText,
      dateEvidenceSource: _dateEvidenceSource,
      dateEvidenceIsRelative: _dateEvidenceIsRelative,
      dateEvidenceResolvedDate: _dateEvidenceResolvedDate,
      sourceConflictFields: _sourceConflictFields,
      ...timeAndPublicFieldPatch
    } = args.patch;
    const patch = {
      ...normalizeEventTimeWritePatch(timeAndPublicFieldPatch),
      ...dateEvidencePatch,
      ...(args.patch.imageUrl !== undefined
        ? {
            imageUrl: args.patch.imageUrl,
            imageStorageId:
              args.patch.imageStorageId ??
              [primaryEvent, ...duplicateEvents].find(
                (event) =>
                  event.imageUrl === args.patch.imageUrl &&
                  event.imageStorageId !== undefined,
              )?.imageStorageId,
          }
        : {}),
      ...venueFields,
      ...(args.patch.eventType !== undefined
        ? { eventType: canonicalizeEventType(args.patch.eventType) }
        : {}),
    };
    const effectiveEvent = { ...primaryEvent, ...patch };
    effectivePrimaryEvent = effectiveEvent;
    await assertApprovalCandidatePolicy(
      ctx,
      {
        title: effectiveEvent.title,
        date: effectiveEvent.date,
        venue: effectiveEvent.venue,
        venueId: effectiveEvent.venueId,
        venueInstagramHandle: effectiveEvent.venueInstagramHandle,
        instagramPostId: effectiveEvent.instagramPostId,
        instagramPostUrl: effectiveEvent.instagramPostUrl,
        time: effectiveEvent.time,
        artists: effectiveEvent.artists,
        sourceOccurrenceKey: effectiveEvent.sourceOccurrenceKey,
        normalizedFieldsJson: effectiveEvent.normalizedFieldsJson,
      },
      [args.primaryId, ...duplicateIds],
    );
    await assertInstagramOccurrenceReferencesCanBeReassigned(
      ctx,
      primaryEvent._id,
      effectiveEvent,
    );
    applyPrimaryPatch = async () => {
      await ctx.db.patch(args.primaryId, {
        ...patch,
        updatedAt: nextEventUpdatedAt(primaryEvent.updatedAt),
      });
      await writeEventAuditLog(ctx, args.primaryId, "merged_primary_updated", {
        actor,
        patch,
      });
    };
  }

  assertPairwiseOccurrenceRelation(
    [effectivePrimaryEvent, ...duplicateEvents],
    "proven_duplicate",
    "Approved-event merge requires every pair to be a proven duplicate occurrence.",
  );

  const duplicateSourceTopologies = new Map<
    Id<"events">,
    EventOccurrenceTopology
  >();
  for (const duplicateEvent of duplicateEvents) {
    const topology = await assertInstagramOccurrenceReferencesCanBeReassigned(
      ctx,
      duplicateEvent._id,
      effectivePrimaryEvent,
    );
    duplicateSourceTopologies.set(duplicateEvent._id, topology);
  }

  await applyPrimaryPatch?.();

  for (const duplicateId of duplicateIds) {
    const duplicateSourceTopology = duplicateSourceTopologies.get(duplicateId);
    if (!duplicateSourceTopology) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Approved-event merge lost its prepared source topology.",
      );
    }
    await reassignSavedEventReferences(ctx, duplicateId, args.primaryId);
    const duplicateTopologyMutated =
      await reassignInstagramOccurrenceReferences(
        ctx,
        duplicateId,
        args.primaryId,
        duplicateSourceTopology,
      );
    topologyMutated ||= duplicateTopologyMutated;
    await ctx.db.delete(duplicateId);
    await writeEventAuditLog(ctx, duplicateId, "merged_deleted_duplicate", {
      actor,
      patch: { primaryId: args.primaryId },
    });
  }

  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }

  await refreshCanonicalEventDerivedStates(ctx, [args.primaryId]);

  await writeEventAuditLog(ctx, args.primaryId, "merged_duplicates", {
    actor,
    patch: { duplicateIds },
  });

  return {
    primaryId: args.primaryId,
    deletedDuplicateCount: duplicateIds.length,
  };
}

export async function deleteExpiredEventsHandler(
  ctx: MutationCtx,
  args: {
    batchSize?: number;
    beforeDate?: string;
    beforeDateCursor?: string | null;
    beforeDateScanComplete?: boolean;
    sameDayCursor?: string | null;
    sameDayScanComplete?: boolean;
  },
) {
  const batchSize = normalizeExpiredEventDeleteBatchSize(args.batchSize);
  const timeZone = getConfiguredEventTimezone();
  const explicitBeforeDate = args.beforeDate?.trim();
  if (
    args.beforeDate !== undefined &&
    dateKeyToUtcMs(explicitBeforeDate ?? "") === null
  ) {
    throw new Error("beforeDate must be a valid YYYY-MM-DD date.");
  }
  const calculatedCutoff = explicitBeforeDate
    ? { isoDate: explicitBeforeDate, minutesSinceMidnight: 0 }
    : getEventExpiryCutoff(new Date(), timeZone);
  const shouldDeleteSameDayExpiredEvents = explicitBeforeDate === undefined;
  const persistedCursor = shouldDeleteSameDayExpiredEvents
    ? await ctx.db
        .query("eventRetentionCursors")
        .withIndex("by_key", (q) => q.eq("key", EVENT_RETENTION_CURSOR_KEY))
        .unique()
    : null;
  if (
    persistedCursor &&
    (dateKeyToUtcMs(persistedCursor.cutoffDate) === null ||
      !Number.isSafeInteger(persistedCursor.cutoffMinutesSinceMidnight) ||
      persistedCursor.cutoffMinutesSinceMidnight < 0 ||
      persistedCursor.cutoffMinutesSinceMidnight >= 24 * 60)
  ) {
    throw new Error("Persisted expired-event retention cursor is invalid.");
  }
  const cutoff = persistedCursor
    ? {
        isoDate: persistedCursor.cutoffDate,
        minutesSinceMidnight: persistedCursor.cutoffMinutesSinceMidnight,
      }
    : calculatedCutoff;
  const beforeDateScanWasComplete =
    persistedCursor?.beforeDateScanComplete ??
    args.beforeDateScanComplete === true;
  const effectiveBeforeDateCursor =
    persistedCursor?.beforeDateCursor ?? args.beforeDateCursor ?? null;
  const beforeDatePage = beforeDateScanWasComplete
    ? null
    : await ctx.db
        .query("events")
        .withIndex("by_date", (q) => q.lt("date", cutoff.isoDate))
        .paginate({
          cursor: effectiveBeforeDateCursor,
          numItems: batchSize,
        });
  const eventsBeforeCutoffDate = beforeDatePage?.page ?? [];
  const retainedCampaignEventsBeforeCutoff = eventsBeforeCutoffDate.filter(
    isCrossPostCampaignLineageEvent,
  );
  const deletionCandidatesBeforeCutoff = eventsBeforeCutoffDate.filter(
    (event) => !isCrossPostCampaignLineageEvent(event),
  );
  const deletableEventsBeforeCutoff = deletionCandidatesBeforeCutoff;

  const deletedEventIds: Id<"events">[] = [];
  let deletedSavedEventCount = 0;
  let topologyMutated = false;

  for (const event of deletableEventsBeforeCutoff) {
    const deletion = await deleteEventWithSavedReferences(ctx, event._id);
    deletedSavedEventCount += deletion.deletedReferenceCount;
    topologyMutated ||= deletion.topologyMutated;
    deletedEventIds.push(event._id);
  }

  const beforeDateScanComplete =
    beforeDateScanWasComplete || beforeDatePage?.isDone === true;
  const beforeDateCursor = beforeDateScanComplete
    ? null
    : (beforeDatePage?.continueCursor ?? null);
  if (!beforeDateScanComplete && !beforeDateCursor) {
    throw new Error("Expired-event retention pagination did not advance.");
  }

  const remainingSlots = batchSize - deletedEventIds.length;
  const skippedSameDayEventCount = 0;
  let sameDayExpiredEventCount = 0;
  const sameDayScanWasComplete =
    !shouldDeleteSameDayExpiredEvents ||
    (persistedCursor?.sameDayScanComplete ?? args.sameDayScanComplete === true);
  const effectiveSameDayCursor =
    persistedCursor?.sameDayCursor ?? args.sameDayCursor ?? null;
  const sameDayPage =
    beforeDateScanComplete &&
    shouldDeleteSameDayExpiredEvents &&
    !sameDayScanWasComplete &&
    remainingSlots > 0
      ? await ctx.db
          .query("events")
          .withIndex("by_date", (q) => q.eq("date", cutoff.isoDate))
          .paginate({
            cursor: effectiveSameDayCursor,
            numItems: remainingSlots,
          })
      : null;

  if (sameDayPage) {
    const sameDayExpiredEvents = sameDayPage.page.filter(
      (event) =>
        isEventExpiredAtCutoff(event, cutoff) &&
        !isCrossPostCampaignLineageEvent(event),
    );

    sameDayExpiredEventCount = sameDayExpiredEvents.length;

    for (const event of sameDayExpiredEvents) {
      const deletion = await deleteEventWithSavedReferences(ctx, event._id);
      deletedSavedEventCount += deletion.deletedReferenceCount;
      topologyMutated ||= deletion.topologyMutated;
      deletedEventIds.push(event._id);
    }
  }

  const sameDayScanComplete =
    sameDayScanWasComplete || sameDayPage?.isDone === true;
  const sameDayCursor = sameDayScanComplete
    ? null
    : (sameDayPage?.continueCursor ?? effectiveSameDayCursor);
  if (
    beforeDateScanComplete &&
    shouldDeleteSameDayExpiredEvents &&
    !sameDayScanComplete &&
    remainingSlots > 0 &&
    !sameDayCursor
  ) {
    throw new Error(
      "Same-day expired-event retention pagination did not advance.",
    );
  }

  const hasMore =
    !beforeDateScanComplete ||
    (shouldDeleteSameDayExpiredEvents && !sameDayScanComplete);
  if (shouldDeleteSameDayExpiredEvents) {
    if (hasMore) {
      const now = Date.now();
      const cursorState = {
        key: EVENT_RETENTION_CURSOR_KEY,
        cutoffDate: cutoff.isoDate,
        cutoffMinutesSinceMidnight: cutoff.minutesSinceMidnight,
        ...(beforeDateCursor ? { beforeDateCursor } : {}),
        beforeDateScanComplete,
        ...(sameDayCursor ? { sameDayCursor } : {}),
        sameDayScanComplete,
        updatedAt: now,
      };
      if (persistedCursor) {
        await ctx.db.patch(persistedCursor._id, cursorState);
      } else {
        await ctx.db.insert("eventRetentionCursors", {
          ...cursorState,
          createdAt: now,
        });
      }
    } else if (persistedCursor) {
      await ctx.db.delete(persistedCursor._id);
    }
  }

  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }

  return {
    deletedEventCount: deletedEventIds.length,
    deletedEventIds,
    deletedSavedEventCount,
    cutoffDate: cutoff.isoDate,
    cutoffTime: formatMinutesSinceMidnight(cutoff.minutesSinceMidnight),
    timeZone,
    hasMore,
    beforeDateCursor,
    beforeDateScanComplete,
    sameDayCursor,
    sameDayScanComplete,
    retainedCampaignEventCount: retainedCampaignEventsBeforeCutoff.length,
    skippedSameDayEventCount,
    sameDayExpiredEventCount,
  };
}
