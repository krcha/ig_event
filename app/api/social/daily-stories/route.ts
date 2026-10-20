import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server.js";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { buildDailyStoriesPayload } from "@/lib/social/daily-stories";
import { EVENT_ZEKA_PUBLIC_ORIGIN, getBelgradeDate, getNextIsoDate, type DailyCarouselEvent } from "@/lib/social/daily-carousel";
import { getRequiredEnv } from "@/lib/utils/env";
import { logGeneratorFailure } from "@/lib/social/generator-diagnostics";
import { readPublicationContext, type PublicationContext } from "@/lib/social/publication-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const listPublicEvents = "events:listPublicCalendarEventsWindowPaginated" as unknown as FunctionReference<"query">;

async function buildResponse(request: Request, context: PublicationContext = {}) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized social publishing request." }, { status: 401 });
  }
  const url = new URL(request.url);
  const publishDate = url.searchParams.get("date")?.trim() || getBelgradeDate();
  try {
    if (url.searchParams.getAll("date").length > 1) throw new Error("Repeated date.");
    getNextIsoDate(publishDate);
  } catch {
    return NextResponse.json({ error: "date must be a real YYYY-MM-DD date." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  let stage: "query" | "payload/layout" = "query";
  let diagnosticPage: number | null = null;
  const startedAt = Date.now();
  try {
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const events: DailyCarouselEvent[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let complete = false;
    for (let count = 0; count < 100; count += 1) {
      diagnosticPage = count + 1;
      const page = await convex.query(listPublicEvents, { fromDate: publishDate, beforeDate: getNextIsoDate(publishDate), cursor }) as {
        page: DailyCarouselEvent[]; isDone: boolean; continueCursor: string;
      };
      events.push(...page.page);
      if (page.isDone) { complete = true; break; }
      if (!page.continueCursor || seenCursors.has(page.continueCursor)) throw new Error("Incomplete public event window.");
      seenCursors.add(page.continueCursor);
      cursor = page.continueCursor;
    }
    if (!complete) throw new Error("Incomplete public event window.");
    const origin = process.env.EVENT_ZEKA_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "") ||
      (["localhost", "127.0.0.1"].includes(url.hostname) ? url.origin : EVENT_ZEKA_PUBLIC_ORIGIN);
    stage = "payload/layout";
    diagnosticPage = null;
    return NextResponse.json(buildDailyStoriesPayload({ ...context, events, publishDate, publicOrigin: origin }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logGeneratorFailure(error, { format: "story", publishDate, stage, page: diagnosticPage, startedAt });
    return NextResponse.json({ error: "Could not load the complete public event window for today's Stories." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export async function GET(request: Request) { return buildResponse(request); }
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized social publishing request." }, { status: 401 });
  let context: PublicationContext;
  try { context = await readPublicationContext(request); }
  catch { return NextResponse.json({ error: "Invalid publication context." }, { status: 400, headers: { "cache-control": "no-store" } }); }
  return buildResponse(request, context);
}
