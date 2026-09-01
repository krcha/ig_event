import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEventTimeWritePatch } from "../../lib/events/event-time-write";
import {
  assertServiceCreateEventPolicy,
  hasEventEvidenceV2AutoApproval,
} from "../../lib/events/event-update-precondition";
import { assertPublicEventImageWrite } from "../../lib/images/public-event-image";
import { PUBLICATION_POLICY_VERSION } from "../../lib/domain/publication/policy";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { requireAdminOrServiceSecret } from "../authz";
import {
  assertSourceProcessingFence,
  recordSourceOccurrenceSatisfaction,
  type SourceOccurrencePlan,
} from "../internal/sourceOccurrenceReceipts";
import { refreshEventPublicationStates } from "../publicationPolicy";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import { resolveVenueDenormalizedFields } from "./moderationVenue";
import { writeEventAuditLog } from "./persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
} from "./sourceApproval";
import { scheduleSourceOccurrenceShadow } from "./sourceOccurrenceCompatibility";
import { requireCanonicalInstagramPostUrl } from "./sourceUrlPolicy";

type EventTimeSource =
  | "alt_text"
  | "caption"
  | "description"
  | "model"
  | "poster"
  | "schedule_entry"
  | "unknown";
type EventTimeStatus = "confirmed" | "inferred" | "unknown";
type EventTimeEvidenceKind =
  | "start_time_stated"
  | "not_stated"
  | "unreadable"
  | "doors_open_only";
type EventDateEvidenceSource = "caption" | "poster" | "alt_text" | "unknown";

export async function createEventHandler(
  ctx: MutationCtx,
  args: {
    title: string;
    date: string;
    time?: string;
    timeSource?: EventTimeSource;
    timeEvidenceText?: string | null;
    timeConfidence?: number;
    timeStatus?: EventTimeStatus;
    timeEvidenceKind?: EventTimeEvidenceKind;
    dateEvidenceText?: string;
    dateEvidenceSource?: EventDateEvidenceSource;
    dateEvidenceIsRelative?: boolean;
    dateEvidenceResolvedDate?: string;
    sourceConflictFields?: string[];
    venue: string;
    artists: string[];
    description?: string;
    imageUrl?: string;
    imageStorageId?: Id<"_storage">;
    instagramPostUrl?: string;
    instagramPostId?: string;
    ticketPrice?: string;
    eventType: string;
    sourceCaption?: string;
    sourcePostedAt?: string;
    rawExtractionJson?: string;
    normalizedFieldsJson?: string;
    sourceOccurrenceKey?: string;
    sourceOccurrencePlan?: SourceOccurrencePlan;
    processingFence?: Parameters<typeof assertSourceProcessingFence>[1];
    promotionTier?: "featured" | "promoted";
    promotionStart?: string;
    promotionEnd?: string;
    promotionPriority?: number;
    status?: "pending" | "approved" | "rejected";
    returnCreateDisposition?: boolean;
    serviceSecret?: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  const {
    serviceSecret: _serviceSecret,
    returnCreateDisposition,
    sourceOccurrencePlan: occurrencePlan,
    processingFence,
    ...eventArgs
  } = args;
  const sourceDocument = processingFence
    ? await assertSourceProcessingFence(ctx, processingFence)
    : null;
  if (!processingFence && (occurrencePlan || eventArgs.sourceOccurrenceKey)) {
    throw new Error(
      "Source occurrence event creation requires a current processing fence.",
    );
  }
  if (eventArgs.sourceOccurrenceKey) {
    const existingOccurrence = await ctx.db
      .query("events")
      .withIndex("by_sourceOccurrenceKey", (q) =>
        q.eq("sourceOccurrenceKey", eventArgs.sourceOccurrenceKey),
      )
      .unique();
    if (existingOccurrence) {
      if (occurrencePlan && eventArgs.sourceOccurrenceKey) {
        const satisfaction = await recordSourceOccurrenceSatisfaction(
          ctx,
          occurrencePlan,
          eventArgs.sourceOccurrenceKey,
          existingOccurrence._id,
          sourceDocument as Doc<"scrapedPosts">,
        );
        await refreshEventPublicationStates(
          ctx,
          satisfaction.representativeEventIds,
        );
        await scheduleSourceOccurrenceShadow(
          ctx,
          satisfaction.sourceOccurrenceId,
          "attach",
        );
      }
      return returnCreateDisposition
        ? {
            eventId: existingOccurrence._id,
            created: false,
            updatedAt: existingOccurrence.updatedAt,
          }
        : existingOccurrence._id;
    }
  }
  const venueFields = await resolveVenueDenormalizedFields(
    ctx,
    eventArgs.venue,
  );
  if (kind === "service") {
    const structuredEvidenceApproval = hasEventEvidenceV2AutoApproval(
      eventArgs.normalizedFieldsJson,
      { ...eventArgs, ...venueFields },
    );
    if (
      eventArgs.status === "approved" &&
      !venueFields.venueInstagramHandle &&
      !structuredEvidenceApproval
    ) {
      throw new Error(
        "Service-authenticated event creation cannot approve an event without a resolved source venue handle.",
      );
    }
    assertServiceCreateEventPolicy(args.status, args.normalizedFieldsJson, {
      ...eventArgs,
      ...venueFields,
    });
    if (eventArgs.status === "approved") {
      await assertPersistedServiceSourcePolicy(ctx, {
        ...eventArgs,
        ...venueFields,
      });
    }
  }
  void _serviceSecret;
  const now = Date.now();
  assertPublicEventImageWrite(eventArgs.imageUrl, eventArgs.imageStorageId);
  if (eventArgs.status === "approved") {
    await assertApprovalCandidatePolicy(ctx, { ...eventArgs, ...venueFields });
  }
  const normalizedEventArgs = normalizeEventTimeWritePatch(eventArgs);
  const canonicalEventType = canonicalizeEventType(eventArgs.eventType);
  const effectiveEventForIndexes = {
    ...normalizedEventArgs,
    ...venueFields,
    eventType: canonicalEventType,
  };
  const occurrenceIndexFields = buildEventOccurrenceIndexPatch(
    effectiveEventForIndexes,
  );
  const canonicalSourceUrl =
    eventArgs.instagramPostUrl === undefined &&
    (eventArgs.status ?? "pending") !== "approved"
      ? ""
      : requireCanonicalInstagramPostUrl(
          eventArgs.instagramPostUrl,
          "Event creation",
        );
  const eventId = await ctx.db.insert("events", {
    ...normalizedEventArgs,
    ...(canonicalSourceUrl
      ? {
          normalizedInstagramPostUrl: canonicalSourceUrl,
        }
      : {}),
    ...(canonicalSourceUrl ? { canonicalSourceUrl } : {}),
    ...venueFields,
    ...occurrenceIndexFields,
    eventType: canonicalEventType,
    publicationEvaluatedAt: now,
    publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
    publicationReason:
      (eventArgs.status ?? "pending") === "approved"
        ? "canonical_source_grounding_missing"
        : "moderation_not_approved",
    publicationState:
      (eventArgs.status ?? "pending") === "approved"
        ? "pending_verification"
        : "hidden",
    status: eventArgs.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  });

  let occurrenceRepresentativeEventIds: Id<"events">[] = [eventId];
  let sourceOccurrenceIdForShadow: Id<"sourceOccurrences"> | null = null;
  if (occurrencePlan && eventArgs.sourceOccurrenceKey) {
    const satisfaction = await recordSourceOccurrenceSatisfaction(
      ctx,
      occurrencePlan,
      eventArgs.sourceOccurrenceKey,
      eventId,
      sourceDocument as Doc<"scrapedPosts">,
    );
    occurrenceRepresentativeEventIds = satisfaction.representativeEventIds;
    sourceOccurrenceIdForShadow = satisfaction.sourceOccurrenceId;
  }
  await refreshEventPublicationStates(ctx, occurrenceRepresentativeEventIds);
  if (sourceOccurrenceIdForShadow) {
    await scheduleSourceOccurrenceShadow(
      ctx,
      sourceOccurrenceIdForShadow,
      "create",
    );
  }

  await writeEventAuditLog(ctx, eventId, "created", {
    actor,
    patch: normalizedEventArgs,
  });

  return returnCreateDisposition
    ? { eventId, created: true, updatedAt: now }
    : eventId;
}
