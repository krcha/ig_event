import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isHumanApprovalIneligibleError } from "../../lib/domain/moderation/index";
import { isSensibleEventTitleForApproval } from "../../lib/events/event-title-approval";
import { getBelgradeDayKey } from "../../lib/pipeline/belgrade-day-key";
import { loadBoundedPublicVenueResolverRows } from "../venueResolver";
import {
  assertHumanApprovalWithCanonicalVenueFallback,
  buildPendingModerationVenueResolver,
  prepareHumanApprovalCandidateFromVenueResolver,
  type PreparedHumanApprovalCandidate,
} from "./moderationVenue";
import { dateKeyToUtcMs } from "./publicReads";
import { classifyApprovalCandidates } from "./sourceApproval";

const MAX_PENDING_MODERATION_UNIQUENESS_ITEMS = 10;
const MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE = 100;

export type PendingModerationUniquenessReviewItem = {
  id: Id<"events">;
  expectedUpdatedAt: number;
};

export type PendingModerationUniquenessClassification = {
  id: Id<"events">;
  expectedUpdatedAt: number;
  disposition:
    | "unique"
    | "duplicate"
    | "ambiguous"
    | "ineligible"
    | "indeterminate";
  reason:
    | "unique_no_conflict"
    | "duplicate_same_occurrence"
    | "ambiguous_same_date_occurrence"
    | "ineligible_title"
    | "ineligible_invalid_date"
    | "ineligible_expired_event"
    | "ineligible_source_policy"
    | "indeterminate_venue_limit"
    | "indeterminate_pending_cohort_limit"
    | "indeterminate_approved_cohort_limit"
    | "indeterminate_batch_incomplete";
  conflictIds: Id<"events">[];
};

type PendingModerationDateCohort = {
  pending: Doc<"events">[];
  approved: Doc<"events">[];
  pendingTruncated: boolean;
  approvedTruncated: boolean;
};

export type PendingModerationUniquenessBuild = {
  result: {
    complete: boolean;
    items: PendingModerationUniquenessClassification[];
  };
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
      throw new Error(
        "Unique pending review expectedUpdatedAt values must be safe integers.",
      );
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
      pending: pending.slice(
        0,
        MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE,
      ),
      approved: approved.slice(
        0,
        MAX_PENDING_MODERATION_UNIQUENESS_DATE_COHORT_SIZE,
      ),
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
  if (dateKeyToUtcMs(event.date) === null) return "ineligible_invalid_date";
  return event.date < currentBelgradeDay ? "ineligible_expired_event" : null;
}

export async function buildPendingModerationUniquenessReview(
  ctx: QueryCtx | MutationCtx,
  options: {
    items: PendingModerationUniquenessReviewItem[];
    asOfMs: number;
    moderationNote: string;
  },
): Promise<PendingModerationUniquenessBuild> {
  if (!Number.isSafeInteger(options.asOfMs) || options.asOfMs < 0) {
    throw new Error(
      "Unique pending review asOfMs must be a non-negative safe integer.",
    );
  }
  const reviewedEvents = await loadExactPendingModerationReviewEvents(
    ctx,
    options.items,
  );
  const currentBelgradeDay = getBelgradeDayKey(options.asOfMs);
  const publicVenues = await loadBoundedPublicVenueResolverRows(ctx);
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
      if (!event) {
        throw new Error(
          "Reviewed pending event disappeared during classification.",
        );
      }
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
    return { result: { complete: false, items }, reviewedEvents, approvals };
  }

  const dates = [
    ...new Set(
      options.items.map((item) => {
        const event = reviewedEvents.get(item.id);
        if (!event) {
          throw new Error(
            "Reviewed pending event disappeared during classification.",
          );
        }
        return event.date;
      }),
    ),
  ];
  const cohorts = await loadPendingModerationDateCohorts(ctx, dates);
  const venueResolver = buildPendingModerationVenueResolver(
    publicVenues.venues,
    publicVenues.identities,
  );
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
    if (!event) {
      throw new Error(
        "Reviewed pending event disappeared during classification.",
      );
    }
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
      const humanReviewPatch =
        await assertHumanApprovalWithCanonicalVenueFallback(
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
      if (!isHumanApprovalIneligibleError(error)) throw error;
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
