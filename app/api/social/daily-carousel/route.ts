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
import { logGeneratorFailure } from "@/lib/social/generator-diagnostics";
import { readPublicationContext, type PublicationContext } from "@/lib/social/publication-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const listPublicCalendarEventsWindowQuery =
  "events:listPublicCalendarEventsWindowPaginated" as unknown as FunctionReference<"query">;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getRequestedDate(request: Request): string {
  const parameters = new URL(request.url).searchParams;
  if (parameters.getAll("date").length > 1) throw new Error("Repeated date.");
  const requestedDate = parameters.get("date")?.trim();
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

async function buildResponse(request: Request, context: PublicationContext = {}) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized social publishing request." }, { status: 401 });
  }

  let publishDate = "";
  let stage: "query" | "payload/layout" = "query";
  let diagnosticPage: number | null = null;
  const startedAt = Date.now();
  try {
    publishDate = getRequestedDate(request);
    const tomorrow = getNextIsoDate(publishDate);
    const dayAfterTomorrow = getNextIsoDate(tomorrow);
    const thirdDay = getNextIsoDate(dayAfterTomorrow);
    const eventDates = [tomorrow, dayAfterTomorrow, thirdDay];
    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const events: DailyCarouselEvent[] = [];
    let cursor: string | null = null;
    let complete = false;
    const seenCursors = new Set<string>();
    for (let count = 0; count < 100; count++) {
      diagnosticPage = count + 1;
      const page = (await convex.query(listPublicCalendarEventsWindowQuery, {
        beforeDate: getNextIsoDate(thirdDay),
        cursor,
        fromDate: tomorrow,
      })) as {
        continueCursor: string;
        isDone: boolean;
        page: DailyCarouselEvent[];
      };
      events.push(...page.page);
      if (page.isDone) { complete = true; break; }
      if (!page.continueCursor || seenCursors.has(page.continueCursor)) throw new Error("Incomplete public event window.");
      seenCursors.add(page.continueCursor);
      cursor = page.continueCursor;
    }
    if (!complete) throw new Error("Incomplete public event window.");
    const origin = getPublicOrigin(request);
    stage = "payload/layout";
    diagnosticPage = null;
    const payload = buildDailyCarouselPayload({
      ...context,
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
    const status = /date|YYYY-MM-DD/i.test(message) ? 400 : 503;
    if (status === 503) logGeneratorFailure(error, { format: "carousel", publishDate, stage, page: diagnosticPage, startedAt });
    return NextResponse.json(
      {
        error: status === 400 ? message : "Could not build daily carousel.",
      },
      { status },
    );
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
