import { NextRequest, NextResponse } from "next/server";
import { isPlausibleConvexPublicId } from "@/lib/convex/public-id";
import { loadDiscoverEventsAfter } from "@/lib/discover/feed-page";
import {
  addDaysToDateKey,
  formatUtcDateKey,
  getNightlifeDefaultDateKey,
  parseDateKeyToUtcNoon,
} from "@/lib/events/nightlife-date";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") ?? "";
  const after = request.nextUrl.searchParams.get("after") ?? "";
  const revision = request.nextUrl.searchParams.get("revision") ?? "";
  const parsedDate = parseDateKeyToUtcNoon(date);
  const today = getNightlifeDefaultDateKey();

  // A tab opened before the 07:00 Belgrade rollover can still finish its old day.
  if (
    !parsedDate ||
    formatUtcDateKey(parsedDate) !== date ||
    date < addDaysToDateKey(today, -2) ||
    date > addDaysToDateKey(today, 1) ||
    !isPlausibleConvexPublicId(after) ||
    !/^[a-f0-9]{64}$/.test(revision)
  ) {
    return NextResponse.json({ error: "Invalid Discover page request." }, {
      headers: RESPONSE_HEADERS,
      status: 400,
    });
  }

  const batch = await loadDiscoverEventsAfter(date, after, revision);
  if (batch.error) {
    return NextResponse.json({ error: "Discover posts are temporarily unavailable." }, {
      headers: RESPONSE_HEADERS,
      status: 503,
    });
  }
  if (batch.cursorMissing || batch.feedChanged) {
    return NextResponse.json({ error: "The feed changed. Reload Discover to continue." }, {
      headers: RESPONSE_HEADERS,
      status: 409,
    });
  }

  return NextResponse.json({
    date,
    events: batch.events,
    hasMore: batch.hasMore,
    nextCursor: batch.nextCursor,
    totalEvents: batch.totalEvents,
  }, { headers: RESPONSE_HEADERS });
}
