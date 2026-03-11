import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  buildApprovedEventAutoCleanupGroups,
  filterUpcomingApprovedEventsForDuplicateCleanup,
  type ApprovedEventDuplicateRecord,
} from "@/lib/events/approved-event-duplicates";
import { getRequiredEnv, hasClerkEnv } from "@/lib/utils/env";

type EventRecord = {
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
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  updatedAt: number;
};

const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;
const getEventQuery =
  "events:getEvent" as unknown as FunctionReference<"query">;
const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;

export const maxDuration = 180;

function getConvexHttpClient() {
  return new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
}

async function hideDuplicateIds(
  convex: ConvexHttpClient,
  duplicateIds: string[],
  reviewedBy?: string,
) {
  const hiddenIds: string[] = [];
  const skippedIds: Array<{ id: string; reason: string }> = [];
  const failedIds: Array<{ id: string; error: string }> = [];

  for (const id of duplicateIds) {
    try {
      const existingEvent = (await convex.query(getEventQuery, {
        id,
      })) as EventRecord | null;
      if (!existingEvent) {
        skippedIds.push({ id, reason: "missing" });
        continue;
      }
      if (existingEvent.status !== "approved") {
        skippedIds.push({ id, reason: `status:${existingEvent.status}` });
        continue;
      }

      try {
        await convex.mutation(updateEventMutation, {
          id,
          patch: {
            status: "rejected",
            reviewedAt: Date.now(),
            reviewedBy,
            moderationNote: "Auto-hidden by approved duplicate cleanup.",
          },
        });
        hiddenIds.push(id);
      } catch (error) {
        failedIds.push({
          id,
          error: error instanceof Error ? error.message : "Unknown hide error.",
        });
      }
    } catch (error) {
      failedIds.push({
        id,
        error: error instanceof Error ? error.message : "Unknown lookup error.",
      });
    }
  }

  return {
    hiddenIds,
    skippedIds,
    failedIds,
  };
}

function mapEventRecord(event: EventRecord): ApprovedEventDuplicateRecord {
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

export async function POST() {
  try {
    let reviewedBy: string | undefined;
    if (hasClerkEnv()) {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      reviewedBy = userId;
    }

    const convex = getConvexHttpClient();
    const approvedEvents = (await convex.query(listByStatusQuery, {
      status: "approved",
      limit: 500,
    })) as EventRecord[];

    const upcomingEvents = filterUpcomingApprovedEventsForDuplicateCleanup(
      approvedEvents.map(mapEventRecord),
    );
    const cleanupGroups = buildApprovedEventAutoCleanupGroups(upcomingEvents);
    const duplicateIds = [...new Set(cleanupGroups.flatMap((group) => group.duplicateEventIds))];

    const hideResult =
      duplicateIds.length > 0
        ? await hideDuplicateIds(convex, duplicateIds, reviewedBy)
        : { hiddenIds: [], skippedIds: [], failedIds: [] };
    const deletedCount = hideResult.hiddenIds.length;

    console.info(
      JSON.stringify({
        level: "info",
        event: "approved_events.auto_cleanup",
        scannedEventCount: upcomingEvents.length,
        duplicateGroupCount: cleanupGroups.length,
        hiddenCount: deletedCount,
        skippedCount: hideResult.skippedIds.length,
        failedCount: hideResult.failedIds.length,
      }),
    );

    return NextResponse.json({
      ok: true,
      scannedEventCount: upcomingEvents.length,
      duplicateGroupCount: cleanupGroups.length,
      deletedCount,
      skippedCount: hideResult.skippedIds.length,
      failedCount: hideResult.failedIds.length,
      skippedDeletes: hideResult.skippedIds,
      failedDeletes: hideResult.failedIds,
      groups: cleanupGroups.map((group) => ({
        groupId: group.groupId,
        date: group.primaryEvent.date,
        venue: group.primaryEvent.venue,
        primaryEventId: group.primaryEventId,
        primaryTitle: group.primaryEvent.title,
        duplicateEventIds: group.duplicateEventIds,
        duplicateTitles: group.duplicateEvents.map((event) => event.title),
        reasons: [...new Set(Object.values(group.matchReasonsByEventId).flat())],
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to clean approved event duplicates.",
      },
      { status: 500 },
    );
  }
}
