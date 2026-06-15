import { auth, currentUser } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type FavoriteVenueRequestBody = {
  venueId?: unknown;
};

function getVenueId(body: FavoriteVenueRequestBody): Id<"venues"> | null {
  return typeof body.venueId === "string" && body.venueId.length > 0
    ? (body.venueId as Id<"venues">)
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
    return NextResponse.json({ error: "Sign in to view favorite venues." }, { status: 401 });
  }

  const convex = getConvexClient();
  if (convex instanceof NextResponse) {
    return convex;
  }

  try {
    const result = await convex.query(api.users.listFavoriteVenues, { userId });
    return NextResponse.json({ ...result, userId });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not load favorite venues.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to follow venues." }, { status: 401 });
  }

  let body: FavoriteVenueRequestBody;
  try {
    body = (await request.json()) as FavoriteVenueRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const venueId = getVenueId(body);
  if (!venueId) {
    return NextResponse.json({ error: "A valid venueId is required." }, { status: 400 });
  }

  const convex = getConvexClient();
  if (convex instanceof NextResponse) {
    return convex;
  }

  try {
    await ensureConvexUser(convex, userId);
    const result = await convex.mutation(api.users.toggleFavoriteVenue, {
      userId,
      venueId,
    });
    const venue = result.favorite ? await convex.query(api.venues.getVenue, { id: venueId }) : null;

    return NextResponse.json({ ...result, userId, venue, venueId });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not toggle this venue.",
      },
      { status: 500 },
    );
  }
}
