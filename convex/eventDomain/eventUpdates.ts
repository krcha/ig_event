import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { normalizeEventTimeWritePatch } from "../../lib/events/event-time-write";
import {
  assertExpectedEventStatus,
  assertExpectedEventUpdatedAt,
  assertServiceUpdateEventPolicy,
  hasEventEvidenceV2AutoApproval,
  nextEventUpdatedAt,
} from "../../lib/events/event-update-precondition";
import { assertPublicEventImageWrite } from "../../lib/images/public-event-image";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { requireAdminOrServiceSecret } from "../authz";
import {
  assertSourceOccurrenceGenerationCurrent,
  assertSourceProcessingFence,
  eventRepresentsExpectedOccurrence,
  recordSourceOccurrenceSatisfaction,
  type SourceOccurrencePlan,
} from "../internal/sourceOccurrenceReceipts";
import {
  evaluateEventPublication,
  refreshEventPublicationStates,
  toPublicationPatch,
} from "../publicationPolicy";
import { MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION } from "../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "./sourceApproval";
import { resolveVenueDenormalizedFields } from "./moderationVenue";
import { scheduleSourceOccurrenceShadow } from "./sourceOccurrenceCompatibility";
import { writeEventAuditLog } from "./persistence";
import type { EventUpdatePatch } from "./contracts";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";

type Authorization = {
  actor: string;
  kind: "admin" | "service";
};

type EventUpdateArgs = {
  id: Id<"events">;
  patch: EventUpdatePatch;
  expectedStatus?: "pending" | "approved" | "rejected";
  expectedUpdatedAt?: number;
};

export async function applyEventUpdate(
  ctx: MutationCtx,
  args: EventUpdateArgs,
  authorization: Authorization,
  options: { occurrenceRebindFollows?: boolean } = {},
): Promise<{ updatedAt: number }> {
  const existingEvent = await ctx.db.get(args.id);
  if (!existingEvent) {
    throw new Error("Event not found.");
  }
  assertExpectedEventStatus(existingEvent.status, args.expectedStatus);
  assertExpectedEventUpdatedAt(existingEvent.updatedAt, args.expectedUpdatedAt);

  const { clearTicketPrice, ...eventPatch } = args.patch;
  if (clearTicketPrice && eventPatch.ticketPrice !== undefined) {
    throw new Error(
      "ticketPrice and clearTicketPrice cannot be used together.",
    );
  }
  const venueFields =
    eventPatch.venue !== undefined
      ? await resolveVenueDenormalizedFields(ctx, eventPatch.venue)
      : {};
  const nextImageStorageId =
    eventPatch.imageStorageId ??
    (eventPatch.imageUrl !== undefined &&
    eventPatch.imageUrl === existingEvent.imageUrl
      ? existingEvent.imageStorageId
      : undefined);
  assertPublicEventImageWrite(eventPatch.imageUrl, nextImageStorageId);
  const imagePairPatch =
    eventPatch.imageUrl !== undefined
      ? {
          imageUrl: eventPatch.imageUrl,
          imageStorageId: nextImageStorageId,
        }
      : {};
  const canonicalSourceUrl =
    eventPatch.instagramPostUrl === undefined
      ? undefined
      : requireCanonicalInstagramPostUrl(
          eventPatch.instagramPostUrl,
          "Event update",
        );
  const patch = {
    ...normalizeEventTimeWritePatch(eventPatch),
    ...(clearTicketPrice ? { ticketPrice: undefined } : {}),
    ...imagePairPatch,
    ...venueFields,
    ...(eventPatch.instagramPostUrl !== undefined
      ? {
          normalizedInstagramPostUrl: canonicalSourceUrl,
          canonicalSourceUrl,
        }
      : {}),
    ...(eventPatch.eventType !== undefined
      ? { eventType: canonicalizeEventType(eventPatch.eventType) }
      : {}),
  };
  const materialChange = Object.entries(patch).some(
    ([key, value]) =>
      JSON.stringify(existingEvent[key as keyof typeof existingEvent]) !==
      JSON.stringify(value),
  );
  const occurrenceDefiningFields = new Set([
    "artists",
    "date",
    "dateEvidenceIsRelative",
    "dateEvidenceResolvedDate",
    "dateEvidenceSource",
    "dateEvidenceText",
    "eventType",
    "instagramPostId",
    "instagramPostUrl",
    "normalizedFieldsJson",
    "rawExtractionJson",
    "sourceCaption",
    "sourceConflictFields",
    "sourcePostedAt",
    "time",
    "timeConfidence",
    "timeEvidenceKind",
    "timeEvidenceText",
    "timeSource",
    "timeStatus",
    "title",
    "venue",
  ]);
  const occurrenceDefiningChange = Object.entries(patch).some(
    ([key, value]) =>
      occurrenceDefiningFields.has(key) &&
      JSON.stringify(existingEvent[key as keyof typeof existingEvent]) !==
        JSON.stringify(value),
  );
  if (isCrossPostCampaignLineageEvent(existingEvent)) {
    if (materialChange) {
      throw new Error(
        "Campaign lineage events may only change through a dedicated re-attestation operation.",
      );
    }
    return { updatedAt: existingEvent.updatedAt };
  }
  if (occurrenceDefiningChange && !options.occurrenceRebindFollows) {
    const [occurrences, sourceLinks] = await Promise.all([
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_canonical_event", (q) =>
          q.eq("canonicalEventId", existingEvent._id),
        )
        .take(MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1),
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", existingEvent._id))
        .take(MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1),
    ]);
    if (
      occurrences.length > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION ||
      sourceLinks.length > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION
    ) {
      throw new DomainError(
        "OCCURRENCE_INCOMPLETE",
        "Event provenance exceeds the safe bounded update limit.",
      );
    }
    if (
      sourceLinks.length > 0 ||
      occurrences.some((occurrence) => occurrence.state !== "superseded")
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Occurrence-defining event fields require a receipt-fenced correction transaction.",
        { details: { eventId: existingEvent._id } },
      );
    }
  }
  const updatedAt = nextEventUpdatedAt(existingEvent.updatedAt);
  const effectiveEvent = { ...existingEvent, ...patch };
  if (authorization.kind === "service") {
    const structuredEvidenceApproval = hasEventEvidenceV2AutoApproval(
      effectiveEvent.normalizedFieldsJson,
      effectiveEvent,
    );
    if (
      patch.status === "approved" &&
      !effectiveEvent.venueInstagramHandle &&
      !structuredEvidenceApproval
    ) {
      throw new Error(
        "Service-authenticated event updates cannot approve an event without a resolved source venue handle.",
      );
    }
    assertServiceUpdateEventPolicy(existingEvent.status, patch, existingEvent);
    if (patch.status === "approved") {
      await assertPersistedServiceSourcePolicy(ctx, effectiveEvent);
    }
  }
  if (effectiveEvent.status === "approved") {
    requireCanonicalInstagramPostUrl(
      effectiveEvent.instagramPostUrl,
      `Approved event update ${existingEvent._id}`,
    );
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
      [args.id],
    );
  }
  const occurrenceIndexPatch = materialChange
    ? buildEventOccurrenceIndexPatch(effectiveEvent)
    : {};
  const publicationPatch = toPublicationPatch(
    await evaluateEventPublication(ctx, {
      ...effectiveEvent,
      ...occurrenceIndexPatch,
      updatedAt,
    }),
  );
  await ctx.db.patch(args.id, {
    ...patch,
    ...occurrenceIndexPatch,
    ...publicationPatch,
    updatedAt,
  });
  const auditPatch = clearTicketPrice
    ? { ...patch, clearTicketPrice: true }
    : patch;
  await writeEventAuditLog(ctx, args.id, "updated", {
    actor: authorization.actor,
    patch: auditPatch,
  });
  return { updatedAt };
}

export async function updateEventHandler(
  ctx: MutationCtx,
  args: EventUpdateArgs & { serviceSecret?: string },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  return applyEventUpdate(ctx, args, authorization);
}

export async function updateEventAndRecordInstagramSourceOccurrenceSatisfactionHandler(
  ctx: MutationCtx,
  args: EventUpdateArgs & {
    plan: SourceOccurrencePlan;
    satisfiedKey: string;
    supersededKey?: string;
    processingFence: Parameters<typeof assertSourceProcessingFence>[1];
    serviceSecret?: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  const sourceDocument = await assertSourceProcessingFence(
    ctx,
    args.processingFence,
  );
  await assertSourceOccurrenceGenerationCurrent(ctx, args.plan);
  const existingEvent = await ctx.db.get(args.id);
  const expectedOccurrence = args.plan.expectedOccurrences?.find(
    (occurrence) => occurrence.key === args.satisfiedKey,
  );
  if (
    existingEvent &&
    expectedOccurrence &&
    !eventRepresentsExpectedOccurrence(
      { ...existingEvent, ...args.patch },
      expectedOccurrence,
      { allowUnverifiedPending: true },
    )
  ) {
    throw new Error("Updated event does not match the source occurrence.");
  }
  const updateResult = await applyEventUpdate(ctx, args, authorization, {
    occurrenceRebindFollows: true,
  });
  const satisfaction = await recordSourceOccurrenceSatisfaction(
    ctx,
    args.plan,
    args.satisfiedKey,
    args.id,
    sourceDocument as Doc<"scrapedPosts">,
    args.supersededKey,
  );
  await refreshEventPublicationStates(ctx, satisfaction.representativeEventIds);
  await scheduleSourceOccurrenceShadow(
    ctx,
    satisfaction.sourceOccurrenceId,
    "update",
  );
  return { updated: true, recorded: true, updatedAt: updateResult.updatedAt };
}
