import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { AgendaRenderError, renderAgendaPoster } from "@/lib/social/agenda-images";
import { getNextIsoDate, type DailyCarouselEvent } from "@/lib/social/daily-carousel";
import { buildStoryAgendaRenderVersion, isEventAvailableForMorningStory } from "@/lib/social/daily-stories";
import { reelVideoResponse, renderDailyAgendaVideo } from "@/lib/social/reel-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const getPublicEvent = "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
type PublicEventRecord = DailyCarouselEvent & { status: "approved" };

function errorResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}

export async function GET(request: Request, context: { params: Promise<{ date: string }> }) {
  const { date } = await context.params;
  const parameters = new URL(request.url).searchParams;
  const ids = (parameters.get("events") ?? "").split(",");
  const version = parameters.get("v") ?? "";
  const publishDate = parameters.get("publishDate") ?? date;
  try { getNextIsoDate(date); getNextIsoDate(publishDate); }
  catch { return errorResponse("Story and publication dates must be real YYYY-MM-DD dates.", 400); }
  if (publishDate !== date) return errorResponse("Story event date must match its publication date.", 400);
  if (parameters.getAll("events").length !== 1 || parameters.getAll("v").length !== 1 || parameters.getAll("publishDate").length > 1 ||
    parameters.getAll("cover").length > 1 || (parameters.has("cover") && parameters.get("cover") !== "1") ||
    ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length ||
    ids.some(id => !/^[a-z0-9]{10,64}$/.test(id)) || !/^s[12345]-[a-z0-9]{1,16}$/.test(version)) {
    return errorResponse("Story requires one to four unique event IDs and its render version.", 400);
  }
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) return errorResponse("Story rendering is not configured.", 503);
  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
    const records = await Promise.all(ids.map(async id => await convex.query(getPublicEvent, { id }) as PublicEventRecord | null));
    if (records.some((event, index) => !event || event._id !== ids[index] || event.status !== "approved" || !isEventAvailableForMorningStory(event, date))) {
      return errorResponse("A selected event is no longer public for this Story date.", 404);
    }
    const events = records as PublicEventRecord[];
    if (buildStoryAgendaRenderVersion(date, events, publishDate) !== version) return errorResponse("Event facts or daily design changed. Refresh the Story payload.", 409);
    if (parameters.get("cover") === "1") {
      const image = await renderAgendaPoster({ date, events, position: 0, format: "story", publishDate });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(image), { headers: { "cache-control": "public, max-age=60, must-revalidate", "content-type": "image/jpeg", "content-length": String(image.byteLength), "x-content-type-options": "nosniff" } });
    }
    return reelVideoResponse(await renderDailyAgendaVideo(date, events, { format: "story", publishDate }), request);
  } catch (error) {
    return errorResponse(error instanceof AgendaRenderError ? "Complete event identities cannot be rendered safely." : "Could not verify or render selected public events.", error instanceof AgendaRenderError ? 422 : 503);
  }
}

export const HEAD = GET;
