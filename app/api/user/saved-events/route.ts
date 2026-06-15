import { auth, currentUser } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type SaveEventRequestBody = {
  eventId?: unknown;
};

function getEventId(body: SaveEventRequestBody): Id<"events"> | null {
  return typeof body.eventId === "string" && body.eventId.length > 0
    ? (body.eventId as Id<"events">)
    : null;
}

function getConvexClient(): ConvexHttpClient | NextResponse {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return NextResponse.json({ error: "Convex is not configured." }, { status: 503 });
  }

  return new ConvexHttpClient(convexUrl);
}

async function ensureConvexUser(convex: ConvexHttpClient, clerkUserId: string) {
  const clerkUser = await currentUser();
  await convex.mutation(api.users.upsertUser, {
    clerkId: clerkUserId,
    email: clerkUser?.primaryEmailAddress?.emailAddress,
  });
}

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to view saved events." }, { status: 401 });
  }

  const convex = getConvexClient();
  if (convex instanceof NextResponse) {
    return convex;
  }

  try {
    const result = await convex.query(api.users.listSavedEvents, { userId });
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

  const convex = getConvexClient();
  if (convex instanceof NextResponse) {
    return convex;
  }

  try {
    await ensureConvexUser(convex, userId);
    const result = await convex.mutation(api.users.toggleSavedEvent, {
      eventId,
      userId,
    });
    const event = result.saved ? await convex.query(api.events.getEvent, { id: eventId }) : null;

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
