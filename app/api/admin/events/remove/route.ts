import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

type RequestBody = {
  eventId?: string;
};

const deleteApprovedEventMutation =
  "events:deleteApprovedEvent" as unknown as FunctionReference<"mutation">;

export async function POST(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventId = body.eventId?.trim() || "";
  if (!eventId) {
    return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  }

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    await convex.mutation(deleteApprovedEventMutation, {
      id: eventId,
    });

    return NextResponse.json({
      ok: true,
      eventId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to remove approved event.",
      },
      { status: 500 },
    );
  }
}
