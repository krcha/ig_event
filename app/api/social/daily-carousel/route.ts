import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  balanceDailyCarouselEvents,
  buildDailyCarouselPayload,
  getBelgradeDate,
  getNextIsoDate,
  rankDailyCarouselEvents,
  type DailyCarouselEvent,
} from "@/lib/social/daily-carousel";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const listPublicCalendarEventsWindowQuery =
  "events:listPublicCalendarEventsWindow" as unknown as FunctionReference<"query">;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POSTER_CANDIDATES = 30;
const POSTER_PROBE_BATCH_SIZE = 6;

function getRequestedDate(request: Request): string {
  const requestedDate = new URL(request.url).searchParams.get("date")?.trim();
  if (!requestedDate) {
    return getBelgradeDate();
  }
  if (!ISO_DATE_PATTERN.test(requestedDate)) {
    throw new Error("date must use YYYY-MM-DD format.");
  }
  getNextIsoDate(requestedDate);
  return requestedDate;
}

async function hasUsablePoster(request: Request, event: DailyCarouselEvent): Promise<boolean> {
  const url = new URL(`/api/discover/images/${encodeURIComponent(event._id)}`, request.url);
  const handle = event.venueInstagramHandle?.trim().replace(/^@+/, "").toLowerCase();
  if (handle) {
    url.searchParams.set("handle", handle);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    await response.body?.cancel();
    return response.ok && contentType.startsWith("image/") && !contentType.includes("svg");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectPosterReadyEvents(
  request: Request,
  events: DailyCarouselEvent[],
  publishDate: string,
  eventDates: string[],
): Promise<DailyCarouselEvent[]> {
  const ranked = rankDailyCarouselEvents(events, publishDate, eventDates);
  const candidates = ranked.slice(0, MAX_POSTER_CANDIDATES);
  const posterReady: DailyCarouselEvent[] = [];

  for (let offset = 0; offset < candidates.length; offset += POSTER_PROBE_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + POSTER_PROBE_BATCH_SIZE);
    const availability = await Promise.all(batch.map((event) => hasUsablePoster(request, event)));
    batch.forEach((event, index) => {
      if (availability[index]) {
        posterReady.push(event);
      }
    });
    const balanced = balanceDailyCarouselEvents(posterReady, eventDates);
    const quota = Math.floor(6 / Math.max(1, eventDates.length));
    if (
      balanced.length >= 6 &&
      eventDates.every(
        (date) => balanced.filter((event) => event.date === date).length >= quota,
      )
    ) {
      return balanced;
    }
  }

  const posterReadyIds = new Set(posterReady.map((event) => event._id));
  return balanceDailyCarouselEvents(
    [...posterReady, ...ranked.filter((event) => !posterReadyIds.has(event._id))],
    eventDates,
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized social publishing request." }, { status: 401 });
  }

  try {
    const publishDate = getRequestedDate(request);
    const tomorrow = getNextIsoDate(publishDate);
    const dayAfterTomorrow = getNextIsoDate(tomorrow);
    const eventDates = [tomorrow, dayAfterTomorrow];
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const events = (await convex.query(listPublicCalendarEventsWindowQuery, {
      fromDate: tomorrow,
      beforeDate: getNextIsoDate(dayAfterTomorrow),
    })) as DailyCarouselEvent[];
    const origin = new URL(request.url).origin;
    const selectedEvents = await selectPosterReadyEvents(
      request,
      events,
      publishDate,
      eventDates,
    );
    const payload = buildDailyCarouselPayload({
      events,
      publishDate,
      eventDates,
      publicOrigin: origin,
      selectedEvents,
    });

    return NextResponse.json(payload, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not build daily carousel.",
      },
      { status: 500 },
    );
  }
}
