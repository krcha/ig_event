import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { FunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { hasClerkEnv } from "@/lib/utils/env";

type SaveEventRequestBody = {
  eventId?: unknown;
  saved?: unknown;
};

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;
const toggleMySavedEventMutation =
  "users:toggleMySavedEvent" as unknown as FunctionReference<"mutation">;
const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;

function getEventId(body: SaveEventRequestBody): Id<"events"> | null {
  return typeof body.eventId === "string" && body.eventId.length > 0
    ? (body.eventId as Id<"events">)
    : null;
}

export async function GET() {
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to view saved events." }, { status: 401 });
  }

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const result = await convex.query(getMyLibraryQuery, {});
    return NextResponse.json({ ...result, userId });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not load saved events.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to save events." }, { status: 401 });
  }

  let body: SaveEventRequestBody;
  try {
    body = (await request.json()) as SaveEventRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const eventId = getEventId(body);
  if (!eventId) {
    return NextResponse.json({ error: "A valid eventId is required." }, { status: 400 });
  }
  const saved = typeof body.saved === "boolean" ? body.saved : undefined;

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const result = await convex.mutation(toggleMySavedEventMutation, {
      eventId,
      saved,
    });
    const event = result.saved
      ? await convex.query(getPublicApprovedEventQuery, { id: eventId })
      : null;

    return NextResponse.json({ ...result, event, eventId, userId });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not toggle this event.",
      },
      { status: 500 },
    );
  }
}
