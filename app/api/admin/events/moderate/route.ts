import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

type EventStatus = "approved" | "rejected";

type RequestBody = {
  eventId?: string;
  eventIds?: string[];
  expectedUpdatedAt?: number;
  expectedVersions?: Array<{ eventId?: string; expectedUpdatedAt?: number }>;
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

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /reviewed version|expected versions|expectedUpdatedAt/iu.test(error.message);
}

export async function POST(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }
  const reviewedBy = adminAccess.userId ?? undefined;

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
    const convex = await createAuthenticatedConvexHttpClient();
    const moderationNote = body.moderationNote?.trim() || undefined;

    if (eventIds.length > 0) {
      const expectedVersions = Array.isArray(body.expectedVersions)
        ? body.expectedVersions.map((item) => ({
            id: item.eventId?.trim() || "",
            expectedUpdatedAt: item.expectedUpdatedAt,
          }))
        : [];
      const expectedVersionById = new Map(
        expectedVersions.map((item) => [item.id, item.expectedUpdatedAt] as const),
      );
      if (
        expectedVersions.some((item) => !item.id || !Number.isSafeInteger(item.expectedUpdatedAt)) ||
        expectedVersionById.size !== expectedVersions.length ||
        expectedVersionById.size !== eventIds.length ||
        eventIds.some((id) => !expectedVersionById.has(id))
      ) {
        return NextResponse.json(
          { error: "expectedVersions must provide one exact reviewed version per eventId." },
          { status: 400 },
        );
      }
      const result = (await convex.mutation(setEventStatusesMutation, {
        ids: eventIds,
        expectedVersions: expectedVersions.map((item) => ({
          id: item.id,
          expectedUpdatedAt: item.expectedUpdatedAt as number,
        })),
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

    if (!Number.isSafeInteger(body.expectedUpdatedAt)) {
      return NextResponse.json(
        { error: "expectedUpdatedAt must be the exact reviewed event version." },
        { status: 400 },
      );
    }

    await convex.mutation(setEventStatusMutation, {
      id: eventId,
      expectedUpdatedAt: body.expectedUpdatedAt,
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
      { status: isVersionConflict(error) ? 409 : 500 },
    );
  }
}
