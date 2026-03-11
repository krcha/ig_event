import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";

type RequestBody = {
  primaryEventId?: string;
  duplicateEventIds?: string[];
  primaryPatch?: {
    title?: string;
    date?: string;
    time?: string;
    venue?: string;
    artists?: string[];
    description?: string;
    ticketPrice?: string;
    eventType?: string;
    imageUrl?: string;
  };
};

const mergeApprovedEventsMutation =
  "events:mergeApprovedEvents" as unknown as FunctionReference<"mutation">;

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePatch(body: RequestBody["primaryPatch"]) {
  if (!body) {
    return {};
  }

  const artists = Array.isArray(body.artists)
    ? [...new Set(body.artists.map((artist) => artist.trim()).filter(Boolean))]
    : undefined;

  return {
    ...(normalizeString(body.title) ? { title: normalizeString(body.title) } : {}),
    ...(normalizeString(body.date) ? { date: normalizeString(body.date) } : {}),
    ...(normalizeString(body.time) ? { time: normalizeString(body.time) } : {}),
    ...(normalizeString(body.venue) ? { venue: normalizeString(body.venue) } : {}),
    ...(artists && artists.length > 0 ? { artists } : {}),
    ...(normalizeString(body.description)
      ? { description: normalizeString(body.description) }
      : {}),
    ...(normalizeString(body.ticketPrice)
      ? { ticketPrice: normalizeString(body.ticketPrice) }
      : {}),
    ...(normalizeString(body.eventType)
      ? { eventType: normalizeString(body.eventType) }
      : {}),
    ...(normalizeString(body.imageUrl) ? { imageUrl: normalizeString(body.imageUrl) } : {}),
  };
}

export async function POST(request: Request) {
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const primaryEventId = body.primaryEventId?.trim() || "";
  const duplicateEventIds = Array.isArray(body.duplicateEventIds)
    ? [...new Set(body.duplicateEventIds.map((id) => id.trim()).filter(Boolean))]
    : [];

  if (!primaryEventId) {
    return NextResponse.json({ error: "primaryEventId is required." }, { status: 400 });
  }
  if (duplicateEventIds.length === 0) {
    return NextResponse.json(
      { error: "At least one duplicateEventId is required." },
      { status: 400 },
    );
  }

  try {
    const convex = getConvexHttpClient();
    const patch = normalizePatch(body.primaryPatch);
    const result = await convex.mutation(mergeApprovedEventsMutation, {
      primaryId: primaryEventId,
      duplicateIds: duplicateEventIds,
      patch,
    });

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to apply approved event master review.",
      },
      { status: 500 },
    );
  }
}
