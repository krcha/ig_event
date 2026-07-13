import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  buildApprovedEventAutoCleanupGroups,
  filterUpcomingApprovedEventsForDuplicateCleanup,
  type ApprovedEventDuplicateRecord,
} from "./approved-event-duplicates.ts";

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
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function buildCleanupGroupsForApprovedEvents(
  events: ApprovedEventSourceRecord[],
) {
  const duplicateRecords = events.map(mapApprovedEventRecord);
  const upcomingEvents = filterUpcomingApprovedEventsForDuplicateCleanup(duplicateRecords);
  const cleanupGroups = buildApprovedEventAutoCleanupGroups(upcomingEvents);

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
    const cleanupGroups = buildApprovedEventAutoCleanupGroups(upcomingEvents);

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

  const remainingGroupCount = buildApprovedEventAutoCleanupGroups(
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
    const pageSize = Math.min(100, limit - events.length);
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
    for (const group of cleanupGroups) {
      try {
        await convex.mutation(mergeApprovedEventsMutation, {
          primaryId: group.primaryEventId,
          duplicateIds: group.duplicateEventIds,
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
