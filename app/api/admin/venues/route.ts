import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
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
  latitude?: number;
  longitude?: number;
  neighborhood?: string;
  lastFullScrapeAttemptAt?: number;
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
  latitude?: number;
  longitude?: number;
  neighborhood?: string;
  lastFullScrapeAttemptAt?: number;
  isActive?: boolean;
};

type UpdateVenueBody = {
  id?: string;
  patch?: {
    name?: string;
    instagramHandle?: string;
    category?: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    neighborhood?: string;
    lastFullScrapeAttemptAt?: number;
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

export async function GET() {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const venues = (await convex.query(listVenuesQuery, {})) as VenueRecord[];
    return NextResponse.json({
      venues: venues.map((venue) => ({
        id: venue._id,
        name: venue.name,
        instagramHandle: venue.instagramHandle,
        category: canonicalizeVenueCategory(venue.category),
        location: venue.location ?? null,
        latitude: venue.latitude ?? null,
        longitude: venue.longitude ?? null,
        neighborhood: venue.neighborhood ?? null,
        lastFullScrapeAttemptAt: venue.lastFullScrapeAttemptAt ?? null,
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
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
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
    const convex = await createAuthenticatedConvexHttpClient();
    const id = await convex.mutation(createVenueMutation, {
      name,
      instagramHandle,
      category,
      location: body.location?.trim() || undefined,
      ...(typeof body.latitude === "number" ? { latitude: body.latitude } : {}),
      ...(typeof body.longitude === "number" ? { longitude: body.longitude } : {}),
      ...(body.neighborhood?.trim() ? { neighborhood: body.neighborhood.trim() } : {}),
      ...(typeof body.lastFullScrapeAttemptAt === "number"
        ? { lastFullScrapeAttemptAt: body.lastFullScrapeAttemptAt }
        : {}),
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
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
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
    const convex = await createAuthenticatedConvexHttpClient();
    const venuePatch = {
      ...(body.patch.name !== undefined ? { name: body.patch.name } : {}),
      ...(body.patch.instagramHandle !== undefined
        ? { instagramHandle: body.patch.instagramHandle }
        : {}),
      ...(body.patch.category !== undefined ? { category: body.patch.category } : {}),
      ...(body.patch.location !== undefined ? { location: body.patch.location } : {}),
      ...(typeof body.patch.latitude === "number" ? { latitude: body.patch.latitude } : {}),
      ...(typeof body.patch.longitude === "number" ? { longitude: body.patch.longitude } : {}),
      ...(body.patch.neighborhood !== undefined
        ? { neighborhood: body.patch.neighborhood }
        : {}),
      ...(typeof body.patch.lastFullScrapeAttemptAt === "number"
        ? { lastFullScrapeAttemptAt: body.patch.lastFullScrapeAttemptAt }
        : {}),
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
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
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
    const convex = await createAuthenticatedConvexHttpClient();
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
