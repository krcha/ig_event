import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { AgendaRenderError, renderAgendaPoster } from "@/lib/social/agenda-images";
import {
  buildAgendaRenderVersion,
  getNextIsoDate,
  type DailyCarouselEvent,
} from "@/lib/social/daily-carousel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;

type RouteContext = { params: Promise<{ date: string }> };
type PublicEventRecord = DailyCarouselEvent & { status: "approved" };

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { date } = await context.params;
  const parameters = new URL(request.url).searchParams;
  const ids = (parameters.get("events") ?? "").split(",");
  const positionText = parameters.get("position") ?? "";
  const version = parameters.get("v") ?? "";
  try {
    getNextIsoDate(date);
  } catch {
    return errorResponse("Poster date must be a real YYYY-MM-DD date.", 400);
  }
  if (
    parameters.getAll("events").length !== 1 ||
    parameters.getAll("position").length !== 1 ||
    parameters.getAll("v").length !== 1 ||
    ids.length < 1 || ids.length > 3 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9]{10,64}$/.test(id)) ||
    !/^[012]$/.test(positionText) ||
    !/^[a-z0-9]{1,16}$/.test(version)
  ) {
    return errorResponse("Poster requires one to three unique event IDs, position 0-2 and its render version.", 400);
  }
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return errorResponse("Agenda rendering is not configured.", 503);
  const position = Number(positionText);

  try {
    const convex = new ConvexHttpClient(convexUrl);
    // Bounded exact-ID reads preserve the payload's selection and use the same
    // publication/venue visibility policy as public event details.
    const records = await Promise.all(ids.map(async (id) =>
      await convex.query(getPublicApprovedEventQuery, { id }) as PublicEventRecord | null,
    ));
    if (records.some((event, index) => !event || event._id !== ids[index] || event.status !== "approved" || event.date !== date)) {
      return errorResponse("A selected event is no longer public on this date.", 404);
    }
    const events = records as PublicEventRecord[];
    if (buildAgendaRenderVersion(date, events, position) !== version) {
      return errorResponse("Selected event facts changed. Refresh the daily agenda payload.", 409);
    }
    const image = await renderAgendaPoster({ date, events, position });
    return new Response(new Uint8Array(image), {
      headers: {
        "cache-control": "public, max-age=60, must-revalidate",
        "content-type": "image/jpeg",
        "content-length": String(image.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AgendaRenderError) {
      return errorResponse("Complete event identities cannot be rendered safely on this poster.", 422);
    }
    return errorResponse("Could not verify or render the selected public events.", 503);
  }
}
