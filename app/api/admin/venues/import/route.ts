import { auth } from "@clerk/nextjs/server";
import { parse } from "csv-parse/sync";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";

type VenueRecord = {
  _id: string;
  name: string;
  instagramHandle: string;
  category: string;
  location?: string;
  isActive: boolean;
};

type ParsedCsvVenue = {
  instagramHandle: string;
  name: string;
};

const listVenuesQuery = "venues:listVenues" as unknown as FunctionReference<"query">;
const createVenueMutation =
  "venues:createVenue" as unknown as FunctionReference<"mutation">;
const updateVenueMutation =
  "venues:updateVenue" as unknown as FunctionReference<"mutation">;

function getConvexClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

async function ensureAuthorized() {
  if (!hasClerkEnv()) return true;
  const session = await auth();
  return Boolean(session.userId);
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function parseCsvToVenues(csvText: string) {
  const rows = parse(csvText, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const seenHandles = new Set<string>();
  const venues: ParsedCsvVenue[] = [];
  let skippedMissingHandle = 0;
  let skippedMissingName = 0;
  let skippedDuplicateHandle = 0;

  for (const row of rows) {
    const instagramHandle = normalizeHandle(row["_ap3a"] ?? "");
    const name = (row["x1lliihq"] ?? "").trim();

    if (!instagramHandle) {
      skippedMissingHandle += 1;
      continue;
    }
    if (!name) {
      skippedMissingName += 1;
      continue;
    }
    if (seenHandles.has(instagramHandle)) {
      skippedDuplicateHandle += 1;
      continue;
    }

    seenHandles.add(instagramHandle);
    venues.push({ instagramHandle, name });
  }

  return {
    venues,
    totalRows: rows.length,
    skippedMissingHandle,
    skippedMissingName,
    skippedDuplicateHandle,
  };
}

export async function POST(request: Request) {
  if (!(await ensureAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form payload." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "CSV file is required." }, { status: 400 });
  }

  const category = (formData.get("category")?.toString().trim() || "venue").slice(0, 80);
  const isActive = formData.get("isActive")?.toString() !== "false";

  let csvText: string;
  try {
    csvText = await file.text();
  } catch {
    return NextResponse.json({ error: "Failed to read CSV file." }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseCsvToVenues(csvText);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to parse CSV.",
      },
      { status: 400 },
    );
  }

  if (parsed.venues.length === 0) {
    return NextResponse.json(
      {
        error: "No valid rows found. Expected _ap3a for handle and x1lliihq for name.",
      },
      { status: 400 },
    );
  }

  try {
    const convex = getConvexClient();
    const existingVenues = (await convex.query(listVenuesQuery, {})) as VenueRecord[];
    const byHandle = new Map(
      existingVenues.map((venue) => [normalizeHandle(venue.instagramHandle), venue] as const),
    );

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const venue of parsed.venues) {
      const existingVenue = byHandle.get(venue.instagramHandle);
      if (!existingVenue) {
        await convex.mutation(createVenueMutation, {
          name: venue.name,
          instagramHandle: venue.instagramHandle,
          category,
          isActive,
        });
        created += 1;
        continue;
      }

      const nextPatch: {
        name?: string;
        instagramHandle?: string;
      } = {};

      if (existingVenue.name !== venue.name) {
        nextPatch.name = venue.name;
      }
      if (normalizeHandle(existingVenue.instagramHandle) !== venue.instagramHandle) {
        nextPatch.instagramHandle = venue.instagramHandle;
      }

      if (Object.keys(nextPatch).length === 0) {
        unchanged += 1;
        continue;
      }

      await convex.mutation(updateVenueMutation, {
        id: existingVenue._id,
        patch: nextPatch,
      });
      updated += 1;
    }

    return NextResponse.json({
      ok: true,
      totalRows: parsed.totalRows,
      validRows: parsed.venues.length,
      created,
      updated,
      unchanged,
      skippedMissingHandle: parsed.skippedMissingHandle,
      skippedMissingName: parsed.skippedMissingName,
      skippedDuplicateHandle: parsed.skippedDuplicateHandle,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to import venues from CSV.",
      },
      { status: 500 },
    );
  }
}
