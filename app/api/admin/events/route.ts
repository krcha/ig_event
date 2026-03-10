import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";

type EventStatus = "pending" | "approved" | "rejected";

type EventListQuery = {
  status: EventStatus;
  limit?: number;
};

type EventListAllQuery = {
  limit?: number;
};

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
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  moderationNote?: string;
  createdAt: number;
  updatedAt: number;
};

const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;
const listEventsQuery =
  "events:listEvents" as unknown as FunctionReference<"query">;

function mapEventRecord(event: EventRecord) {
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
    rawExtractionJson: event.rawExtractionJson ?? null,
    normalizedFieldsJson: event.normalizedFieldsJson ?? null,
    moderation: {
      status: event.status,
      reviewedAt: event.reviewedAt ?? null,
      reviewedBy: event.reviewedBy ?? null,
      moderationNote: event.moderationNote ?? null,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function parseStatus(value: string | null): EventStatus {
  if (value === "approved" || value === "rejected" || value === "pending") {
    return value;
  }
  return "pending";
}

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

export async function GET(request: Request) {
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const status = parseStatus(searchParams.get("status"));
  const limitParam = Number(searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;
  const includeDuplicateContext = searchParams.get("duplicateContext") === "1";

  try {
    const convex = getConvexHttpClient();
    const events = (await convex.query(listByStatusQuery, {
      status,
      limit,
    } satisfies EventListQuery)) as EventRecord[];
    const duplicateContextLimit = Math.max(limit * 3, 300);
    const duplicateContextEvents = includeDuplicateContext
      ? ((await convex.query(listEventsQuery, {
          limit: Math.min(duplicateContextLimit, 600),
        } satisfies EventListAllQuery)) as EventRecord[])
      : [];

    return NextResponse.json({
      status,
      events: events.map(mapEventRecord),
      duplicateContextEvents: duplicateContextEvents.map(mapEventRecord),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list moderation events.",
      },
      { status: 500 },
    );
  }
}
