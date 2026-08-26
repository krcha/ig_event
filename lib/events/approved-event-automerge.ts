import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  classifyApprovalOccurrenceRelation,
  getNormalizedApprovalOccurrenceKey,
  type ApprovalOccurrenceRelation,
} from "./approval-occurrence-conflict.ts";
import {
  buildApprovedEventAutoCleanupGroups,
  filterUpcomingApprovedEventsForDuplicateCleanup,
  type ApprovedEventAutoCleanupGroup,
  type ApprovedEventDuplicateRecord,
} from "./approved-event-duplicates.ts";
import { toSearchableText } from "../pipeline/venue-normalization.ts";
import {
  immutableSourceOccurrenceBindingsHaveEqualReliableTime,
  immutableSourceOccurrenceBindingsMatch,
} from "./source-occurrence-representation.ts";

type EventStatus = "pending" | "approved" | "rejected";

type ApprovedEventSourceRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  normalizedFieldsJson?: string;
  sourceOccurrenceKey?: string;
  venueId?: string;
  venueInstagramHandle?: string;
  status?: EventStatus;
  createdAt: number;
  updatedAt: number;
};

export type ApprovedEventAutoMergeFailure = {
  primaryEventId: string;
  duplicateEventIds: string[];
  error: string;
};

export type ApprovedEventAutoMergeSummary = {
  approvedCount: number;
  finalApprovedCount: number;
  scannedEventCount: number;
  duplicateGroupCount: number;
  mergedGroupCount: number;
  mergedDuplicateCount: number;
  remainingGroupCount: number;
  failedCount: number;
  failures: ApprovedEventAutoMergeFailure[];
  passes: number;
  error?: string;
};

const listByStatusQuery =
  "events:listByStatusPaginated" as unknown as FunctionReference<"query">;
const mergeApprovedEventsMutation =
  "events:mergeApprovedEvents" as unknown as FunctionReference<"mutation">;

const DEFAULT_AUTO_MERGE_APPROVED_LIMIT = 5_000;
const DEFAULT_AUTO_MERGE_MAX_PASSES = 5;
const COMPLETED_RUN_CLEANUP_CACHE_LIMIT = 128;
const completedRunCleanupSuccesses = new Map<string, ApprovedEventAutoMergeSummary>();
const completedRunCleanupInFlight = new Map<
  string,
  Promise<ApprovedEventAutoMergeSummary>
>();

function mapApprovedEventRecord(
  event: ApprovedEventSourceRecord,
): ApprovedEventDuplicateRecord {
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
    sourceOccurrenceKey: event.sourceOccurrenceKey ?? null,
    venueId: event.venueId ?? null,
    venueInstagramHandle: event.venueInstagramHandle ?? null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function normalizeHandle(value: string | null | undefined): string {
  return value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
}

function normalizeLookup(value: string | null | undefined): string {
  return toSearchableText(value ?? "").replace(/\s+/g, " ").trim();
}

function approvedEventsShareVenue(
  left: ApprovedEventDuplicateRecord,
  right: ApprovedEventDuplicateRecord,
): boolean {
  const leftVenueId = left.venueId?.trim() ?? "";
  const rightVenueId = right.venueId?.trim() ?? "";
  const leftHandle = normalizeHandle(left.venueInstagramHandle);
  const rightHandle = normalizeHandle(right.venueInstagramHandle);
  const leftVenue = normalizeLookup(left.venue);
  const rightVenue = normalizeLookup(right.venue);
  return (
    (Boolean(leftVenueId) && leftVenueId === rightVenueId) ||
    (Boolean(leftHandle) && leftHandle === rightHandle) ||
    (Boolean(leftVenue) && leftVenue === rightVenue)
  );
}

function approvedEventHasKnownVenue(event: ApprovedEventDuplicateRecord): boolean {
  return Boolean(
    event.venueId?.trim() ||
      normalizeHandle(event.venueInstagramHandle) ||
      normalizeLookup(event.venue),
  );
}

function approvedEventsShareSource(
  left: ApprovedEventDuplicateRecord,
  right: ApprovedEventDuplicateRecord,
): boolean {
  const leftPostId = left.instagramPostId?.trim() ?? "";
  const rightPostId = right.instagramPostId?.trim() ?? "";
  const leftPostUrl = normalizeLookup(left.instagramPostUrl);
  const rightPostUrl = normalizeLookup(right.instagramPostUrl);
  return (
    (Boolean(leftPostId) && leftPostId === rightPostId) ||
    (Boolean(leftPostUrl) && leftPostUrl === rightPostUrl)
  );
}

/**
 * Mirrors the pairwise occurrence boundary enforced by
 * events:mergeApprovedEvents. The broader cleanup heuristic is intentionally
 * retained for public projection and human review, but unattended mutation
 * may only receive pairs the mutation itself can prove are duplicates.
 */
export function classifyApprovedEventAutoMergePair(
  left: ApprovedEventDuplicateRecord,
  right: ApprovedEventDuplicateRecord,
): ApprovalOccurrenceRelation {
  if (left.date !== right.date) {
    return "unrelated";
  }
  return classifyApprovalOccurrenceRelation({
    candidate: left,
    existing: right,
    sameVenue: approvedEventsShareVenue(left, right),
    sameSource: approvedEventsShareSource(left, right),
    unknownVenue:
      !approvedEventHasKnownVenue(left) || !approvedEventHasKnownVenue(right),
  });
}

export function isApprovedEventAutoMergePairEligible(
  left: ApprovedEventDuplicateRecord,
  right: ApprovedEventDuplicateRecord,
): boolean {
  const leftOccurrenceKey = getNormalizedApprovalOccurrenceKey(left);
  const rightOccurrenceKey = getNormalizedApprovalOccurrenceKey(right);
  const exactSameOccurrenceKey = Boolean(
    leftOccurrenceKey && leftOccurrenceKey === rightOccurrenceKey,
  );
  return (
    classifyApprovedEventAutoMergePair(left, right) === "proven_duplicate" &&
    immutableSourceOccurrenceBindingsMatch(left, right) &&
    (exactSameOccurrenceKey ||
      immutableSourceOccurrenceBindingsHaveEqualReliableTime(left, right))
  );
}

function buildStrictGroup(
  groupId: string,
  events: ApprovedEventDuplicateRecord[],
): ApprovedEventAutoCleanupGroup {
  const [primaryEvent, ...duplicateEvents] = events;
  return {
    groupId,
    primaryEventId: primaryEvent.id,
    duplicateEventIds: duplicateEvents.map((event) => event.id),
    primaryEvent,
    duplicateEvents,
    matchReasonsByEventId: Object.fromEntries(
      duplicateEvents.map((event) => [
        event.id,
        ["strict occurrence contract: proven duplicate"],
      ]),
    ),
  };
}

/**
 * Partition broad cleanup candidates into pairwise-proven cliques. This keeps
 * unattended cleanup fail-closed and prevents a broad heuristic dry-run from
 * proposing a mutation that mergeApprovedEvents must reject.
 */
export function buildApprovedEventAutoMergeGroups(
  events: ApprovedEventDuplicateRecord[],
): ApprovedEventAutoCleanupGroup[] {
  const broadGroups = buildApprovedEventAutoCleanupGroups(events);
  const strictGroups: ApprovedEventAutoCleanupGroup[] = [];

  for (const broadGroup of broadGroups) {
    let remaining = [broadGroup.primaryEvent, ...broadGroup.duplicateEvents];
    while (remaining.length > 1) {
      const primary = remaining[0];
      const members = [primary];
      const deferred: ApprovedEventDuplicateRecord[] = [];

      for (const candidate of remaining.slice(1)) {
        const pairwiseProven = members.every(
          (member) => isApprovedEventAutoMergePairEligible(member, candidate),
        );
        if (pairwiseProven) {
          members.push(candidate);
        } else {
          deferred.push(candidate);
        }
      }

      if (members.length > 1) {
        strictGroups.push(
          buildStrictGroup(`auto_merge_${strictGroups.length + 1}`, members),
        );
      }
      remaining = deferred;
    }
  }

  return strictGroups;
}

function buildCleanupGroupsForApprovedEvents(
  events: ApprovedEventSourceRecord[],
) {
  const duplicateRecords = events.map(mapApprovedEventRecord);
  const upcomingEvents = filterUpcomingApprovedEventsForDuplicateCleanup(duplicateRecords);
  const cleanupGroups = buildApprovedEventAutoMergeGroups(upcomingEvents);

  return {
    scannedEventCount: upcomingEvents.length,
    cleanupGroups,
  };
}

export function simulateApprovedEventAutoMerge(
  events: ApprovedEventDuplicateRecord[],
  options?: {
    maxPasses?: number;
  },
): ApprovedEventAutoMergeSummary {
  const maxPasses = Math.max(1, options?.maxPasses ?? DEFAULT_AUTO_MERGE_MAX_PASSES);
  let currentEvents = [...events];
  let passes = 0;
  let duplicateGroupCount = 0;
  let mergedGroupCount = 0;
  let mergedDuplicateCount = 0;
  let scannedEventCount = 0;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const upcomingEvents = filterUpcomingApprovedEventsForDuplicateCleanup(currentEvents);
    const cleanupGroups = buildApprovedEventAutoMergeGroups(upcomingEvents);

    passes = pass;
    if (pass === 1) {
      scannedEventCount = upcomingEvents.length;
    }
    duplicateGroupCount += cleanupGroups.length;

    if (cleanupGroups.length === 0) {
      break;
    }

    const duplicateIds = new Set(
      cleanupGroups.flatMap((group) => group.duplicateEventIds),
    );
    currentEvents = currentEvents.filter((event) => !duplicateIds.has(event.id));
    mergedGroupCount += cleanupGroups.length;
    mergedDuplicateCount += [...duplicateIds].length;
  }

  const remainingGroupCount = buildApprovedEventAutoMergeGroups(
    filterUpcomingApprovedEventsForDuplicateCleanup(currentEvents),
  ).length;

  return {
    approvedCount: events.length,
    finalApprovedCount: currentEvents.length,
    scannedEventCount,
    duplicateGroupCount,
    mergedGroupCount,
    mergedDuplicateCount,
    remainingGroupCount,
    failedCount: 0,
    failures: [],
    passes,
  };
}

async function loadApprovedEvents(
  convex: ConvexHttpClient,
  limit: number,
  serviceSecret?: string,
): Promise<ApprovedEventSourceRecord[]> {
  const events: ApprovedEventSourceRecord[] = [];
  let cursor: string | null = null;

  while (events.length < limit) {
    const pageSize = Math.min(10, limit - events.length);
    const result = (await convex.query(listByStatusQuery, {
      status: "approved",
      paginationOpts: {
        cursor,
        numItems: pageSize,
      },
      ...(serviceSecret ? { serviceSecret } : {}),
    })) as {
      page: ApprovedEventSourceRecord[];
      isDone: boolean;
      continueCursor: string;
    };

    events.push(...result.page);
    if (result.isDone || !result.continueCursor || result.continueCursor === cursor) {
      break;
    }
    cursor = result.continueCursor;
  }

  return events.slice(0, limit);
}

export async function runApprovedEventAutoMerge(
  convex: ConvexHttpClient,
  options?: {
    limit?: number;
    maxPasses?: number;
    serviceSecret?: string;
  },
): Promise<ApprovedEventAutoMergeSummary> {
  const limit = Math.max(1, options?.limit ?? DEFAULT_AUTO_MERGE_APPROVED_LIMIT);
  const maxPasses = Math.max(1, options?.maxPasses ?? DEFAULT_AUTO_MERGE_MAX_PASSES);
  const failures: ApprovedEventAutoMergeFailure[] = [];
  let approvedCount = 0;
  let finalApprovedCount = 0;
  let scannedEventCount = 0;
  let duplicateGroupCount = 0;
  let mergedGroupCount = 0;
  let mergedDuplicateCount = 0;
  let remainingGroupCount = 0;
  let passes = 0;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const approvedEvents = await loadApprovedEvents(convex, limit, options?.serviceSecret);
    const { scannedEventCount: nextScannedEventCount, cleanupGroups } =
      buildCleanupGroupsForApprovedEvents(approvedEvents);

    approvedCount = approvedEvents.length;
    scannedEventCount = nextScannedEventCount;
    duplicateGroupCount += cleanupGroups.length;
    passes = pass;

    if (cleanupGroups.length === 0) {
      finalApprovedCount = approvedEvents.length;
      remainingGroupCount = 0;
      break;
    }

    let mergedThisPass = 0;
    const approvedEventById = new Map(approvedEvents.map((event) => [event._id, event]));
    for (const group of cleanupGroups) {
      try {
        const primaryEvent = approvedEventById.get(group.primaryEventId);
        const duplicateEvents = group.duplicateEventIds.map((id) => approvedEventById.get(id));
        if (!primaryEvent || duplicateEvents.some((event) => !event)) {
          throw new Error("Approved-event cleanup versions are unavailable.");
        }
        await convex.mutation(mergeApprovedEventsMutation, {
          primaryId: group.primaryEventId,
          duplicateIds: group.duplicateEventIds,
          expectedPrimaryUpdatedAt: primaryEvent.updatedAt,
          expectedDuplicateVersions: duplicateEvents.map((event) => ({
            id: event!._id,
            expectedUpdatedAt: event!.updatedAt,
          })),
          patch: {},
          ...(options?.serviceSecret ? { serviceSecret: options.serviceSecret } : {}),
        });
        mergedGroupCount += 1;
        mergedDuplicateCount += group.duplicateEventIds.length;
        mergedThisPass += 1;
      } catch (error) {
        failures.push({
          primaryEventId: group.primaryEventId,
          duplicateEventIds: group.duplicateEventIds,
          error: error instanceof Error ? error.message : "Unknown merge error.",
        });
      }
    }

    if (mergedThisPass === 0) {
      finalApprovedCount = approvedEvents.length;
      remainingGroupCount = cleanupGroups.length;
      break;
    }

    const postMergeApprovedEvents = await loadApprovedEvents(
      convex,
      limit,
      options?.serviceSecret,
    );
    finalApprovedCount = postMergeApprovedEvents.length;
    remainingGroupCount = buildCleanupGroupsForApprovedEvents(postMergeApprovedEvents).cleanupGroups.length;
    if (remainingGroupCount === 0) {
      break;
    }
  }

  if (passes === 0) {
    const approvedEvents = await loadApprovedEvents(convex, limit, options?.serviceSecret);
    approvedCount = approvedEvents.length;
    finalApprovedCount = approvedEvents.length;
    const cleanupResult = buildCleanupGroupsForApprovedEvents(approvedEvents);
    scannedEventCount = cleanupResult.scannedEventCount;
    remainingGroupCount = cleanupResult.cleanupGroups.length;
  }

  return {
    approvedCount,
    finalApprovedCount,
    scannedEventCount,
    duplicateGroupCount,
    mergedGroupCount,
    mergedDuplicateCount,
    remainingGroupCount,
    failedCount: failures.length,
    failures,
    passes,
  };
}

export function assertApprovedEventAutoMergeCompleted(
  summary: ApprovedEventAutoMergeSummary,
): void {
  if (summary.error) {
    throw new Error(`Approved-event cleanup failed: ${summary.error}`);
  }
  if (summary.failedCount > 0) {
    throw new Error(
      `Approved-event cleanup failed for ${summary.failedCount} merge group(s).`,
    );
  }
  if (summary.remainingGroupCount > 0) {
    throw new Error(
      `Approved-event cleanup left ${summary.remainingGroupCount} eligible merge group(s).`,
    );
  }
}

function rememberCompletedRunCleanup(
  runId: string,
  summary: ApprovedEventAutoMergeSummary,
): void {
  completedRunCleanupSuccesses.set(runId, summary);
  while (completedRunCleanupSuccesses.size > COMPLETED_RUN_CLEANUP_CACHE_LIMIT) {
    const oldestRunId = completedRunCleanupSuccesses.keys().next().value;
    if (typeof oldestRunId !== "string") break;
    completedRunCleanupSuccesses.delete(oldestRunId);
  }
}

/**
 * Process-local single-flight plus success memory keeps the six fixed lanes
 * from repeating a normal completion cleanup. A crash clears the memory, so a
 * completed-run probe retries the idempotent, version-fenced cleanup instead
 * of permanently skipping it.
 */
export async function runApprovedEventAutoMergeOnceForCompletedRun(
  convex: ConvexHttpClient,
  options: {
    runId: string;
    limit?: number;
    maxPasses?: number;
    serviceSecret?: string;
  },
): Promise<ApprovedEventAutoMergeSummary> {
  const runId = options.runId.trim();
  if (!runId) {
    throw new Error("Completed-run approved cleanup requires a durable run ID.");
  }
  const completed = completedRunCleanupSuccesses.get(runId);
  if (completed) return completed;
  const inFlight = completedRunCleanupInFlight.get(runId);
  if (inFlight) return inFlight;

  const cleanup = (async () => {
    const summary = await runApprovedEventAutoMerge(convex, options);
    assertApprovedEventAutoMergeCompleted(summary);
    rememberCompletedRunCleanup(runId, summary);
    return summary;
  })();
  completedRunCleanupInFlight.set(runId, cleanup);
  try {
    return await cleanup;
  } finally {
    completedRunCleanupInFlight.delete(runId);
  }
}
