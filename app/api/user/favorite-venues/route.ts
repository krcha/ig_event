import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { FunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { hasClerkEnv } from "@/lib/utils/env";

type FavoriteVenueRequestBody = {
  favorite?: unknown;
  venueId?: unknown;
};

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;
const toggleMyFavoriteVenueMutation =
  "users:toggleMyFavoriteVenue" as unknown as FunctionReference<"mutation">;
const listPublicVenueFieldsByIdsQuery =
  "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;

function getVenueId(body: FavoriteVenueRequestBody): Id<"venues"> | null {
  return typeof body.venueId === "string" && body.venueId.length > 0
    ? (body.venueId as Id<"venues">)
    : null;
}

export async function GET() {
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to view favorite venues." }, { status: 401 });
  }

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const result = await convex.query(getMyLibraryQuery, {});
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
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

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
  const favorite = typeof body.favorite === "boolean" ? body.favorite : undefined;

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const result = await convex.mutation(toggleMyFavoriteVenueMutation, {
      favorite,
      venueId,
    });
    const venues = result.favorite
      ? ((await convex.query(listPublicVenueFieldsByIdsQuery, {
          ids: [venueId],
        })) as unknown[])
      : [];
    const venue = venues[0] ?? null;

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
