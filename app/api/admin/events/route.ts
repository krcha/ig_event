import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import type { EventTimeSource, EventTimeStatus } from "@/lib/events/event-time";
import {
  getModerationDuplicateContextDates,
  loadModerationDuplicateContextWithFallback,
  mergeModerationDuplicateContextEvents,
} from "@/lib/events/moderation-duplicate-context";
import { buildSameDateModerationBatches } from "@/lib/events/moderation-uniqueness-batches";
import { canonicalizeEventType } from "@/lib/taxonomy/venue-types";

type EventStatus = "pending" | "approved" | "rejected";
type PromotionTier = "featured" | "promoted";

type EventListPaginatedQuery = {
  status: EventStatus;
  paginationOpts: {
    cursor: string | null;
    numItems: number;
  };
};

type EventListPaginatedResult = {
  continueCursor: string;
  isDone: boolean;
  page: EventRecord[];
  pageStatus?: string;
};

type PendingUniquenessDisposition =
  | "unique"
  | "duplicate"
  | "ambiguous"
  | "ineligible"
  | "indeterminate";

type PendingUniquenessItem = {
  id: string;
  expectedUpdatedAt: number;
  disposition: PendingUniquenessDisposition;
  reason: string;
  conflictIds: string[];
};

type PendingUniquenessResult = {
  complete: boolean;
  items: PendingUniquenessItem[];
};

type ModerationDuplicateContextQuery = {
  dates: string[];
};

type UpdatePromotionRequestBody = {
  eventId?: string;
  expectedUpdatedAt?: number;
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
  timeSource?: EventTimeSource;
  timeEvidenceText?: string;
  timeConfidence?: number;
  timeStatus?: EventTimeStatus;
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

type ModerationDuplicateContextRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  normalizedVenueIdentity?: string;
  normalizedVenueInstagramHandle?: string;
  artists: string[];
  description?: string;
  eventType: string;
  sourceCaption?: string;
  status: EventStatus;
  createdAt: number;
  updatedAt: number;
};

type ModerationDuplicateContextResult = {
  events: ModerationDuplicateContextRecord[];
  truncated: boolean;
};

const MODERATION_PAGE_SIZE = 25;
const MAX_MODERATION_EVENTS = 200;
const MAX_PENDING_UNIQUENESS_ITEMS = 10;

const listByStatusPaginatedQuery =
  "events:listByStatusPaginated" as unknown as FunctionReference<"query">;
const classifyPendingModerationUniquenessQuery =
  "events:classifyPendingModerationUniqueness" as unknown as FunctionReference<"query">;
const listModerationDuplicateContextByDatesQuery =
  "events:listModerationDuplicateContextByDates" as unknown as FunctionReference<"query">;
const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;

function mapEventRecord(event: EventRecord) {
  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    timeSource: event.timeSource ?? "unknown",
    timeEvidenceText: event.timeEvidenceText ?? null,
    timeConfidence: event.timeConfidence ?? 0,
    timeStatus: event.timeStatus ?? "unknown",
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

function isPendingUniquenessDisposition(
  value: unknown,
): value is PendingUniquenessDisposition {
  return (
    value === "unique" ||
    value === "duplicate" ||
    value === "ambiguous" ||
    value === "ineligible" ||
    value === "indeterminate"
  );
}

function makeIndeterminateUniqueness(
  event: EventRecord,
  reason: string,
): PendingUniquenessItem {
  return {
    id: event._id,
    expectedUpdatedAt: event.updatedAt,
    disposition: "indeterminate",
    reason,
    conflictIds: [],
  };
}

function mapModerationDuplicateContextRecord(
  event: ModerationDuplicateContextRecord,
) {
  const normalizedFieldsJson = JSON.stringify({
    normalizedDate: event.date,
    ...(event.normalizedVenueIdentity
      ? { normalizedVenue: event.normalizedVenueIdentity }
      : {}),
    ...(event.normalizedVenueInstagramHandle
      ? { locationName: event.normalizedVenueInstagramHandle }
      : {}),
  });

  return {
    id: event._id,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    timeSource: "unknown" as const,
    timeEvidenceText: null,
    timeConfidence: 0,
    timeStatus: "unknown" as const,
    venue: event.venue,
    artists: event.artists,
    description: event.description ?? null,
    imageUrl: null,
    instagramPostUrl: null,
    ticketPrice: null,
    eventType: canonicalizeEventType(event.eventType),
    sourceCaption: event.sourceCaption ?? null,
    sourcePostedAt: null,
    rawExtractionJson: null,
    normalizedFieldsJson,
    promotionTier: null,
    promotionStart: null,
    promotionEnd: null,
    promotionPriority: null,
    moderation: {
      status: event.status,
      reviewedAt: null,
      reviewedBy: null,
      moderationNote: null,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    pendingUniqueness: null,
  };
}

function parseStatus(value: string | null): EventStatus {
  if (value === "approved" || value === "rejected" || value === "pending") {
    return value;
  }
  return "pending";
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

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /reviewed version|expectedUpdatedAt/iu.test(error.message);
}

export async function GET(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) {
    return adminAccess.response;
  }

  const { searchParams } = new URL(request.url);
  const status = parseStatus(searchParams.get("status"));
  const limitParam = Number(searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(MAX_MODERATION_EVENTS, limitParam))
    : 50;
  const includeDuplicateContext = searchParams.get("duplicateContext") === "1";

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const events: EventRecord[] = [];
    let cursor: string | null = null;
    let eventListComplete = false;

    for (
      let pageNumber = 0;
      pageNumber < Math.ceil(MAX_MODERATION_EVENTS / MODERATION_PAGE_SIZE) &&
      events.length < limit;
      pageNumber += 1
    ) {
      const pageSize = Math.min(MODERATION_PAGE_SIZE, limit - events.length);
      const pageResult = (await convex.query(listByStatusPaginatedQuery, {
        status,
        paginationOpts: {
          cursor,
          numItems: pageSize,
        },
      } satisfies EventListPaginatedQuery)) as EventListPaginatedResult;

      if (pageResult.pageStatus === "SplitRequired") {
        throw new Error(
          "Moderation pagination requires a split; refusing a partial queue read.",
        );
      }
      if (!Array.isArray(pageResult.page) || pageResult.page.length > pageSize) {
        throw new Error("Moderation pagination returned an invalid page.");
      }

      events.push(...pageResult.page);
      if (pageResult.isDone) {
        eventListComplete = true;
        break;
      }
      if (!pageResult.continueCursor || pageResult.continueCursor === cursor) {
        throw new Error("Moderation pagination cursor stalled.");
      }
      cursor = pageResult.continueCursor;
    }

    const pendingUniquenessById = new Map<string, PendingUniquenessItem>();
    let pendingUniquenessComplete = status === "pending" && eventListComplete;
    if (status === "pending") {
      const classificationAsOfMs = Date.now();
      const eventChunks = buildSameDateModerationBatches(
        events,
        MAX_PENDING_UNIQUENESS_ITEMS,
      );
      for (const eventChunk of eventChunks) {
        const requestedVersionById = new Map(
          eventChunk.map((event) => [event._id, event.updatedAt] as const),
        );
        let classification: PendingUniquenessResult;
        try {
          classification = (await convex.query(
            classifyPendingModerationUniquenessQuery,
            {
              items: eventChunk.map((event) => ({
                id: event._id,
                expectedUpdatedAt: event.updatedAt,
              })),
              asOfMs: classificationAsOfMs,
            },
          )) as PendingUniquenessResult;
        } catch (error) {
          pendingUniquenessComplete = false;
          console.error(
            JSON.stringify({
              level: "error",
              event: "moderation_uniqueness_classification_degraded",
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown moderation uniqueness classification error.",
            }),
          );
          for (const event of eventChunk) {
            pendingUniquenessById.set(
              event._id,
              makeIndeterminateUniqueness(
                event,
                "The server could not verify this event's uniqueness.",
              ),
            );
          }
          continue;
        }

        if (!classification.complete || !Array.isArray(classification.items)) {
          pendingUniquenessComplete = false;
        }

        const seenClassificationIds = new Set<string>();
        for (const item of classification.items ?? []) {
          const expectedUpdatedAt = requestedVersionById.get(item.id);
          if (
            expectedUpdatedAt === undefined ||
            seenClassificationIds.has(item.id) ||
            item.expectedUpdatedAt !== expectedUpdatedAt ||
            !isPendingUniquenessDisposition(item.disposition) ||
            !Array.isArray(item.conflictIds)
          ) {
            pendingUniquenessComplete = false;
            continue;
          }
          seenClassificationIds.add(item.id);
          pendingUniquenessById.set(item.id, item);
        }

        for (const event of eventChunk) {
          if (!seenClassificationIds.has(event._id)) {
            pendingUniquenessComplete = false;
            pendingUniquenessById.set(
              event._id,
              makeIndeterminateUniqueness(
                event,
                "The server did not return an exact uniqueness classification.",
              ),
            );
          }
        }
      }
    }

    const mappedEvents = events.map((event) => ({
      ...mapEventRecord(event),
      pendingUniqueness:
        status === "pending"
          ? (pendingUniquenessById.get(event._id) ??
            makeIndeterminateUniqueness(
              event,
              "The event was not classified for unique approval.",
            ))
          : null,
    }));
    const duplicateContextDates = getModerationDuplicateContextDates(events);
    const duplicateContext = await loadModerationDuplicateContextWithFallback({
      baseEvents: mappedEvents,
      includeDuplicateContext,
      loadContext: async () => {
        if (duplicateContextDates.length === 0) {
          return { events: [], truncated: false };
        }

        const context = (await convex.query(
          listModerationDuplicateContextByDatesQuery,
          {
            dates: duplicateContextDates,
          } satisfies ModerationDuplicateContextQuery,
        )) as ModerationDuplicateContextResult;
        return {
          events: mergeModerationDuplicateContextEvents(
            mappedEvents,
            context.events.map(mapModerationDuplicateContextRecord),
          ),
          truncated: context.truncated,
        };
      },
      onLoadError: (error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "moderation_duplicate_context_degraded",
            message:
              error instanceof Error
                ? error.message
                : "Unknown moderation duplicate-context error.",
          }),
        );
      },
    });

    return NextResponse.json({
      status,
      events: mappedEvents,
      eventListComplete,
      pendingUniquenessComplete,
      duplicateContextEvents: duplicateContext.duplicateContextEvents,
      duplicateContextDegraded: duplicateContext.degraded,
      duplicateContextTruncated: duplicateContext.truncated,
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
  if (!Number.isSafeInteger(body.expectedUpdatedAt)) {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be the exact reviewed event version." },
      { status: 400 },
    );
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
    const convex = await createAuthenticatedConvexHttpClient();
    await convex.mutation(updateEventMutation, {
      id: eventId,
      expectedUpdatedAt: body.expectedUpdatedAt,
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
      { status: isVersionConflict(error) ? 409 : 500 },
    );
  }
}
