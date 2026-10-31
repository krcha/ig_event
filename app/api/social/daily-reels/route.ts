import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server.js";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { buildDailyReelPayload } from "@/lib/social/daily-reels";
import { EVENT_ZEKA_PUBLIC_ORIGIN, getBelgradeDate, getNextIsoDate, type DailyCarouselEvent } from "@/lib/social/daily-carousel";
import { getRequiredEnv } from "@/lib/utils/env";
import { logGeneratorFailure } from "@/lib/social/generator-diagnostics";
import { readPublicationContext, type PublicationContext } from "@/lib/social/publication-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const listPublicEvents = "events:listPublicCalendarEventsWindowPaginated" as unknown as FunctionReference<"query">;

async function buildResponse(request: Request, context: PublicationContext = {}) {
  const headers = { "cache-control": "no-store" };
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized Reel publishing request." }, { status: 401, headers });
  const url = new URL(request.url);
  const publishDate = url.searchParams.get("date")?.trim() || getBelgradeDate();
  let eventDate: string;
  try {
    if (url.searchParams.getAll("date").length > 1) throw new Error("Repeated date.");
    eventDate = getNextIsoDate(publishDate);
  } catch { return NextResponse.json({ error: "date must be a real YYYY-MM-DD date." }, { status: 400, headers }); }
  let stage: "query" | "payload/layout" = "query";
  let diagnosticPage: number | null = null;
  const startedAt = Date.now();
  try {
    const client = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const events: DailyCarouselEvent[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      diagnosticPage = pageNumber + 1;
      const page = await client.query(listPublicEvents, { fromDate: eventDate, beforeDate: getNextIsoDate(eventDate), cursor }) as {
        page: DailyCarouselEvent[]; isDone: boolean; continueCursor: string;
      };
      events.push(...page.page);
      if (page.isDone) { complete = true; break; }
      if (!page.continueCursor || seen.has(page.continueCursor)) throw new Error("Incomplete event window.");
      seen.add(page.continueCursor); cursor = page.continueCursor;
    }
    if (!complete) throw new Error("Incomplete event window.");
    const publicOrigin = process.env.EVENT_ZEKA_PUBLIC_ORIGIN?.trim() || EVENT_ZEKA_PUBLIC_ORIGIN;
    stage = "payload/layout";
    diagnosticPage = null;
    return NextResponse.json(buildDailyReelPayload({ ...context, events, publishDate, publicOrigin }), { headers });
  } catch (error) {
    logGeneratorFailure(error, { format: "reel", publishDate, stage, page: diagnosticPage, startedAt }); return NextResponse.json({ error: "Could not load the complete public event window for tomorrow's Reel." }, { status: 503, headers }); }
}

export async function GET(request: Request) { return buildResponse(request); }

export async function POST(request: Request) {
  const headers = { "cache-control": "no-store" };
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized Reel publishing request." }, { status: 401, headers });
  try {
    return buildResponse(request, await readPublicationContext(request));
  } catch { return NextResponse.json({ error: "Invalid publication context." }, { status: 400, headers }); }
}
