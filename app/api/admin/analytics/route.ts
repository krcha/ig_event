import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { isAnalyticsOwner } from "@/lib/analytics/access";
import { getAnalyticsRange, type AnalyticsGroup } from "@/lib/analytics/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const access = await requireAdminApiAccess();
  const headers = { "Cache-Control": "private, no-store" };
  if (!access.ok) {
    access.response.headers.set("Cache-Control", "private, no-store");
    return access.response;
  }
  if (!isAnalyticsOwner(access.userId, process.env)) return NextResponse.json({ error: "Analytics are available only to the owner." }, { status: 403, headers });
  const start = request.nextUrl.searchParams.get("start") ?? "";
  const end = request.nextUrl.searchParams.get("end") ?? "";
  const group = request.nextUrl.searchParams.get("group") as AnalyticsGroup;
  try {
    if (!["hour", "day", "month"].includes(group)) throw new Error("Choose hourly, daily, or monthly grouping.");
    getAnalyticsRange(start, end, group);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid date range." }, { status: 400, headers });
  }
  try {
    const client = await createAuthenticatedConvexHttpClient();
    const report = await client.action(api.analytics.report, { start, end, group });
    return NextResponse.json(report, { headers });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message.includes("Choose a shorter date range");
    return NextResponse.json({ error: tooLarge ? "Too much traffic for this range. Choose a shorter date range." : "Analytics could not be loaded. Check the backend connection and try again." }, { status: tooLarge ? 422 : 503, headers });
  }
}
