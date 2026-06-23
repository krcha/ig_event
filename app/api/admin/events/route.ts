import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { canonicalizeEventType } from "@/lib/taxonomy/venue-types";

type EventStatus = "pending" | "approved" | "rejected";
type PromotionTier = "featured" | "promoted";

type EventListQuery = {
  status: EventStatus;
  limit?: number;
};

type EventListAllQuery = {
  limit?: number;
};

type UpdatePromotionRequestBody = {
  eventId?: string;
  promotionEnd?: string | null;
  promotionPriority?: number | string | null;
  promotionStart?: string | null;
  promotionTier?: PromotionTier | "none" | null;
};

type EventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
  normalizedFieldsJson?: string;
  promotionTier?: PromotionTier;
  promotionStart?: string;
  promotionEnd?: string;
  promotionPriority?: number;
  status: EventStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  moderationNote?: string;
  createdAt: number;
  updatedAt: number;
};

const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;
const listEventsQuery =
  "events:listEvents" as unknown as FunctionReference<"query">;
const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;

function mapEventRecord(event: EventRecord) {
  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    artists: event.artists,
    description: event.description ?? null,
    imageUrl: event.imageUrl ?? null,
    instagramPostUrl: event.instagramPostUrl ?? null,
    ticketPrice: event.ticketPrice ?? null,
    eventType: canonicalizeEventType(event.eventType),
    sourceCaption: event.sourceCaption ?? null,
    sourcePostedAt: event.sourcePostedAt ?? null,
    rawExtractionJson: event.rawExtractionJson ?? null,
    normalizedFieldsJson: event.normalizedFieldsJson ?? null,
    promotionTier: event.promotionTier ?? null,
    promotionStart: event.promotionStart ?? null,
    promotionEnd: event.promotionEnd ?? null,
    promotionPriority: event.promotionPriority ?? null,
    moderation: {
      status: event.status,
      reviewedAt: event.reviewedAt ?? null,
      reviewedBy: event.reviewedBy ?? null,
      moderationNote: event.moderationNote ?? null,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function parseStatus(value: string | null): EventStatus {
  if (value === "approved" || value === "rejected" || value === "pending") {
    return value;
  }
  return "pending";
}

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

function normalizeDateValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error("Promotion dates must use YYYY-MM-DD.");
  }
  return value.trim();
}

function normalizePromotionPriority(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error("Promotion priority must be a number.");
  }
  return Math.trunc(parsed);
}

function normalizePromotionTier(value: unknown): PromotionTier | "none" {
  if (value === null || value === undefined || value === "" || value === "none") {
    return "none";
  }
  if (value === "featured" || value === "promoted") {
    return value;
  }
  throw new Error("Promotion tier must be none, featured, or promoted.");
}

export async function GET(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }

  const { searchParams } = new URL(request.url);
  const status = parseStatus(searchParams.get("status"));
  const limitParam = Number(searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;
  const includeDuplicateContext = searchParams.get("duplicateContext") === "1";

  try {
    const convex = getConvexHttpClient();
    const events = (await convex.query(listByStatusQuery, {
      status,
      limit,
    } satisfies EventListQuery)) as EventRecord[];
    const duplicateContextLimit = Math.max(limit * 3, 300);
    const duplicateContextEvents = includeDuplicateContext
      ? ((await convex.query(listEventsQuery, {
          limit: Math.min(duplicateContextLimit, 600),
        } satisfies EventListAllQuery)) as EventRecord[])
      : [];

    return NextResponse.json({
      status,
      events: events.map(mapEventRecord),
      duplicateContextEvents: duplicateContextEvents.map(mapEventRecord),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list moderation events.",
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

  let body: UpdatePromotionRequestBody;
  try {
    body = (await request.json()) as UpdatePromotionRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventId = body.eventId?.trim() || "";
  if (!eventId) {
    return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  }

  try {
    const tier = normalizePromotionTier(body.promotionTier);
    const patch =
      tier === "none"
        ? {
            promotionEnd: undefined,
            promotionPriority: undefined,
            promotionStart: undefined,
            promotionTier: undefined,
          }
        : {
            promotionEnd: normalizeDateValue(body.promotionEnd),
            promotionPriority: normalizePromotionPriority(body.promotionPriority),
            promotionStart: normalizeDateValue(body.promotionStart),
            promotionTier: tier,
          };
    const convex = getConvexHttpClient();
    await convex.mutation(updateEventMutation, {
      id: eventId,
      patch,
    });

    return NextResponse.json({
      eventId,
      ok: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update promotion.",
      },
      { status: 500 },
    );
  }
}
