import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  buildDailyCarouselPayload,
  EVENT_ZEKA_PUBLIC_ORIGIN,
  getBelgradeDate,
  getNextIsoDate,
  type DailyCarouselEvent,
} from "@/lib/social/daily-carousel";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const listPublicCalendarEventsWindowQuery =
  "events:listPublicCalendarEventsWindow" as unknown as FunctionReference<"query">;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function getPublicOrigin(request: Request): string {
  const configuredOrigin = process.env.EVENT_ZEKA_PUBLIC_ORIGIN?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/+$/, "");
  }
  const requestUrl = new URL(request.url);
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") {
    return requestUrl.origin;
  }
  return EVENT_ZEKA_PUBLIC_ORIGIN;
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
    const origin = getPublicOrigin(request);
    const payload = buildDailyCarouselPayload({
      events,
      publishDate,
      eventDates,
      publicOrigin: origin,
    });

    return NextResponse.json(payload, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build daily carousel.";
    const status = /date|YYYY-MM-DD/i.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }
}
