import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";

type EventStatus = "approved" | "rejected";

type RequestBody = {
  eventId?: string;
  eventIds?: string[];
  status?: EventStatus;
  moderationNote?: string;
};

const setEventStatusMutation =
  "events:setEventStatus" as unknown as FunctionReference<"mutation">;
const setEventStatusesMutation =
  "events:setEventStatuses" as unknown as FunctionReference<"mutation">;

function isValidStatus(status: string | undefined): status is EventStatus {
  return status === "approved" || status === "rejected";
}

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

export async function POST(request: Request) {
  const clerkEnabled = hasClerkEnv();
  let reviewedBy: string | undefined;

  if (clerkEnabled) {
    const session = await auth();
    if (!session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    reviewedBy = session.userId;
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!isValidStatus(body.status)) {
    return NextResponse.json(
      { error: "status must be either approved or rejected." },
      { status: 400 },
    );
  }

  const eventIds = Array.isArray(body.eventIds)
    ? [...new Set(
        body.eventIds
          .map((eventId) => eventId.trim())
          .filter((eventId) => eventId.length > 0),
      )]
    : [];
  const eventId = body.eventId?.trim() || "";

  if (!eventId && eventIds.length === 0) {
    return NextResponse.json(
      { error: "eventId or eventIds is required." },
      { status: 400 },
    );
  }

  try {
    const convex = getConvexHttpClient();
    const moderationNote = body.moderationNote?.trim() || undefined;

    if (eventIds.length > 0) {
      const result = (await convex.mutation(setEventStatusesMutation, {
        ids: eventIds,
        status: body.status,
        reviewedBy,
        moderationNote,
      })) as {
        updatedCount: number;
        skippedCount: number;
      };

      return NextResponse.json({
        ok: true,
        eventIds,
        status: body.status,
        updatedCount: result.updatedCount,
        skippedCount: result.skippedCount,
      });
    }

    await convex.mutation(setEventStatusMutation, {
      id: eventId,
      status: body.status,
      reviewedBy,
      moderationNote,
    });

    return NextResponse.json({
      ok: true,
      eventId,
      status: body.status,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update moderation status.",
      },
      { status: 500 },
    );
  }
}
