import { getCachedCarouselJpeg } from "@/lib/social/carousel-jpeg-cache";
import { SOCIAL_DESIGN_VERSION } from "@/lib/social/poster-directions";
import { renderClosingCarouselSlide } from "@/lib/social/agenda-images";
import { buildClosingCtaRenderVersion } from "@/lib/social/carousel-cta";
import { getNextIsoDate } from "@/lib/social/daily-carousel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const version = parameters.get("v");
  const date = parameters.get("date") || undefined;
  try {
    if (parameters.getAll("date").length > 1) throw new Error("Repeated date.");
    if (date) getNextIsoDate(date);
  } catch { return new Response("Invalid closing artwork date.", { status: 400, headers: { "cache-control": "no-store" } }); }
  if (parameters.getAll("v").length > 1 || (version !== null && version !== buildClosingCtaRenderVersion(date))) {
    return new Response("Closing artwork changed. Refresh the daily carousel payload.", {
      status: 409,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  const image = await getCachedCarouselJpeg(
    { kind: "cta", date, version: buildClosingCtaRenderVersion(date), design: SOCIAL_DESIGN_VERSION },
    () => renderClosingCarouselSlide(date),
  );
  return new Response(request.method === "HEAD" ? null : new Uint8Array(image), {
    headers: {
      "cache-control": "public, max-age=60, must-revalidate",
      "content-type": "image/jpeg",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}

export const HEAD = GET;
