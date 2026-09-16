import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeEventTimeWritePatch } from "../../lib/events/event-time-write";
import { adaptInstagramScrapedPostToSourceDocument } from "../../lib/domain/source-documents";
import { sha256Hex } from "../../lib/domain/reconciliation/evidence-digest";
import {
  assertServiceCreateEventPolicy,
  hasEventEvidenceV2AutoApproval,
} from "../../lib/events/event-update-precondition";
import { assertPublicEventImageWrite } from "../../lib/images/public-event-image";
import { PUBLICATION_POLICY_VERSION } from "../../lib/domain/publication/policy";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { requireAdminOrServiceSecret } from "../authz";
import {
  assertSourceOccurrencePlanMatchesSourceDocument,
  assertSourceOccurrencePlanWithinBounds,
  assertSourceProcessingFence,
  eventRepresentsExpectedOccurrence,
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

function isExactSingleOccurrencePlan(
  plan: SourceOccurrencePlan | undefined,
  sourceOccurrenceKey: string | undefined,
  fencedSourceIdentity: string | undefined,
): boolean {
  return Boolean(
    plan &&
      sourceOccurrenceKey &&
      fencedSourceIdentity &&
      plan.expectedKeys.length === 1 &&
      plan.expectedKeys[0] === sourceOccurrenceKey &&
      plan.expectedOccurrences.length === 1 &&
      plan.expectedOccurrences[0]?.key === sourceOccurrenceKey &&
      plan.deferredChildCount === 0 &&
      plan.deferredChildKeys.length === 0 &&
      plan.observedChildKeys.length === 1 &&
      // The planner tracks an ordinary single source child separately from
      // its occurrence. Schedule children deliberately remain outside this
      // bridge, even if only one schedule occurrence survived preparation.
      plan.observedChildKeys[0] ===
        `instagram-source-child-v1:${sha256Hex(JSON.stringify({
          sourceIdentity: fencedSourceIdentity,
          identity: { kind: "single" },
        }))}`,
  );
}

async function assertCanonicalDuplicateRepairSourceUnbound(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  sourceDocument: Doc<"scrapedPosts">,
): Promise<void> {
  const canonicalSource =
    adaptInstagramScrapedPostToSourceDocument(sourceDocument);
  const postIds = [
    ...new Set(
      [sourceDocument.postId.trim(), canonicalSource.providerDocumentId]
        .filter(Boolean),
    ),
  ];
  const postUrls = [
    ...new Set(
      [
        sourceDocument.instagramPostUrl.trim(),
        canonicalSource.canonicalSource.canonicalUrl,
      ].filter(Boolean),
    ),
  ];
  const canonicalPostUrl = canonicalSource.canonicalSource.canonicalUrl;
  const [
    receipts,
    sourceOccurrences,
    sourceOccurrencesByDocument,
    sourceOccurrencesByCanonicalUrl,
    legacyOccurrenceLinks,
    legacyLinksByPostId,
    legacyLinksByPostUrl,
    legacyLinksByCanonicalUrl,
    eventsByPostId,
    eventsByLegacyUrl,
    eventsByNormalizedUrl,
    eventsByCanonicalUrl,
  ] = await Promise.all([
    ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", plan.sourceIdentity),
      )
      .take(1),
    ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q.eq("sourceIdentity", plan.sourceIdentity),
      )
      .take(1),
    ctx.db
      .query("sourceOccurrences")
      .withIndex("by_document_occurrence", (q) =>
        q.eq("sourceDocumentId", sourceDocument._id),
      )
      .take(1),
    ctx.db
      .query("sourceOccurrences")
      .withIndex("by_canonical_source_occurrence", (q) =>
        q.eq("canonicalSourceUrl", canonicalPostUrl),
      )
      .take(1),
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_source_occurrence", (q) =>
        q.eq("sourceIdentity", plan.sourceIdentity),
      )
      .take(1),
    Promise.all(
      postIds.map((postId) =>
        ctx.db
          .query("instagramEventSources")
          .withIndex("by_post_id", (q) => q.eq("instagramPostId", postId))
          .take(1),
      ),
    ),
    Promise.all(
      postUrls.map((postUrl) =>
        ctx.db
          .query("instagramEventSources")
          .withIndex("by_post_url", (q) =>
            q.eq("instagramPostUrl", postUrl),
          )
          .take(1),
      ),
    ),
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_canonical_source_url", (q) =>
        q.eq("canonicalSourceUrl", canonicalPostUrl),
      )
      .take(1),
    Promise.all(
      postIds.map((postId) =>
        ctx.db
          .query("events")
          .withIndex("by_instagramPostId", (q) =>
            q.eq("instagramPostId", postId),
          )
          .take(1),
      ),
    ),
    Promise.all(
      postUrls.map((postUrl) =>
        ctx.db
          .query("events")
          .withIndex("by_instagramPostUrl", (q) =>
            q.eq("instagramPostUrl", postUrl),
          )
          .take(1),
      ),
    ),
    ctx.db
      .query("events")
      .withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", canonicalPostUrl),
      )
      .take(1),
    ctx.db
      .query("events")
      .withIndex("by_canonicalSourceUrl", (q) =>
        q.eq("canonicalSourceUrl", canonicalPostUrl),
      )
      .take(1),
  ]);
  if (
    receipts.length > 0 ||
    sourceOccurrences.length > 0 ||
    sourceOccurrencesByDocument.length > 0 ||
    sourceOccurrencesByCanonicalUrl.length > 0 ||
    legacyOccurrenceLinks.length > 0 ||
    legacyLinksByPostId.some((rows) => rows.length > 0) ||
    legacyLinksByPostUrl.some((rows) => rows.length > 0) ||
    legacyLinksByCanonicalUrl.length > 0 ||
    eventsByPostId.some((rows) => rows.length > 0) ||
    eventsByLegacyUrl.some((rows) => rows.length > 0) ||
    eventsByNormalizedUrl.length > 0 ||
    eventsByCanonicalUrl.length > 0
  ) {
    throw new Error(
      "Canonical-duplicate-only creation requires an unbound source document with no occurrence receipt.",
    );
  }
}

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
    requireCanonicalApprovedDuplicate?: boolean;
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
    requireCanonicalApprovedDuplicate,
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
  if (occurrencePlan) {
    assertSourceOccurrencePlanWithinBounds(occurrencePlan);
  }
  const canReturnCanonicalApprovedDuplicate =
    kind === "service" &&
    returnCreateDisposition === true &&
    processingFence !== undefined &&
    eventArgs.status === "approved" &&
    isExactSingleOccurrencePlan(
      occurrencePlan,
      eventArgs.sourceOccurrenceKey,
      sourceDocument
        ? adaptInstagramScrapedPostToSourceDocument(sourceDocument).sourceIdentity
        : undefined,
    );
  if (
    requireCanonicalApprovedDuplicate === true &&
    !canReturnCanonicalApprovedDuplicate
  ) {
    throw new Error(
      "Canonical-duplicate-only creation requires service authentication, one exact approved occurrence, and a current processing fence.",
    );
  }
  if (canReturnCanonicalApprovedDuplicate) {
    const strictPlan = occurrencePlan as SourceOccurrencePlan;
    const strictSourceDocument = sourceDocument as Doc<"scrapedPosts">;
    assertSourceOccurrencePlanMatchesSourceDocument(
      strictPlan,
      strictSourceDocument,
    );
    if (
      !eventRepresentsExpectedOccurrence(
        {
          title: eventArgs.title,
          date: eventArgs.date,
          time: eventArgs.time,
          venue: eventArgs.venue,
          artists: eventArgs.artists,
          status: eventArgs.status ?? "pending",
          sourceOccurrenceKey: eventArgs.sourceOccurrenceKey,
          normalizedFieldsJson: eventArgs.normalizedFieldsJson,
        },
        strictPlan.expectedOccurrences[0],
      )
    ) {
      throw new Error(
        "Canonical-duplicate-only candidate does not represent its exact source occurrence.",
      );
    }
    if (requireCanonicalApprovedDuplicate === true) {
      await assertCanonicalDuplicateRepairSourceUnbound(
        ctx,
        strictPlan,
        strictSourceDocument,
      );
    }
  }
  if (eventArgs.sourceOccurrenceKey) {
    const existingOccurrence = await ctx.db
      .query("events")
      .withIndex("by_sourceOccurrenceKey", (q) =>
        q.eq("sourceOccurrenceKey", eventArgs.sourceOccurrenceKey),
      )
      .unique();
    if (existingOccurrence) {
      if (requireCanonicalApprovedDuplicate === true) {
        throw new Error(
          "Canonical-duplicate-only creation cannot reuse an existing source occurrence.",
        );
      }
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
    const existingApprovedDuplicate = await assertApprovalCandidatePolicy(
      ctx,
      { ...eventArgs, ...venueFields },
      [],
      {
        returnUniqueApprovedDuplicate: canReturnCanonicalApprovedDuplicate,
      },
    );
    if (existingApprovedDuplicate) {
      return {
        eventId: existingApprovedDuplicate.eventId,
        created: false,
        updatedAt: existingApprovedDuplicate.updatedAt,
        disposition: "canonical_approved_duplicate" as const,
      };
    }
    if (requireCanonicalApprovedDuplicate === true) {
      throw new Error(
        "Canonical-duplicate-only creation did not find one uniquely proven approved event.",
      );
    }
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
