import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  buildNightlifeLineupCoalescingPlan,
  NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION,
} from "../../lib/events/nightlife-lineup-coalescing";
import {
  hasEventEvidenceV2AutoApproval,
  nextEventUpdatedAt,
} from "../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { requireAdminOrServiceSecret } from "../authz";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../internal/sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../internal/sourceOccurrenceTopologyEpoch";
import {
  MAX_SAVED_REFERENCES_PER_EVENT_OPERATION,
  SavedEventRepositoryConflict,
  savedEventRepository,
} from "../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import {
  exactStringSetEquals,
  parseCoalescingJsonRecord,
  readNightlifeLineupSource,
} from "./coalescingSupport";
import type {
  NightlifeLineupCandidateVersion,
  NightlifeLineupCoalescingPatch,
} from "./contracts";
import {
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "./persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
  normalizeLookup,
  normalizeSourceCaption,
} from "./sourceApproval";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";
import { normalizedString, stringArraysEqual } from "./valueNormalization";

const MAX_LINEUP_COALESCING_SAVES_PER_EVENT =
  MAX_SAVED_REFERENCES_PER_EVENT_OPERATION;

export async function getNightlifeLineupCoalescingContextHandler(
  ctx: QueryCtx,
  args: {
    ids: Id<"events">[];
    sourceIdentity: string;
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Nightlife lineup context requires service authentication.",
    );
  }
  if (
    args.ids.length < 2 ||
    args.ids.length > 16 ||
    new Set(args.ids).size !== args.ids.length ||
    !args.sourceIdentity.trim()
  ) {
    throw new Error("Nightlife lineup context request is invalid.");
  }
  const events = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
  if (events.some((event) => event === null)) {
    throw new Error("Nightlife lineup context event set is incomplete.");
  }
  const sourceLinks = await Promise.all(
    args.ids.map(async (id) => {
      const links = await ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", id))
        .take(2);
      if (links.length !== 1) {
        throw new Error(
          `Nightlife lineup context source link is not unique: ${id}.`,
        );
      }
      return links[0];
    }),
  );
  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", args.sourceIdentity),
    )
    .take(2);
  if (receiptRows.length !== 1) {
    throw new Error("Nightlife lineup context receipt is not unique.");
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receiptRows[0]);
  const savedReferences = await Promise.all(
    args.ids.map((id) =>
      savedEventRepository.loadEventReferences(ctx, id, {
        limit: MAX_LINEUP_COALESCING_SAVES_PER_EVENT,
      }),
    ),
  );
  return {
    events: events as Doc<"events">[],
    sourceLinks,
    receipt: receiptRows[0],
    savedEvents: savedReferences.flatMap((references) => references.canonical),
    userSavedEvents: savedReferences.flatMap((references) => references.legacy),
  };
}

export async function coalesceApprovedNightlifeLineupOccurrencesHandler(
  ctx: MutationCtx,
  args: {
    primary: NightlifeLineupCandidateVersion;
    duplicates: NightlifeLineupCandidateVersion[];
    expectedSourceIdentity: string;
    expectedSourceFingerprint: string;
    expectedOccurrenceKeys: string[];
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    patch: NightlifeLineupCoalescingPatch;
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
      "Nightlife lineup coalescing requires service authentication.",
    );
  }
  if (
    args.moderationNote.trim().length < 24 ||
    !args.expectedSourceIdentity.trim() ||
    !args.expectedSourceFingerprint.trim() ||
    !args.patch.sourceFingerprint.trim() ||
    !Number.isSafeInteger(args.primary.expectedUpdatedAt) ||
    !Number.isSafeInteger(args.primary.expectedSourceLinkUpdatedAt) ||
    !Number.isSafeInteger(args.expectedReceiptUpdatedAt) ||
    args.duplicates.length < 1 ||
    args.duplicates.length > 15
  ) {
    throw new Error("Nightlife lineup coalescing arguments are invalid.");
  }

  const targetVersions = [args.primary, ...args.duplicates];
  const targetIds = targetVersions.map((item) => String(item.id));
  if (
    new Set(targetIds).size !== targetIds.length ||
    new Set(args.expectedOccurrenceKeys).size !==
      args.expectedOccurrenceKeys.length ||
    args.expectedOccurrenceKeys.length !== targetVersions.length
  ) {
    throw new Error(
      "Nightlife lineup coalescing requires unique event IDs and keys.",
    );
  }

  const events: Doc<"events">[] = [];
  for (const item of targetVersions) {
    if (
      !Number.isSafeInteger(item.expectedUpdatedAt) ||
      !Number.isSafeInteger(item.expectedSourceLinkUpdatedAt)
    ) {
      throw new Error(
        "Nightlife lineup coalescing requires valid event versions.",
      );
    }
    const event = await ctx.db.get(item.id);
    if (
      !event ||
      event.status !== "approved" ||
      event.updatedAt !== item.expectedUpdatedAt ||
      event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson
    ) {
      throw new Error(
        `Nightlife lineup event precondition failed: ${item.id}.`,
      );
    }
    events.push(event);
  }

  const primaryEvent = events[0]!;
  const duplicateEvents = events.slice(1);
  const commonVenue = normalizeLookup(primaryEvent.venue);
  const commonPostUrl = requireCanonicalInstagramPostUrl(
    primaryEvent.instagramPostUrl,
    "Nightlife lineup primary source",
  );
  if (
    canonicalizeEventType(primaryEvent.eventType) !== "nightlife" ||
    !commonVenue ||
    !commonPostUrl ||
    !primaryEvent.instagramPostId ||
    !primaryEvent.sourceOccurrenceKey ||
    !primaryEvent.rawExtractionJson
  ) {
    throw new Error(
      "Nightlife lineup primary event is not fully source-bound.",
    );
  }
  for (const event of events) {
    if (
      canonicalizeEventType(event.eventType) !== "nightlife" ||
      event.date !== primaryEvent.date ||
      normalizeLookup(event.venue) !== commonVenue ||
      event.venueId !== primaryEvent.venueId ||
      normalizeHandle(event.venueInstagramHandle ?? "") !==
        normalizeHandle(primaryEvent.venueInstagramHandle ?? "") ||
      event.instagramPostId !== primaryEvent.instagramPostId ||
      requireCanonicalInstagramPostUrl(
        event.instagramPostUrl,
        `Nightlife lineup event source ${event._id}`,
      ) !== commonPostUrl ||
      event.rawExtractionJson !== primaryEvent.rawExtractionJson ||
      normalizeSourceCaption(event.sourceCaption) !==
        normalizeSourceCaption(primaryEvent.sourceCaption) ||
      event.sourcePostedAt !== primaryEvent.sourcePostedAt ||
      event.ticketPrice !== primaryEvent.ticketPrice ||
      event.imageUrl !== primaryEvent.imageUrl ||
      event.imageStorageId !== primaryEvent.imageStorageId ||
      event.promotionTier !== primaryEvent.promotionTier ||
      event.promotionStart !== primaryEvent.promotionStart ||
      event.promotionEnd !== primaryEvent.promotionEnd ||
      event.promotionPriority !== primaryEvent.promotionPriority ||
      !event.sourceOccurrenceKey
    ) {
      throw new Error(
        "Nightlife lineup rows do not share one exact source occurrence.",
      );
    }
  }

  const rawExtraction = parseCoalescingJsonRecord(
    primaryEvent.rawExtractionJson,
    "Nightlife lineup raw extraction",
  );
  const rawScheduleEntries = rawExtraction.schedule_entries;
  const rawConflicts = rawExtraction.source_conflicts;
  const sharedScheduleContext = rawExtraction.shared_schedule_context;
  if (
    rawExtraction.extraction_contract_version !== "event_evidence_v2" ||
    rawExtraction.is_event !== true ||
    canonicalizeEventType(normalizedString(rawExtraction.category)) !==
      "nightlife" ||
    !Array.isArray(rawConflicts) ||
    rawConflicts.length !== 0 ||
    !Array.isArray(rawScheduleEntries) ||
    rawScheduleEntries.length !== events.length ||
    !sharedScheduleContext ||
    typeof sharedScheduleContext !== "object" ||
    Array.isArray(sharedScheduleContext)
  ) {
    throw new Error(
      "Nightlife lineup raw extraction is not one complete v2 timetable.",
    );
  }
  const sharedTime = (sharedScheduleContext as Record<string, unknown>).time;
  if (
    !sharedTime ||
    typeof sharedTime !== "object" ||
    Array.isArray(sharedTime)
  ) {
    throw new Error("Nightlife lineup shared time evidence is missing.");
  }
  const sharedTimeRecord = sharedTime as Record<string, unknown>;
  const sharedTimeValue = normalizedString(sharedTimeRecord.value);
  const sharedTimeEvidence = normalizedString(sharedTimeRecord.evidence);
  const sharedTimeSource = readNightlifeLineupSource(sharedTimeRecord.source);
  if (
    sharedTimeRecord.applies_to_all !== true ||
    !sharedTimeValue ||
    !sharedTimeEvidence ||
    !sharedTimeSource ||
    sharedTimeSource === "unknown"
  ) {
    throw new Error("Nightlife lineup shared time evidence is not verified.");
  }

  const usedSourceLines = new Set<string>();
  const planCandidates = events.map((event) => {
    const fields = parseCoalescingJsonRecord(
      event.normalizedFieldsJson ?? "",
      `Nightlife lineup normalized fields ${event._id}`,
    );
    const sourceLine = normalizedString(fields.splitSourceLine);
    const sourceMatches = rawScheduleEntries.filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      return (
        normalizedString((value as Record<string, unknown>).source_text) ===
        sourceLine
      );
    }) as Record<string, unknown>[];
    const sourceEntry = sourceMatches.length === 1 ? sourceMatches[0] : null;
    const dateEvidence = sourceEntry?.date_evidence;
    const timeEvidence = sourceEntry?.time_evidence;
    const source =
      timeEvidence &&
      typeof timeEvidence === "object" &&
      !Array.isArray(timeEvidence)
        ? readNightlifeLineupSource(
            (timeEvidence as Record<string, unknown>).source,
          )
        : null;
    const entryArtists = sourceEntry?.artists;
    if (
      !sourceLine ||
      usedSourceLines.has(sourceLine) ||
      !sourceEntry ||
      !source ||
      source === "unknown" ||
      normalizedString(sourceEntry.title) !== normalizedString(event.title) ||
      normalizedString(sourceEntry.time) !== normalizedString(event.time) ||
      normalizeLookup(normalizedString(sourceEntry.venue)) !== commonVenue ||
      !stringArraysEqual(entryArtists, event.artists) ||
      normalizedString(
        (dateEvidence as Record<string, unknown>).resolved_date,
      ) !== event.date ||
      !timeEvidence ||
      typeof timeEvidence !== "object" ||
      Array.isArray(timeEvidence) ||
      (timeEvidence as Record<string, unknown>).status !==
        "start_time_stated" ||
      normalizeLookup(
        normalizedString((timeEvidence as Record<string, unknown>).exact_text),
      ) !== normalizeLookup(event.time ?? "") ||
      fields.extractionContractVersion !== "event_evidence_v2" ||
      fields.structuredEvidenceVerified !== true ||
      fields.multiEventSplitDetected !== true ||
      fields.multiEventSplitCount !== events.length ||
      fields.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
      fields.sourceOccurrenceSourceFingerprint !==
        args.expectedSourceFingerprint ||
      fields.sourceOccurrenceExpectedCount !== events.length ||
      !Array.isArray(fields.sourceOccurrenceExpectedKeys) ||
      !fields.sourceOccurrenceExpectedKeys.every(
        (value) => typeof value === "string",
      ) ||
      !exactStringSetEquals(
        fields.sourceOccurrenceExpectedKeys as string[],
        args.expectedOccurrenceKeys,
      ) ||
      fields.sourceOccurrenceDeferredChildCount !== 0 ||
      normalizedString(fields.title) !== normalizedString(event.title) ||
      normalizedString(fields.normalizedDate) !== event.date ||
      normalizedString(fields.time) !== normalizedString(event.time) ||
      normalizeLookup(normalizedString(fields.normalizedVenue)) !==
        commonVenue ||
      !stringArraysEqual(fields.artists, event.artists)
    ) {
      throw new Error(
        `Nightlife lineup source-row binding failed: ${event._id}.`,
      );
    }
    usedSourceLines.add(sourceLine);
    return {
      id: String(event._id),
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      sourceText: sourceLine,
      source,
      timeEvidenceText: normalizedString(
        (timeEvidence as Record<string, unknown>).exact_text,
      ),
      timeEvidenceVerified: true,
    };
  });

  const plan = buildNightlifeLineupCoalescingPlan({
    eventType: "nightlife",
    sourceConflictCount: 0,
    sharedTime: { value: sharedTimeValue, verified: true },
    candidates: planCandidates,
  });
  if (!plan || plan.timingMode !== "shared_timetable") {
    throw new Error(
      "Nightlife lineup rows are not one contiguous overall timetable.",
    );
  }
  if (
    plan.candidateIds[0] !== String(primaryEvent._id) ||
    normalizedString(args.patch.title) !== normalizedString(plan.title) ||
    normalizedString(args.patch.time) !== normalizedString(plan.time) ||
    !stringArraysEqual(args.patch.artists, plan.artists) ||
    normalizedString(args.patch.description) !==
      normalizedString(plan.description) ||
    args.patch.timeSource !== sharedTimeSource ||
    normalizedString(args.patch.timeEvidenceText) !== sharedTimeEvidence ||
    args.patch.timeConfidence !== 0.95 ||
    args.patch.timeStatus !== "confirmed" ||
    args.patch.timeEvidenceKind !== "start_time_stated" ||
    args.patch.sourceOccurrenceKey !== primaryEvent.sourceOccurrenceKey ||
    args.patch.sourceFingerprint === args.expectedSourceFingerprint
  ) {
    throw new Error(
      "Nightlife lineup patch does not match the verified timetable plan.",
    );
  }

  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", args.expectedSourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (receipt) assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  if (
    !receipt ||
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceFingerprint !== args.expectedSourceFingerprint ||
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    !Array.isArray(receipt.expectedOccurrences) ||
    receipt.expectedOccurrences.length !== events.length ||
    receipt.satisfiedOccurrences.length !== events.length ||
    !exactStringSetEquals(receipt.expectedKeys, args.expectedOccurrenceKeys) ||
    !exactStringSetEquals(receipt.satisfiedKeys, args.expectedOccurrenceKeys) ||
    !exactStringSetEquals(
      events.map((event) => event.sourceOccurrenceKey!),
      args.expectedOccurrenceKeys,
    )
  ) {
    throw new Error("Nightlife lineup occurrence receipt precondition failed.");
  }

  const sourceLinks = new Map<Id<"events">, Doc<"instagramEventSources">>();
  const expectedVersionByEventId = new Map(
    targetVersions.map((item) => [String(item.id), item]),
  );
  let commonSourceHandle: string | null = null;
  for (const event of events) {
    const links = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .take(2);
    const link = links.length === 1 ? links[0] : null;
    const expectedOccurrence = receipt.expectedOccurrences.find(
      (occurrence) => occurrence.key === event.sourceOccurrenceKey,
    );
    const satisfiedOccurrence = receipt.satisfiedOccurrences.find(
      (occurrence) => occurrence.key === event.sourceOccurrenceKey,
    );
    const expectedVersion = expectedVersionByEventId.get(String(event._id));
    const linkedSourceHandle = normalizeHandle(link?.sourceHandle ?? "");
    const eventFields = parseCoalescingJsonRecord(
      event.normalizedFieldsJson ?? "",
      `Nightlife lineup source handle ${event._id}`,
    );
    const attestedSourceHandle = normalizeHandle(
      normalizedString(eventFields.sourceGroundingInstagramHandle),
    );
    const venueSourceHandle = normalizeHandle(event.venueInstagramHandle ?? "");
    const sourceHandle =
      linkedSourceHandle ||
      (link?.sourceHandle === undefined &&
      attestedSourceHandle &&
      attestedSourceHandle === venueSourceHandle
        ? attestedSourceHandle
        : "");
    const expectedOccurrenceMatches =
      sourceOccurrenceRepresentativeMatchesExpected(
        event,
        expectedOccurrence,
      ) ||
      Boolean(
        expectedOccurrence &&
        expectedOccurrence.venue === "" &&
        sourceOccurrenceRepresentativeMatchesExpected(event, {
          ...expectedOccurrence,
          // Legacy receipts could preserve the extraction-time empty venue
          // even after a later, source-backed venue canonicalization updated
          // both the event and its immutable normalized snapshot. The cohort
          // checks above already prove one exact nonempty venue for every row.
          venue: event.venue,
        }),
      );
    const linkPostUrl = link
      ? requireCanonicalInstagramPostUrl(
          link.instagramPostUrl,
          `Nightlife lineup source link ${event._id}`,
        )
      : "";
    if (
      !link ||
      !expectedVersion ||
      link._id !== expectedVersion.expectedSourceLinkId ||
      link.updatedAt !== expectedVersion.expectedSourceLinkUpdatedAt ||
      link.sourceIdentity !== args.expectedSourceIdentity ||
      link.sourceFingerprint !== args.expectedSourceFingerprint ||
      link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
      link.instagramPostId !== event.instagramPostId ||
      linkPostUrl !== commonPostUrl ||
      !expectedOccurrence ||
      satisfiedOccurrence?.eventId !== event._id ||
      !expectedOccurrenceMatches
    ) {
      throw new Error(
        `Nightlife lineup occurrence link precondition failed: ${event._id}.`,
      );
    }
    if (
      !sourceHandle ||
      sourceHandle !== attestedSourceHandle ||
      sourceHandle !== venueSourceHandle ||
      (commonSourceHandle !== null && sourceHandle !== commonSourceHandle)
    ) {
      throw new Error("Nightlife lineup source handles are inconsistent.");
    }
    commonSourceHandle = sourceHandle;
    sourceLinks.set(event._id, link);
  }
  for (const event of events) {
    try {
      await savedEventRepository.loadEventReferences(ctx, event._id, {
        limit: MAX_LINEUP_COALESCING_SAVES_PER_EVENT,
      });
    } catch (error) {
      if (error instanceof SavedEventRepositoryConflict) {
        throw new Error(
          `Nightlife lineup save cohort exceeds the safe bound: ${event._id}.`,
        );
      }
      throw error;
    }
  }

  const nextFields = parseCoalescingJsonRecord(
    args.patch.normalizedFieldsJson,
    "Nightlife lineup next normalized fields",
  );
  if (
    nextFields.lineupScheduleCoalesced !== true ||
    nextFields.lineupScheduleCoalescingPolicyVersion !==
      NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION ||
    nextFields.lineupScheduleTimingMode !== plan.timingMode ||
    nextFields.lineupScheduleSourceRowCount !== events.length ||
    JSON.stringify(nextFields.lineupScheduleSlots) !==
      JSON.stringify(plan.slots) ||
    JSON.stringify(nextFields.lineupScheduleSourceEvidence) !==
      JSON.stringify(
        plan.slots.map((slot) => ({
          text: slot.sourceText,
          source: slot.source,
        })),
      ) ||
    normalizedString(nextFields.splitSourceLine) !==
      normalizedString([sharedTimeEvidence, ...plan.sourceTexts].join("\n")) ||
    normalizedString(nextFields.description) !==
      normalizedString(plan.description) ||
    nextFields.multiEventSplitDetected !== true ||
    nextFields.multiEventSplitCount !== events.length ||
    nextFields.splitEventTotal !== 1 ||
    nextFields.sourceOccurrenceKey !== primaryEvent.sourceOccurrenceKey ||
    nextFields.sourceOccurrenceSourceFingerprint !==
      args.patch.sourceFingerprint ||
    nextFields.sourceOccurrenceExpectedCount !== 1 ||
    !stringArraysEqual(nextFields.sourceOccurrenceExpectedKeys, [
      primaryEvent.sourceOccurrenceKey,
    ]) ||
    nextFields.sourceOccurrenceDeferredChildCount !== 0
  ) {
    throw new Error("Nightlife lineup next attestation is incomplete.");
  }
  if (
    !commonSourceHandle ||
    normalizeHandle(
      normalizedString(nextFields.sourceGroundingInstagramHandle),
    ) !== commonSourceHandle
  ) {
    throw new Error("Nightlife lineup next source handle is inconsistent.");
  }

  const prospectiveEvent = {
    ...primaryEvent,
    title: args.patch.title,
    time: args.patch.time,
    timeSource: args.patch.timeSource,
    timeEvidenceText: args.patch.timeEvidenceText,
    timeConfidence: args.patch.timeConfidence,
    timeStatus: args.patch.timeStatus,
    timeEvidenceKind: args.patch.timeEvidenceKind,
    artists: args.patch.artists,
    description: args.patch.description,
    normalizedFieldsJson: args.patch.normalizedFieldsJson,
    sourceOccurrenceKey: args.patch.sourceOccurrenceKey,
  };
  if (
    !hasEventEvidenceV2AutoApproval(
      args.patch.normalizedFieldsJson,
      prospectiveEvent,
    )
  ) {
    throw new Error(
      "Nightlife lineup patch does not preserve approved v2 grounding.",
    );
  }
  await assertPersistedServiceSourcePolicy(ctx, prospectiveEvent);
  await assertApprovalCandidatePolicy(
    ctx,
    prospectiveEvent,
    targetVersions.map((item) => item.id),
  );

  const primaryLink = sourceLinks.get(primaryEvent._id);
  if (!primaryLink) {
    throw new Error("Nightlife lineup primary source link disappeared.");
  }
  const now = Date.now();
  const primaryUpdatedAt = nextEventUpdatedAt(primaryEvent.updatedAt, now);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, now);
  await ctx.db.patch(primaryEvent._id, {
    title: args.patch.title,
    time: args.patch.time,
    timeSource: args.patch.timeSource,
    timeEvidenceText: args.patch.timeEvidenceText,
    timeConfidence: args.patch.timeConfidence,
    timeStatus: args.patch.timeStatus,
    timeEvidenceKind: args.patch.timeEvidenceKind,
    artists: args.patch.artists,
    description: args.patch.description,
    normalizedFieldsJson: args.patch.normalizedFieldsJson,
    sourceOccurrenceKey: args.patch.sourceOccurrenceKey,
    moderationNote: args.moderationNote.trim(),
    updatedAt: primaryUpdatedAt,
  });
  await ctx.db.patch(primaryLink._id, {
    sourceFingerprint: args.patch.sourceFingerprint,
    sourceHandle: commonSourceHandle,
    updatedAt: nextEventUpdatedAt(primaryLink.updatedAt, now),
  });
  await ctx.db.patch(receipt._id, {
    sourceFingerprint: args.patch.sourceFingerprint,
    expectedKeys: [primaryEvent.sourceOccurrenceKey],
    expectedOccurrences: [
      {
        key: primaryEvent.sourceOccurrenceKey,
        date: primaryEvent.date,
        time: args.patch.time,
        venue: primaryEvent.venue,
        title: args.patch.title,
        artists: args.patch.artists,
      },
    ],
    satisfiedKeys: [primaryEvent.sourceOccurrenceKey],
    satisfiedOccurrences: [
      { key: primaryEvent.sourceOccurrenceKey, eventId: primaryEvent._id },
    ],
    updatedAt: receiptUpdatedAt,
  });
  await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
    ctx,
    {
      expected: {
        key: primaryEvent.sourceOccurrenceKey,
        date: primaryEvent.date,
        time: args.patch.time,
        venue: primaryEvent.venue,
        title: args.patch.title,
        artists: args.patch.artists,
      },
      representative: prospectiveEvent,
      sourceFingerprint: args.patch.sourceFingerprint,
      sourceLink: primaryLink,
      topologyEpochVerified: true,
    },
  );

  let movedSaveCount = 0;
  let dedupedSaveCount = 0;
  for (const duplicateEvent of duplicateEvents) {
    const saveResult = await reassignSavedEventReferences(
      ctx,
      duplicateEvent._id,
      primaryEvent._id,
    );
    movedSaveCount += saveResult.movedCount;
    dedupedSaveCount += saveResult.dedupedCount;
    const sourceLink = sourceLinks.get(duplicateEvent._id);
    if (!sourceLink) {
      throw new Error("Nightlife lineup duplicate source link disappeared.");
    }
    await ctx.db.delete(sourceLink._id);
    await sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(
      ctx,
      duplicateEvent._id,
      { topologyEpochVerified: true },
    );
    await ctx.db.delete(duplicateEvent._id);
    await writeEventAuditLog(
      ctx,
      duplicateEvent._id,
      "lineup_occurrence_folded",
      {
        actor: authorization.actor,
        note: args.moderationNote.trim(),
        patch: {
          primaryId: primaryEvent._id,
          sourceOccurrenceKey: duplicateEvent.sourceOccurrenceKey,
        },
      },
    );
  }
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await refreshCanonicalEventDerivedStates(ctx, [primaryEvent._id]);
  await writeEventAuditLog(
    ctx,
    primaryEvent._id,
    "lineup_occurrences_coalesced",
    {
      actor: authorization.actor,
      note: args.moderationNote.trim(),
      patch: {
        duplicateIds: duplicateEvents.map((event) => event._id),
        previousSourceOccurrenceKeys: args.expectedOccurrenceKeys,
        retainedSourceOccurrenceKey: primaryEvent.sourceOccurrenceKey,
        lineupSlots: plan.slots,
        title: args.patch.title,
        time: args.patch.time,
        artists: args.patch.artists,
        previousSourceFingerprint: args.expectedSourceFingerprint,
        sourceFingerprint: args.patch.sourceFingerprint,
        movedSaveCount,
        dedupedSaveCount,
      },
    },
  );

  return {
    primaryId: primaryEvent._id,
    primaryUpdatedAt,
    receiptUpdatedAt,
    deletedDuplicateCount: duplicateEvents.length,
    movedSaveCount,
    dedupedSaveCount,
  };
}
