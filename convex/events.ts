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
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval";
import { buildNormalizedEventVenueIdentity } from "../lib/events/event-venue-identity";
import {
  buildApprovedEventAutoCleanupGroups,
  type ApprovedEventDuplicateRecord,
} from "../lib/events/approved-event-duplicates";
import {
  assertExpectedEventStatus,
  assertExpectedEventUpdatedAt,
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  hasCompleteSourceGroundingAttestation,
  hasEventEvidenceV2AutoApproval,
  hasHumanReviewedLegacySourceAttestation,
  hasHumanReviewedLegacySourcePolicyMarker,
  hasHumanReviewableLegacySourceAttestation,
  nextEventUpdatedAt,
  assertServiceCreateEventPolicy,
  assertServiceUpdateEventPolicy,
} from "../lib/events/event-update-precondition";
import {
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
const MAX_SOURCE_GROUNDING_REPROCESS_BATCH_SIZE = 100;
const MAX_EVENTS_GET_MANY_BY_IDS = 100;
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

async function assertPersistedServiceSourcePolicy(
  ctx: MutationCtx,
  candidate: ServiceSourceCandidateFields,
  options: { allowHumanReviewedLegacy?: boolean } = {},
): Promise<void> {
  const structuredEvidence = hasEventEvidenceV2AutoApproval(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewedLegacy =
    options.allowHumanReviewedLegacy === true &&
    hasHumanReviewableLegacySourceAttestation(candidate.normalizedFieldsJson, candidate);
  let structuredSourceHandle = "";
  let structuredExtractionMode = "";
  if (structuredEvidence || humanReviewedLegacy) {
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
  if (structuredEvidence) {
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
  ctx: MutationCtx,
  candidate: ServiceSourceCandidateFields & { imageUrl?: string },
  moderationNote: string | undefined,
): Promise<{
  normalizedFieldsJson?: string;
  humanReviewedLegacySourcePolicyVersion?:
    typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
}> {
  const completeMachineAttestation = hasCompleteSourceGroundingAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewableLegacy = hasHumanReviewableLegacySourceAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  if (!completeMachineAttestation && !humanReviewableLegacy) {
    throw new Error(
      "Human approval requires complete canonical Instagram source grounding for the final public fields.",
    );
  }
  if (humanReviewableLegacy && (moderationNote?.trim().length ?? 0) < 20) {
    throw new Error("Legacy human approval requires a substantive moderation note.");
  }
  await assertPersistedServiceSourcePolicy(ctx, candidate, {
    allowHumanReviewedLegacy: humanReviewableLegacy,
  });
  if (!humanReviewableLegacy) {
    return {};
  }
  const normalizedFields = JSON.parse(candidate.normalizedFieldsJson ?? "{}") as Record<
    string,
    unknown
  >;
  return {
    humanReviewedLegacySourcePolicyVersion:
      HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      humanReviewedLegacySourcePolicyVersion:
        HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
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
    .withIndex("by_date", (q) => q.eq("date", candidate.date))
    .collect();
  const candidateVenue = normalizeLookup(candidate.venue);
  const candidatePostUrl = normalizeLookup(candidate.instagramPostUrl ?? "");
  const candidatePostId = candidate.instagramPostId?.trim() ?? "";
  const excluded = new Set(excludeEventIds);
  let ambiguousConflict = false;
  for (const event of sameDateEvents) {
    if (excluded.has(event._id) || event.status !== "approved") {
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
): Promise<{
  candidate: Doc<"events"> & VenueDenormalizedFields;
  venuePatch: Partial<Doc<"events">> & VenueDenormalizedFields;
}> {
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

    return (await projectPublicEventPage(ctx, [event]))[0];
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

function normalizeOccurrenceBindingText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("sr-Latn")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function normalizeOccurrenceArtists(values: string[]): string[] {
  return [...new Set(values.map(normalizeOccurrenceBindingText).filter(Boolean))].sort();
}

function eventHasUnverifiedSourceOccurrencePlan(
  event: Pick<Doc<"events">, "normalizedFieldsJson">,
): boolean {
  if (!event.normalizedFieldsJson) return false;
  try {
    const parsed = JSON.parse(event.normalizedFieldsJson) as Record<string, unknown>;
    return parsed.sourceOccurrencePlanUnverified === true;
  } catch {
    return false;
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
  if (!event || !expected || event.status === "rejected") return false;
  if (
    !options.allowUnverifiedPending &&
    event.status !== "approved" &&
    eventHasUnverifiedSourceOccurrencePlan(event)
  ) {
    return false;
  }
  // Once an event is durably bound to this source occurrence, moderation may
  // legitimately change mutable display fields such as title or time. Keep
  // same-source provenance stable instead of reopening an already represented
  // child because of a presentation edit.
  if (event.sourceOccurrenceKey === expected.key) return true;
  const eventArtists = normalizeOccurrenceArtists(event.artists);
  const expectedArtists = normalizeOccurrenceArtists(expected.artists);
  return (
    event.date === expected.date &&
    normalizeOccurrenceBindingText(event.venue) ===
      normalizeOccurrenceBindingText(expected.venue) &&
    normalizeOccurrenceBindingText(event.title) ===
      normalizeOccurrenceBindingText(expected.title) &&
    eventArtists.length === expectedArtists.length &&
    eventArtists.every((artist, index) => artist === expectedArtists[index]) &&
    (!expected.time ||
      (Boolean(event.time) &&
        normalizeOccurrenceBindingText(event.time) ===
          normalizeOccurrenceBindingText(expected.time)))
  );
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

export const setEventStatus = mutation({
  args: {
    id: v.id("events"),
    status: moderationStatus,
    reviewedBy: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    expectedUpdatedAt: v.optional(v.number()),
  },
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
      const humanReviewPatch = await assertHumanApprovalSourcePolicy(
        ctx,
        prepared.candidate,
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
        const humanReviewPatch = await assertHumanApprovalSourcePolicy(
          ctx,
          prepared.candidate,
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

    let effectivePrimaryEvent: ApprovalCandidateFields = primaryEvent;
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
