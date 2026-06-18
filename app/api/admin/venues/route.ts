import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";
import { canonicalizeVenueCategory } from "@/lib/taxonomy/venue-types";
import {
  createEmptyVenueHoursJson,
  serializeVenueHoursJson,
  BELGRADE_TIMEZONE,
} from "@/lib/venues/venue-hours-cache";
import { createManualVenueHoursPatch } from "@/lib/venues/venue-hours-fetcher";

type VenueRecord = {
  _id: string;
  name: string;
  instagramHandle: string;
  category: string;
  location?: string;
  hoursSource?: "osm" | "google" | "manual" | "none";
  hoursJson?: string;
  hoursFetchedAt?: number;
  hoursExpiresAt?: number;
  hoursTimezone?: string;
  osmElementId?: string;
  osmElementType?: string;
  googlePlaceId?: string;
  hoursError?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

type CreateVenueBody = {
  name?: string;
  instagramHandle?: string;
  category?: string;
  location?: string;
  isActive?: boolean;
};

type UpdateVenueBody = {
  id?: string;
  patch?: {
    name?: string;
    instagramHandle?: string;
    category?: string;
    location?: string;
    isActive?: boolean;
    clearVenueHours?: boolean;
    manualOpeningHours?: string;
  };
};

type DeleteVenueBody = {
  id?: string;
};

const listVenuesQuery = "venues:listVenues" as unknown as FunctionReference<"query">;
const createVenueMutation =
  "venues:createVenue" as unknown as FunctionReference<"mutation">;
const updateVenueMutation =
  "venues:updateVenue" as unknown as FunctionReference<"mutation">;
const patchVenueHoursMutation =
  "venues:patchVenueHours" as unknown as FunctionReference<"mutation">;
const removeVenueMutation =
  "venues:removeVenue" as unknown as FunctionReference<"mutation">;

function getConvexClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

function createClearVenueHoursPatch(now = Date.now()) {
  const generatedAt = new Date(now).toISOString();
  return {
    googlePlaceId: "",
    hoursError: "",
    hoursExpiresAt: 0,
    hoursFetchedAt: 0,
    hoursJson: serializeVenueHoursJson(
      createEmptyVenueHoursJson({
        generatedAt,
        source: "none",
      }),
    ),
    hoursSource: "none" as const,
    hoursTimezone: BELGRADE_TIMEZONE,
    osmElementId: "",
    osmElementType: "",
  };
}

async function ensureAuthorized() {
  if (!hasClerkEnv()) return true;
  const session = await auth();
  return Boolean(session.userId);
}

export async function GET() {
  if (!(await ensureAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const convex = getConvexClient();
    const venues = (await convex.query(listVenuesQuery, {})) as VenueRecord[];
    return NextResponse.json({
      venues: venues.map((venue) => ({
        id: venue._id,
        name: venue.name,
        instagramHandle: venue.instagramHandle,
        category: canonicalizeVenueCategory(venue.category),
        location: venue.location ?? null,
        hoursSource: venue.hoursSource ?? null,
        hoursJson: venue.hoursJson ?? null,
        hoursFetchedAt: venue.hoursFetchedAt ?? null,
        hoursExpiresAt: venue.hoursExpiresAt ?? null,
        hoursTimezone: venue.hoursTimezone ?? null,
        osmElementId: venue.osmElementId ?? null,
        osmElementType: venue.osmElementType ?? null,
        googlePlaceId: venue.googlePlaceId ?? null,
        hoursError: venue.hoursError ?? null,
        isActive: venue.isActive,
        createdAt: venue.createdAt,
        updatedAt: venue.updatedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load venues.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await ensureAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateVenueBody;
  try {
    body = (await request.json()) as CreateVenueBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const name = body.name?.trim();
  const instagramHandle = body.instagramHandle?.trim();
  const category = canonicalizeVenueCategory(body.category);

  if (!name || !instagramHandle) {
    return NextResponse.json(
      { error: "name and instagramHandle are required." },
      { status: 400 },
    );
  }

  try {
    const convex = getConvexClient();
    const id = await convex.mutation(createVenueMutation, {
      name,
      instagramHandle,
      category,
      location: body.location?.trim() || undefined,
      isActive: body.isActive ?? true,
    });

    return NextResponse.json({ id });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create venue.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  if (!(await ensureAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: UpdateVenueBody;
  try {
    body = (await request.json()) as UpdateVenueBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!body.id || !body.patch) {
    return NextResponse.json(
      { error: "id and patch are required." },
      { status: 400 },
    );
  }

  const manualOpeningHours = body.patch.manualOpeningHours?.trim();
  let hoursPatch:
    | ReturnType<typeof createClearVenueHoursPatch>
    | ReturnType<typeof createManualVenueHoursPatch>
    | null = null;
  if (manualOpeningHours) {
    try {
      hoursPatch = createManualVenueHoursPatch(manualOpeningHours);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? `Invalid manual opening_hours: ${error.message}`
              : "Invalid manual opening_hours.",
        },
        { status: 400 },
      );
    }
  } else if (body.patch.clearVenueHours === true) {
    hoursPatch = createClearVenueHoursPatch();
  }

  try {
    const convex = getConvexClient();
    const venuePatch = {
      ...(body.patch.name !== undefined ? { name: body.patch.name } : {}),
      ...(body.patch.instagramHandle !== undefined
        ? { instagramHandle: body.patch.instagramHandle }
        : {}),
      ...(body.patch.category !== undefined ? { category: body.patch.category } : {}),
      ...(body.patch.location !== undefined ? { location: body.patch.location } : {}),
      ...(body.patch.isActive !== undefined ? { isActive: body.patch.isActive } : {}),
      ...(body.patch.category !== undefined
        ? { category: canonicalizeVenueCategory(body.patch.category) }
        : {}),
    };

    if (Object.keys(venuePatch).length > 0) {
      await convex.mutation(updateVenueMutation, {
        id: body.id,
        patch: venuePatch,
      });
    }

    if (hoursPatch) {
      await convex.mutation(patchVenueHoursMutation, {
        id: body.id,
        patch: hoursPatch,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update venue.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!(await ensureAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: DeleteVenueBody;
  try {
    body = (await request.json()) as DeleteVenueBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }

  try {
    const convex = getConvexClient();
    await convex.mutation(removeVenueMutation, {
      id: body.id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to remove venue.",
      },
      { status: 500 },
    );
  }
}
