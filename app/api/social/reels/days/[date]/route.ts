import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { AgendaRenderError } from "@/lib/social/agenda-images";
import { getNextIsoDate, type DailyCarouselEvent } from "@/lib/social/daily-carousel";
import { buildReelRenderVersion } from "@/lib/social/daily-reels";
import { reelVideoResponse, renderDailyReel, renderReelCover } from "@/lib/social/reel-video";
import { resolvePosterPublicationDate } from "@/lib/social/poster-directions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
const getPublicEvent = "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
const failure = (message: string, status: number) => new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });

export async function GET(request: Request, context: { params: Promise<{ date: string }> }) {
  const { date } = await context.params;
  const query = new URL(request.url).searchParams;
  const ids = (query.get("events") || "").split(",");
  const version = query.get("v") || "";
  let publishDate: string;
  try { getNextIsoDate(date); publishDate = resolvePosterPublicationDate(date, 0, "reel", query.get("publishDate") ?? undefined); }
  catch { return failure("Reel and publication dates must be real YYYY-MM-DD dates.", 400); }
  if (getNextIsoDate(publishDate) !== date) return failure("Reel event date must be tomorrow relative to publication.", 400);
  if (query.getAll("events").length !== 1 || query.getAll("v").length !== 1 || query.getAll("cover").length > 1 || query.getAll("publishDate").length > 1 ||
    (query.has("cover") && query.get("cover") !== "1") || ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length ||
    ids.some(id => !/^[a-z0-9]{10,64}$/.test(id)) || !/^r[2345]-[a-z0-9]{1,16}$/.test(version)) return failure("Reel requires exact unique event IDs and its render version.", 400);
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) return failure("Reel rendering is not configured.", 503);
  try {
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
    const records = await Promise.all(ids.map(id => client.query(getPublicEvent, { id }))) as Array<(DailyCarouselEvent & { status: string }) | null>;
    if (records.some((event, index) => !event || event._id !== ids[index] || event.status !== "approved" || event.date !== date)) return failure("A selected Reel event is no longer public for this date.", 404);
    const events = records as DailyCarouselEvent[];
    if (version !== buildReelRenderVersion(date, events, publishDate)) return failure("Event facts or daily design changed. Refresh the Reel payload.", 409);
    if (query.get("cover") === "1") {
      const image = await renderReelCover(date, events, publishDate);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(image), { headers: { "content-type": "image/jpeg", "content-length": String(image.length), "cache-control": "public, max-age=60, must-revalidate", "x-content-type-options": "nosniff" } });
    }
    return reelVideoResponse(await renderDailyReel(date, events, publishDate), request);
  } catch (error) { return failure(error instanceof AgendaRenderError ? "Complete event identities cannot fit safely." : "Could not verify or render this Reel.", error instanceof AgendaRenderError ? 422 : 503); }
}

export const HEAD = GET;
