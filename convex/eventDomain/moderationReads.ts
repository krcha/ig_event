import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_MODERATION_DUPLICATE_CONTEXT_DATES } from "../../lib/events/moderation-duplicate-context";
import { requireAdminIdentity, requireAdminOrServiceSecret } from "../authz";
import {
  buildPendingModerationUniquenessReview,
  type PendingModerationUniquenessReviewItem,
} from "./moderationUniqueness";
import { dateKeyToUtcMs } from "./publicReads";

const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS = 100;
const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE = 8;
const MODERATION_DUPLICATE_CONTEXT_DATE_BATCH_SIZE = 4;
const MODERATION_DUPLICATE_CONTEXT_TITLE_LENGTH = 300;
const MODERATION_DUPLICATE_CONTEXT_TIME_LENGTH = 32;
const MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH = 300;
const MODERATION_DUPLICATE_CONTEXT_ARTIST_COUNT = 100;
const MODERATION_DUPLICATE_CONTEXT_ARTIST_LENGTH = 200;
const MODERATION_DUPLICATE_CONTEXT_DESCRIPTION_LENGTH = 1_000;
const MODERATION_DUPLICATE_CONTEXT_EVENT_TYPE_LENGTH = 100;
const MODERATION_DUPLICATE_CONTEXT_CAPTION_LENGTH = 2_000;
const PENDING_MODERATION_UNIQUENESS_PREVIEW_NOTE =
  "Preview-only unique moderation review; no status mutation is performed.";

function projectModerationDuplicateContextEvent(event: Doc<"events">) {
  return {
    _id: event._id,
    title: event.title.slice(0, MODERATION_DUPLICATE_CONTEXT_TITLE_LENGTH),
    date: event.date,
    ...(event.time
      ? { time: event.time.slice(0, MODERATION_DUPLICATE_CONTEXT_TIME_LENGTH) }
      : {}),
    venue: event.venue.slice(0, MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH),
    ...(event.normalizedVenueIdentity
      ? {
          normalizedVenueIdentity: event.normalizedVenueIdentity.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH,
          ),
        }
      : {}),
    ...(event.normalizedVenueInstagramHandle
      ? {
          normalizedVenueInstagramHandle:
            event.normalizedVenueInstagramHandle.slice(
              0,
              MODERATION_DUPLICATE_CONTEXT_VENUE_LENGTH,
            ),
        }
      : {}),
    artists: event.artists
      .slice(0, MODERATION_DUPLICATE_CONTEXT_ARTIST_COUNT)
      .map((artist) =>
        artist.slice(0, MODERATION_DUPLICATE_CONTEXT_ARTIST_LENGTH),
      ),
    ...(event.description
      ? {
          description: event.description.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_DESCRIPTION_LENGTH,
          ),
        }
      : {}),
    eventType: event.eventType.slice(
      0,
      MODERATION_DUPLICATE_CONTEXT_EVENT_TYPE_LENGTH,
    ),
    ...(event.sourceCaption
      ? {
          sourceCaption: event.sourceCaption.slice(
            0,
            MODERATION_DUPLICATE_CONTEXT_CAPTION_LENGTH,
          ),
        }
      : {}),
    status: event.status,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export async function listModerationDuplicateContextByDatesHandler(
  ctx: QueryCtx,
  args: { dates: string[] },
) {
  await requireAdminIdentity(ctx);
  if (args.dates.length > MAX_MODERATION_DUPLICATE_CONTEXT_DATES) {
    throw new Error(
      `Moderation duplicate context accepts at most ${MAX_MODERATION_DUPLICATE_CONTEXT_DATES} dates.`,
    );
  }
  const dates: string[] = [];
  const seenDates = new Set<string>();
  for (const candidate of args.dates) {
    const date = candidate.trim();
    if (dateKeyToUtcMs(date) === null) {
      throw new Error(
        "Moderation duplicate context dates must use valid YYYY-MM-DD values.",
      );
    }
    if (!seenDates.has(date)) {
      seenDates.add(date);
      dates.push(date);
    }
  }

  const contextEvents: ReturnType<
    typeof projectModerationDuplicateContextEvent
  >[] = [];
  let truncated = false;
  let start = 0;
  for (
    ;
    start < dates.length &&
    contextEvents.length < MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS;
  ) {
    const remainingCapacity =
      MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS - contextEvents.length;
    const dateBatchSize = Math.min(
      MODERATION_DUPLICATE_CONTEXT_DATE_BATCH_SIZE,
      Math.ceil(
        remainingCapacity / MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE,
      ),
    );
    const dateBatch = dates.slice(start, start + dateBatchSize);
    start += dateBatch.length;
    const eventBatches = await Promise.all(
      dateBatch.map((date) =>
        ctx.db
          .query("events")
          .withIndex("by_status_date", (q) =>
            q.eq("status", "approved").eq("date", date),
          )
          .order("desc")
          .take(MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE + 1),
      ),
    );
    for (const eventBatch of eventBatches) {
      if (
        eventBatch.length > MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE
      ) {
        truncated = true;
      }
      for (const event of eventBatch.slice(
        0,
        MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE,
      )) {
        if (contextEvents.length >= MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS) {
          truncated = true;
          break;
        }
        contextEvents.push(projectModerationDuplicateContextEvent(event));
      }
    }
  }
  if (start < dates.length) truncated = true;
  return { events: contextEvents, truncated };
}

export async function classifyPendingModerationUniquenessHandler(
  ctx: QueryCtx,
  args: {
    items: PendingModerationUniquenessReviewItem[];
    asOfMs: number;
    serviceSecret?: string;
  },
) {
  await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  const review = await buildPendingModerationUniquenessReview(ctx, {
    items: args.items,
    asOfMs: args.asOfMs,
    moderationNote: PENDING_MODERATION_UNIQUENESS_PREVIEW_NOTE,
  });
  return review.result;
}
