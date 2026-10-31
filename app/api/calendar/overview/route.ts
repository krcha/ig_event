import { NextRequest, NextResponse } from "next/server";
import { loadPublicCalendarOverviewWindow } from "@/lib/events/public-calendar-overview";
import { getMobileWeekOverviewWindows } from "@/lib/events/mobile-week";
import { parseDateKeyToUtcNoon } from "@/lib/events/nightlife-date";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const month = params.get("month") ?? "";
  const weekStart = params.get("weekStart") ?? "";
  const q = params.get("q")?.trim() || undefined;
  const venue = params.get("venue")?.trim() || undefined;
  const weekDate = parseDateKeyToUtcNoon(weekStart);
  if (!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(month) || !weekDate || !Number.isFinite(weekDate.getTime()) || weekDate.toISOString().slice(0, 10) !== weekStart || (q?.length ?? 0) > 200 || (venue?.length ?? 0) > 200) {
    return NextResponse.json({ error: "Invalid calendar range." }, { status: 400 });
  }
  const fromDate = `${month}-01`;
  const next = new Date(`${fromDate}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const beforeDate = next.toISOString().slice(0, 10);
  const extraWeekWindows = getMobileWeekOverviewWindows(weekStart, { fromDate, beforeDate });
  const [overview, ...extra] = await Promise.all([
    loadPublicCalendarOverviewWindow({ fromDate, beforeDate, q, venue }),
    ...extraWeekWindows.map(window => loadPublicCalendarOverviewWindow({ ...window, q, venue })),
  ]);
  if ([overview, ...extra].some(result => result.error)) {
    return NextResponse.json({ error: "Calendar counts are unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ groups: [overview, ...extra].flatMap(result => result.groups), venues: overview.venues, generatedAt: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
