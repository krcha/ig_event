import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  buildApprovedEventReviewCandidateGroups,
  filterUpcomingApprovedEventsForReview,
  reviewApprovedEventsForMasterReview,
  type ApprovedEventRecordForReview,
} from "@/lib/ai/review-approved-events";
import { hasClerkEnv } from "@/lib/utils/env";

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

export const maxDuration = 180;

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

function mapApprovedEvent(event: EventRecord): ApprovedEventRecordForReview {
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
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const convex = getConvexHttpClient();
    const approvedEvents = (await convex.query(listByStatusQuery, {
      status: "approved",
      limit: 500,
    })) as EventRecord[];
    const activeApprovedEvents = filterUpcomingApprovedEventsForReview(
      approvedEvents.map(mapApprovedEvent),
    );
    const candidateGroups = buildApprovedEventReviewCandidateGroups(activeApprovedEvents);
    const review = await reviewApprovedEventsForMasterReview({
      events: activeApprovedEvents,
      candidateGroups,
    });
    const candidateGroupById = new Map(
      candidateGroups.map((group) => [group.groupId, group] as const),
    );

    return NextResponse.json({
      overview: review.overview,
      activeEventCount: review.activeEventCount,
      candidateGroupCount: review.candidateGroupCount,
      generatedAt: new Date().toISOString(),
      reviewGroups: review.reviewGroups.map((group) => ({
        ...group,
        candidateEvents: candidateGroupById.get(group.groupId)?.events ?? [],
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run approved events master review.",
      },
      { status: 500 },
    );
  }
}
