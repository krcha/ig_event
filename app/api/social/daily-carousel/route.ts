import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  buildDailyCarouselPayload,
  getBelgradeDate,
  getNextIsoDate,
  type DailyCarouselEvent,
} from "@/lib/social/daily-carousel";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export async function GET(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized social publishing request." }, { status: 401 });
  }

  try {
    const publishDate = getRequestedDate(request);
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const events = (await convex.query(listPublicCalendarEventsWindowQuery, {
      fromDate: publishDate,
      beforeDate: getNextIsoDate(publishDate),
    })) as DailyCarouselEvent[];
    const origin = new URL(request.url).origin;
    const payload = buildDailyCarouselPayload({ events, publishDate, publicOrigin: origin });

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
