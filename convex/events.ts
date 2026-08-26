import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import {
  formatMinutesSinceMidnight,
  getConfiguredEventTimezone,
  getEventExpiryCutoff,
  isEventExpiredAtCutoff,
} from "../lib/events/event-retention";
import { normalizeEventTimeWritePatch } from "../lib/events/event-time-write";
import { isSensibleEventTitleForApproval } from "../lib/events/event-title-approval";
import { classifyApprovalOccurrenceRelation } from "../lib/events/approval-occurrence-conflict";
import { MAX_MODERATION_DUPLICATE_CONTEXT_DATES } from "../lib/events/moderation-duplicate-context";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../lib/events/source-occurrence-representation";
import { buildNormalizedEventVenueIdentity } from "../lib/events/event-venue-identity";
import { buildUnnamedScheduleFallbackTitle } from "../lib/events/unnamed-schedule-fallback";
import {
  buildNightlifeLineupCoalescingPlan,
  NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION,
  type NightlifeLineupSource,
} from "../lib/events/nightlife-lineup-coalescing";
import {
  buildCrossPostPromotionCoalescingPlan,
  CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
} from "../lib/events/cross-post-promotion-coalescing";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "../lib/events/approved-event-duplicates";
import {
  assertExpectedEventStatus,
  assertExpectedEventUpdatedAt,
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  hasCompleteSourceGroundingAttestation,
  hasEventEvidenceV2AutoApproval,
  hasHumanReviewedLegacySourceAttestation,
  hasHumanReviewedLegacySourcePolicyMarker,
  hasHumanReviewableLegacySourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  nextEventUpdatedAt,
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
} from "../lib/events/event-update-precondition";
import {
  buildCanonicalVenueAliasesByHandle,
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueNameDetailed,
  normalizeHandle,
  toSearchableText,
} from "../lib/pipeline/venue-normalization";
import { canonicalizeEventType } from "../lib/taxonomy/venue-types";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import { assertPublicEventImageWrite } from "../lib/images/public-event-image";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "./authz";
import { projectPublicEvent } from "./publicEventProjection";
import { isCanonicallyGroundedApprovedEvent } from "./publicEventGrounding";

const eventStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
const moderationDuplicateContextEvent = v.object({
  _id: v.id("events"),
  title: v.string(),
  date: v.string(),
  time: v.optional(v.string()),
  venue: v.string(),
  normalizedVenueIdentity: v.optional(v.string()),
  normalizedVenueInstagramHandle: v.optional(v.string()),
  artists: v.array(v.string()),
  description: v.optional(v.string()),
  eventType: v.string(),
  sourceCaption: v.optional(v.string()),
  status: eventStatus,
  createdAt: v.number(),
  updatedAt: v.number(),
});
const moderationDuplicateContextResult = v.object({
  events: v.array(moderationDuplicateContextEvent),
  truncated: v.boolean(),
});
const pendingModerationUniquenessReviewItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
});
const pendingModerationUniquenessDisposition = v.union(
  v.literal("unique"),
  v.literal("duplicate"),
  v.literal("ambiguous"),
  v.literal("ineligible"),
  v.literal("indeterminate"),
);
const pendingModerationUniquenessReason = v.union(
  v.literal("unique_no_conflict"),
  v.literal("duplicate_same_occurrence"),
  v.literal("ambiguous_same_date_occurrence"),
  v.literal("ineligible_title"),
  v.literal("ineligible_invalid_date"),
  v.literal("ineligible_expired_event"),
  v.literal("ineligible_source_policy"),
  v.literal("indeterminate_venue_limit"),
  v.literal("indeterminate_pending_cohort_limit"),
  v.literal("indeterminate_approved_cohort_limit"),
  v.literal("indeterminate_batch_incomplete"),
);
const pendingModerationUniquenessClassification = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  disposition: pendingModerationUniquenessDisposition,
  reason: pendingModerationUniquenessReason,
  conflictIds: v.array(v.id("events")),
});
const pendingModerationUniquenessResult = v.object({
  complete: v.boolean(),
  items: v.array(pendingModerationUniquenessClassification),
});
const approveUniquePendingEventsResult = v.object({
  complete: v.boolean(),
  approvedIds: v.array(v.id("events")),
  skipped: v.array(pendingModerationUniquenessClassification),
});
const promotionTier = v.union(v.literal("featured"), v.literal("promoted"));
const sourceProcessingFence = v.object({
  handle: v.string(),
  scrapedPostId: v.optional(v.id("scrapedPosts")),
  postId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
  owner: v.string(),
  sourceRevision: v.number(),
});
type SourceProcessingFence = {
  handle: string;
  scrapedPostId?: Id<"scrapedPosts">;
  postId?: string;
  instagramPostUrl?: string;
  owner: string;
  sourceRevision: number;
};
const sourceOccurrencePlan = v.object({
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
    }),
  ),
  deferredChildCount: v.number(),
  deferredChildKeys: v.array(v.string()),
  observedChildKeys: v.array(v.string()),
  previousSourceFingerprint: v.optional(v.union(v.string(), v.null())),
  confirmedPastKeys: v.optional(v.array(v.string())),
});
const eventTimeSource = v.union(
  v.literal("alt_text"),
  v.literal("caption"),
  v.literal("description"),
  v.literal("model"),
  v.literal("poster"),
  v.literal("schedule_entry"),
  v.literal("unknown"),
);
const eventTimeStatus = v.union(
  v.literal("confirmed"),
  v.literal("inferred"),
  v.literal("unknown"),
);
const eventDateEvidenceSource = v.union(
  v.literal("caption"),
  v.literal("poster"),
  v.literal("alt_text"),
  v.literal("unknown"),
);
const eventTimeEvidenceKind = v.union(
  v.literal("start_time_stated"),
  v.literal("not_stated"),
  v.literal("unreadable"),
  v.literal("doors_open_only"),
);
const eventUpdatePatch = v.object({
  title: v.optional(v.string()),
  date: v.optional(v.string()),
  time: v.optional(v.string()),
  timeSource: v.optional(eventTimeSource),
  timeEvidenceText: v.optional(v.union(v.string(), v.null())),
  timeConfidence: v.optional(v.number()),
  timeStatus: v.optional(eventTimeStatus),
  timeEvidenceKind: v.optional(eventTimeEvidenceKind),
  dateEvidenceText: v.optional(v.string()),
  dateEvidenceSource: v.optional(eventDateEvidenceSource),
  dateEvidenceIsRelative: v.optional(v.boolean()),
  dateEvidenceResolvedDate: v.optional(v.string()),
  sourceConflictFields: v.optional(v.array(v.string())),
  venue: v.optional(v.string()),
  artists: v.optional(v.array(v.string())),
  description: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageStorageId: v.optional(v.id("_storage")),
  instagramPostUrl: v.optional(v.string()),
  instagramPostId: v.optional(v.string()),
  ticketPrice: v.optional(v.string()),
  clearTicketPrice: v.optional(v.boolean()),
  eventType: v.optional(v.string()),
  sourceCaption: v.optional(v.string()),
  sourcePostedAt: v.optional(v.string()),
  rawExtractionJson: v.optional(v.string()),
  normalizedFieldsJson: v.optional(v.string()),
  promotionTier: v.optional(promotionTier),
  promotionStart: v.optional(v.string()),
  promotionEnd: v.optional(v.string()),
  promotionPriority: v.optional(v.number()),
  status: v.optional(eventStatus),
  reviewedAt: v.optional(v.number()),
  reviewedBy: v.optional(v.string()),
  moderationNote: v.optional(v.string()),
});
type EventUpdatePatch = Infer<typeof eventUpdatePatch>;
const moderationStatus = v.union(v.literal("approved"), v.literal("rejected"));
const sourceGroundingReprocessItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  nextNormalizedFieldsJson: v.string(),
});
const eventEvidencePolicyPatch = v.object({
  artists: v.optional(v.array(v.string())),
  dateEvidenceIsRelative: v.boolean(),
  dateEvidenceResolvedDate: v.string(),
  dateEvidenceSource: eventDateEvidenceSource,
  dateEvidenceText: v.string(),
  normalizedFieldsJson: v.string(),
  sourceConflictFields: v.array(v.string()),
  status: eventStatus,
  title: v.optional(v.string()),
  venue: v.optional(v.string()),
});
const eventEvidencePolicyReprocessItem = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  patch: eventEvidencePolicyPatch,
});
const trustedV2VenueRepairResult = v.object({
  updated: v.boolean(),
  updatedAt: v.number(),
  status: eventStatus,
});
const approvedLegacyVenueRepairResult = v.object({
  receiptUpdatedAt: v.number(),
  status: v.literal("approved"),
  updated: v.boolean(),
  updatedAt: v.number(),
});
const nightlifeLineupCandidateVersion = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
});
const nightlifeLineupCoalescingPatch = v.object({
  title: v.string(),
  time: v.string(),
  timeSource: eventTimeSource,
  timeEvidenceText: v.string(),
  timeConfidence: v.number(),
  timeStatus: eventTimeStatus,
  timeEvidenceKind: eventTimeEvidenceKind,
  artists: v.array(v.string()),
  description: v.string(),
  normalizedFieldsJson: v.string(),
  sourceOccurrenceKey: v.string(),
  sourceFingerprint: v.string(),
});
const nightlifeLineupCoalescingResult = v.object({
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  receiptUpdatedAt: v.number(),
  deletedDuplicateCount: v.number(),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});
const crossPostPromotionCandidateVersion = v.object({
  id: v.id("events"),
  expectedUpdatedAt: v.number(),
  expectedNormalizedFieldsJson: v.string(),
  expectedSourceLinkId: v.id("instagramEventSources"),
  expectedSourceLinkUpdatedAt: v.number(),
  expectedSourceIdentity: v.string(),
  expectedSourceFingerprint: v.string(),
  expectedOccurrenceKey: v.string(),
  expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
});
const crossPostPromotionCoalescingResult = v.object({
  operationId: v.string(),
  primaryId: v.id("events"),
  primaryUpdatedAt: v.number(),
  foldedVariantIds: v.array(v.id("events")),
  variantUpdatedAts: v.array(
    v.object({ id: v.id("events"), updatedAt: v.number() }),
  ),
  variantReceiptUpdatedAts: v.array(
    v.object({
      eventId: v.id("events"),
      receiptId: v.id("instagramSourceOccurrenceReceipts"),
      updatedAt: v.number(),
    }),
  ),
  movedSaveCount: v.number(),
  dedupedSaveCount: v.number(),
});
const crossPostPromotionCoalescingContextResult = v.object({
  state: v.union(v.literal("ready"), v.literal("already_coalesced")),
  targetVenue: v.any(),
  candidates: v.array(
    v.object({
      event: v.any(),
      sourceLink: v.any(),
      receipt: v.any(),
    }),
  ),
});
const MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE = 100;
const MAX_EVENT_EVIDENCE_POLICY_REPROCESS_BATCH_SIZE = 16;
const MAX_APPROVAL_DATE_COHORT_SIZE = 500;
const MAX_EVENTS_GET_MANY_BY_IDS = 100;
const MAX_PENDING_MODERATION_UNIQUENESS_ITEMS = 10;
const MAX_PENDING_MODERATION_UNIQUENESS_VENUES = 2_000;
const MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE = 100;
const PENDING_MODERATION_UNIQUENESS_PREVIEW_NOTE =
  "Server preview of unique pending approval.";
const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS = 100;
const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE = 8;
const MODERATION_DUPLICATE_CONTEXT_DATE_BATCH_SIZE = 4;
const MODERATION_DUPLICATE_CONTEXT_TITLE_LENGTH = 300;
const MODERATION_DUPLICATE_CONTEXT_TIME_LENGTH = 32;
const MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH = 300;
const MODERATION_DUPLICATE_CONTEXT_ARTIST_COUNT = 100;
const MODERATION_DUPLICATE_CONTEXT_ARTIST_LENGTH = 200;
const MODERATION_DUPLICATE_CONTEXT_DESCRIPTION_LENGTH = 1_000;
const MODERATION_DUPLICATE_CONTEXT_EVENT_TYPE_LENGTH = 100;
const MODERATION_DUPLICATE_CONTEXT_CAPTION_LENGTH = 2_000;
const SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS = new Set([
  "caption_source_event_mismatch",
  "unverified_core_event_source",
]);
const SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS = new Set([
  ...SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS,
  "requires_human_approval",
]);
const DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE = 100;
const DISCOVER_ORGANIC_SCAN_LIMIT = 120;
const PUBLIC_EVENT_PAGE_SIZE = 50;
const MAX_PUBLIC_EVENT_WINDOW_DAYS = 400;
const MAX_PUBLIC_CALENDAR_WINDOW_DAYS = 45;
const PUBLIC_DUPLICATE_DATE_COHORT_LIMIT = 25;
const MAX_LINEUP_COALESCING_SAVES_PER_EVENT = 1_000;
const MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT = 100;
const MAX_CROSS_POST_PROMOTION_AUDIT_JSON_BYTES = 600_000;

function buildPublicPaginationOptions(options: { cursor: string | null; numItems: number }) {
  const requested = Number.isFinite(options.numItems) ? Math.trunc(options.numItems) : 1;
  return {
    cursor: options.cursor,
    numItems: Math.max(1, Math.min(PUBLIC_EVENT_PAGE_SIZE, requested)),
  };
}

function readModerationPendingReasons(normalizedFieldsJson: string | undefined): string[] {
  try {
    const parsed = JSON.parse(normalizedFieldsJson ?? "{}");
    return Array.isArray(parsed?.moderationPendingReasons)
      ? parsed.moderationPendingReasons.filter(
          (reason: unknown): reason is string => typeof reason === "string" && reason.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function assertSourceGroundingReprocessReasons(event: Doc<"events">): void {
  const reasons = readModerationPendingReasons(event.normalizedFieldsJson);
  if (!reasons.some((reason) => SOURCE_GROUNDING_REPROCESS_SOURCE_REASONS.has(reason))) {
    throw new Error(`Source-grounding hold required for event ${event._id}.`);
  }
  const nonRemovable = reasons.filter(
    (reason) => !SOURCE_GROUNDING_REPROCESS_REMOVABLE_REASONS.has(reason),
  );
  if (nonRemovable.length > 0) {
    throw new Error(
      `Unrelated moderation holds block source-grounding reprocessing for event ${event._id}: ${nonRemovable.join(", ")}.`,
    );
  }
}

type VenueDenormalizedFields = {
  normalizedVenueIdentity?: string | undefined;
  normalizedVenueInstagramHandle?: string | undefined;
  venueCategory?: string | undefined;
  venueId?: Id<"venues"> | undefined;
  venueInstagramHandle?: string | undefined;
  venueLatitude?: number | undefined;
  venueLocation?: string | undefined;
  venueLongitude?: number | undefined;
};

const CLEARED_VENUE_DENORMALIZED_FIELDS: VenueDenormalizedFields = {
  normalizedVenueIdentity: undefined,
  normalizedVenueInstagramHandle: undefined,
  venueCategory: undefined,
  venueId: undefined,
  venueInstagramHandle: undefined,
  venueLatitude: undefined,
  venueLocation: undefined,
  venueLongitude: undefined,
};

function normalizeLookup(value: string): string {
  return toSearchableText(value).replace(/\s+/g, " ").trim();
}

function normalizeSourceCaption(value: string | undefined): string {
  return value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
}

type ApprovalCandidateFields = {
  title: string;
  date: string;
  venue: string;
  venueId?: Id<"venues">;
  venueInstagramHandle?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
  time?: string;
  artists?: string[];
  sourceOccurrenceKey?: string;
  normalizedFieldsJson?: string;
  timeEvidenceKind?: "start_time_stated" | "not_stated" | "unreadable" | "doors_open_only";
  dateEvidenceText?: string;
  dateEvidenceSource?: "caption" | "poster" | "alt_text" | "unknown";
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  sourceConflictFields?: string[];
  imageUrl?: string;
  imageStorageId?: Id<"_storage">;
};

type ServiceSourceCandidateFields = ApprovalCandidateFields & {
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
};

type PendingModerationUniquenessReviewItem = Infer<
  typeof pendingModerationUniquenessReviewItem
>;
type PendingModerationUniquenessClassification = Infer<
  typeof pendingModerationUniquenessClassification
>;
type PreparedHumanApprovalCandidate = {
  candidate: Doc<"events"> & VenueDenormalizedFields;
  venuePatch: Partial<Doc<"events">> & VenueDenormalizedFields & { venue?: string };
};

async function assertPersistedServiceSourcePolicy(
  ctx: QueryCtx | MutationCtx,
  candidate: ServiceSourceCandidateFields,
  options: {
    allowHumanReviewedLegacy?: boolean;
    allowHumanReviewedStructured?: boolean;
  } = {},
): Promise<void> {
  const structuredEvidence = hasEventEvidenceV2AutoApproval(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewedLegacy =
    options.allowHumanReviewedLegacy === true &&
    hasHumanReviewableLegacySourceAttestation(candidate.normalizedFieldsJson, candidate);
  const humanReviewedStructured =
    options.allowHumanReviewedStructured === true &&
    hasHumanReviewableStructuredSourceAttestation(
      candidate.normalizedFieldsJson,
      candidate,
    );
  let structuredSourceHandle = "";
  let structuredExtractionMode = "";
  if (structuredEvidence || humanReviewedLegacy || humanReviewedStructured) {
    try {
      const fields = JSON.parse(candidate.normalizedFieldsJson ?? "{}") as Record<string, unknown>;
      structuredSourceHandle =
        typeof fields.sourceGroundingInstagramHandle === "string"
          ? normalizeHandle(fields.sourceGroundingInstagramHandle)
          : "";
      structuredExtractionMode =
        typeof fields.extractionMode === "string" ? fields.extractionMode.trim() : "";
    } catch {
      structuredSourceHandle = "";
      structuredExtractionMode = "";
    }
  }
  const handle = structuredSourceHandle || normalizeHandle(candidate.venueInstagramHandle ?? "");
  const postId = candidate.instagramPostId?.trim() ?? "";
  const postUrl = normalizeInstagramPostUrl(candidate.instagramPostUrl);
  const sourceCaption = normalizeSourceCaption(candidate.sourceCaption);
  if (
    !handle ||
    !postId ||
    !postUrl.startsWith("https://www.instagram.com/") ||
    !candidate.sourcePostedAt ||
    (!structuredEvidence && !sourceCaption)
  ) {
    throw new Error("Service approval requires a persisted Instagram source post.");
  }
  const persistedCandidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) => q.eq("handle", handle).eq("postId", postId))
    .take(2);
  const persisted = persistedCandidates.length === 1 ? persistedCandidates[0] : null;
  if (
    !persisted ||
    normalizeHandle(persisted.handle) !== handle ||
    normalizeHandle(persisted.username) !== handle ||
    persisted.postId !== postId ||
    normalizeInstagramPostUrl(persisted.instagramPostUrl) !== postUrl ||
    normalizeSourceCaption(persisted.caption) !== sourceCaption ||
    persisted.postedAt !== candidate.sourcePostedAt
  ) {
    throw new Error("Service approval source does not match the persisted Instagram post.");
  }
  if (structuredEvidence || humanReviewedStructured) {
    const posterAssets =
      structuredExtractionMode === "poster"
        ? await ctx.db
            .query("mediaAssets")
            .withIndex("by_sourceKey", (q) => q.eq("sourceKey", `instagram-post:${postId}`))
            .take(2)
        : [];
    const posterAsset = posterAssets.length === 1 ? posterAssets[0] : null;
    if (
      !candidate.rawExtractionJson ||
      candidate.rawExtractionJson !== persisted.analysisResultJson ||
      persisted.analysisRevision !== (persisted.sourceRevision ?? 1) ||
      persisted.analysisContractVersion !== "event_evidence_v2" ||
      persisted.analysisIsEvent !== true ||
      !persisted.analysisModel?.startsWith("gpt-5-mini") ||
      candidate.sourcePostedAt !== persisted.postedAt ||
      (structuredExtractionMode === "poster" &&
        (!persisted.analysisImageSourceUrl ||
          !persisted.analysisImageChecksumSha256 ||
          !persisted.imageStorageId ||
          !posterAsset ||
          posterAsset.storageId !== persisted.imageStorageId ||
          posterAsset.checksumSha256 !== persisted.analysisImageChecksumSha256 ||
          ((candidate.imageUrl !== undefined || candidate.imageStorageId !== undefined) &&
            (candidate.imageUrl !== posterAsset.url ||
              candidate.imageStorageId !== posterAsset.storageId))))
    ) {
      throw new Error(
        "Service approval requires current persisted GPT-5 mini event evidence bound to the exact source revision.",
      );
    }
    return;
  }
  if (humanReviewedLegacy) {
    return;
  }
  if (
    !isCaptionSourceCoherentWithEvent({
      title: candidate.title,
      date: candidate.date,
      time: candidate.time,
      venue: candidate.venue,
      artists: candidate.artists ?? [],
      sourceCaption: persisted.caption,
      sourcePostedAt: persisted.postedAt,
      instagramPostId: persisted.postId,
      instagramPostUrl: persisted.instagramPostUrl,
      sourceInstagramHandle: persisted.handle,
      venueInstagramHandle: candidate.venueInstagramHandle,
    })
  ) {
    throw new Error(
      "Service approval source does not independently ground the final public event fields.",
    );
  }
}

async function assertHumanApprovalSourcePolicy(
  ctx: QueryCtx | MutationCtx,
  candidate: ServiceSourceCandidateFields & { imageUrl?: string },
  moderationNote: string | undefined,
): Promise<{
  normalizedFieldsJson?: string;
  humanReviewedLegacySourcePolicyVersion?:
    typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
  humanReviewedStructuredSourcePolicyVersion?:
    typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
}> {
  const completeMachineAttestation = hasCompleteSourceGroundingAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewableLegacy = hasHumanReviewableLegacySourceAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewableStructured = hasHumanReviewableStructuredSourceAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  if (
    !completeMachineAttestation &&
    !humanReviewableLegacy &&
    !humanReviewableStructured
  ) {
    throw new Error(
      "Human approval requires complete canonical Instagram source grounding for the final public fields.",
    );
  }
  if (
    (humanReviewableLegacy || humanReviewableStructured) &&
    (moderationNote?.trim().length ?? 0) < 20
  ) {
    throw new Error("Human approval requires a substantive moderation note.");
  }
  await assertPersistedServiceSourcePolicy(ctx, candidate, {
    allowHumanReviewedLegacy: humanReviewableLegacy,
    allowHumanReviewedStructured: humanReviewableStructured,
  });
  if (!humanReviewableLegacy && !humanReviewableStructured) {
    return {};
  }
  const normalizedFields = JSON.parse(candidate.normalizedFieldsJson ?? "{}") as Record<
    string,
    unknown
  >;
  const marker: {
    humanReviewedLegacySourcePolicyVersion?:
      typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
    humanReviewedStructuredSourcePolicyVersion?:
      typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
  } = humanReviewableStructured
    ? {
        humanReviewedStructuredSourcePolicyVersion:
          HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
      }
    : {
        humanReviewedLegacySourcePolicyVersion:
          HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
      };
  return {
    ...marker,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      ...marker,
    }),
  };
}

function approvalCandidatesShareVenue(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
): boolean {
  const leftVenue = normalizeLookup(left.venue);
  return (
    (left.venueId !== undefined && right.venueId !== undefined && left.venueId === right.venueId) ||
    (Boolean(left.venueInstagramHandle) &&
      normalizeHandle(left.venueInstagramHandle ?? "") ===
        normalizeHandle(right.venueInstagramHandle ?? "")) ||
    (Boolean(leftVenue) && leftVenue === normalizeLookup(right.venue))
  );
}

function approvalCandidateHasKnownVenue(candidate: ApprovalCandidateFields): boolean {
  return (
    candidate.venueId !== undefined ||
    Boolean(normalizeHandle(candidate.venueInstagramHandle ?? "")) ||
    Boolean(normalizeLookup(candidate.venue))
  );
}

function approvalCandidatesShareSource(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
): boolean {
  const leftPostId = left.instagramPostId?.trim() ?? "";
  const leftPostUrl = normalizeLookup(left.instagramPostUrl ?? "");
  return (
    (Boolean(leftPostId) && leftPostId === right.instagramPostId?.trim()) ||
    (Boolean(leftPostUrl) && leftPostUrl === normalizeLookup(right.instagramPostUrl ?? ""))
  );
}

function classifyApprovalCandidates(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
) {
  if (left.date !== right.date) return "unrelated" as const;
  return classifyApprovalOccurrenceRelation({
    candidate: left,
    existing: right,
    sameVenue: approvalCandidatesShareVenue(left, right),
    sameSource: approvalCandidatesShareSource(left, right),
    unknownVenue:
      !approvalCandidateHasKnownVenue(left) || !approvalCandidateHasKnownVenue(right),
  });
}

function assertPairwiseOccurrenceRelation(
  candidates: ApprovalCandidateFields[],
  expected: "proven_distinct" | "proven_duplicate",
  message: string,
): void {
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (classifyApprovalCandidates(candidates[leftIndex], candidates[rightIndex]) !== expected) {
        throw new Error(message);
      }
    }
  }
}

async function assertApprovalCandidatePolicy(
  ctx: MutationCtx,
  candidate: ApprovalCandidateFields,
  excludeEventIds: Id<"events">[] = [],
): Promise<void> {
  if (!isSensibleEventTitleForApproval(candidate)) {
    throw new Error("Event title is not suitable for approval.");
  }

  const sameDateEvents = await ctx.db
    .query("events")
    .withIndex("by_status_date", (q) =>
      q.eq("status", "approved").eq("date", candidate.date),
    )
    .take(MAX_APPROVAL_DATE_COHORT_SIZE + 1);
  if (sameDateEvents.length > MAX_APPROVAL_DATE_COHORT_SIZE) {
    throw new Error("Approved same-date cohort exceeds the safe review bound.");
  }
  const candidateVenue = normalizeLookup(candidate.venue);
  const candidatePostUrl = normalizeLookup(candidate.instagramPostUrl ?? "");
  const candidatePostId = candidate.instagramPostId?.trim() ?? "";
  const excluded = new Set(excludeEventIds);
  let ambiguousConflict = false;
  for (const event of sameDateEvents) {
    if (excluded.has(event._id)) {
      continue;
    }
    const sameVenue =
      (candidate.venueId !== undefined &&
        event.venueId !== undefined &&
        event.venueId === candidate.venueId) ||
      (Boolean(candidate.venueInstagramHandle) &&
        normalizeHandle(event.venueInstagramHandle ?? "") ===
          normalizeHandle(candidate.venueInstagramHandle ?? "")) ||
      (Boolean(candidateVenue) && normalizeLookup(event.venue) === candidateVenue);
    const sameSourceEvent =
      (Boolean(candidatePostId) && event.instagramPostId?.trim() === candidatePostId) ||
      (Boolean(candidatePostUrl) &&
        normalizeLookup(event.instagramPostUrl ?? "") === candidatePostUrl);
    const relation = classifyApprovalOccurrenceRelation({
      candidate,
      existing: event,
      sameVenue,
      sameSource: sameSourceEvent,
      unknownVenue:
        !approvalCandidateHasKnownVenue(candidate) ||
        !approvalCandidateHasKnownVenue(event),
    });
    if (relation === "proven_duplicate") {
      throw new Error("An approved event already exists for this canonical occurrence.");
    }
    if (relation === "ambiguous") {
      ambiguousConflict = true;
    }
  }

  if (ambiguousConflict) {
    throw new Error(
      "This same-day occurrence is ambiguous against an approved event and cannot be auto-approved.",
    );
  }
}

function resolveVenueDenormalizedFieldsFromPublicVenues(
  venues: Doc<"venues">[],
  venueName: string | undefined,
): VenueDenormalizedFields {
  const rawVenueName = venueName ?? "";
  const lookupName = normalizeLookup(rawVenueName);
  if (!lookupName) {
    return CLEARED_VENUE_DENORMALIZED_FIELDS;
  }

  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
  const canonicalization = canonicalizeVenueNameDetailed(
    rawVenueName,
    canonicalVenueNamesByHandle,
    {
      canonicalVenueAliasesByHandle: buildCanonicalVenueAliasesByHandle(venues),
    },
  );
  const canonicalHandle = canonicalization?.handle
    ? normalizeHandle(canonicalization.handle)
    : null;
  const canonicalLookupName = normalizeLookup(canonicalization?.venue ?? rawVenueName);
  const matchingVenues = venues.filter((candidate) => {
    if (canonicalHandle && normalizeHandle(candidate.instagramHandle) === canonicalHandle) {
      return true;
    }
    return normalizeLookup(candidate.name) === canonicalLookupName;
  });
  const venue = matchingVenues.length === 1 ? matchingVenues[0] : null;
  if (!venue) {
    return {
      ...CLEARED_VENUE_DENORMALIZED_FIELDS,
      normalizedVenueIdentity: canonicalLookupName || lookupName,
      ...(canonicalHandle ? { normalizedVenueInstagramHandle: canonicalHandle } : {}),
    };
  }

  return {
    ...CLEARED_VENUE_DENORMALIZED_FIELDS,
    ...buildNormalizedEventVenueIdentity({
      venue: venue.name,
      venueInstagramHandle: venue.instagramHandle,
    }),
    venueCategory: venue.category,
    venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle,
    ...(venue.latitude !== undefined ? { venueLatitude: venue.latitude } : {}),
    ...(venue.location ? { venueLocation: venue.location } : {}),
    ...(venue.longitude !== undefined ? { venueLongitude: venue.longitude } : {}),
  };
}

type PendingModerationVenueResolver = {
  canonicalVenueNamesByHandle: ReturnType<typeof buildCanonicalVenueNamesByHandle>;
  canonicalVenueAliasesByHandle: ReturnType<typeof buildCanonicalVenueAliasesByHandle>;
  venueById: Map<Id<"venues">, Doc<"venues">>;
  venueByHandle: Map<string, Doc<"venues"> | null>;
  venueByLookup: Map<string, Doc<"venues"> | null>;
  resolvedByLookup: Map<
    string,
    { venueFields: VenueDenormalizedFields; canonicalVenueName?: string }
  >;
};

function addUniqueVenueLookup(
  lookup: Map<string, Doc<"venues"> | null>,
  key: string,
  venue: Doc<"venues">,
): void {
  if (!key) return;
  const existing = lookup.get(key);
  if (existing === undefined) {
    lookup.set(key, venue);
    return;
  }
  if (existing && existing._id !== venue._id) {
    lookup.set(key, null);
  }
}

function buildPendingModerationVenueResolver(
  venues: Doc<"venues">[],
): PendingModerationVenueResolver {
  const venueById = new Map<Id<"venues">, Doc<"venues">>();
  const venueByHandle = new Map<string, Doc<"venues"> | null>();
  const venueByLookup = new Map<string, Doc<"venues"> | null>();
  for (const venue of venues) {
    venueById.set(venue._id, venue);
    const handle = normalizeHandle(venue.instagramHandle);
    addUniqueVenueLookup(venueByHandle, handle, venue);
    addUniqueVenueLookup(venueByLookup, normalizeLookup(venue.name), venue);
    addUniqueVenueLookup(venueByLookup, normalizeLookup(handle), venue);
    for (const alias of venue.aliases ?? []) {
      addUniqueVenueLookup(venueByLookup, normalizeLookup(alias), venue);
    }
  }
  return {
    canonicalVenueNamesByHandle: buildCanonicalVenueNamesByHandle(venues),
    canonicalVenueAliasesByHandle: buildCanonicalVenueAliasesByHandle(venues),
    venueById,
    venueByHandle,
    venueByLookup,
    resolvedByLookup: new Map(),
  };
}

function resolveVenueForPendingModeration(
  resolver: PendingModerationVenueResolver,
  venueName: string,
): { venueFields: VenueDenormalizedFields; canonicalVenueName?: string } {
  const lookupName = normalizeLookup(venueName);
  if (!lookupName) {
    return { venueFields: CLEARED_VENUE_DENORMALIZED_FIELDS };
  }
  const cached = resolver.resolvedByLookup.get(lookupName);
  if (cached) return cached;

  let matchedVenue: Doc<"venues"> | null | undefined;
  if (resolver.venueByLookup.has(lookupName)) {
    matchedVenue = resolver.venueByLookup.get(lookupName);
  } else {
    const canonicalization = canonicalizeVenueNameDetailed(
      venueName,
      resolver.canonicalVenueNamesByHandle,
      {
        canonicalVenueAliasesByHandle: resolver.canonicalVenueAliasesByHandle,
      },
    );
    const canonicalHandle = canonicalization?.handle
      ? normalizeHandle(canonicalization.handle)
      : "";
    const canonicalLookup = normalizeLookup(canonicalization?.venue ?? venueName);
    matchedVenue = canonicalHandle
      ? resolver.venueByHandle.get(canonicalHandle)
      : resolver.venueByLookup.get(canonicalLookup);
  }

  const resolved = matchedVenue
    ? {
        venueFields: {
          ...CLEARED_VENUE_DENORMALIZED_FIELDS,
          ...buildNormalizedEventVenueIdentity({
            venue: matchedVenue.name,
            venueInstagramHandle: matchedVenue.instagramHandle,
          }),
          venueCategory: matchedVenue.category,
          venueId: matchedVenue._id,
          venueInstagramHandle: matchedVenue.instagramHandle,
          ...(matchedVenue.latitude !== undefined
            ? { venueLatitude: matchedVenue.latitude }
            : {}),
          ...(matchedVenue.location ? { venueLocation: matchedVenue.location } : {}),
          ...(matchedVenue.longitude !== undefined
            ? { venueLongitude: matchedVenue.longitude }
            : {}),
        },
        canonicalVenueName: matchedVenue.name,
      }
    : {
        venueFields: {
          ...CLEARED_VENUE_DENORMALIZED_FIELDS,
          normalizedVenueIdentity: lookupName,
        },
      };
  resolver.resolvedByLookup.set(lookupName, resolved);
  return resolved;
}

function prepareHumanApprovalCandidateFromVenueResolver(
  event: Doc<"events">,
  resolver: PendingModerationVenueResolver,
): PreparedHumanApprovalCandidate {
  const existingVenue =
    (event.venueId ? resolver.venueById.get(event.venueId) : undefined) ??
    (event.venueInstagramHandle
      ? resolver.venueByHandle.get(normalizeHandle(event.venueInstagramHandle))
      : undefined);
  const { venueFields, canonicalVenueName } = existingVenue
    ? {
        venueFields: {
          ...CLEARED_VENUE_DENORMALIZED_FIELDS,
          ...buildNormalizedEventVenueIdentity({
            venue: existingVenue.name,
            venueInstagramHandle: existingVenue.instagramHandle,
          }),
          venueCategory: existingVenue.category,
          venueId: existingVenue._id,
          venueInstagramHandle: existingVenue.instagramHandle,
          ...(existingVenue.latitude !== undefined
            ? { venueLatitude: existingVenue.latitude }
            : {}),
          ...(existingVenue.location
            ? { venueLocation: existingVenue.location }
            : {}),
          ...(existingVenue.longitude !== undefined
            ? { venueLongitude: existingVenue.longitude }
            : {}),
        },
        canonicalVenueName: existingVenue.name,
      }
    : resolveVenueForPendingModeration(resolver, event.venue);
  const venuePatch = {
    ...venueFields,
    ...(canonicalVenueName && canonicalVenueName !== event.venue
      ? { venue: canonicalVenueName }
      : {}),
  };
  return {
    candidate: { ...event, ...venuePatch },
    venuePatch,
  };
}

async function resolveVenueDenormalizedFields(
  ctx: QueryCtx | MutationCtx,
  venueName: string | undefined,
): Promise<VenueDenormalizedFields> {
  const venues = (await ctx.db.query("venues").collect()).filter(isVenuePublic);
  return resolveVenueDenormalizedFieldsFromPublicVenues(venues, venueName);
}

async function prepareHumanApprovalCandidate(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<PreparedHumanApprovalCandidate> {
  const venues = (await ctx.db.query("venues").collect()).filter(isVenuePublic);
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(venues, event.venue);
  const definedVenueFields = Object.fromEntries(
    Object.entries(venueFields).filter(([, value]) => value !== undefined),
  ) as VenueDenormalizedFields;
  const canonicalVenueName = venueFields.venueId
    ? venues.find((venue) => venue._id === venueFields.venueId)?.name
    : undefined;
  const venuePatch = {
    ...definedVenueFields,
    ...(canonicalVenueName && canonicalVenueName !== event.venue
      ? { venue: canonicalVenueName }
      : {}),
  };
  return { candidate: { ...event, ...venuePatch }, venuePatch };
}

function rebindStructuredHumanReviewToCanonicalVenue(
  humanReviewPatch: {
    normalizedFieldsJson?: string;
    humanReviewedLegacySourcePolicyVersion?:
      typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
    humanReviewedStructuredSourcePolicyVersion?:
      typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
  },
  venuePatch: Partial<Doc<"events">> & VenueDenormalizedFields,
): typeof humanReviewPatch {
  const canonicalVenue = venuePatch.venue?.trim();
  if (
    !canonicalVenue ||
    humanReviewPatch.humanReviewedStructuredSourcePolicyVersion !==
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION ||
    !humanReviewPatch.normalizedFieldsJson
  ) {
    return humanReviewPatch;
  }

  const normalizedFields = JSON.parse(
    humanReviewPatch.normalizedFieldsJson,
  ) as Record<string, unknown>;
  return {
    ...humanReviewPatch,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      normalizedVenue: canonicalVenue,
      humanReviewedVenueCanonicalizationPolicyVersion: 1,
    }),
  };
}

async function assertHumanApprovalWithCanonicalVenueFallback(
  ctx: QueryCtx | MutationCtx,
  sourceEvent: Doc<"events">,
  prepared: PreparedHumanApprovalCandidate,
  moderationNote: string | undefined,
) {
  try {
    return await assertHumanApprovalSourcePolicy(
      ctx,
      prepared.candidate,
      moderationNote,
    );
  } catch (error) {
    if (
      !prepared.venuePatch.venue ||
      !(error instanceof Error) ||
      error.message !==
        "Human approval requires complete canonical Instagram source grounding for the final public fields."
    ) {
      throw error;
    }
  }

  const sourceHumanReviewPatch = await assertHumanApprovalSourcePolicy(
    ctx,
    sourceEvent,
    moderationNote,
  );
  return rebindStructuredHumanReviewToCanonicalVenue(
    sourceHumanReviewPatch,
    prepared.venuePatch,
  );
}

type PendingModerationDateCohort = {
  pending: Doc<"events">[];
  approved: Doc<"events">[];
  pendingTruncated: boolean;
  approvedTruncated: boolean;
};

type PendingModerationUniquenessBuild = {
  result: Infer<typeof pendingModerationUniquenessResult>;
  reviewedEvents: Map<Id<"events">, Doc<"events">>;
  approvals: Map<
    Id<"events">,
    {
      prepared: PreparedHumanApprovalCandidate;
      humanReviewPatch: Awaited<
        ReturnType<typeof assertHumanApprovalWithCanonicalVenueFallback>
      >;
    }
  >;
};

const HUMAN_APPROVAL_INELIGIBLE_MESSAGES = new Set([
  "Human approval requires complete canonical Instagram source grounding for the final public fields.",
  "Human approval requires a substantive moderation note.",
  "Service approval requires a persisted Instagram source post.",
  "Service approval source does not match the persisted Instagram post.",
  "Service approval requires current persisted GPT-5 mini event evidence bound to the exact source revision.",
  "Service approval source does not independently ground the final public event fields.",
]);

function isExpectedHumanApprovalIneligibility(error: unknown): boolean {
  return error instanceof Error && HUMAN_APPROVAL_INELIGIBLE_MESSAGES.has(error.message);
}

function assertPendingModerationUniquenessReviewItems(
  items: PendingModerationUniquenessReviewItem[],
): void {
  if (
    items.length < 1 ||
    items.length > MAX_PENDING_MODERATION_UNIQUENESS_ITEMS
  ) {
    throw new Error(
      `Unique pending review requires 1-${MAX_PENDING_MODERATION_UNIQUENESS_ITEMS} exact event versions.`,
    );
  }
  const ids = new Set<Id<"events">>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.expectedUpdatedAt)) {
      throw new Error("Unique pending review expectedUpdatedAt values must be safe integers.");
    }
    if (ids.has(item.id)) {
      throw new Error("Unique pending review event IDs must be unique.");
    }
    ids.add(item.id);
  }
}

async function loadExactPendingModerationReviewEvents(
  ctx: QueryCtx | MutationCtx,
  items: PendingModerationUniquenessReviewItem[],
): Promise<Map<Id<"events">, Doc<"events">>> {
  assertPendingModerationUniquenessReviewItems(items);
  const events = await Promise.all(items.map((item) => ctx.db.get(item.id)));
  const reviewedEvents = new Map<Id<"events">, Doc<"events">>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const event = events[index];
    if (!event || event.status !== "pending") {
      throw new Error(
        `Event changed since the reviewed version: ${item.id} is missing or no longer pending.`,
      );
    }
    if (event.updatedAt !== item.expectedUpdatedAt) {
      throw new Error(
        `Event changed since the reviewed version: ${item.id} expected updatedAt ${item.expectedUpdatedAt}, found ${event.updatedAt}.`,
      );
    }
    reviewedEvents.set(item.id, event);
  }
  return reviewedEvents;
}

async function loadPendingModerationPublicVenues(
  ctx: QueryCtx | MutationCtx,
): Promise<{ venues: Doc<"venues">[]; truncated: boolean }> {
  const venues = await ctx.db
    .query("venues")
    .take(MAX_PENDING_MODERATION_UNIQUENESS_VENUES + 1);
  return {
    venues: venues
      .slice(0, MAX_PENDING_MODERATION_UNIQUENESS_VENUES)
      .filter(isVenuePublic),
    truncated: venues.length > MAX_PENDING_MODERATION_UNIQUENESS_VENUES,
  };
}

async function loadPendingModerationDateCohorts(
  ctx: QueryCtx | MutationCtx,
  dates: string[],
): Promise<Map<string, PendingModerationDateCohort>> {
  const cohorts = new Map<string, PendingModerationDateCohort>();
  for (const date of dates) {
    const [pending, approved] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "pending").eq("date", date),
        )
        .take(MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE + 1),
      ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").eq("date", date),
        )
        .take(MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE + 1),
    ]);
    cohorts.set(date, {
      pending: pending.slice(0, MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE),
      approved: approved.slice(0, MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE),
      pendingTruncated:
        pending.length > MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE,
      approvedTruncated:
        approved.length > MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE,
    });
  }
  return cohorts;
}

function buildPendingModerationUniquenessClassification(
  item: PendingModerationUniquenessReviewItem,
  disposition: PendingModerationUniquenessClassification["disposition"],
  reason: PendingModerationUniquenessClassification["reason"],
  conflictIds: Id<"events">[] = [],
): PendingModerationUniquenessClassification {
  return {
    id: item.id,
    expectedUpdatedAt: item.expectedUpdatedAt,
    disposition,
    reason,
    conflictIds: [...new Set(conflictIds)].sort((left, right) =>
      String(left).localeCompare(String(right)),
    ),
  };
}

function getPendingModerationDateIneligibilityReason(
  event: Doc<"events">,
  currentBelgradeDay: string,
): "ineligible_invalid_date" | "ineligible_expired_event" | null {
  if (dateKeyToUtcMs(event.date) === null) {
    return "ineligible_invalid_date";
  }
  return event.date < currentBelgradeDay ? "ineligible_expired_event" : null;
}

async function buildPendingModerationUniquenessReview(
  ctx: QueryCtx | MutationCtx,
  options: {
    items: PendingModerationUniquenessReviewItem[];
    asOfMs: number;
    moderationNote: string;
  },
): Promise<PendingModerationUniquenessBuild> {
  if (!Number.isSafeInteger(options.asOfMs) || options.asOfMs < 0) {
    throw new Error("Unique pending review asOfMs must be a non-negative safe integer.");
  }
  const reviewedEvents = await loadExactPendingModerationReviewEvents(
    ctx,
    options.items,
  );
  const currentBelgradeDay = getBelgradeDayKey(options.asOfMs);
  const publicVenues = await loadPendingModerationPublicVenues(ctx);
  const approvals = new Map<
    Id<"events">,
    {
      prepared: PreparedHumanApprovalCandidate;
      humanReviewPatch: Awaited<
        ReturnType<typeof assertHumanApprovalWithCanonicalVenueFallback>
      >;
    }
  >();

  if (publicVenues.truncated) {
    const items = options.items.map((item) => {
      const event = reviewedEvents.get(item.id);
      if (!event) throw new Error("Reviewed pending event disappeared during classification.");
      const dateReason = getPendingModerationDateIneligibilityReason(
        event,
        currentBelgradeDay,
      );
      if (dateReason) {
        return buildPendingModerationUniquenessClassification(
          item,
          "ineligible",
          dateReason,
        );
      }
      if (!isSensibleEventTitleForApproval(event)) {
        return buildPendingModerationUniquenessClassification(
          item,
          "ineligible",
          "ineligible_title",
        );
      }
      return buildPendingModerationUniquenessClassification(
        item,
        "indeterminate",
        "indeterminate_venue_limit",
      );
    });
    return {
      result: { complete: false, items },
      reviewedEvents,
      approvals,
    };
  }

  const dates = [
    ...new Set(
      options.items.map((item) => {
        const event = reviewedEvents.get(item.id);
        if (!event) throw new Error("Reviewed pending event disappeared during classification.");
        return event.date;
      }),
    ),
  ];
  const cohorts = await loadPendingModerationDateCohorts(ctx, dates);
  const venueResolver = buildPendingModerationVenueResolver(publicVenues.venues);
  const preparedById = new Map<Id<"events">, PreparedHumanApprovalCandidate>();
  const prepare = (event: Doc<"events">) => {
    const cached = preparedById.get(event._id);
    if (cached) return cached;
    const prepared = prepareHumanApprovalCandidateFromVenueResolver(
      event,
      venueResolver,
    );
    preparedById.set(event._id, prepared);
    return prepared;
  };

  const classifications: PendingModerationUniquenessClassification[] = [];
  for (const item of options.items) {
    const event = reviewedEvents.get(item.id);
    if (!event) throw new Error("Reviewed pending event disappeared during classification.");
    const dateReason = getPendingModerationDateIneligibilityReason(
      event,
      currentBelgradeDay,
    );
    if (dateReason) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "ineligible",
          dateReason,
        ),
      );
      continue;
    }
    const prepared = prepare(event);
    if (!isSensibleEventTitleForApproval(prepared.candidate)) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "ineligible",
          "ineligible_title",
        ),
      );
      continue;
    }

    const cohort = cohorts.get(event.date);
    if (!cohort || cohort.pendingTruncated) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "indeterminate",
          "indeterminate_pending_cohort_limit",
        ),
      );
      continue;
    }
    if (cohort.approvedTruncated) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "indeterminate",
          "indeterminate_approved_cohort_limit",
        ),
      );
      continue;
    }

    const duplicateIds: Id<"events">[] = [];
    const ambiguousIds: Id<"events">[] = [];
    for (const other of [...cohort.pending, ...cohort.approved]) {
      if (other._id === event._id) continue;
      const relation = classifyApprovalCandidates(
        prepared.candidate,
        prepare(other).candidate,
      );
      if (relation === "proven_duplicate") duplicateIds.push(other._id);
      if (relation === "ambiguous") ambiguousIds.push(other._id);
    }
    if (duplicateIds.length > 0) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "duplicate",
          "duplicate_same_occurrence",
          duplicateIds,
        ),
      );
      continue;
    }
    if (ambiguousIds.length > 0) {
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "ambiguous",
          "ambiguous_same_date_occurrence",
          ambiguousIds,
        ),
      );
      continue;
    }

    try {
      const humanReviewPatch = await assertHumanApprovalWithCanonicalVenueFallback(
        ctx,
        event,
        prepared,
        options.moderationNote,
      );
      approvals.set(item.id, { prepared, humanReviewPatch });
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "unique",
          "unique_no_conflict",
        ),
      );
    } catch (error) {
      if (!isExpectedHumanApprovalIneligibility(error)) throw error;
      classifications.push(
        buildPendingModerationUniquenessClassification(
          item,
          "ineligible",
          "ineligible_source_policy",
        ),
      );
    }
  }

  return {
    result: {
      complete: classifications.every(
        (item) => item.disposition !== "indeterminate",
      ),
      items: classifications,
    },
    reviewedEvents,
    approvals,
  };
}

async function loadPublicVenueIdsForEvents(
  ctx: QueryCtx,
  events: Doc<"events">[],
): Promise<Set<Id<"venues">>> {
  const venueIds = [
    ...new Set(events.map((event) => event.venueId).filter((id): id is Id<"venues"> => id !== undefined)),
  ];
  const venues = await Promise.all(venueIds.map((venueId) => ctx.db.get(venueId)));
  return new Set(
    venues
      .filter((venue): venue is Doc<"venues"> => venue !== null && isVenuePublic(venue))
      .map((venue) => venue._id),
  );
}

async function projectPublicEventPage(
  ctx: QueryCtx,
  events: Doc<"events">[],
) {
  const groundingDecisions = await Promise.all(
    events.map((event) => isCanonicallyGroundedApprovedEvent(ctx, event)),
  );
  const groundedEvents = events.filter((_, index) => groundingDecisions[index]);
  return projectCanonicallyGroundedPublicEventPage(ctx, groundedEvents);
}

async function projectCanonicallyGroundedPublicEventPage(
  ctx: QueryCtx,
  groundedEvents: Doc<"events">[],
) {
  const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, groundedEvents);
  return groundedEvents.map((event) =>
    projectPublicEvent(
      event,
      event.venueId !== undefined && publicVenueIds.has(event.venueId),
    ),
  );
}

function usesEventEvidenceV2(event: Doc<"events">): boolean {
  try {
    const normalized = JSON.parse(event.normalizedFieldsJson ?? "null") as unknown;
    if (
      normalized &&
      typeof normalized === "object" &&
      !Array.isArray(normalized) &&
      ((normalized as Record<string, unknown>).extractionContractVersion ===
        "event_evidence_v2" ||
        (normalized as Record<string, unknown>).sourceGroundingVersion === 5 ||
        (normalized as Record<string, unknown>).sourceGroundingEvidence ===
          "persisted_openai_event_evidence_v2")
    ) {
      return true;
    }
  } catch {
    // A valid raw extraction contract below can still identify the row.
  }
  try {
    const raw = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    return Boolean(
      raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).extraction_contract_version ===
          "event_evidence_v2",
    );
  } catch {
    return false;
  }
}

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
  const cleared = patch.dateEvidenceText === null && patch.dateEvidenceResolvedDate === null;
  if (cleared) {
    if (
      patch.dateEvidenceSource !== "unknown" ||
      patch.dateEvidenceIsRelative !== false ||
      patch.sourceConflictFields?.length !== 0
    ) {
      throw new Error("Cleared date evidence must use unknown/non-relative/empty-conflict metadata.");
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
  if (!text || !/^\d{4}-\d{2}-\d{2}$/u.test(resolvedDate) || resolvedDate !== effectiveDate) {
    throw new Error("Replacement date evidence must bind exactly to the effective event date.");
  }
  return {
    dateEvidenceText: text,
    dateEvidenceSource: patch.dateEvidenceSource,
    dateEvidenceIsRelative: patch.dateEvidenceIsRelative,
    dateEvidenceResolvedDate: resolvedDate,
    sourceConflictFields: patch.sourceConflictFields,
  };
}

/**
 * Preserve already-approved legacy rows while enforcing the full persisted
 * source/revision/media attestation for every event-evidence-v2 row.
 */
async function projectLegacyCompatiblePublicEventPage(
  ctx: QueryCtx,
  events: Doc<"events">[],
) {
  const visibility = await Promise.all(
    events.map((event) =>
      usesEventEvidenceV2(event) ||
      event.humanReviewedLegacySourcePolicyVersion ===
        HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION ||
      hasHumanReviewedLegacySourcePolicyMarker(event.normalizedFieldsJson)
        ? isCanonicallyGroundedApprovedEvent(ctx, event)
        : Promise.resolve(true),
    ),
  );
  return projectCanonicallyGroundedPublicEventPage(
    ctx,
    events.filter((_, index) => visibility[index]),
  );
}

function toApprovedEventDuplicateRecord(event: Doc<"events">): ApprovedEventDuplicateRecord {
  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    artists: event.artists,
    description: event.description ?? null,
    imageUrl: event.imageUrl ?? null,
    instagramPostUrl: event.instagramPostUrl ?? null,
    instagramPostId: event.instagramPostId ?? null,
    ticketPrice: event.ticketPrice ?? null,
    eventType: event.eventType,
    sourceCaption: event.sourceCaption ?? null,
    sourcePostedAt: event.sourcePostedAt ?? null,
    normalizedFieldsJson: event.normalizedFieldsJson ?? null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

async function loadApprovedDateCohort(
  ctx: QueryCtx,
  date: string,
): Promise<Doc<"events">[] | null> {
  const cohort = await ctx.db
    .query("events")
    .withIndex("by_status_date", (q) => q.eq("status", "approved").eq("date", date))
    .take(PUBLIC_DUPLICATE_DATE_COHORT_LIMIT + 1);
  if (cohort.length > PUBLIC_DUPLICATE_DATE_COHORT_LIMIT) return null;
  const groundingDecisions = await Promise.all(
    cohort.map((event) => isCanonicallyGroundedApprovedEvent(ctx, event)),
  );
  return cohort.filter((_, index) => groundingDecisions[index]);
}

export async function getPublicDuplicateEventIds(
  ctx: QueryCtx,
  page: Doc<"events">[],
): Promise<Set<Id<"events">>> {
  if (page.length === 0) {
    return new Set();
  }

  const eventsByDate = new Map<string, Doc<"events">[]>();
  for (const event of page) {
    const cohort = eventsByDate.get(event.date) ?? [];
    cohort.push(event);
    eventsByDate.set(event.date, cohort);
  }

  const boundaryDates = new Set([page[0].date, page[page.length - 1].date]);
  for (const date of boundaryDates) {
    const completeCohort = await loadApprovedDateCohort(ctx, date);
    if (completeCohort === null) {
      eventsByDate.delete(date);
    } else {
      eventsByDate.set(date, completeCohort);
    }
  }

  const duplicateIds = new Set<Id<"events">>();
  for (const cohort of eventsByDate.values()) {
    if (cohort.length < 2 || cohort.length > PUBLIC_DUPLICATE_DATE_COHORT_LIMIT) {
      continue;
    }
    const groups = buildApprovedEventAutoCleanupGroups(
      cohort.map(toApprovedEventDuplicateRecord),
    );
    for (const group of groups) {
      for (const duplicateId of group.duplicateEventIds) {
        duplicateIds.add(duplicateId as Id<"events">);
      }
    }
  }
  return duplicateIds;
}

async function projectDeduplicatedPublicEventPage(
  ctx: QueryCtx,
  events: Doc<"events">[],
) {
  const groundingDecisions = await Promise.all(
    events.map((event) => isCanonicallyGroundedApprovedEvent(ctx, event)),
  );
  const groundedEvents = events.filter((_, index) => groundingDecisions[index]);
  const duplicateIds = await getPublicDuplicateEventIds(ctx, groundedEvents);
  return projectCanonicallyGroundedPublicEventPage(
    ctx,
    groundedEvents.filter((event) => !duplicateIds.has(event._id)),
  );
}

async function writeEventAuditLog(
  ctx: MutationCtx,
  eventId: Id<"events">,
  action: string,
  options: {
    actor?: string;
    note?: string;
    patch?: unknown;
  } = {},
) {
  await ctx.db.insert("eventAuditLog", {
    eventId,
    action,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.patch !== undefined ? { patchJson: JSON.stringify(options.patch) } : {}),
    createdAt: Date.now(),
  });
}

function normalizeExpiredEventDeleteBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXPIRED_EVENT_DELETE_BATCH_SIZE;
  }

  return Math.max(1, Math.min(500, Math.trunc(value as number)));
}

async function deleteEventWithSavedReferences(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<number> {
  const legacySavedEvents = await ctx.db
    .query("userSavedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  const savedEvents = await ctx.db
    .query("savedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();

  for (const savedEvent of legacySavedEvents) {
    await ctx.db.delete(savedEvent._id);
  }

  for (const savedEvent of savedEvents) {
    await ctx.db.delete(savedEvent._id);
  }

  await ctx.db.delete(eventId);
  return legacySavedEvents.length + savedEvents.length;
}

async function reassignSavedEventReferences(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
): Promise<{ movedCount: number; dedupedCount: number }> {
  if (fromEventId === toEventId) {
    return { movedCount: 0, dedupedCount: 0 };
  }

  const legacySavedEvents = await ctx.db
    .query("userSavedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();
  const savedEvents = await ctx.db
    .query("savedEvents")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();

  let movedCount = 0;
  let dedupedCount = 0;

  for (const savedEvent of legacySavedEvents) {
    const existingPrimarySave = await ctx.db
      .query("userSavedEvents")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", savedEvent.userId).eq("eventId", toEventId),
      )
      .unique();

    if (existingPrimarySave) {
      await ctx.db.delete(savedEvent._id);
      dedupedCount += 1;
      continue;
    }

    await ctx.db.patch(savedEvent._id, {
      eventId: toEventId,
    });
    movedCount += 1;
  }

  for (const savedEvent of savedEvents) {
    const existingPrimarySave = await ctx.db
      .query("savedEvents")
      .withIndex("by_user_event", (q) =>
        q.eq("userId", savedEvent.userId).eq("eventId", toEventId),
      )
      .unique();

    if (existingPrimarySave) {
      await ctx.db.delete(savedEvent._id);
      dedupedCount += 1;
      continue;
    }

    await ctx.db.patch(savedEvent._id, {
      eventId: toEventId,
    });
    movedCount += 1;
  }

  return { movedCount, dedupedCount };
}

async function reassignInstagramOccurrenceReferences(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
): Promise<void> {
  if (fromEventId === toEventId) return;
  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();

  for (const sourceLink of sourceLinks) {
    const primaryLink = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", sourceLink.sourceIdentity)
          .eq("sourceOccurrenceKey", sourceLink.sourceOccurrenceKey),
      )
      .unique();
    if (primaryLink && primaryLink._id !== sourceLink._id) {
      if (primaryLink.eventId !== toEventId) {
        throw new Error("Instagram occurrence source is already linked to another event.");
      }
      await ctx.db.delete(sourceLink._id);
    } else {
      await ctx.db.patch(sourceLink._id, {
        eventId: toEventId,
        updatedAt: nextEventUpdatedAt(sourceLink.updatedAt),
      });
    }

    const receipt = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceLink.sourceIdentity))
      .unique();
    if (!receipt) continue;
    const satisfiedOccurrences = receipt.satisfiedOccurrences.map((occurrence) =>
      occurrence.eventId === fromEventId ? { ...occurrence, eventId: toEventId } : occurrence,
    );
    if (satisfiedOccurrences.every((occurrence, index) =>
      occurrence.eventId === receipt.satisfiedOccurrences[index].eventId
    )) {
      continue;
    }
    if (new Set(satisfiedOccurrences.map((occurrence) => occurrence.eventId)).size !== satisfiedOccurrences.length) {
      throw new Error("Merging would collapse distinct Instagram source occurrences.");
    }
    await ctx.db.patch(receipt._id, {
      satisfiedOccurrences,
      updatedAt: nextEventUpdatedAt(receipt.updatedAt),
    });
  }
}

async function assertInstagramOccurrenceReferencesCanBeReassigned(
  ctx: MutationCtx,
  fromEventId: Id<"events">,
  toEvent: Doc<"events">,
): Promise<void> {
  if (fromEventId === toEvent._id) return;
  const sourceLinks = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", fromEventId))
    .collect();

  for (const sourceLink of sourceLinks) {
    const receipt = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceLink.sourceIdentity))
      .unique();
    if (!receipt) continue;

    for (const occurrence of receipt.satisfiedOccurrences) {
      if (occurrence.eventId !== fromEventId) continue;
      const expectedOccurrence = receipt.expectedOccurrences?.find(
        (expected) => expected.key === occurrence.key,
      );
      if (
        !sourceOccurrenceRepresentativeMatchesExpected(
          toEvent,
          expectedOccurrence,
        )
      ) {
        throw new Error(
          "Approved-event merge cannot preserve an Instagram occurrence receipt.",
        );
      }
    }
  }
}

export const getEvent = query({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    return ctx.db.get(args.id);
  },
});

export const listEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    const limit = args.limit ?? 100;
    return ctx.db.query("events").order("desc").take(limit);
  },
});

function projectModerationDuplicateContextEvent(event: Doc<"events">) {
  return {
    _id: event._id,
    title: event.title.slice(0, MODERATION_DUPLICATE_CONTEXT_TITLE_LENGTH),
    date: event.date,
    ...(event.time
      ? { time: event.time.slice(0, MODERATION_DUPLICATE_CONTEXT_TIME_LENGTH) }
      : {}),
    venue: event.venue.slice(0, MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH),
    ...(event.normalizedVenueIdentity
      ? {
          normalizedVenueIdentity: event.normalizedVenueIdentity.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH,
          ),
        }
      : {}),
    ...(event.normalizedVenueInstagramHandle
      ? {
          normalizedVenueInstagramHandle: event.normalizedVenueInstagramHandle.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH,
          ),
        }
      : {}),
    artists: event.artists
      .slice(0, MODERATION_DUPLICATE_CONTEXT_ARTIST_COUNT)
      .map((artist) => artist.slice(0, MODERATION_DUPLICATE_CONTEXT_ARTIST_LENGTH)),
    ...(event.description
      ? {
          description: event.description.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_DESCRIPTION_LENGTH,
          ),
        }
      : {}),
    eventType: event.eventType.slice(0, MODERATION_DUPLICATE_CONTEXT_EVENT_TYPE_LENGTH),
    ...(event.sourceCaption
      ? {
          sourceCaption: event.sourceCaption.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_CAPTION_LENGTH,
          ),
        }
      : {}),
    status: event.status,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export const listModerationDuplicateContextByDates = query({
  args: {
    dates: v.array(v.string()),
  },
  returns: moderationDuplicateContextResult,
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    if (args.dates.length > MAX_MODERATION_DUPLICATE_CONTEXT_DATES) {
      throw new Error(
        `Moderation duplicate context accepts at most ${MAX_MODERATION_DUPLICATE_CONTEXT_DATES} dates.`,
      );
    }

    const dates: string[] = [];
    const seenDates = new Set<string>();
    for (const candidate of args.dates) {
      const date = candidate.trim();
      if (dateKeyToUtcMs(date) === null) {
        throw new Error("Moderation duplicate context dates must use valid YYYY-MM-DD values.");
      }
      if (!seenDates.has(date)) {
        seenDates.add(date);
        dates.push(date);
      }
    }

    const contextEvents: ReturnType<typeof projectModerationDuplicateContextEvent>[] = [];
    let truncated = false;
    let start = 0;
    for (
      ;
      start < dates.length && contextEvents.length < MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS;
    ) {
      const remainingCapacity =
        MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS - contextEvents.length;
      const dateBatchSize = Math.min(
        MODERATION_DUPLICATE_CONTEXT_DATE_BATCH_SIZE,
        Math.ceil(
          remainingCapacity / MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE,
        ),
      );
      const dateBatch = dates.slice(
        start,
        start + dateBatchSize,
      );
      start += dateBatch.length;
      const eventBatches = await Promise.all(
        dateBatch.map((date) =>
          // Pending rows already come from the requested moderation page. The
          // extra context is reserved for approved conflicts so a busy date's
          // pending traffic cannot crowd out the duplicate that matters.
          ctx.db
            .query("events")
            .withIndex("by_status_date", (q) =>
              q.eq("status", "approved").eq("date", date),
            )
            .order("desc")
            .take(MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE + 1),
        ),
      );

      for (const eventBatch of eventBatches) {
        if (eventBatch.length > MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE) {
          truncated = true;
        }
        for (const event of eventBatch.slice(
          0,
          MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE,
        )) {
          if (contextEvents.length >= MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS) {
            truncated = true;
            break;
          }
          contextEvents.push(projectModerationDuplicateContextEvent(event));
        }
      }
    }

    if (start < dates.length) {
      truncated = true;
    }

    return { events: contextEvents, truncated };
  },
});

export const classifyPendingModerationUniqueness = query({
  args: {
    items: v.array(pendingModerationUniquenessReviewItem),
    asOfMs: v.number(),
  },
  returns: pendingModerationUniquenessResult,
  handler: async (ctx, args) => {
    await requireAdminIdentity(ctx);
    const review = await buildPendingModerationUniquenessReview(ctx, {
      items: args.items,
      asOfMs: args.asOfMs,
      moderationNote: PENDING_MODERATION_UNIQUENESS_PREVIEW_NOTE,
    });
    return review.result;
  },
});

export const getPublicApprovedEvent = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.id);
    if (!eventId) {
      return null;
    }

    const event = await ctx.db.get(eventId);
    if (!event || event.status !== "approved") {
      return null;
    }

    return (await projectLegacyCompatiblePublicEventPage(ctx, [event]))[0] ?? null;
  },
});

export const getByInstagramPostId = query({
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const matches = await ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) =>
        q.eq("instagramPostId", args.instagramPostId),
      )
      .take(1);
    return matches[0] ?? null;
  },
});

export const getByInstagramPostUrl = query({
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const matches = await ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", args.instagramPostUrl),
      )
      .take(1);
    return matches[0] ?? null;
  },
});

export const listByInstagramPostId = query({
  args: {
    instagramPostId: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) =>
        q.eq("instagramPostId", args.instagramPostId),
      )
      .collect();
  },
});

export const listByInstagramPostUrl = query({
  args: {
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", args.instagramPostUrl),
      )
      .collect();
  },
});

export const listByStatus = query({
  args: {
    status: eventStatus,
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const limit = args.limit ?? 100;
    return ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);
  },
});

export const listByStatusPaginated = query({
  args: {
    status: eventStatus,
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getManyByIds = query({
  args: {
    ids: v.array(v.id("events")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.ids.length === 0 || args.ids.length > MAX_EVENTS_GET_MANY_BY_IDS) {
      throw new Error(`Event ID reads require 1-${MAX_EVENTS_GET_MANY_BY_IDS} IDs.`);
    }
    if (new Set(args.ids).size !== args.ids.length) {
      throw new Error("Event ID reads require unique IDs.");
    }
    const events = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return events.filter((event): event is Doc<"events"> => event !== null);
  },
});

export const getNightlifeLineupCoalescingContext = query({
  args: {
    ids: v.array(v.id("events")),
    sourceIdentity: v.string(),
    serviceSecret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Nightlife lineup context requires service authentication.");
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
          throw new Error(`Nightlife lineup context source link is not unique: ${id}.`);
        }
        return links[0];
      }),
    );
    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", args.sourceIdentity))
      .take(2);
    if (receiptRows.length !== 1) {
      throw new Error("Nightlife lineup context receipt is not unique.");
    }
    const [savedEvents, userSavedEvents] = await Promise.all([
      Promise.all(
        args.ids.map((id) =>
          ctx.db
            .query("savedEvents")
            .withIndex("by_event", (q) => q.eq("eventId", id))
            .take(MAX_LINEUP_COALESCING_SAVES_PER_EVENT + 1),
        ),
      ),
      Promise.all(
        args.ids.map((id) =>
          ctx.db
            .query("userSavedEvents")
            .withIndex("by_event", (q) => q.eq("eventId", id))
            .take(MAX_LINEUP_COALESCING_SAVES_PER_EVENT + 1),
        ),
      ),
    ]);
    if (
      [...savedEvents, ...userSavedEvents].some(
        (rows) => rows.length > MAX_LINEUP_COALESCING_SAVES_PER_EVENT,
      )
    ) {
      throw new Error("Nightlife lineup context save cohort exceeds the safe bound.");
    }
    return {
      events: events as Doc<"events">[],
      sourceLinks,
      receipt: receiptRows[0],
      savedEvents: savedEvents.flat(),
      userSavedEvents: userSavedEvents.flat(),
    };
  },
});

export const backfillEventVenueIdentityBatch = mutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const requestedLimit = Number.isFinite(args.limit) ? Math.trunc(args.limit as number) : 100;
    const result = await ctx.db.query("events").paginate({
      cursor: args.cursor ?? null,
      numItems: Math.max(1, Math.min(100, requestedLimit)),
    });
    let updated = 0;
    const publicVenues = (await ctx.db.query("venues").collect()).filter(isVenuePublic);
    const publicVenuesById = new Map(publicVenues.map((venue) => [venue._id, venue]));

    for (const event of result.page) {
      const linkedVenue = event.venueId ? publicVenuesById.get(event.venueId) : undefined;
      const resolved = linkedVenue
        ? resolveVenueDenormalizedFieldsFromPublicVenues([linkedVenue], linkedVenue.name)
        : resolveVenueDenormalizedFieldsFromPublicVenues(publicVenues, event.venue);
      const shouldAssignCanonicalVenue = event.venueId === undefined && resolved.venueId !== undefined;
      const patch = {
        normalizedVenueIdentity: resolved.normalizedVenueIdentity,
        normalizedVenueInstagramHandle: resolved.normalizedVenueInstagramHandle,
        ...(shouldAssignCanonicalVenue
          ? {
              venueCategory: resolved.venueCategory,
              venueId: resolved.venueId,
              venueInstagramHandle: resolved.venueInstagramHandle,
              venueLatitude: resolved.venueLatitude,
              venueLocation: resolved.venueLocation,
              venueLongitude: resolved.venueLongitude,
            }
          : {}),
      };
      const unchanged =
        event.normalizedVenueIdentity === patch.normalizedVenueIdentity &&
        event.normalizedVenueInstagramHandle === patch.normalizedVenueInstagramHandle &&
        (!shouldAssignCanonicalVenue ||
          (event.venueCategory === patch.venueCategory &&
            event.venueId === patch.venueId &&
            event.venueInstagramHandle === patch.venueInstagramHandle &&
            event.venueLatitude === patch.venueLatitude &&
            event.venueLocation === patch.venueLocation &&
            event.venueLongitude === patch.venueLongitude));
      if (unchanged) {
        continue;
      }
      await ctx.db.patch(event._id, {
        ...patch,
        updatedAt: nextEventUpdatedAt(event.updatedAt),
      });
      updated += 1;
    }

    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      scanned: result.page.length,
      updated,
    };
  },
});

export const listByStatusDateWindow = query({
  args: {
    status: eventStatus,
    fromDate: v.string(),
    beforeDate: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", args.status).gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .collect();
  },
});

export const listPublicEventsWindow = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    assertPublicEventDateWindow(args.fromDate, args.beforeDate, MAX_PUBLIC_EVENT_WINDOW_DAYS);
    const result = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .paginate(buildPublicPaginationOptions(args.paginationOpts));
    return {
      ...result,
      page: await projectLegacyCompatiblePublicEventPage(ctx, result.page),
    };
  },
});

function toPublicCalendarEvent(event: ReturnType<typeof projectPublicEvent>) {
  return {
    _id: event._id,
    artists: event.artists,
    date: event.date,
    eventType: event.eventType,
    status: event.status,
    title: event.title,
    venue: event.venue,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.instagramPostId ? { instagramPostId: event.instagramPostId } : {}),
    ...(event.instagramPostUrl ? { instagramPostUrl: event.instagramPostUrl } : {}),
    ...(event.ticketPrice ? { ticketPrice: event.ticketPrice } : {}),
    ...(event.time ? { time: event.time } : {}),
    ...(event.timeSource ? { timeSource: event.timeSource } : {}),
    ...(event.timeEvidenceText ? { timeEvidenceText: event.timeEvidenceText } : {}),
    ...(event.timeConfidence !== undefined ? { timeConfidence: event.timeConfidence } : {}),
    ...(event.timeStatus ? { timeStatus: event.timeStatus } : {}),
    ...(event.venueCategory ? { venueCategory: event.venueCategory } : {}),
    ...(event.venueId ? { venueId: event.venueId } : {}),
    ...(event.venueInstagramHandle
      ? { venueInstagramHandle: event.venueInstagramHandle }
      : {}),
    ...(event.venueLatitude !== undefined ? { venueLatitude: event.venueLatitude } : {}),
    ...(event.venueLocation ? { venueLocation: event.venueLocation } : {}),
    ...(event.venueLongitude !== undefined ? { venueLongitude: event.venueLongitude } : {}),
  };
}

export const listPublicCalendarEventsWindowPaginated = query({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    assertPublicEventDateWindow(args.fromDate, args.beforeDate, MAX_PUBLIC_CALENDAR_WINDOW_DAYS);
    const result = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate).lt("date", args.beforeDate),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: PUBLIC_EVENT_PAGE_SIZE,
      });

    // Match the list view: legacy approved records remain visible, while v2
    // rows must retain their canonical source/revision/media authorization.
    const publicEvents = await projectLegacyCompatiblePublicEventPage(ctx, result.page);
    return {
      ...result,
      page: publicEvents.map(toPublicCalendarEvent),
    };
  },
});

export const listApprovedUpcomingByDatePaginated = query({
  args: {
    fromDate: v.string(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("events")
      .withIndex("by_status_date", (q) =>
        q.eq("status", "approved").gte("date", args.fromDate),
      )
      .paginate(buildPublicPaginationOptions(args.paginationOpts));
    return {
      ...result,
      page: await projectPublicEventPage(ctx, result.page),
    };
  },
});

function readDateParts(value: string): { day: number; month: number; year: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return { day, month, year };
}

function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function dateKeyToUtcMs(value: string): number | null {
  const parts = readDateParts(value);
  if (!parts) {
    return null;
  }
  const timestamp = Date.UTC(parts.year, parts.month - 1, parts.day);
  return formatDateKey(new Date(timestamp)) === value ? timestamp : null;
}

function assertPublicEventDateWindow(
  fromDate: string,
  beforeDate: string,
  maximumDays: number,
): void {
  const fromTimestamp = dateKeyToUtcMs(fromDate);
  const beforeTimestamp = dateKeyToUtcMs(beforeDate);
  const spanDays =
    fromTimestamp === null || beforeTimestamp === null
      ? Number.NaN
      : (beforeTimestamp - fromTimestamp) / 86_400_000;
  if (!Number.isInteger(spanDays) || spanDays < 1 || spanDays > maximumDays) {
    throw new Error(
      `Public event date window must span 1-${maximumDays} days using valid YYYY-MM-DD dates.`,
    );
  }
}

function addDaysToDateKey(value: string, days: number): string {
  const parts = readDateParts(value);
  if (!parts) {
    return value;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateKey(date);
}

function getUtcDayForDateKey(value: string): number {
  const parts = readDateParts(value);
  if (!parts) {
    return 1;
  }

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function getUpcomingWeekendDates(today: string): Set<string> {
  const day = getUtcDayForDateKey(today);
  const startOffset = day >= 1 && day <= 4 ? 5 - day : 0;
  const endOffset = day === 5 ? 2 : day === 6 ? 1 : day === 0 ? 0 : startOffset + 2;
  const dates = new Set<string>();

  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const date = addDaysToDateKey(today, offset);
    const dateDay = getUtcDayForDateKey(date);
    if (dateDay === 5 || dateDay === 6 || dateDay === 0) {
      dates.add(date);
    }
  }

  return dates;
}

function isPromotionActive(
  event: { promotionEnd?: string; promotionStart?: string },
  today: string,
): boolean {
  return Boolean(
    event.promotionStart &&
      event.promotionEnd &&
      event.promotionStart <= today &&
      today <= event.promotionEnd,
  );
}

function comparePromotionEvents(
  left: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
  right: {
    _id: Id<"events">;
    date: string;
    promotionPriority?: number;
    title: string;
  },
): number {
  const priorityDelta =
    (left.promotionPriority ?? Number.POSITIVE_INFINITY) -
    (right.promotionPriority ?? Number.POSITIVE_INFINITY);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareOrganicEvents(
  left: { _id: Id<"events">; date: string; time?: string; title: string },
  right: { _id: Id<"events">; date: string; time?: string; title: string },
): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function hasFreeTicketPrice(value: string | undefined): boolean {
  const normalized = value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return (
    !normalized ||
    normalized === "0" ||
    normalized === "free" ||
    normalized === "besplatno" ||
    normalized === "slobodan ulaz" ||
    normalized === "slobodne donacije" ||
    normalized === "donacije"
  );
}

export const getDiscoverFeed = query({
  args: {
    today: v.string(),
  },
  handler: async (ctx, args) => {
    const featuredCandidates = await ctx.db
      .query("events")
      .withIndex("by_status_promotionTier", (q) =>
        q.eq("status", "approved").eq("promotionTier", "featured"),
      )
      .collect();
    const promotedCandidates = await ctx.db
      .query("events")
      .withIndex("by_status_promotionTier", (q) =>
        q.eq("status", "approved").eq("promotionTier", "promoted"),
      )
      .collect();

    const featured = featuredCandidates
      .filter((event) => isPromotionActive(event, args.today))
      .sort(comparePromotionEvents)
      .slice(0, 1);
    const promoted = promotedCandidates
      .filter((event) => isPromotionActive(event, args.today))
      .sort(comparePromotionEvents)
      .slice(0, 10);
    const paidIds = new Set([...featured, ...promoted].map((event) => event._id));

    const tonight = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").eq("date", args.today),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => !paidIds.has(event._id))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    const weekendDates = getUpcomingWeekendDates(args.today);
    const weekendEnd = [...weekendDates].sort().at(-1) ?? args.today;
    const weekend = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today).lte("date", weekendEnd),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => weekendDates.has(event.date))
      .filter((event) => !paidIds.has(event._id))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    const free = (
      await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) =>
          q.eq("status", "approved").gte("date", args.today),
        )
        .take(DISCOVER_ORGANIC_SCAN_LIMIT)
    )
      .filter((event) => !paidIds.has(event._id))
      .filter((event) => hasFreeTicketPrice(event.ticketPrice))
      .sort(compareOrganicEvents)
      .slice(0, 12);

    const selectedEvents = [
      ...featured,
      ...free,
      ...promoted,
      ...tonight,
      ...weekend,
    ];
    const groundingDecisions = await Promise.all(
      selectedEvents.map((event) => isCanonicallyGroundedApprovedEvent(ctx, event)),
    );
    const groundedEventIds = new Set(
      selectedEvents
        .filter((_, index) => groundingDecisions[index])
        .map((event) => event._id),
    );
    const groundedEvents = selectedEvents.filter((event) => groundedEventIds.has(event._id));
    const publicVenueIds = await loadPublicVenueIdsForEvents(ctx, groundedEvents);
    const projectGroup = (events: Doc<"events">[]) =>
      events
        .filter((event) => groundedEventIds.has(event._id))
        .map((event) =>
          projectPublicEvent(
            event,
            event.venueId !== undefined && publicVenueIds.has(event.venueId),
          ),
        );

    return {
      featured: projectGroup(featured),
      free: projectGroup(free),
      promoted: projectGroup(promoted),
      tonight: projectGroup(tonight),
      weekend: projectGroup(weekend),
    };
  },
});

export const listByDate = query({
  args: {
    date: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("events")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .collect();
  },
});

type SourceOccurrencePlan = {
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
  }>;
  deferredChildCount: number;
  deferredChildKeys: string[];
  observedChildKeys: string[];
  previousSourceFingerprint?: string | null;
  confirmedPastKeys?: string[];
};

function assertSourceOccurrencePlan(plan: SourceOccurrencePlan, satisfiedKey: string): void {
  if (
    !plan.sourceIdentity ||
    !plan.sourceFingerprint ||
    plan.expectedKeys.length < 1 ||
    new Set(plan.expectedKeys).size !== plan.expectedKeys.length ||
    plan.expectedOccurrences.length !== plan.expectedKeys.length ||
    new Set(plan.expectedOccurrences.map((item) => item.key)).size !==
      plan.expectedOccurrences.length ||
    plan.expectedOccurrences.some(
      (item) =>
        !item.date ||
        // Event-evidence v2 intentionally persists an unknown venue as "".
        // Reject absent/non-string bindings while preserving that explicit value.
        typeof item.venue !== "string" ||
        !item.title ||
        !Array.isArray(item.artists) ||
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

const eventRepresentsExpectedOccurrence = eventRepresentsExpectedOccurrenceForTesting;

async function assertSourceProcessingFence(
  ctx: MutationCtx,
  fence: SourceProcessingFence,
): Promise<void> {
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
}

async function assertSourceOccurrenceGenerationCurrent(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
): Promise<void> {
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

async function upsertInstagramEventSourceLink(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  satisfiedKey: string,
  representativeEvent: Doc<"events">,
  supersededKey?: string,
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

  const now = Date.now();
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
    updatedAt: now,
  };

  if (existingTarget) {
    await ctx.db.patch(existingTarget._id, patch);
    if (supersededLink && supersededLink._id !== existingTarget._id) {
      await ctx.db.delete(supersededLink._id);
    }
    return;
  }
  if (supersededLink) {
    await ctx.db.patch(supersededLink._id, patch);
    return;
  }
  await ctx.db.insert("instagramEventSources", {
    ...patch,
    linkedAt: now,
  });
}

async function recordSourceOccurrenceSatisfaction(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
  satisfiedKey: string,
  representativeEventId: Id<"events">,
  supersededKey?: string,
): Promise<void> {
  const representativeEvent = await ctx.db.get(representativeEventId);
  if (!representativeEvent) {
    throw new Error("Representative event does not exist.");
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
    await upsertInstagramEventSourceLink(
      ctx,
      plan,
      satisfiedKey,
      representativeEvent,
      supersededKey,
    );
    return;
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
  await ctx.db.patch(existing._id, {
    sourceFingerprint: plan.sourceFingerprint,
    expectedKeys,
    expectedOccurrences,
    satisfiedKeys,
    deferredChildCount,
    deferredChildKeys,
    satisfiedOccurrences,
    updatedAt: now,
  });
  await upsertInstagramEventSourceLink(
    ctx,
    plan,
    satisfiedKey,
    representativeEvent,
    supersededKey,
  );
}

async function reconcileExistingSourceOccurrenceReceipt(
  ctx: MutationCtx,
  plan: SourceOccurrencePlan,
): Promise<boolean> {
  if (
    plan.expectedKeys.length !== 0 ||
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
    return true;
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
  return true;
}

export const reconcileInstagramSourceOccurrenceReceipt = mutation({
  args: {
    plan: sourceOccurrencePlan,
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await assertSourceProcessingFence(ctx, args.processingFence);
    return {
      reconciled: await reconcileExistingSourceOccurrenceReceipt(ctx, args.plan),
    };
  },
});

export const getInstagramSourceOccurrenceReceipt = query({
  args: {
    sourceIdentity: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const receipt = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", args.sourceIdentity))
      .unique();
    if (!receipt) {
      return null;
    }
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
      .map(({ exists: _exists, ...occurrence }) => occurrence);
    return {
      ...receipt,
      satisfiedKeys: receipt.satisfiedKeys.filter((key) => representedKeys.has(key)),
      satisfiedOccurrences: liveSatisfiedOccurrences,
    };
  },
});

export const recordInstagramSourceOccurrenceSatisfaction = mutation({
  args: {
    plan: sourceOccurrencePlan,
    satisfiedKey: v.string(),
    representativeEventId: v.id("events"),
    supersededKey: v.optional(v.string()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await assertSourceProcessingFence(ctx, args.processingFence);
    await recordSourceOccurrenceSatisfaction(
      ctx,
      args.plan,
      args.satisfiedKey,
      args.representativeEventId,
      args.supersededKey,
    );
    return { recorded: true };
  },
});

export const createEvent = mutation({
  args: {
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    timeSource: v.optional(eventTimeSource),
    timeEvidenceText: v.optional(v.union(v.string(), v.null())),
    timeConfidence: v.optional(v.number()),
    timeStatus: v.optional(eventTimeStatus),
    timeEvidenceKind: v.optional(eventTimeEvidenceKind),
    dateEvidenceText: v.optional(v.string()),
    dateEvidenceSource: v.optional(eventDateEvidenceSource),
    dateEvidenceIsRelative: v.optional(v.boolean()),
    dateEvidenceResolvedDate: v.optional(v.string()),
    sourceConflictFields: v.optional(v.array(v.string())),
    venue: v.string(),
    artists: v.array(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    instagramPostUrl: v.optional(v.string()),
    instagramPostId: v.optional(v.string()),
    ticketPrice: v.optional(v.string()),
    eventType: v.string(),
    sourceCaption: v.optional(v.string()),
    sourcePostedAt: v.optional(v.string()),
    rawExtractionJson: v.optional(v.string()),
    normalizedFieldsJson: v.optional(v.string()),
    sourceOccurrenceKey: v.optional(v.string()),
    sourceOccurrencePlan: v.optional(sourceOccurrencePlan),
    processingFence: v.optional(sourceProcessingFence),
    promotionTier: v.optional(promotionTier),
    promotionStart: v.optional(v.string()),
    promotionEnd: v.optional(v.string()),
    promotionPriority: v.optional(v.number()),
    status: v.optional(eventStatus),
    returnCreateDisposition: v.optional(v.boolean()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const {
      serviceSecret: _serviceSecret,
      returnCreateDisposition,
      sourceOccurrencePlan: occurrencePlan,
      processingFence,
      ...eventArgs
    } = args;
    if (processingFence) {
      await assertSourceProcessingFence(ctx, processingFence);
    } else if (occurrencePlan || eventArgs.sourceOccurrenceKey) {
      throw new Error("Source occurrence event creation requires a current processing fence.");
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
          await recordSourceOccurrenceSatisfaction(
            ctx,
            occurrencePlan,
            eventArgs.sourceOccurrenceKey,
            existingOccurrence._id,
          );
        }
        return returnCreateDisposition
          ? { eventId: existingOccurrence._id, created: false, updatedAt: existingOccurrence.updatedAt }
          : existingOccurrence._id;
      }
    }
    const venueFields = await resolveVenueDenormalizedFields(ctx, eventArgs.venue);
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
        await assertPersistedServiceSourcePolicy(ctx, { ...eventArgs, ...venueFields });
      }
    }
    void _serviceSecret;
    const now = Date.now();
    assertPublicEventImageWrite(eventArgs.imageUrl, eventArgs.imageStorageId);
    if (eventArgs.status === "approved") {
      await assertApprovalCandidatePolicy(ctx, { ...eventArgs, ...venueFields });
    }
    const normalizedEventArgs = normalizeEventTimeWritePatch(eventArgs);
    const eventId = await ctx.db.insert("events", {
      ...normalizedEventArgs,
      ...(eventArgs.instagramPostUrl
        ? { normalizedInstagramPostUrl: normalizeInstagramPostUrl(eventArgs.instagramPostUrl) }
        : {}),
      ...venueFields,
      eventType: canonicalizeEventType(eventArgs.eventType),
      status: eventArgs.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    });

    if (occurrencePlan && eventArgs.sourceOccurrenceKey) {
      await recordSourceOccurrenceSatisfaction(
        ctx,
        occurrencePlan,
        eventArgs.sourceOccurrenceKey,
        eventId,
      );
    }

    await writeEventAuditLog(ctx, eventId, "created", {
      actor,
      patch: normalizedEventArgs,
    });

    return returnCreateDisposition
      ? { eventId, created: true, updatedAt: now }
      : eventId;
  },
});

export const updateSourceOccurrenceExpectedCount = mutation({
  args: {
    id: v.id("events"),
    sourceOccurrenceKey: v.string(),
    expectedCurrentCount: v.number(),
    expectedCurrentKeys: v.array(v.string()),
    expectedCurrentDeferredChildCount: v.number(),
    expectedCurrentSourceFingerprint: v.optional(v.string()),
    nextExpectedCount: v.number(),
    nextExpectedKeys: v.array(v.string()),
    nextDeferredChildCount: v.number(),
    nextSourceFingerprint: v.string(),
    confirmedPastKeys: v.array(v.string()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await assertSourceProcessingFence(ctx, args.processingFence);
    const currentKeySet = new Set(args.expectedCurrentKeys);
    const nextKeySet = new Set(args.nextExpectedKeys);
    const removedKeys = args.expectedCurrentKeys.filter((key) => !nextKeySet.has(key));
    const addedKeys = args.nextExpectedKeys.filter((key) => !currentKeySet.has(key));
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
      throw new Error("Source occurrence completeness metadata transition is not safe.");
    }

    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }
    if (existingEvent.sourceOccurrenceKey !== args.sourceOccurrenceKey) {
      throw new Error("Source occurrence identity changed before metadata update.");
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
      throw new Error("Normalized source occurrence identity changed before metadata update.");
    }
    if (
      normalizedFields.sourceOccurrenceExpectedCount === args.nextExpectedCount &&
      JSON.stringify(normalizedFields.sourceOccurrenceExpectedKeys) ===
        JSON.stringify(args.nextExpectedKeys) &&
      normalizedFields.sourceOccurrenceDeferredChildCount === args.nextDeferredChildCount &&
      normalizedFields.sourceOccurrenceSourceFingerprint === args.nextSourceFingerprint
    ) {
      return { updated: false };
    }
    if (
      normalizedFields.sourceOccurrenceExpectedCount !== args.expectedCurrentCount ||
      JSON.stringify(normalizedFields.sourceOccurrenceExpectedKeys) !==
        JSON.stringify(args.expectedCurrentKeys) ||
      (normalizedFields.sourceOccurrenceDeferredChildCount ?? 0) !==
        args.expectedCurrentDeferredChildCount ||
      normalizedFields.sourceOccurrenceSourceFingerprint !==
        args.expectedCurrentSourceFingerprint
    ) {
      throw new Error("Source occurrence completeness metadata changed before update.");
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
    await writeEventAuditLog(ctx, args.id, "source_occurrence_completeness_updated", {
      actor,
      patch: {
        sourceOccurrenceKey: args.sourceOccurrenceKey,
        sourceOccurrenceExpectedCount: args.nextExpectedCount,
        sourceOccurrenceExpectedKeys: args.nextExpectedKeys,
        sourceOccurrenceDeferredChildCount: args.nextDeferredChildCount,
        sourceOccurrenceSourceFingerprint: args.nextSourceFingerprint,
      },
    });
    return { updated: true };
  },
});

/**
 * Repairs the narrowly scoped event-evidence-v2 venue-loss bug without
 * reopening a paid fetch or weakening the generic service update policy.
 *
 * The mutation only accepts an empty current venue, an exact optimistic
 * version/JSON snapshot, and a next JSON value whose sole change is the
 * canonical venue already bound to the persisted source handle. Approved
 * rows must still pass the complete v2 source and duplicate policies.
 */
export const repairTrustedV2EventVenue = mutation({
  args: {
    id: v.id("events"),
    expectedStatus: eventStatus,
    expectedUpdatedAt: v.number(),
    expectedNormalizedFieldsJson: v.string(),
    nextVenue: v.string(),
    nextNormalizedFieldsJson: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: trustedV2VenueRepairResult,
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (kind !== "service") {
      throw new Error("Trusted v2 venue repair requires service authentication.");
    }
    if (args.moderationNote.trim().length < 20) {
      throw new Error("Trusted v2 venue repair requires a substantive audit note.");
    }
    if (!Number.isSafeInteger(args.expectedUpdatedAt)) {
      throw new Error("Trusted v2 venue repair requires a valid expectedUpdatedAt.");
    }

    const event = await ctx.db.get(args.id);
    if (!event) {
      throw new Error("Event not found.");
    }
    assertExpectedEventStatus(event.status, args.expectedStatus);
    assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
    if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
      throw new Error("Normalized event evidence changed before venue repair.");
    }
    if (normalizeLookup(event.venue)) {
      throw new Error("Trusted v2 venue repair only accepts an empty current venue.");
    }

    let currentFields: Record<string, unknown>;
    let nextFields: Record<string, unknown>;
    try {
      const current = JSON.parse(args.expectedNormalizedFieldsJson) as unknown;
      const next = JSON.parse(args.nextNormalizedFieldsJson) as unknown;
      if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !next ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        throw new Error("invalid normalized fields");
      }
      currentFields = current as Record<string, unknown>;
      nextFields = next as Record<string, unknown>;
    } catch {
      throw new Error("Trusted v2 venue repair requires valid normalized JSON.");
    }

    const nextVenue = args.nextVenue.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (
      !nextVenue ||
      (typeof currentFields.normalizedVenue === "string" &&
        normalizeLookup(currentFields.normalizedVenue))
    ) {
      throw new Error("Trusted v2 venue repair requires an empty attested venue.");
    }
    const expectedNextFields = { ...currentFields, normalizedVenue: nextVenue };
    if (JSON.stringify(expectedNextFields) !== JSON.stringify(nextFields)) {
      throw new Error("Trusted v2 venue repair may only change normalizedVenue.");
    }
    if (
      currentFields.extractionContractVersion !== "event_evidence_v2" ||
      currentFields.extractionIsEvent !== true ||
      currentFields.sourceGroundingVersion !== 5 ||
      currentFields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2" ||
      currentFields.trustedVenueSource !== true ||
      currentFields.venueEvidenceVerified !== true ||
      (currentFields.extractionMode !== "poster" &&
        currentFields.extractionMode !== "caption_only")
    ) {
      throw new Error("Event is not eligible for the trusted v2 venue repair.");
    }

    const sourceHandle =
      typeof currentFields.sourceGroundingInstagramHandle === "string"
        ? normalizeHandle(currentFields.sourceGroundingInstagramHandle)
        : "";
    const postId = event.instagramPostId?.trim() ?? "";
    const postUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
    if (!sourceHandle || !postId || !postUrl.startsWith("https://www.instagram.com/")) {
      throw new Error("Trusted v2 venue repair requires an exact Instagram source identity.");
    }

    const publicVenues = (await ctx.db.query("venues").collect()).filter(isVenuePublic);
    const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(publicVenues, nextVenue);
    const canonicalVenue = venueFields.venueId
      ? publicVenues.find((venue) => venue._id === venueFields.venueId)
      : undefined;
    if (
      !canonicalVenue ||
      canonicalVenue.name !== nextVenue ||
      normalizeHandle(canonicalVenue.instagramHandle) !== sourceHandle ||
      normalizeHandle(venueFields.venueInstagramHandle ?? "") !== sourceHandle
    ) {
      throw new Error("Repaired venue must be the source handle's exact public venue.");
    }

    const sourceRows = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
      .take(2);
    const source = sourceRows.length === 1 ? sourceRows[0] : null;
    const exactCanonicalVenueSource = Boolean(
      source?.active &&
        source.role === "venue" &&
        source.venueId === canonicalVenue._id,
    );
    if (
      !source ||
      !source.active ||
      source.role === "promoter" ||
      (source.venueId !== undefined && source.venueId !== canonicalVenue._id)
    ) {
      throw new Error("Repaired venue is not backed by an active venue source.");
    }

    const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(publicVenues);
    const canonicalVenueAliasesByHandle = buildCanonicalVenueAliasesByHandle(publicVenues);
    const rawVenue =
      typeof currentFields.rawVenue === "string" ? currentFields.rawVenue.trim() : "";
    const rawVenueCanonicalization = canonicalizeVenueNameDetailed(
      rawVenue,
      canonicalVenueNamesByHandle,
      { canonicalVenueAliasesByHandle },
    );
    if (
      (!rawVenue && !exactCanonicalVenueSource) ||
      (rawVenue &&
        normalizeHandle(rawVenueCanonicalization?.handle ?? "") !== sourceHandle)
    ) {
      throw new Error("Persisted model venue does not resolve to the source's canonical venue.");
    }

    const persistedCandidates = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postId", (q) => q.eq("handle", sourceHandle).eq("postId", postId))
      .take(2);
    const persisted = persistedCandidates.length === 1 ? persistedCandidates[0] : null;
    if (
      !persisted ||
      normalizeHandle(persisted.handle) !== sourceHandle ||
      normalizeHandle(persisted.username) !== sourceHandle ||
      persisted.postId !== postId ||
      normalizeInstagramPostUrl(persisted.instagramPostUrl) !== postUrl ||
      normalizeSourceCaption(persisted.caption) !== normalizeSourceCaption(event.sourceCaption) ||
      persisted.postedAt !== event.sourcePostedAt ||
      persisted.analysisResultJson !== event.rawExtractionJson ||
      persisted.analysisRevision !== (persisted.sourceRevision ?? 1) ||
      persisted.analysisContractVersion !== "event_evidence_v2" ||
      persisted.analysisIsEvent !== true ||
      !persisted.analysisModel?.startsWith("gpt-5-mini")
    ) {
      throw new Error("Trusted v2 venue repair requires the current persisted GPT source.");
    }

    const effectiveEvent = {
      ...event,
      ...venueFields,
      venue: canonicalVenue.name,
      normalizedFieldsJson: args.nextNormalizedFieldsJson,
    };
    if (event.status === "approved") {
      if (!hasEventEvidenceV2AutoApproval(args.nextNormalizedFieldsJson, effectiveEvent)) {
        throw new Error("Approved venue repair must retain complete v2 auto-approval evidence.");
      }
      await assertPersistedServiceSourcePolicy(ctx, effectiveEvent);
      await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
    }

    const updatedAt = nextEventUpdatedAt(event.updatedAt);
    await ctx.db.patch(event._id, {
      venue: canonicalVenue.name,
      normalizedFieldsJson: args.nextNormalizedFieldsJson,
      ...venueFields,
      updatedAt,
    });
    await writeEventAuditLog(ctx, event._id, "trusted_v2_venue_repaired", {
      actor,
      note: args.moderationNote.trim(),
      patch: {
        venue: canonicalVenue.name,
        normalizedVenue: canonicalVenue.name,
        sourceHandle,
      },
    });
    return { updated: true, updatedAt, status: event.status };
  },
});

/**
 * Atomically repairs the legacy address-as-venue extraction bug for an
 * already-approved event and its immutable source-occurrence receipt.
 *
 * The previous venue must exactly equal the linked public venue's persisted
 * location, while the event source handle must own that venue. Every related
 * document is guarded by its reviewed version so this cannot become a generic
 * service-authenticated approved-event editor.
 */
export const repairApprovedLegacyEventVenueAndOccurrence = mutation({
  args: {
    id: v.id("events"),
    expectedUpdatedAt: v.number(),
    expectedCurrentVenue: v.string(),
    expectedNormalizedFieldsJson: v.string(),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    expectedSourceId: v.id("instagramSources"),
    expectedSourceUpdatedAt: v.number(),
    expectedScrapedPostId: v.id("scrapedPosts"),
    expectedScrapedPostSourceRevision: v.number(),
    expectedScrapedPostAnalysisRevision: v.number(),
    expectedSourceLinkId: v.id("instagramEventSources"),
    expectedSourceLinkUpdatedAt: v.number(),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    expectedSourceIdentity: v.string(),
    expectedSourceFingerprint: v.string(),
    expectedSourceOccurrenceKey: v.string(),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: approvedLegacyVenueRepairResult,
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (kind !== "service") {
      throw new Error("Approved legacy venue repair requires service authentication.");
    }
    const moderationNote = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (moderationNote.length < 20) {
      throw new Error("Approved legacy venue repair requires a substantive audit note.");
    }
    if (
      !Number.isSafeInteger(args.expectedUpdatedAt) ||
      !Number.isSafeInteger(args.expectedTargetVenueUpdatedAt) ||
      !Number.isSafeInteger(args.expectedSourceUpdatedAt) ||
      !Number.isSafeInteger(args.expectedScrapedPostSourceRevision) ||
      !Number.isSafeInteger(args.expectedScrapedPostAnalysisRevision) ||
      !Number.isSafeInteger(args.expectedSourceLinkUpdatedAt) ||
      !Number.isSafeInteger(args.expectedReceiptUpdatedAt)
    ) {
      throw new Error("Approved legacy venue repair requires valid optimistic versions.");
    }

    const event = await ctx.db.get(args.id);
    if (!event) {
      throw new Error("Event not found.");
    }
    if (event.status !== "approved") {
      throw new Error("Approved legacy venue repair only accepts an approved event.");
    }
    assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
    if (
      event.venue !== args.expectedCurrentVenue ||
      event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson
    ) {
      throw new Error("Approved legacy event venue evidence changed before repair.");
    }
    if (
      event.humanReviewedLegacySourcePolicyVersion !==
        HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION ||
      !hasHumanReviewedLegacySourceAttestation(event.normalizedFieldsJson, event)
    ) {
      throw new Error("Event is not an eligible human-reviewed legacy source event.");
    }
    if (!(await isCanonicallyGroundedApprovedEvent(ctx, event))) {
      throw new Error("Current approved event is not publicly source-grounded.");
    }

    let currentFields: Record<string, unknown>;
    let rawExtraction: Record<string, unknown> | null = null;
    try {
      const parsedFields = JSON.parse(args.expectedNormalizedFieldsJson) as unknown;
      if (!parsedFields || typeof parsedFields !== "object" || Array.isArray(parsedFields)) {
        throw new Error("invalid normalized fields");
      }
      currentFields = parsedFields as Record<string, unknown>;
      if (event.rawExtractionJson) {
        const parsedRawExtraction = JSON.parse(event.rawExtractionJson) as unknown;
        rawExtraction =
          parsedRawExtraction &&
          typeof parsedRawExtraction === "object" &&
          !Array.isArray(parsedRawExtraction)
            ? (parsedRawExtraction as Record<string, unknown>)
            : null;
      }
    } catch {
      throw new Error("Approved legacy venue repair requires valid persisted evidence JSON.");
    }
    if (
      (currentFields.sourceGroundingVersion !== 3 &&
        currentFields.sourceGroundingVersion !== 4) ||
      currentFields.sourceGroundingEvidence !== "instagram_caption" ||
      currentFields.extractionContractVersion === "event_evidence_v2" ||
      rawExtraction?.extraction_contract_version === "event_evidence_v2" ||
      normalizeLookup(String(currentFields.rawVenue ?? "")) !==
        normalizeLookup(event.venue) ||
      normalizeLookup(String(currentFields.normalizedVenue ?? "")) !==
        normalizeLookup(event.venue)
    ) {
      throw new Error("Persisted evidence is not the eligible legacy address-as-venue shape.");
    }

    const sourceHandle = normalizeHandle(
      typeof currentFields.sourceGroundingInstagramHandle === "string"
        ? currentFields.sourceGroundingInstagramHandle
        : "",
    );
    const postId = event.instagramPostId?.trim() ?? "";
    const postUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
    if (
      !sourceHandle ||
      !postId ||
      !postUrl ||
      event.sourceOccurrenceKey !== args.expectedSourceOccurrenceKey ||
      !args.expectedSourceIdentity.trim() ||
      !args.expectedSourceFingerprint.trim()
    ) {
      throw new Error("Approved legacy venue repair requires exact source identity fields.");
    }

    const targetVenue = await ctx.db.get(args.targetVenueId);
    if (
      !targetVenue ||
      targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
      !isVenuePublic(targetVenue) ||
      normalizeHandle(targetVenue.instagramHandle) !== sourceHandle ||
      !targetVenue.location ||
      normalizeLookup(targetVenue.location) !== normalizeLookup(event.venue) ||
      normalizeLookup(targetVenue.name) === normalizeLookup(event.venue)
    ) {
      throw new Error("Target venue is not the exact public source venue for this address.");
    }

    const sourceRows = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
      .take(2);
    const source = sourceRows.length === 1 ? sourceRows[0] : null;
    if (
      !source ||
      source._id !== args.expectedSourceId ||
      source.updatedAt !== args.expectedSourceUpdatedAt ||
      !source.active ||
      source.role !== "venue" ||
      source.venueId !== targetVenue._id
    ) {
      throw new Error("Instagram source no longer owns the target venue.");
    }

    const persistedCandidates = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postId", (q) =>
        q.eq("handle", sourceHandle).eq("postId", postId),
      )
      .take(2);
    const persisted = persistedCandidates.length === 1 ? persistedCandidates[0] : null;
    if (
      !persisted ||
      persisted._id !== args.expectedScrapedPostId ||
      persisted.sourceRevision !== args.expectedScrapedPostSourceRevision ||
      persisted.analysisRevision !== args.expectedScrapedPostAnalysisRevision ||
      normalizeHandle(persisted.handle) !== sourceHandle ||
      normalizeHandle(persisted.username) !== sourceHandle ||
      persisted.postId !== postId ||
      normalizeInstagramPostUrl(persisted.instagramPostUrl) !== postUrl ||
      normalizeSourceCaption(persisted.caption) !== normalizeSourceCaption(event.sourceCaption) ||
      persisted.postedAt !== event.sourcePostedAt ||
      persisted.analysisResultJson !== event.rawExtractionJson
    ) {
      throw new Error("Persisted Instagram extraction changed before venue repair.");
    }

    const sourceLinks = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .take(2);
    const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
    if (
      !sourceLink ||
      sourceLink._id !== args.expectedSourceLinkId ||
      sourceLink.updatedAt !== args.expectedSourceLinkUpdatedAt ||
      sourceLink.sourceIdentity !== args.expectedSourceIdentity ||
      sourceLink.sourceFingerprint !== args.expectedSourceFingerprint ||
      sourceLink.sourceOccurrenceKey !== args.expectedSourceOccurrenceKey ||
      sourceLink.instagramPostId !== event.instagramPostId ||
      normalizeInstagramPostUrl(sourceLink.instagramPostUrl) !== postUrl ||
      (sourceLink.sourceHandle !== undefined &&
        normalizeHandle(sourceLink.sourceHandle) !== sourceHandle)
    ) {
      throw new Error("Event source link changed before venue repair.");
    }

    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", args.expectedSourceIdentity),
      )
      .take(2);
    const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
    const expectedOccurrences = receipt?.expectedOccurrences ?? [];
    const matchingOccurrences = expectedOccurrences.filter(
      (occurrence) => occurrence.key === args.expectedSourceOccurrenceKey,
    );
    const matchingSatisfiedOccurrences = (receipt?.satisfiedOccurrences ?? []).filter(
      (occurrence) => occurrence.key === args.expectedSourceOccurrenceKey,
    );
    const satisfiedOccurrencesForEvent = (receipt?.satisfiedOccurrences ?? []).filter(
      (occurrence) => occurrence.eventId === event._id,
    );
    const expectedOccurrence = matchingOccurrences[0];
    if (
      !receipt ||
      receipt._id !== args.expectedReceiptId ||
      receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
      receipt.sourceFingerprint !== args.expectedSourceFingerprint ||
      matchingOccurrences.length !== 1 ||
      matchingSatisfiedOccurrences.length !== 1 ||
      satisfiedOccurrencesForEvent.length !== 1 ||
      matchingSatisfiedOccurrences[0].eventId !== event._id ||
      receipt.expectedKeys.filter((key) => key === args.expectedSourceOccurrenceKey).length !== 1 ||
      receipt.satisfiedKeys.filter((key) => key === args.expectedSourceOccurrenceKey).length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence)
    ) {
      throw new Error("Source occurrence receipt changed or is not represented by this event.");
    }

    const nextFields = {
      ...currentFields,
      canonicalVenueLocation: targetVenue.location,
      manualVenueCanonicalizationPreviousVenue: event.venue,
      manualVenueCanonicalizationReason: "source_location_matches_canonical_venue",
      manualVenueCanonicalizationSourceHandle: sourceHandle,
      manualVenueCanonicalizationVersion: 1,
      normalizedVenue: targetVenue.name,
      rawVenueMatchesCanonicalLocation: true,
    };
    const nextNormalizedFieldsJson = JSON.stringify(nextFields);
    const venueFields: VenueDenormalizedFields = {
      ...CLEARED_VENUE_DENORMALIZED_FIELDS,
      ...buildNormalizedEventVenueIdentity({
        venue: targetVenue.name,
        venueInstagramHandle: targetVenue.instagramHandle,
      }),
      venueCategory: targetVenue.category,
      venueId: targetVenue._id,
      venueInstagramHandle: targetVenue.instagramHandle,
      ...(targetVenue.latitude !== undefined
        ? { venueLatitude: targetVenue.latitude }
        : {}),
      ...(targetVenue.location ? { venueLocation: targetVenue.location } : {}),
      ...(targetVenue.longitude !== undefined
        ? { venueLongitude: targetVenue.longitude }
        : {}),
    };
    const nextModerationNote = [event.moderationNote?.trim(), moderationNote]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const effectiveEvent: Doc<"events"> = {
      ...event,
      ...venueFields,
      venue: targetVenue.name,
      normalizedFieldsJson: nextNormalizedFieldsJson,
      moderationNote: nextModerationNote,
    };
    const nextExpectedOccurrence = {
      ...expectedOccurrence,
      venue: targetVenue.name,
    };
    if (
      !sourceOccurrenceRepresentativeMatchesExpected(
        effectiveEvent,
        nextExpectedOccurrence,
      )
    ) {
      throw new Error("Repaired event would not represent its source occurrence.");
    }
    await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
    if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectiveEvent))) {
      throw new Error("Repaired event would no longer be publicly source-grounded.");
    }

    const updatedAt = nextEventUpdatedAt(event.updatedAt);
    const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt);
    await ctx.db.patch(event._id, {
      ...venueFields,
      venue: targetVenue.name,
      normalizedFieldsJson: nextNormalizedFieldsJson,
      moderationNote: nextModerationNote,
      updatedAt,
    });
    await ctx.db.patch(receipt._id, {
      expectedOccurrences: expectedOccurrences.map((occurrence) =>
        occurrence.key === args.expectedSourceOccurrenceKey
          ? nextExpectedOccurrence
          : occurrence,
      ),
      updatedAt: receiptUpdatedAt,
    });
    await writeEventAuditLog(ctx, event._id, "approved_legacy_venue_repaired", {
      actor,
      note: moderationNote,
      patch: {
        previousVenue: event.venue,
        receiptId: receipt._id,
        sourceHandle,
        sourceIdentity: receipt.sourceIdentity,
        sourceOccurrenceKey: args.expectedSourceOccurrenceKey,
        targetVenue: targetVenue.name,
        targetVenueId: targetVenue._id,
      },
    });
    return {
      receiptUpdatedAt,
      status: "approved" as const,
      updated: true,
      updatedAt,
    };
  },
});

async function applyEventUpdate(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    patch: EventUpdatePatch;
    expectedStatus?: "pending" | "approved" | "rejected";
    expectedUpdatedAt?: number;
  },
  authorization: { actor: string; kind: "admin" | "service" },
): Promise<{ updatedAt: number }> {
  const existingEvent = await ctx.db.get(args.id);
  if (!existingEvent) {
    throw new Error("Event not found.");
  }
  assertExpectedEventStatus(existingEvent.status, args.expectedStatus);
  assertExpectedEventUpdatedAt(existingEvent.updatedAt, args.expectedUpdatedAt);

  const updatedAt = nextEventUpdatedAt(existingEvent.updatedAt);
  const { clearTicketPrice, ...eventPatch } = args.patch;
  if (clearTicketPrice && eventPatch.ticketPrice !== undefined) {
    throw new Error("ticketPrice and clearTicketPrice cannot be used together.");
  }
  const venueFields =
    eventPatch.venue !== undefined
      ? await resolveVenueDenormalizedFields(ctx, eventPatch.venue)
      : {};
  const nextImageStorageId =
    eventPatch.imageStorageId ??
    (eventPatch.imageUrl !== undefined && eventPatch.imageUrl === existingEvent.imageUrl
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
  const patch = {
    ...normalizeEventTimeWritePatch(eventPatch),
    ...(clearTicketPrice ? { ticketPrice: undefined } : {}),
    ...imagePairPatch,
    ...venueFields,
    ...(eventPatch.instagramPostUrl !== undefined
      ? {
          normalizedInstagramPostUrl: normalizeInstagramPostUrl(eventPatch.instagramPostUrl),
        }
      : {}),
    ...(eventPatch.eventType !== undefined
      ? { eventType: canonicalizeEventType(eventPatch.eventType) }
      : {}),
  };
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
  await ctx.db.patch(args.id, { ...patch, updatedAt });
  const auditPatch = clearTicketPrice
    ? { ...patch, clearTicketPrice: true }
    : patch;
  await writeEventAuditLog(ctx, args.id, "updated", {
    actor: authorization.actor,
    patch: auditPatch,
  });
  return { updatedAt };
}

export const updateEvent = mutation({
  args: {
    id: v.id("events"),
    patch: eventUpdatePatch,
    expectedStatus: v.optional(eventStatus),
    expectedUpdatedAt: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return applyEventUpdate(ctx, args, authorization);
  },
});

export const updateEventAndRecordInstagramSourceOccurrenceSatisfaction = mutation({
  args: {
    id: v.id("events"),
    patch: eventUpdatePatch,
    expectedStatus: v.optional(eventStatus),
    expectedUpdatedAt: v.optional(v.number()),
    plan: sourceOccurrencePlan,
    satisfiedKey: v.string(),
    supersededKey: v.optional(v.string()),
    processingFence: sourceProcessingFence,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    await assertSourceProcessingFence(ctx, args.processingFence);
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
    const updateResult = await applyEventUpdate(ctx, args, authorization);
    await recordSourceOccurrenceSatisfaction(
      ctx,
      args.plan,
      args.satisfiedKey,
      args.id,
      args.supersededKey,
    );
    return { updated: true, recorded: true, updatedAt: updateResult.updatedAt };
  },
});

export const reprocessPendingSourceGroundingBatch = mutation({
  args: {
    serviceSecret: v.string(),
    items: v.array(sourceGroundingReprocessItem),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (kind !== "service") {
      throw new Error("Service authentication required.");
    }
    if (args.items.length === 0) {
      throw new Error("Source-grounding reprocessing requires at least one event.");
    }
    if (args.items.length > MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE) {
      throw new Error(
        `Source-grounding reprocessing is limited to ${MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE} events.`,
      );
    }

    const eventIds = new Set<string>();
    const prepared: Array<{
      event: Doc<"events">;
      item: (typeof args.items)[number];
    }> = [];
    for (const item of args.items) {
      if (eventIds.has(item.id)) {
        throw new Error(`Duplicate source-grounding reprocess event ID: ${item.id}.`);
      }
      eventIds.add(item.id);
      if (!Number.isSafeInteger(item.expectedUpdatedAt)) {
        throw new Error(`Invalid expectedUpdatedAt for event ${item.id}.`);
      }
      if (item.nextNormalizedFieldsJson === item.expectedNormalizedFieldsJson) {
        throw new Error(`Source-grounding attestation did not change for event ${item.id}.`);
      }

      const event = await ctx.db.get(item.id);
      if (!event) {
        throw new Error(`Event not found: ${item.id}.`);
      }
      assertExpectedEventStatus(event.status, "pending");
      if (event.updatedAt !== item.expectedUpdatedAt) {
        throw new Error(`Event changed during reprocessing: ${item.id}.`);
      }
      if (event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson) {
        throw new Error(`Normalized fields changed during reprocessing: ${item.id}.`);
      }
      assertSourceGroundingReprocessReasons(event);
      prepared.push({ event, item });
    }

    for (const { event, item } of prepared) {
      if (!event.venueInstagramHandle) {
        throw new Error(`Resolved source venue handle required for event ${event._id}.`);
      }
      const policyPatch = {
        status: "approved" as const,
        normalizedFieldsJson: item.nextNormalizedFieldsJson,
      };
      assertServiceUpdateEventPolicy(event.status, policyPatch, event);
      await assertPersistedServiceSourcePolicy(ctx, event);
      await assertApprovalCandidatePolicy(
        ctx,
        { ...event, normalizedFieldsJson: item.nextNormalizedFieldsJson },
        [event._id],
      );
      await ctx.db.patch(event._id, {
        status: "approved",
        normalizedFieldsJson: item.nextNormalizedFieldsJson,
        updatedAt: nextEventUpdatedAt(event.updatedAt),
      });
      await writeEventAuditLog(ctx, event._id, "source_grounding_reprocessed", {
        actor,
        patch: policyPatch,
      });
    }

    return {
      updatedCount: prepared.length,
      eventIds: prepared.map(({ event }) => event._id),
    };
  },
});

type EventEvidencePolicyReprocessItem = Infer<typeof eventEvidencePolicyReprocessItem>;

function assertEventEvidencePolicyReprocessPatch(
  item: EventEvidencePolicyReprocessItem,
  nextStatus: "approved" | "pending",
): void {
  if (
    !Number.isSafeInteger(item.expectedUpdatedAt) ||
    item.patch.status !== nextStatus ||
    typeof item.patch.normalizedFieldsJson !== "string" ||
    item.patch.normalizedFieldsJson.length === 0
  ) {
    throw new Error("Event-evidence policy replay requires an exact status and normalized payload.");
  }
}

export function assertEventEvidencePolicyTitleTransitionForTesting(
  event: Doc<"events">,
  item: EventEvidencePolicyReprocessItem,
): void {
  const currentFields = parseEventEvidencePolicyNormalizedFields(
    event.normalizedFieldsJson ?? "",
  );
  const nextFields = parseEventEvidencePolicyNormalizedFields(
    item.patch.normalizedFieldsJson,
  );
  const currentUsesFallback =
    currentFields.titleUsedFallback === true &&
    currentFields.titleSource === "unnamed_schedule_fallback";
  const nextUsesFallback =
    nextFields.titleUsedFallback === true &&
    nextFields.titleSource === "unnamed_schedule_fallback";
  const nextTitle = item.patch.title ?? event.title;
  if (!currentUsesFallback && !nextUsesFallback) {
    if (nextTitle === event.title) return;
    throw new Error(
      `Event-evidence policy replay can change only deterministic unnamed fallback titles: ${item.id}.`,
    );
  }
  const currentVersion = currentFields.fallbackIdentityPolicyVersion;
  const nextVersion = nextFields.fallbackIdentityPolicyVersion;
  const currentVersionValid = currentVersion === undefined || currentVersion === 1;
  const nextVersionValid = nextVersion === undefined || nextVersion === 1;
  const migratesLegacyVersion =
    (currentVersion === undefined && nextVersion === 1) ||
    (currentVersion === 1 && nextVersion === undefined);
  const versionsSupported =
    (currentVersion === 1 && nextVersion === 1) || migratesLegacyVersion;
  const currentTitleValid = currentVersion === 1
    ? fallbackTitleMatchesVenueCandidates(event.title, event, [event.venue])
    : fallbackTitleMatchesVenueCandidates(
        event.title,
        event,
        legacyFallbackVenueCandidates(event, currentFields, nextFields),
      );
  const nextPublicVenue = item.patch.venue ?? event.venue;
  const nextTitleValid = nextVersion === 1
    ? fallbackTitleMatchesVenueCandidates(nextTitle, event, [nextPublicVenue])
    : fallbackTitleMatchesVenueCandidates(
        nextTitle,
        event,
        legacyFallbackVenueCandidates(event, nextFields, currentFields),
      );
  if (
    !currentUsesFallback ||
    !nextUsesFallback ||
    !currentVersionValid ||
    !nextVersionValid ||
    !versionsSupported ||
    !currentTitleValid ||
    !nextTitleValid
  ) {
    throw new Error(
      `Event-evidence policy replay can change only deterministic unnamed fallback titles: ${item.id}.`,
    );
  }
}

function compactFallbackIdentity(value: unknown): string {
  return toSearchableText(typeof value === "string" ? value : "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function verifiedFallbackSourceAccountName(
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string {
  const handle = normalizeHandle(
    typeof fields.sourceGroundingInstagramHandle === "string"
      ? fields.sourceGroundingInstagramHandle
      : "",
  );
  const pairedHandle = normalizeHandle(
    typeof pairedFields.sourceGroundingInstagramHandle === "string"
      ? pairedFields.sourceGroundingInstagramHandle
      : "",
  );
  const candidates = [fields.sourceAccountName, pairedFields.sourceAccountName];
  if (!handle || !pairedHandle || handle !== pairedHandle) return "";
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      compactFallbackIdentity(candidate) === compactFallbackIdentity(handle),
  ) ?? "";
}

function boundRawFallbackVenues(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string[] {
  let rawExtraction: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    rawExtraction = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    rawExtraction = null;
  }
  const scheduleEntries = Array.isArray(rawExtraction?.schedule_entries)
    ? rawExtraction.schedule_entries.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const rowSourceText = normalizedString(fields.rowSourceText);
  const pairedRowSourceText = normalizedString(pairedFields.rowSourceText);
  const sharedRowSourceText =
    rowSourceText && rowSourceText === pairedRowSourceText ? rowSourceText : "";
  const matchingEntries = sharedRowSourceText
    ? scheduleEntries.filter(
        (entry) => normalizedString(entry.source_text) === sharedRowSourceText,
      )
    : [];
  const boundEntries = matchingEntries.length > 0
    ? matchingEntries
    : scheduleEntries.length === 1
      ? scheduleEntries
      : [];
  return boundEntries
    .map((entry) => normalizedString(entry.venue))
    .filter(Boolean);
}

function legacyFallbackVenueCandidates(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string[] {
  return [
    "",
    event.venue,
    ...boundRawFallbackVenues(event, fields, pairedFields),
    verifiedFallbackSourceAccountName(fields, pairedFields),
  ].filter((value, index, values) =>
    values.findIndex(
      (candidate) => normalizedString(candidate) === normalizedString(value),
    ) === index,
  );
}

function fallbackTitleMatchesVenueCandidates(
  title: string,
  event: Pick<Doc<"events">, "date" | "eventType">,
  venues: string[],
): boolean {
  return venues.some(
    (venue) =>
      normalizedString(title) === normalizedString(buildUnnamedScheduleFallbackTitle({
        eventType: event.eventType,
        venue,
        isoDate: event.date,
      })),
  );
}

function parseEventEvidencePolicyNormalizedFields(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error("Event-evidence policy replay normalized payload is invalid.");
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function stringArraysEqual(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === "string" && value === right[index])
  );
}

const EVENT_EVIDENCE_REPLAY_MONTHS = new Map<string, number>([
  ["januar", 1], ["januara", 1], ["january", 1],
  ["februar", 2], ["februara", 2], ["february", 2],
  ["mart", 3], ["marta", 3], ["march", 3],
  ["april", 4], ["aprila", 4],
  ["maj", 5], ["maja", 5], ["may", 5],
  ["jun", 6], ["juna", 6], ["june", 6],
  ["jul", 7], ["jula", 7], ["july", 7],
  ["avgust", 8], ["avgusta", 8], ["august", 8],
  ["septembar", 9], ["septembra", 9], ["september", 9],
  ["oktobar", 10], ["oktobra", 10], ["october", 10],
  ["novembar", 11], ["novembra", 11], ["november", 11],
  ["decembar", 12], ["decembra", 12], ["december", 12],
]);

function collectEventEvidenceReplayRangeDates(
  evidenceText: string,
  referenceDate: string,
): Set<string> | null {
  const match = evidenceText.toLocaleLowerCase("sr-Latn").match(
    /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*([\p{L}]+)(?:\s*,?\s*(\d{2,4}))?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})\.?\s*([\p{L}]+)(?:\s*,?\s*(\d{2,4}))?/iu,
  );
  const referenceYear = Number.parseInt(referenceDate.slice(0, 4), 10);
  const startMonth = EVENT_EVIDENCE_REPLAY_MONTHS.get(match?.[2] ?? "");
  const endMonth = EVENT_EVIDENCE_REPLAY_MONTHS.get(match?.[5] ?? "");
  if (!match || !startMonth || !endMonth || !Number.isSafeInteger(referenceYear)) return null;
  const parseYear = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return value.length === 2 ? 2000 + parsed : parsed;
  };
  let startYear = parseYear(match[3]) ?? parseYear(match[6]) ?? referenceYear;
  const endYear = parseYear(match[6]) ?? parseYear(match[3]) ?? referenceYear;
  if (!match[3] && startMonth > endMonth) startYear = endYear - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, Number.parseInt(match[1], 10)));
  const end = new Date(Date.UTC(endYear, endMonth - 1, Number.parseInt(match[4], 10)));
  if (
    start.getUTCFullYear() !== startYear ||
    start.getUTCMonth() !== startMonth - 1 ||
    start.getUTCDate() !== Number.parseInt(match[1], 10) ||
    end.getUTCFullYear() !== endYear ||
    end.getUTCMonth() !== endMonth - 1 ||
    end.getUTCDate() !== Number.parseInt(match[4], 10) ||
    end.getTime() < start.getTime()
  ) {
    return null;
  }
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount < 2 || dayCount > 31) return null;
  return new Set(
    Array.from({ length: dayCount }, (_, index) =>
      new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    ),
  );
}

export function assertEventEvidencePolicyDateEvidenceTransitionForTesting(
  event: Doc<"events">,
  item: EventEvidencePolicyReprocessItem,
): void {
  const unchanged =
    item.patch.dateEvidenceText === event.dateEvidenceText &&
    item.patch.dateEvidenceSource === event.dateEvidenceSource &&
    item.patch.dateEvidenceIsRelative === event.dateEvidenceIsRelative &&
    item.patch.dateEvidenceResolvedDate === event.dateEvidenceResolvedDate;
  if (unchanged) return;
  if (
    item.patch.dateEvidenceText !== event.dateEvidenceText ||
    item.patch.dateEvidenceSource !== event.dateEvidenceSource ||
    item.patch.dateEvidenceIsRelative !== event.dateEvidenceIsRelative ||
    typeof event.dateEvidenceText !== "string" ||
    typeof event.dateEvidenceResolvedDate !== "string" ||
    typeof item.patch.dateEvidenceResolvedDate !== "string"
  ) {
    throw new Error(`Event-evidence policy replay cannot change date evidence: ${item.id}.`);
  }
  const rangeDates = collectEventEvidenceReplayRangeDates(
    event.dateEvidenceText,
    event.date,
  );
  let rawExtraction: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    rawExtraction = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    rawExtraction = null;
  }
  const rawDateEvidence = rawExtraction?.date_evidence;
  const rawScheduleEntries = rawExtraction?.schedule_entries;
  const rawEvidenceCandidates = [
    rawDateEvidence,
    ...(Array.isArray(rawScheduleEntries)
      ? rawScheduleEntries.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).date_evidence
            : null,
        )
      : []),
  ].filter((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  const rawEvidenceMatches = rawEvidenceCandidates.some(
    (evidence) =>
      normalizedString(evidence.exact_text) === normalizedString(event.dateEvidenceText) &&
      evidence.source === event.dateEvidenceSource &&
      typeof evidence.resolved_date === "string" &&
      rangeDates?.has(evidence.resolved_date),
  );
  if (
    !rangeDates ||
    !rawEvidenceMatches ||
    !rangeDates.has(event.date) ||
    !rangeDates.has(event.dateEvidenceResolvedDate) ||
    !rangeDates.has(item.patch.dateEvidenceResolvedDate) ||
    ![event.dateEvidenceResolvedDate, item.patch.dateEvidenceResolvedDate].includes(event.date)
  ) {
    throw new Error(`Event-evidence policy replay date-range correction failed: ${item.id}.`);
  }
}

const assertEventEvidencePolicyDateEvidenceTransition =
  assertEventEvidencePolicyDateEvidenceTransitionForTesting;

function assertEventEvidencePolicyNormalizedBinding(options: {
  normalizedFieldsJson: string;
  occurrenceKey: string;
  sourceFingerprint: string;
  publicFields: {
    artists: string[];
    date: string;
    dateEvidenceIsRelative?: boolean;
    dateEvidenceResolvedDate?: string;
    dateEvidenceSource?: string;
    dateEvidenceText?: string;
    sourceConflictFields?: string[];
    time?: string;
    title: string;
    venue: string;
  };
}): void {
  const fields = parseEventEvidencePolicyNormalizedFields(options.normalizedFieldsJson);
  const event = options.publicFields;
  if (
    fields.sourceOccurrenceKey !== options.occurrenceKey ||
    fields.sourceOccurrenceSourceFingerprint !== options.sourceFingerprint ||
    normalizedString(fields.title) !== normalizedString(event.title) ||
    normalizedString(fields.normalizedDate) !== normalizedString(event.date) ||
    normalizedString(fields.time) !== normalizedString(event.time) ||
    normalizedString(fields.normalizedVenue) !== normalizedString(event.venue) ||
    !stringArraysEqual(fields.artists, event.artists) ||
    !stringArraysEqual(fields.sourceConflictFields, event.sourceConflictFields ?? []) ||
    normalizedString(fields.dateEvidenceText) !== normalizedString(event.dateEvidenceText) ||
    fields.dateEvidenceSource !== event.dateEvidenceSource ||
    fields.dateEvidenceIsRelative !== event.dateEvidenceIsRelative ||
    normalizedString(fields.dateEvidenceResolvedDate) !==
      normalizedString(event.dateEvidenceResolvedDate)
  ) {
    throw new Error("Event-evidence policy replay normalized/public binding failed.");
  }
}

async function applyEventEvidencePolicyTransition(
  ctx: MutationCtx,
  args: {
    sourceIdentity: string;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceFingerprint: string;
    items: EventEvidencePolicyReprocessItem[];
  },
  authorization: { actor: string; kind: "service" },
  transition: "apply" | "rollback",
): Promise<{
  updatedCount: number;
  eventIds: Id<"events">[];
  eventUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }>;
  receiptUpdatedAt: number;
}> {
  const currentStatus = transition === "apply" ? "pending" : "approved";
  const nextStatus = transition === "apply" ? "approved" : "pending";
  if (
    !args.sourceIdentity ||
    !args.expectedSourceFingerprint ||
    !Number.isSafeInteger(args.expectedReceiptUpdatedAt) ||
    args.items.length === 0 ||
    args.items.length > MAX_EVENT_EVIDENCE_POLICY_REPROCESS_BATCH_SIZE
  ) {
    throw new Error("Event-evidence policy replay batch is invalid.");
  }

  const uniqueEventIds = new Set(args.items.map((item) => item.id));
  if (uniqueEventIds.size !== args.items.length) {
    throw new Error("Event-evidence policy replay requires unique event IDs.");
  }
  for (const item of args.items) {
    assertEventEvidencePolicyReprocessPatch(item, nextStatus);
  }

  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", args.sourceIdentity))
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (
    !receipt ||
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceFingerprint !== args.expectedSourceFingerprint ||
    !Array.isArray(receipt.expectedOccurrences)
  ) {
    throw new Error("Event-evidence policy replay receipt precondition failed.");
  }
  const expectedReceiptKeys = receipt.expectedOccurrences.map((occurrence) => occurrence.key);
  const satisfiedReceiptKeys = receipt.satisfiedOccurrences.map((occurrence) => occurrence.key);
  if (
    new Set(expectedReceiptKeys).size !== expectedReceiptKeys.length ||
    new Set(satisfiedReceiptKeys).size !== satisfiedReceiptKeys.length ||
    expectedReceiptKeys.length !== satisfiedReceiptKeys.length ||
    expectedReceiptKeys.some((key) => !satisfiedReceiptKeys.includes(key))
  ) {
    throw new Error("Event-evidence policy replay requires a complete unique occurrence receipt.");
  }

  const prepared: Array<{
    event: Doc<"events">;
    item: EventEvidencePolicyReprocessItem;
    sourceOccurrenceKey: string;
  }> = [];
  const replayKeys = new Set<string>();
  for (const item of args.items) {
    const event = await ctx.db.get(item.id);
    if (
      !event ||
      event.status !== currentStatus ||
      event.updatedAt !== item.expectedUpdatedAt ||
      event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson
    ) {
      throw new Error(`Event-evidence policy replay event precondition failed: ${item.id}.`);
    }
    if (transition === "rollback") {
      const [legacySaved, userSaved] = await Promise.all([
        ctx.db
          .query("savedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(1),
        ctx.db
          .query("userSavedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(1),
      ]);
      if (legacySaved.length > 0 || userSaved.length > 0) {
        throw new Error(`Event-evidence policy rollback refused for a saved event: ${item.id}.`);
      }
    }
    const sourceLinks = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .take(2);
    const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
    const expectedOccurrence = receipt.expectedOccurrences.find(
      (occurrence) => occurrence.key === sourceLink?.sourceOccurrenceKey,
    );
    const satisfiedOccurrence = receipt.satisfiedOccurrences.find(
      (occurrence) => occurrence.key === sourceLink?.sourceOccurrenceKey,
    );
    if (
      !sourceLink ||
      sourceLink.sourceIdentity !== receipt.sourceIdentity ||
      sourceLink.sourceFingerprint !== receipt.sourceFingerprint ||
      sourceLink.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
      !expectedOccurrence ||
      satisfiedOccurrence?.eventId !== event._id ||
      replayKeys.has(sourceLink.sourceOccurrenceKey) ||
      !eventRepresentsExpectedOccurrence(event, expectedOccurrence, {
        allowUnverifiedPending: true,
      })
    ) {
      throw new Error(`Event-evidence policy replay occurrence precondition failed: ${item.id}.`);
    }
    assertEventEvidencePolicyDateEvidenceTransition(event, item);
    assertEventEvidencePolicyTitleTransitionForTesting(event, item);
    assertEventEvidencePolicyNormalizedBinding({
      normalizedFieldsJson: event.normalizedFieldsJson ?? "",
      occurrenceKey: sourceLink.sourceOccurrenceKey,
      sourceFingerprint: receipt.sourceFingerprint,
      publicFields: event,
    });
    assertEventEvidencePolicyNormalizedBinding({
      normalizedFieldsJson: item.patch.normalizedFieldsJson,
      occurrenceKey: sourceLink.sourceOccurrenceKey,
      sourceFingerprint: receipt.sourceFingerprint,
      publicFields: {
        ...event,
        artists: item.patch.artists ?? event.artists,
        dateEvidenceIsRelative: item.patch.dateEvidenceIsRelative,
        dateEvidenceResolvedDate: item.patch.dateEvidenceResolvedDate,
        dateEvidenceSource: item.patch.dateEvidenceSource,
        dateEvidenceText: item.patch.dateEvidenceText,
        sourceConflictFields: item.patch.sourceConflictFields,
        title: item.patch.title ?? event.title,
        venue: item.patch.venue ?? event.venue,
      },
    });
    replayKeys.add(sourceLink.sourceOccurrenceKey);
    prepared.push({ event, item, sourceOccurrenceKey: sourceLink.sourceOccurrenceKey });
  }

  const eventUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }> = [];
  for (const { event, item } of prepared) {
    const result = await applyEventUpdate(
      ctx,
      {
        id: event._id,
        patch: item.patch,
        expectedStatus: currentStatus,
        expectedUpdatedAt: item.expectedUpdatedAt,
      },
      authorization,
    );
    eventUpdatedAts.push({ id: event._id, updatedAt: result.updatedAt });
  }

  const nextExpectedOccurrences = [...receipt.expectedOccurrences];
  for (const { event, sourceOccurrenceKey } of prepared) {
    const updatedEvent = await ctx.db.get(event._id);
    const expectedIndex = nextExpectedOccurrences.findIndex(
      (occurrence) => occurrence.key === sourceOccurrenceKey,
    );
    if (!updatedEvent || expectedIndex < 0) {
      throw new Error("Event-evidence policy replay lost an occurrence representative.");
    }
    const nextExpectedOccurrence = {
      key: sourceOccurrenceKey,
      date: updatedEvent.date,
      ...(updatedEvent.time ? { time: updatedEvent.time } : {}),
      venue: updatedEvent.venue,
      title: updatedEvent.title,
      artists: updatedEvent.artists,
    };
    if (!eventRepresentsExpectedOccurrence(updatedEvent, nextExpectedOccurrence)) {
      throw new Error("Event-evidence policy replay produced an invalid occurrence binding.");
    }
    nextExpectedOccurrences[expectedIndex] = nextExpectedOccurrence;
  }

  for (const satisfied of receipt.satisfiedOccurrences) {
    const representative = await ctx.db.get(satisfied.eventId);
    const expected = nextExpectedOccurrences.find(
      (occurrence) => occurrence.key === satisfied.key,
    );
    if (!eventRepresentsExpectedOccurrence(representative, expected)) {
      throw new Error("Event-evidence policy replay would invalidate a receipt sibling.");
    }
  }

  const receiptUpdatedAt = Math.max(Date.now(), receipt.updatedAt + 1);
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  return {
    updatedCount: prepared.length,
    eventIds: prepared.map(({ event }) => event._id),
    eventUpdatedAts,
    receiptUpdatedAt,
  };
}

const eventEvidencePolicyTransitionArgs = {
  sourceIdentity: v.string(),
  expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
  expectedReceiptUpdatedAt: v.number(),
  expectedSourceFingerprint: v.string(),
  items: v.array(eventEvidencePolicyReprocessItem),
  serviceSecret: v.string(),
};

const eventEvidencePolicyTransitionResult = v.object({
  updatedCount: v.number(),
  eventIds: v.array(v.id("events")),
  eventUpdatedAts: v.array(v.object({ id: v.id("events"), updatedAt: v.number() })),
  receiptUpdatedAt: v.number(),
});

export const reprocessPendingEventEvidencePolicyBatch = mutation({
  args: eventEvidencePolicyTransitionArgs,
  returns: eventEvidencePolicyTransitionResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Event-evidence policy replay requires service authentication.");
    }
    return applyEventEvidencePolicyTransition(
      ctx,
      args,
      { actor: authorization.actor, kind: "service" },
      "apply",
    );
  },
});

export const rollbackEventEvidencePolicyBatch = mutation({
  args: eventEvidencePolicyTransitionArgs,
  returns: eventEvidencePolicyTransitionResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Event-evidence policy rollback requires service authentication.");
    }
    return applyEventEvidencePolicyTransition(
      ctx,
      args,
      { actor: authorization.actor, kind: "service" },
      "rollback",
    );
  },
});

export const approveUniquePendingEvents = mutation({
  args: {
    items: v.array(pendingModerationUniquenessReviewItem),
    moderationNote: v.string(),
  },
  returns: approveUniquePendingEventsResult,
  handler: async (ctx, args) => {
    const identity = await requireAdminIdentity(ctx);
    const moderationNote = args.moderationNote.trim();
    if (moderationNote.length < 20 || moderationNote.length > 1_000) {
      throw new Error(
        "Unique pending approval requires a moderation note of 20-1000 characters.",
      );
    }

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
      await ctx.db.patch(item.id, {
        ...approval.prepared.venuePatch,
        ...approval.humanReviewPatch,
        status: "approved",
        reviewedAt: now,
        reviewedBy: identity.subject,
        moderationNote,
        updatedAt: nextEventUpdatedAt(event.updatedAt, now),
      });
      await writeEventAuditLog(ctx, item.id, "approved", {
        actor: identity.subject,
        note: moderationNote,
        patch: { status: "approved", policy: "unique_pending" },
      });
      approvedIds.push(item.id);
    }

    return {
      complete: true,
      approvedIds,
      skipped,
    };
  },
});

export const setEventStatus = mutation({
  args: {
    id: v.id("events"),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    expectedUpdatedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireAdminIdentity(ctx);
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }

    if (existingEvent.status !== "pending") {
      throw new Error("Only pending events can be moderated.");
    }
    assertExpectedEventUpdatedAt(existingEvent.updatedAt, args.expectedUpdatedAt);

    if (args.status === "approved") {
      const prepared = await prepareHumanApprovalCandidate(ctx, existingEvent);
      const humanReviewPatch = await assertHumanApprovalWithCanonicalVenueFallback(
        ctx,
        existingEvent,
        prepared,
        args.moderationNote,
      );
      await assertApprovalCandidatePolicy(ctx, prepared.candidate, [args.id]);
      await ctx.db.patch(args.id, { ...prepared.venuePatch, ...humanReviewPatch });
    }

    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      reviewedAt: now,
      reviewedBy: args.reviewedBy?.trim() || identity.subject,
      moderationNote: args.moderationNote,
      updatedAt: nextEventUpdatedAt(existingEvent.updatedAt, now),
    });
    await writeEventAuditLog(ctx, args.id, args.status, {
      actor: identity.subject,
      note: args.moderationNote,
      patch: { status: args.status },
    });
    return null;
  },
});

export const setEventStatuses = mutation({
  args: {
    ids: v.array(v.id("events")),
    expectedVersions: v.optional(v.array(v.object({
      id: v.id("events"),
      expectedUpdatedAt: v.number(),
    }))),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    approveAsDistinctSameVenueDateBatch: v.optional(v.boolean()),
  },
  returns: v.object({
    updatedCount: v.number(),
    skippedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await requireAdminIdentity(ctx);
    const now = Date.now();
    const uniqueIds = [...new Set(args.ids)];
    const preloadedEvents = new Map<Id<"events">, Doc<"events">>();
    if (args.expectedVersions !== undefined) {
      const expectedVersionById = new Map(
        args.expectedVersions.map((item) => [item.id, item.expectedUpdatedAt] as const),
      );
      if (
        expectedVersionById.size !== args.expectedVersions.length ||
        expectedVersionById.size !== uniqueIds.length ||
        uniqueIds.some((id) => !expectedVersionById.has(id))
      ) {
        throw new Error("Expected versions must exactly match the moderated event IDs.");
      }
      for (const id of uniqueIds) {
        const event = await ctx.db.get(id);
        if (!event || event.status !== "pending") {
          throw new Error(`Event changed since the reviewed version: ${id} is missing or no longer pending.`);
        }
        assertExpectedEventUpdatedAt(event.updatedAt, expectedVersionById.get(id));
        preloadedEvents.set(id, event);
      }
    }
    if (args.approveAsDistinctSameVenueDateBatch && (args.status !== "approved" || uniqueIds.length < 2)) {
      throw new Error(
        "Distinct same-venue/date batch approval requires at least two approved event IDs.",
      );
    }
    const preparedApprovalCandidates = new Map<
      Id<"events">,
      Awaited<ReturnType<typeof prepareHumanApprovalCandidate>> & {
        humanReviewPatch: {
          normalizedFieldsJson?: string;
          humanReviewedLegacySourcePolicyVersion?:
            typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
          humanReviewedStructuredSourcePolicyVersion?:
            typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
        };
      }
    >();
    if (args.status === "approved") {
      for (const id of uniqueIds) {
        const event = preloadedEvents.get(id) ?? await ctx.db.get(id);
        if (!event || event.status !== "pending") {
          if (args.approveAsDistinctSameVenueDateBatch) {
            throw new Error("Every distinct-batch event must still be pending.");
          }
          continue;
        }
        const prepared = await prepareHumanApprovalCandidate(ctx, event);
        const humanReviewPatch = await assertHumanApprovalWithCanonicalVenueFallback(
          ctx,
          event,
          prepared,
          args.moderationNote,
        );
        preparedApprovalCandidates.set(id, { ...prepared, humanReviewPatch });
      }
      if (args.approveAsDistinctSameVenueDateBatch) {
        assertPairwiseOccurrenceRelation(
          uniqueIds.map((id) => {
            const prepared = preparedApprovalCandidates.get(id);
            if (!prepared) throw new Error("Distinct-batch approval candidate is missing.");
            return prepared.candidate;
          }),
          "proven_distinct",
          "Distinct same-venue/date batch approval requires every pair to be proven distinct.",
        );
      }
    }
    let updatedCount = 0;
    let skippedCount = 0;

    for (const id of uniqueIds) {
      const existingEvent = preloadedEvents.get(id) ?? await ctx.db.get(id);
      if (!existingEvent || existingEvent.status !== "pending") {
        skippedCount += 1;
        continue;
      }

      if (args.status === "approved") {
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
          await ctx.db.patch(id, {
            ...prepared.venuePatch,
            ...prepared.humanReviewPatch,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/^(?:Event title is not suitable for approval|An approved event already exists for this canonical occurrence|This same-day occurrence is ambiguous against an approved event and cannot be auto-approved)\.$/.test(
              error.message,
            )
          ) {
            throw error;
          }
          skippedCount += 1;
          continue;
        }
      }

      await ctx.db.patch(id, {
        status: args.status,
        reviewedAt: now,
        reviewedBy: args.reviewedBy?.trim() || identity.subject,
        moderationNote: args.moderationNote,
        updatedAt: nextEventUpdatedAt(existingEvent.updatedAt, now),
      });
      await writeEventAuditLog(ctx, id, args.status, {
        actor: identity.subject,
        note: args.moderationNote,
        patch: { status: args.status },
      });
      updatedCount += 1;
    }

    return {
      updatedCount,
      skippedCount,
    };
  },
});

function parseNightlifeLineupJsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(`${label} must be a JSON object.`);
}

function readNightlifeLineupSource(value: unknown): NightlifeLineupSource | null {
  return value === "caption" ||
    value === "poster" ||
    value === "alt_text" ||
    value === "unknown"
    ? value
    : null;
}

function exactStringSetEquals(left: string[], right: string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

type CrossPostReceiptExpectedOccurrence = {
  key: string;
  date: string;
  time?: string;
  venue: string;
  title: string;
  artists: string[];
};

function exactCrossPostReceiptSemanticsEqual(
  left: CrossPostReceiptExpectedOccurrence | undefined,
  right: CrossPostReceiptExpectedOccurrence | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.date === right.date &&
      left.time === right.time &&
      left.venue === right.venue &&
      left.title === right.title &&
      left.artists.length === right.artists.length &&
      left.artists.every((artist, index) => artist === right.artists[index]),
  );
}

function crossPostReceiptHasExactSingleBinding(
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  sourceLink: Doc<"instagramEventSources">,
): boolean {
  return (
    receipt.sourceIdentity === sourceLink.sourceIdentity &&
    receipt.sourceFingerprint === sourceLink.sourceFingerprint &&
    receipt.expectedKeys.length === 1 &&
    receipt.expectedKeys[0] === sourceLink.sourceOccurrenceKey &&
    receipt.expectedOccurrences?.length === 1 &&
    receipt.expectedOccurrences[0]?.key === sourceLink.sourceOccurrenceKey &&
    receipt.satisfiedKeys.length === 1 &&
    receipt.satisfiedKeys[0] === sourceLink.sourceOccurrenceKey &&
    receipt.satisfiedOccurrences.length === 1 &&
    receipt.satisfiedOccurrences[0]?.key === sourceLink.sourceOccurrenceKey &&
    receipt.deferredChildCount === 0 &&
    receipt.deferredChildKeys.length === 0
  );
}

function assertCrossPostPromotionAuditPayload(payload: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(payload)).byteLength >
    MAX_CROSS_POST_PROMOTION_AUDIT_JSON_BYTES
  ) {
    throw new Error("Cross-post promotion rollback payload exceeds the safe audit bound.");
  }
}

function buildCrossPostPromotionModerationMarker(
  role: "primary" | "variant",
  operationId: string,
): string {
  return (
    `[cross_post_campaign_${role}:v${CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION}] ` +
    `${operationId} - `
  );
}

/**
 * Returns the exact bounded rows needed to construct a coalescing mutation.
 * Operators can call it again after an uncertain response: the same operation
 * then reports already_coalesced instead of encouraging a second mutation.
 */
export const getCrossPostPromotionCoalescingContext = query({
  args: {
    operationId: v.string(),
    eventIds: v.array(v.id("events")),
    targetVenueId: v.id("venues"),
    serviceSecret: v.string(),
  },
  returns: crossPostPromotionCoalescingContextResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Cross-post promotion context requires service authentication.");
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(args.operationId) ||
      args.eventIds.length < 2 ||
      args.eventIds.length > 8 ||
      new Set(args.eventIds.map(String)).size !== args.eventIds.length
    ) {
      throw new Error("Cross-post promotion context arguments are invalid.");
    }
    const targetVenue = await ctx.db.get(args.targetVenueId);
    if (!targetVenue) {
      throw new Error("Cross-post promotion context target venue is missing.");
    }
    const candidates: Array<{
      event: Doc<"events">;
      sourceLink: Doc<"instagramEventSources">;
      receipt: Doc<"instagramSourceOccurrenceReceipts">;
    }> = [];
    for (const eventId of args.eventIds) {
      const event = await ctx.db.get(eventId);
      if (!event) {
        throw new Error(`Cross-post promotion context event is missing: ${eventId}.`);
      }
      const sourceLinks = await ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .take(2);
      const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
      const receipts = sourceLink
        ? await ctx.db
            .query("instagramSourceOccurrenceReceipts")
            .withIndex("by_sourceIdentity", (q) =>
              q.eq("sourceIdentity", sourceLink.sourceIdentity),
            )
            .take(2)
        : [];
      const receipt = receipts.length === 1 ? receipts[0] : null;
      if (
        !sourceLink ||
        !receipt ||
        sourceLink.eventId !== event._id ||
        sourceLink.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        sourceLink.instagramPostId !== event.instagramPostId ||
        normalizeInstagramPostUrl(sourceLink.instagramPostUrl ?? "") !==
          normalizeInstagramPostUrl(event.instagramPostUrl ?? "") ||
        receipt.sourceIdentity !== sourceLink.sourceIdentity ||
        receipt.sourceFingerprint !== sourceLink.sourceFingerprint
      ) {
        throw new Error(
          `Cross-post promotion context requires one exact link and receipt: ${eventId}.`,
        );
      }
      candidates.push({ event, sourceLink, receipt });
    }

    const primaryMarker = buildCrossPostPromotionModerationMarker(
      "primary",
      args.operationId,
    );
    const variantMarker = buildCrossPostPromotionModerationMarker(
      "variant",
      args.operationId,
    );
    const primaryCandidate = candidates[0]!;
    const primaryExpectedOccurrence = primaryCandidate.receipt.expectedOccurrences?.[0];
    const primaryPubliclyGrounded = await isCanonicallyGroundedApprovedEvent(
      ctx,
      primaryCandidate.event,
    );
    const ready = primaryPubliclyGrounded && candidates.every(({ event, sourceLink, receipt }) => {
      const expectedOccurrence = receipt.expectedOccurrences?.[0];
      return (
        event.status === "approved" &&
        crossPostReceiptHasExactSingleBinding(receipt, sourceLink) &&
        receipt.satisfiedOccurrences[0]?.eventId === event._id &&
        sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence)
      );
    });
    const exactReceiptAfterState =
      crossPostReceiptHasExactSingleBinding(
        primaryCandidate.receipt,
        primaryCandidate.sourceLink,
      ) &&
      primaryCandidate.receipt.satisfiedOccurrences[0]?.eventId ===
        primaryCandidate.event._id &&
      sourceOccurrenceRepresentativeMatchesExpected(
        primaryCandidate.event,
        primaryExpectedOccurrence,
      ) &&
      candidates.slice(1).every(({ event, sourceLink, receipt }) => {
        const expectedOccurrence = receipt.expectedOccurrences?.[0];
        return (
          sourceLink.eventId === event._id &&
          crossPostReceiptHasExactSingleBinding(receipt, sourceLink) &&
          exactCrossPostReceiptSemanticsEqual(
            expectedOccurrence,
            primaryExpectedOccurrence,
          ) &&
          receipt.satisfiedOccurrences[0]?.eventId === primaryCandidate.event._id &&
          sourceOccurrenceRepresentativeMatchesExpected(
            primaryCandidate.event,
            expectedOccurrence,
          )
        );
      });
    const exactTargetAfterState =
      primaryCandidate.event.venueId === targetVenue._id &&
      primaryCandidate.event.venue === targetVenue.name &&
      normalizeHandle(primaryCandidate.event.venueInstagramHandle ?? "") ===
        normalizeHandle(targetVenue.instagramHandle);
    let exactPrimaryAudit = false;
    if (candidates[0]?.event.moderationNote?.startsWith(primaryMarker) === true) {
      const auditRows = await ctx.db
        .query("eventAuditLog")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventIds[0]!))
        .take(101);
      if (auditRows.length > 100) {
        throw new Error("Cross-post promotion after-state audit exceeds the safe bound.");
      }
      exactPrimaryAudit = auditRows.some((audit) => {
        if (audit.action !== "cross_post_campaign_coalesced" || !audit.patchJson) {
          return false;
        }
        try {
          const patch = JSON.parse(audit.patchJson) as Record<string, unknown>;
          const foldedVariantIds = Array.isArray(patch.foldedVariantIds)
            ? patch.foldedVariantIds
            : [];
          const variantReceiptUpdatedAts = Array.isArray(
            patch.variantReceiptUpdatedAts,
          )
            ? patch.variantReceiptUpdatedAts
            : [];
          const auditedTargetVenue =
            patch.targetVenue &&
            typeof patch.targetVenue === "object" &&
            !Array.isArray(patch.targetVenue)
              ? (patch.targetVenue as Record<string, unknown>)
              : null;
          return (
            patch.operationId === args.operationId &&
            patch.policyVersion === CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION &&
            patch.canonicalVenueName === targetVenue.name &&
            normalizeHandle(normalizedString(patch.canonicalVenueHandle)) ===
              normalizeHandle(targetVenue.instagramHandle) &&
            auditedTargetVenue?._id === targetVenue._id &&
            auditedTargetVenue.updatedAt === targetVenue.updatedAt &&
            foldedVariantIds.length === candidates.length - 1 &&
            foldedVariantIds.every(
              (eventId, index) => eventId === candidates[index + 1]?.event._id,
            ) &&
            variantReceiptUpdatedAts.length === candidates.length - 1 &&
            variantReceiptUpdatedAts.every((value, index) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                return false;
              }
              const transition = value as Record<string, unknown>;
              const candidate = candidates[index + 1];
              return (
                transition.eventId === candidate?.event._id &&
                transition.receiptId === candidate?.receipt._id &&
                transition.updatedAt === candidate?.receipt.updatedAt
              );
            })
          );
        } catch {
          return false;
        }
      });
    }
    const alreadyCoalesced =
      exactPrimaryAudit &&
      exactReceiptAfterState &&
      exactTargetAfterState &&
      primaryPubliclyGrounded &&
      candidates[0]?.event.status === "approved" &&
      candidates[0]?.event.moderationNote?.startsWith(primaryMarker) === true &&
      candidates
        .slice(1)
        .every(
          ({ event }) =>
            event.status === "rejected" &&
            event.moderationNote?.startsWith(variantMarker) === true,
        );
    if (!ready && !alreadyCoalesced) {
      throw new Error("Cross-post promotion context is neither ready nor an exact after-state.");
    }
    return {
      state: alreadyCoalesced ? ("already_coalesced" as const) : ("ready" as const),
      targetVenue,
      candidates,
    };
  },
});

/**
 * Folds separate promotional posts by one Instagram author into one approved
 * occurrence without pretending that their source occurrences are identical.
 *
 * Every post-specific source link and immutable source-evidence snapshot stays
 * attached to its original row. Campaign variants are rejected in place, while
 * their receipts are rebound semantically to the approved primary so exact
 * replay still observes a fully satisfied source. Receipt changes and original
 * evidence are rollback-audited. This is deliberately separate from the generic
 * merge and single-post lineup fold.
 */
export const coalesceApprovedCrossPostPromotionOccurrences = mutation({
  args: {
    operationId: v.string(),
    primary: crossPostPromotionCandidateVersion,
    duplicates: v.array(crossPostPromotionCandidateVersion),
    targetVenueId: v.id("venues"),
    expectedTargetVenueUpdatedAt: v.number(),
    sharedEvidenceAnchors: v.array(v.string()),
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: crossPostPromotionCoalescingResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Cross-post promotion coalescing requires service authentication.");
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(args.operationId) ||
      args.moderationNote.trim().length < 24 ||
      args.moderationNote.trim().length > 1_000 ||
      args.duplicates.length < 1 ||
      args.duplicates.length > 7 ||
      args.sharedEvidenceAnchors.length < 2 ||
      args.sharedEvidenceAnchors.length > 6 ||
      !Number.isSafeInteger(args.expectedTargetVenueUpdatedAt)
    ) {
      throw new Error("Cross-post promotion coalescing arguments are invalid.");
    }

    const versions = [args.primary, ...args.duplicates];
    const eventIds = versions.map((item) => String(item.id));
    const expectedLinkIds = versions.map((item) => String(item.expectedSourceLinkId));
    const expectedReceiptIds = versions.map((item) => String(item.expectedReceiptId));
    if (
      new Set(eventIds).size !== eventIds.length ||
      new Set(expectedLinkIds).size !== expectedLinkIds.length ||
      new Set(expectedReceiptIds).size !== expectedReceiptIds.length
    ) {
      throw new Error(
        "Cross-post promotion coalescing requires unique events, links, and receipts.",
      );
    }

    const targetVenue = await ctx.db.get(args.targetVenueId);
    if (
      !targetVenue ||
      targetVenue.updatedAt !== args.expectedTargetVenueUpdatedAt ||
      !isVenuePublic(targetVenue) ||
      !targetVenue.name.trim() ||
      !normalizeHandle(targetVenue.instagramHandle)
    ) {
      throw new Error("Cross-post promotion target venue precondition failed.");
    }

    const prepared: Array<{
      event: Doc<"events">;
      fields: Record<string, unknown>;
      link: Doc<"instagramEventSources">;
      receipt: Doc<"instagramSourceOccurrenceReceipts">;
      savedEvents: Doc<"savedEvents">[];
      userSavedEvents: Doc<"userSavedEvents">[];
    }> = [];
    for (const version of versions) {
      if (
        !Number.isSafeInteger(version.expectedUpdatedAt) ||
        !Number.isSafeInteger(version.expectedSourceLinkUpdatedAt) ||
        !Number.isSafeInteger(version.expectedReceiptUpdatedAt) ||
        !version.expectedSourceIdentity.trim() ||
        !version.expectedSourceFingerprint.trim() ||
        !version.expectedOccurrenceKey.trim()
      ) {
        throw new Error("Cross-post promotion version precondition is invalid.");
      }
      const event = await ctx.db.get(version.id);
      if (
        !event ||
        event.status !== "approved" ||
        event.updatedAt !== version.expectedUpdatedAt ||
        event.normalizedFieldsJson !== version.expectedNormalizedFieldsJson ||
        event.sourceOccurrenceKey !== version.expectedOccurrenceKey ||
        !event.instagramPostId ||
        !normalizeInstagramPostUrl(event.instagramPostUrl ?? "") ||
        !event.sourceCaption
      ) {
        throw new Error(`Cross-post promotion event precondition failed: ${version.id}.`);
      }
      const fields = parseNightlifeLineupJsonRecord(
        event.normalizedFieldsJson,
        `Cross-post promotion normalized fields ${event._id}`,
      );
      const links = await ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .take(2);
      const link = links.length === 1 ? links[0] : null;
      if (
        !link ||
        link._id !== version.expectedSourceLinkId ||
        link.updatedAt !== version.expectedSourceLinkUpdatedAt ||
        link.sourceIdentity !== version.expectedSourceIdentity ||
        link.sourceFingerprint !== version.expectedSourceFingerprint ||
        link.sourceOccurrenceKey !== version.expectedOccurrenceKey ||
        link.instagramPostId !== event.instagramPostId ||
        normalizeInstagramPostUrl(link.instagramPostUrl ?? "") !==
          normalizeInstagramPostUrl(event.instagramPostUrl ?? "") ||
        !normalizeHandle(
          normalizedString(fields.sourceGroundingInstagramHandle),
        ) ||
        (link.sourceHandle !== undefined &&
          normalizeHandle(link.sourceHandle) !==
            normalizeHandle(
              normalizedString(fields.sourceGroundingInstagramHandle),
            ))
      ) {
        throw new Error(`Cross-post promotion source-link precondition failed: ${version.id}.`);
      }

      const receipts = await ctx.db
        .query("instagramSourceOccurrenceReceipts")
        .withIndex("by_sourceIdentity", (q) =>
          q.eq("sourceIdentity", version.expectedSourceIdentity),
        )
        .take(2);
      const receipt = receipts.length === 1 ? receipts[0] : null;
      const expectedOccurrence = receipt?.expectedOccurrences?.[0];
      if (
        !receipt ||
        receipt._id !== version.expectedReceiptId ||
        receipt.updatedAt !== version.expectedReceiptUpdatedAt ||
        receipt.sourceFingerprint !== version.expectedSourceFingerprint ||
        receipt.deferredChildCount !== 0 ||
        receipt.deferredChildKeys.length !== 0 ||
        receipt.expectedKeys.length !== 1 ||
        receipt.expectedKeys[0] !== version.expectedOccurrenceKey ||
        receipt.expectedOccurrences?.length !== 1 ||
        expectedOccurrence?.key !== version.expectedOccurrenceKey ||
        receipt.satisfiedKeys.length !== 1 ||
        receipt.satisfiedKeys[0] !== version.expectedOccurrenceKey ||
        receipt.satisfiedOccurrences.length !== 1 ||
        receipt.satisfiedOccurrences[0]?.key !== version.expectedOccurrenceKey ||
        receipt.satisfiedOccurrences[0]?.eventId !== event._id ||
        !sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence)
      ) {
        throw new Error(`Cross-post promotion receipt precondition failed: ${version.id}.`);
      }

      const [savedEvents, userSavedEvents] = await Promise.all([
        ctx.db
          .query("savedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT + 1),
        ctx.db
          .query("userSavedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT + 1),
      ]);
      if (
        savedEvents.length > MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT ||
        userSavedEvents.length > MAX_CROSS_POST_PROMOTION_SAVES_PER_EVENT
      ) {
        throw new Error(`Cross-post promotion save cohort exceeds the safe bound: ${event._id}.`);
      }
      prepared.push({ event, fields, link, receipt, savedEvents, userSavedEvents });
    }

    const plan = buildCrossPostPromotionCoalescingPlan({
      candidates: prepared.map(({ event, fields, link }) => ({
        id: String(event._id),
        sourceHandle:
          link.sourceHandle ??
          normalizedString(fields.sourceGroundingInstagramHandle),
        sourceIdentity: link.sourceIdentity,
        sourceOccurrenceKey: link.sourceOccurrenceKey,
        instagramPostId: event.instagramPostId ?? "",
        instagramPostUrl: normalizeInstagramPostUrl(event.instagramPostUrl ?? ""),
        title: event.title,
        date: event.date,
        time: event.time,
        timeStatus: event.timeStatus,
        timeEvidenceKind: event.timeEvidenceKind,
        timeConfidence: event.timeConfidence,
        dateEvidenceVerified: fields.dateEvidenceVerified === true,
        timeEvidenceVerified: fields.timeEvidenceVerified === true,
        venueEvidenceText: event.sourceCaption ?? "",
        eventType: canonicalizeEventType(event.eventType),
        sourceConflictFields: event.sourceConflictFields ?? [],
        artists: event.artists,
        description: event.description,
        ticketPrice: event.ticketPrice,
        imageUrl: event.imageUrl,
        imageStorageId: event.imageStorageId ? String(event.imageStorageId) : undefined,
      })),
      canonicalVenueName: targetVenue.name,
      canonicalVenueHandle: targetVenue.instagramHandle,
      sharedAnchors: args.sharedEvidenceAnchors,
    });
    if (
      !plan ||
      plan.policyVersion !== CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION ||
      plan.primaryId !== String(args.primary.id) ||
      !exactStringSetEquals(plan.duplicateIds, args.duplicates.map((item) => String(item.id)))
    ) {
      throw new Error("Cross-post promotion occurrence proof failed.");
    }

    const primaryEvent = prepared[0]!.event;
    if (
      !sourceOccurrenceRepresentativeMatchesExpected(primaryEvent, {
        key: primaryEvent.sourceOccurrenceKey!,
        date: plan.date,
        time: plan.time,
        venue: targetVenue.name,
        title: primaryEvent.title,
        artists: plan.artists,
      })
    ) {
      throw new Error(
        "Cross-post promotion aggregate must match the primary immutable snapshot.",
      );
    }
    const targetVenueFields = {
      ...CLEARED_VENUE_DENORMALIZED_FIELDS,
      ...buildNormalizedEventVenueIdentity({
        venue: targetVenue.name,
        venueInstagramHandle: targetVenue.instagramHandle,
      }),
      venueCategory: targetVenue.category,
      venueId: targetVenue._id,
      venueInstagramHandle: targetVenue.instagramHandle,
      ...(targetVenue.latitude !== undefined
        ? { venueLatitude: targetVenue.latitude }
        : {}),
      ...(targetVenue.location ? { venueLocation: targetVenue.location } : {}),
      ...(targetVenue.longitude !== undefined
        ? { venueLongitude: targetVenue.longitude }
        : {}),
    };
    const publicPatch = {
      venue: targetVenue.name,
      ...targetVenueFields,
      artists: plan.artists,
      ...(plan.description ? { description: plan.description } : {}),
      ...(plan.ticketPrice ? { ticketPrice: plan.ticketPrice } : {}),
      moderationNote: args.moderationNote.trim(),
    };
    const prospectivePrimary = { ...primaryEvent, ...publicPatch };
    await assertApprovalCandidatePolicy(
      ctx,
      prospectivePrimary,
      versions.map((item) => item.id),
    );
    if (!(await isCanonicallyGroundedApprovedEvent(ctx, prospectivePrimary))) {
      throw new Error(
        "Cross-post promotion primary would not remain publicly source-grounded.",
      );
    }

    const primaryExpectedOccurrence = prepared[0]!.receipt.expectedOccurrences?.[0];
    if (!primaryExpectedOccurrence) {
      throw new Error("Cross-post promotion primary receipt binding is missing.");
    }
    const now = Date.now();
    const variantReceiptTransitions = prepared.slice(1).map((item) => {
      const nextExpectedOccurrence = {
        key: item.link.sourceOccurrenceKey,
        date: primaryExpectedOccurrence.date,
        ...(primaryExpectedOccurrence.time !== undefined
          ? { time: primaryExpectedOccurrence.time }
          : {}),
        venue: primaryExpectedOccurrence.venue,
        title: primaryExpectedOccurrence.title,
        artists: [...primaryExpectedOccurrence.artists],
      };
      if (
        !sourceOccurrenceRepresentativeMatchesExpected(
          prospectivePrimary,
          nextExpectedOccurrence,
        )
      ) {
        throw new Error(
          `Cross-post promotion primary cannot satisfy variant receipt: ${item.event._id}.`,
        );
      }
      const nextSatisfiedOccurrences = [
        { key: item.link.sourceOccurrenceKey, eventId: primaryEvent._id },
      ];
      const receiptUpdatedAt = nextEventUpdatedAt(item.receipt.updatedAt, now);
      return {
        eventId: item.event._id,
        receiptId: item.receipt._id,
        updatedAt: receiptUpdatedAt,
        expectedOccurrences: [nextExpectedOccurrence],
        satisfiedOccurrences: nextSatisfiedOccurrences,
        receiptAfter: {
          ...item.receipt,
          expectedOccurrences: [nextExpectedOccurrence],
          satisfiedOccurrences: nextSatisfiedOccurrences,
          updatedAt: receiptUpdatedAt,
        },
      };
    });

    const primaryRollback = {
      policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
      operationId: args.operationId,
      eventBefore: primaryEvent,
      sourceLinkBefore: prepared[0]!.link,
      receiptBefore: prepared[0]!.receipt,
      targetVenue,
    };
    assertCrossPostPromotionAuditPayload(primaryRollback);
    const duplicateRollbacks = prepared.slice(1).map((item, index) => {
      const rollback = {
        policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
        operationId: args.operationId,
        primaryId: primaryEvent._id,
        eventBefore: item.event,
        sourceLinkBefore: item.link,
        receiptBefore: item.receipt,
        receiptAfter: variantReceiptTransitions[index]!.receiptAfter,
        savedEventsBefore: item.savedEvents,
        userSavedEventsBefore: item.userSavedEvents,
      };
      assertCrossPostPromotionAuditPayload(rollback);
      return rollback;
    });

    const primaryUpdatedAt = nextEventUpdatedAt(primaryEvent.updatedAt, now);
    const primaryModerationNote =
      buildCrossPostPromotionModerationMarker("primary", args.operationId) +
      args.moderationNote.trim();
    await ctx.db.patch(primaryEvent._id, {
      ...publicPatch,
      reviewedAt: now,
      reviewedBy: authorization.actor,
      moderationNote: primaryModerationNote,
      updatedAt: primaryUpdatedAt,
    });

    let movedSaveCount = 0;
    let dedupedSaveCount = 0;
    const variantRows = prepared.slice(1);
    const variantUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }> = [];
    const variantReceiptUpdatedAts = variantReceiptTransitions.map(
      ({ eventId, receiptId, updatedAt }) => ({ eventId, receiptId, updatedAt }),
    );
    const variantModerationNote =
      buildCrossPostPromotionModerationMarker("variant", args.operationId) +
      args.moderationNote.trim();
    for (let index = 0; index < variantRows.length; index += 1) {
      const item = variantRows[index]!;
      const receiptTransition = variantReceiptTransitions[index]!;
      const saveResult = await reassignSavedEventReferences(
        ctx,
        item.event._id,
        primaryEvent._id,
      );
      movedSaveCount += saveResult.movedCount;
      dedupedSaveCount += saveResult.dedupedCount;
      const variantUpdatedAt = nextEventUpdatedAt(item.event.updatedAt, now);
      await ctx.db.patch(item.event._id, {
        status: "rejected",
        reviewedAt: now,
        reviewedBy: authorization.actor,
        moderationNote: variantModerationNote,
        updatedAt: variantUpdatedAt,
      });
      await ctx.db.patch(item.receipt._id, {
        expectedOccurrences: receiptTransition.expectedOccurrences,
        satisfiedOccurrences: receiptTransition.satisfiedOccurrences,
        updatedAt: receiptTransition.updatedAt,
      });
      variantUpdatedAts.push({ id: item.event._id, updatedAt: variantUpdatedAt });
      await writeEventAuditLog(ctx, item.event._id, "cross_post_campaign_variant_rejected", {
        actor: authorization.actor,
        note: args.moderationNote.trim(),
        patch: {
          ...duplicateRollbacks[index],
          marker: "cross_post_campaign_variant",
          variantUpdatedAt,
        },
      });
    }
    await writeEventAuditLog(ctx, primaryEvent._id, "cross_post_campaign_coalesced", {
      actor: authorization.actor,
      note: args.moderationNote.trim(),
      patch: {
        ...primaryRollback,
        foldedVariantIds: variantRows.map((item) => item.event._id),
        sharedEvidenceAnchors: plan.sharedAnchors,
        canonicalVenueName: plan.canonicalVenueName,
        canonicalVenueHandle: plan.canonicalVenueHandle,
        variantUpdatedAts,
        variantReceiptUpdatedAts,
        movedSaveCount,
        dedupedSaveCount,
      },
    });

    return {
      operationId: args.operationId,
      primaryId: primaryEvent._id,
      primaryUpdatedAt,
      foldedVariantIds: variantRows.map((item) => item.event._id),
      variantUpdatedAts,
      variantReceiptUpdatedAts,
      movedSaveCount,
      dedupedSaveCount,
    };
  },
});

/**
 * Consolidates a fully attested one-night DJ timetable that an older
 * extraction protocol persisted as one event per performer slot.
 *
 * This is deliberately separate from the generic duplicate merge: the old
 * rows have distinct occurrence keys and therefore are not duplicates. The
 * transaction proves that every row belongs to one complete, contiguous
 * source timetable, contracts the occurrence receipt to the retained key,
 * preserves saves, and records an audit trail for every removed row.
 */
export const coalesceApprovedNightlifeLineupOccurrences = mutation({
  args: {
    primary: nightlifeLineupCandidateVersion,
    duplicates: v.array(nightlifeLineupCandidateVersion),
    expectedSourceIdentity: v.string(),
    expectedSourceFingerprint: v.string(),
    expectedOccurrenceKeys: v.array(v.string()),
    expectedReceiptId: v.id("instagramSourceOccurrenceReceipts"),
    expectedReceiptUpdatedAt: v.number(),
    patch: nightlifeLineupCoalescingPatch,
    moderationNote: v.string(),
    serviceSecret: v.string(),
  },
  returns: nightlifeLineupCoalescingResult,
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (authorization.kind !== "service") {
      throw new Error("Nightlife lineup coalescing requires service authentication.");
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
      new Set(args.expectedOccurrenceKeys).size !== args.expectedOccurrenceKeys.length ||
      args.expectedOccurrenceKeys.length !== targetVersions.length
    ) {
      throw new Error("Nightlife lineup coalescing requires unique event IDs and keys.");
    }

    const events: Doc<"events">[] = [];
    for (const item of targetVersions) {
      if (
        !Number.isSafeInteger(item.expectedUpdatedAt) ||
        !Number.isSafeInteger(item.expectedSourceLinkUpdatedAt)
      ) {
        throw new Error("Nightlife lineup coalescing requires valid event versions.");
      }
      const event = await ctx.db.get(item.id);
      if (
        !event ||
        event.status !== "approved" ||
        event.updatedAt !== item.expectedUpdatedAt ||
        event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson
      ) {
        throw new Error(`Nightlife lineup event precondition failed: ${item.id}.`);
      }
      events.push(event);
    }

    const primaryEvent = events[0]!;
    const duplicateEvents = events.slice(1);
    const commonVenue = normalizeLookup(primaryEvent.venue);
    const commonPostUrl = normalizeInstagramPostUrl(primaryEvent.instagramPostUrl ?? "");
    if (
      canonicalizeEventType(primaryEvent.eventType) !== "nightlife" ||
      !commonVenue ||
      !commonPostUrl ||
      !primaryEvent.instagramPostId ||
      !primaryEvent.sourceOccurrenceKey ||
      !primaryEvent.rawExtractionJson
    ) {
      throw new Error("Nightlife lineup primary event is not fully source-bound.");
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
        normalizeInstagramPostUrl(event.instagramPostUrl ?? "") !== commonPostUrl ||
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
        throw new Error("Nightlife lineup rows do not share one exact source occurrence.");
      }
    }

    const rawExtraction = parseNightlifeLineupJsonRecord(
      primaryEvent.rawExtractionJson,
      "Nightlife lineup raw extraction",
    );
    const rawScheduleEntries = rawExtraction.schedule_entries;
    const rawConflicts = rawExtraction.source_conflicts;
    const sharedScheduleContext = rawExtraction.shared_schedule_context;
    if (
      rawExtraction.extraction_contract_version !== "event_evidence_v2" ||
      rawExtraction.is_event !== true ||
      canonicalizeEventType(normalizedString(rawExtraction.category)) !== "nightlife" ||
      !Array.isArray(rawConflicts) ||
      rawConflicts.length !== 0 ||
      !Array.isArray(rawScheduleEntries) ||
      rawScheduleEntries.length !== events.length ||
      !sharedScheduleContext ||
      typeof sharedScheduleContext !== "object" ||
      Array.isArray(sharedScheduleContext)
    ) {
      throw new Error("Nightlife lineup raw extraction is not one complete v2 timetable.");
    }
    const sharedTime = (sharedScheduleContext as Record<string, unknown>).time;
    if (!sharedTime || typeof sharedTime !== "object" || Array.isArray(sharedTime)) {
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
      const fields = parseNightlifeLineupJsonRecord(
        event.normalizedFieldsJson ?? "",
        `Nightlife lineup normalized fields ${event._id}`,
      );
      const sourceLine = normalizedString(fields.splitSourceLine);
      const sourceMatches = rawScheduleEntries.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        return normalizedString((value as Record<string, unknown>).source_text) === sourceLine;
      }) as Record<string, unknown>[];
      const sourceEntry = sourceMatches.length === 1 ? sourceMatches[0] : null;
      const dateEvidence = sourceEntry?.date_evidence;
      const timeEvidence = sourceEntry?.time_evidence;
      const source =
        timeEvidence && typeof timeEvidence === "object" && !Array.isArray(timeEvidence)
          ? readNightlifeLineupSource((timeEvidence as Record<string, unknown>).source)
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
        normalizedString((dateEvidence as Record<string, unknown>).resolved_date) !== event.date ||
        !timeEvidence ||
        typeof timeEvidence !== "object" ||
        Array.isArray(timeEvidence) ||
        (timeEvidence as Record<string, unknown>).status !== "start_time_stated" ||
        normalizeLookup(normalizedString((timeEvidence as Record<string, unknown>).exact_text)) !==
          normalizeLookup(event.time ?? "") ||
        fields.extractionContractVersion !== "event_evidence_v2" ||
        fields.structuredEvidenceVerified !== true ||
        fields.multiEventSplitDetected !== true ||
        fields.multiEventSplitCount !== events.length ||
        fields.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        fields.sourceOccurrenceSourceFingerprint !== args.expectedSourceFingerprint ||
        fields.sourceOccurrenceExpectedCount !== events.length ||
        !Array.isArray(fields.sourceOccurrenceExpectedKeys) ||
        !fields.sourceOccurrenceExpectedKeys.every((value) => typeof value === "string") ||
        !exactStringSetEquals(
          fields.sourceOccurrenceExpectedKeys as string[],
          args.expectedOccurrenceKeys,
        ) ||
        fields.sourceOccurrenceDeferredChildCount !== 0 ||
        normalizedString(fields.title) !== normalizedString(event.title) ||
        normalizedString(fields.normalizedDate) !== event.date ||
        normalizedString(fields.time) !== normalizedString(event.time) ||
        normalizeLookup(normalizedString(fields.normalizedVenue)) !== commonVenue ||
        !stringArraysEqual(fields.artists, event.artists)
      ) {
        throw new Error(`Nightlife lineup source-row binding failed: ${event._id}.`);
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
      throw new Error("Nightlife lineup rows are not one contiguous overall timetable.");
    }
    if (
      plan.candidateIds[0] !== String(primaryEvent._id) ||
      normalizedString(args.patch.title) !== normalizedString(plan.title) ||
      normalizedString(args.patch.time) !== normalizedString(plan.time) ||
      !stringArraysEqual(args.patch.artists, plan.artists) ||
      normalizedString(args.patch.description) !== normalizedString(plan.description) ||
      args.patch.timeSource !== sharedTimeSource ||
      normalizedString(args.patch.timeEvidenceText) !== sharedTimeEvidence ||
      args.patch.timeConfidence !== 0.95 ||
      args.patch.timeStatus !== "confirmed" ||
      args.patch.timeEvidenceKind !== "start_time_stated" ||
      args.patch.sourceOccurrenceKey !== primaryEvent.sourceOccurrenceKey ||
      args.patch.sourceFingerprint === args.expectedSourceFingerprint
    ) {
      throw new Error("Nightlife lineup patch does not match the verified timetable plan.");
    }

    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", args.expectedSourceIdentity),
      )
      .take(2);
    const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
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
      const eventFields = parseNightlifeLineupJsonRecord(
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
        sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence) ||
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
      if (
        !link ||
        !expectedVersion ||
        link._id !== expectedVersion.expectedSourceLinkId ||
        link.updatedAt !== expectedVersion.expectedSourceLinkUpdatedAt ||
        link.sourceIdentity !== args.expectedSourceIdentity ||
        link.sourceFingerprint !== args.expectedSourceFingerprint ||
        link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        link.instagramPostId !== event.instagramPostId ||
        normalizeInstagramPostUrl(link.instagramPostUrl ?? "") !== commonPostUrl ||
        !expectedOccurrence ||
        satisfiedOccurrence?.eventId !== event._id ||
        !expectedOccurrenceMatches
      ) {
        throw new Error(`Nightlife lineup occurrence link precondition failed: ${event._id}.`);
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
      const [savedRows, legacySavedRows] = await Promise.all([
        ctx.db
          .query("savedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(MAX_LINEUP_COALESCING_SAVES_PER_EVENT + 1),
        ctx.db
          .query("userSavedEvents")
          .withIndex("by_event", (q) => q.eq("eventId", event._id))
          .take(MAX_LINEUP_COALESCING_SAVES_PER_EVENT + 1),
      ]);
      if (
        savedRows.length > MAX_LINEUP_COALESCING_SAVES_PER_EVENT ||
        legacySavedRows.length > MAX_LINEUP_COALESCING_SAVES_PER_EVENT
      ) {
        throw new Error(`Nightlife lineup save cohort exceeds the safe bound: ${event._id}.`);
      }
    }

    const nextFields = parseNightlifeLineupJsonRecord(
      args.patch.normalizedFieldsJson,
      "Nightlife lineup next normalized fields",
    );
    if (
      nextFields.lineupScheduleCoalesced !== true ||
      nextFields.lineupScheduleCoalescingPolicyVersion !==
        NIGHTLIFE_LINEUP_COALESCING_POLICY_VERSION ||
      nextFields.lineupScheduleTimingMode !== plan.timingMode ||
      nextFields.lineupScheduleSourceRowCount !== events.length ||
      JSON.stringify(nextFields.lineupScheduleSlots) !== JSON.stringify(plan.slots) ||
      JSON.stringify(nextFields.lineupScheduleSourceEvidence) !==
        JSON.stringify(plan.slots.map((slot) => ({ text: slot.sourceText, source: slot.source }))) ||
      normalizedString(nextFields.splitSourceLine) !==
        normalizedString([sharedTimeEvidence, ...plan.sourceTexts].join("\n")) ||
      normalizedString(nextFields.description) !== normalizedString(plan.description) ||
      nextFields.multiEventSplitDetected !== true ||
      nextFields.multiEventSplitCount !== events.length ||
      nextFields.splitEventTotal !== 1 ||
      nextFields.sourceOccurrenceKey !== primaryEvent.sourceOccurrenceKey ||
      nextFields.sourceOccurrenceSourceFingerprint !== args.patch.sourceFingerprint ||
      nextFields.sourceOccurrenceExpectedCount !== 1 ||
      !stringArraysEqual(nextFields.sourceOccurrenceExpectedKeys, [primaryEvent.sourceOccurrenceKey]) ||
      nextFields.sourceOccurrenceDeferredChildCount !== 0
    ) {
      throw new Error("Nightlife lineup next attestation is incomplete.");
    }
    if (
      !commonSourceHandle ||
      normalizeHandle(normalizedString(nextFields.sourceGroundingInstagramHandle)) !==
        commonSourceHandle
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
    if (!hasEventEvidenceV2AutoApproval(args.patch.normalizedFieldsJson, prospectiveEvent)) {
      throw new Error("Nightlife lineup patch does not preserve approved v2 grounding.");
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
      await ctx.db.delete(duplicateEvent._id);
      await writeEventAuditLog(ctx, duplicateEvent._id, "lineup_occurrence_folded", {
        actor: authorization.actor,
        note: args.moderationNote.trim(),
        patch: {
          primaryId: primaryEvent._id,
          sourceOccurrenceKey: duplicateEvent.sourceOccurrenceKey,
        },
      });
    }
    await writeEventAuditLog(ctx, primaryEvent._id, "lineup_occurrences_coalesced", {
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
    });

    return {
      primaryId: primaryEvent._id,
      primaryUpdatedAt,
      receiptUpdatedAt,
      deletedDuplicateCount: duplicateEvents.length,
      movedSaveCount,
      dedupedSaveCount,
    };
  },
});

export const deleteApprovedEvent = mutation({
  args: {
    id: v.id("events"),
    expectedUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAdminIdentity(ctx);
    const existingEvent = await ctx.db.get(args.id);
    if (!existingEvent) {
      throw new Error("Event not found.");
    }

    if (existingEvent.status !== "approved") {
      throw new Error("Only approved events can be removed.");
    }
    assertExpectedEventUpdatedAt(existingEvent.updatedAt, args.expectedUpdatedAt);

    await deleteEventWithSavedReferences(ctx, args.id);
    await writeEventAuditLog(ctx, args.id, "deleted", {
      actor: identity.subject,
      patch: { status: existingEvent.status },
    });
  },
});

export const mergeApprovedEvents = mutation({
  args: {
    primaryId: v.id("events"),
    duplicateIds: v.array(v.id("events")),
    expectedPrimaryUpdatedAt: v.optional(v.number()),
    expectedDuplicateVersions: v.optional(
      v.array(
        v.object({
          id: v.id("events"),
          expectedUpdatedAt: v.number(),
        }),
      ),
    ),
    patch: v.object({
      title: v.optional(v.string()),
      date: v.optional(v.string()),
      time: v.optional(v.string()),
      timeSource: v.optional(eventTimeSource),
      timeEvidenceText: v.optional(v.union(v.string(), v.null())),
      timeConfidence: v.optional(v.number()),
      timeStatus: v.optional(eventTimeStatus),
      timeEvidenceKind: v.optional(eventTimeEvidenceKind),
      dateEvidenceText: v.optional(v.union(v.string(), v.null())),
      dateEvidenceSource: v.optional(eventDateEvidenceSource),
      dateEvidenceIsRelative: v.optional(v.boolean()),
      dateEvidenceResolvedDate: v.optional(v.union(v.string(), v.null())),
      sourceConflictFields: v.optional(v.array(v.string())),
      venue: v.optional(v.string()),
      artists: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      imageStorageId: v.optional(v.id("_storage")),
      ticketPrice: v.optional(v.string()),
      eventType: v.optional(v.string()),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor, kind } = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const primaryEvent = await ctx.db.get(args.primaryId);
    if (!primaryEvent) {
      throw new Error("Primary event not found.");
    }
    if (primaryEvent.status !== "approved") {
      throw new Error("Only approved events can be merged.");
    }
    assertExpectedEventUpdatedAt(primaryEvent.updatedAt, args.expectedPrimaryUpdatedAt);
    if (kind === "service") {
      assertServiceUpdateEventPolicy(primaryEvent.status, args.patch);
    }

    const duplicateIds = [...new Set(args.duplicateIds)].filter((id) => id !== args.primaryId);
    let expectedDuplicateVersionById: Map<string, number> | undefined;
    if (args.expectedDuplicateVersions !== undefined) {
      expectedDuplicateVersionById = new Map<string, number>();
      for (const item of args.expectedDuplicateVersions) {
        const key = String(item.id);
        if (expectedDuplicateVersionById.has(key)) {
          throw new Error("Expected duplicate versions contain a duplicate event ID.");
        }
        expectedDuplicateVersionById.set(key, item.expectedUpdatedAt);
      }
      if (
        expectedDuplicateVersionById.size !== duplicateIds.length ||
        duplicateIds.some((id) => !expectedDuplicateVersionById?.has(String(id)))
      ) {
        throw new Error("Expected duplicate versions must exactly match the duplicate event IDs.");
      }
    }
    const duplicateEvents: Doc<"events">[] = [];
    for (const duplicateId of duplicateIds) {
      const duplicateEvent = await ctx.db.get(duplicateId);
      if (!duplicateEvent) {
        throw new Error("Duplicate event not found.");
      }
      if (duplicateEvent.status !== "approved") {
        throw new Error("Only approved duplicate events can be removed.");
      }
      assertExpectedEventUpdatedAt(
        duplicateEvent.updatedAt,
        expectedDuplicateVersionById?.get(String(duplicateId)),
      );
      duplicateEvents.push(duplicateEvent);
    }

    let effectivePrimaryEvent: Doc<"events"> = primaryEvent;
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
                    event.imageUrl === args.patch.imageUrl && event.imageStorageId !== undefined,
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
      await ctx.db.patch(args.primaryId, {
        ...patch,
        updatedAt: nextEventUpdatedAt(primaryEvent.updatedAt),
      });
      await writeEventAuditLog(ctx, args.primaryId, "merged_primary_updated", {
        actor,
        patch,
      });
    }

    assertPairwiseOccurrenceRelation(
      [effectivePrimaryEvent, ...duplicateEvents],
      "proven_duplicate",
      "Approved-event merge requires every pair to be a proven duplicate occurrence.",
    );

    for (const duplicateEvent of duplicateEvents) {
      await assertInstagramOccurrenceReferencesCanBeReassigned(
        ctx,
        duplicateEvent._id,
        effectivePrimaryEvent,
      );
    }

    for (const duplicateId of duplicateIds) {
      await reassignSavedEventReferences(ctx, duplicateId, args.primaryId);
      await reassignInstagramOccurrenceReferences(ctx, duplicateId, args.primaryId);
      await ctx.db.delete(duplicateId);
      await writeEventAuditLog(ctx, duplicateId, "merged_deleted_duplicate", {
        actor,
        patch: { primaryId: args.primaryId },
      });
    }

    await writeEventAuditLog(ctx, args.primaryId, "merged_duplicates", {
      actor,
      patch: { duplicateIds },
    });

    return {
      primaryId: args.primaryId,
      deletedDuplicateCount: duplicateIds.length,
    };
  },
});

export const deleteExpiredEvents = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
    beforeDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchSize = normalizeExpiredEventDeleteBatchSize(args.batchSize);
    const timeZone = getConfiguredEventTimezone();
    const explicitBeforeDate = args.beforeDate?.trim();
    if (args.beforeDate !== undefined && dateKeyToUtcMs(explicitBeforeDate ?? "") === null) {
      throw new Error("beforeDate must be a valid YYYY-MM-DD date.");
    }
    const cutoff = explicitBeforeDate
      ? { isoDate: explicitBeforeDate, minutesSinceMidnight: 0 }
      : getEventExpiryCutoff(new Date(), timeZone);
    const shouldDeleteSameDayExpiredEvents = explicitBeforeDate === undefined;
    const eventsBeforeCutoffDate = await ctx.db
      .query("events")
      .withIndex("by_date", (q) => q.lt("date", cutoff.isoDate))
      .take(batchSize);

    const deletedEventIds: Id<"events">[] = [];
    let deletedSavedEventCount = 0;

    for (const event of eventsBeforeCutoffDate) {
      deletedSavedEventCount += await deleteEventWithSavedReferences(ctx, event._id);
      deletedEventIds.push(event._id);
    }

    const remainingSlots = batchSize - deletedEventIds.length;
    let skippedSameDayEventCount = 0;
    let sameDayExpiredEventCount = 0;

    if (shouldDeleteSameDayExpiredEvents && remainingSlots > 0) {
      const eventsOnCutoffDate = await ctx.db
        .query("events")
        .withIndex("by_date", (q) => q.eq("date", cutoff.isoDate))
        .collect();
      const sameDayExpiredEvents = eventsOnCutoffDate.filter((event) =>
        isEventExpiredAtCutoff(event, cutoff),
      );

      sameDayExpiredEventCount = sameDayExpiredEvents.length;
      skippedSameDayEventCount = Math.max(0, sameDayExpiredEvents.length - remainingSlots);

      for (const event of sameDayExpiredEvents.slice(0, remainingSlots)) {
        deletedSavedEventCount += await deleteEventWithSavedReferences(ctx, event._id);
        deletedEventIds.push(event._id);
      }
    }

    return {
      deletedEventCount: deletedEventIds.length,
      deletedEventIds,
      deletedSavedEventCount,
      cutoffDate: cutoff.isoDate,
      cutoffTime: formatMinutesSinceMidnight(cutoff.minutesSinceMidnight),
      timeZone,
      hasMore:
        eventsBeforeCutoffDate.length === batchSize ||
        (shouldDeleteSameDayExpiredEvents && skippedSameDayEventCount > 0),
      skippedSameDayEventCount,
      sameDayExpiredEventCount,
    };
  },
});
