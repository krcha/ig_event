import { renderCtaCarouselSlide } from "@/lib/social/carousel-images";

export const runtime = "nodejs";

export async function GET() {
  const image = await renderCtaCarouselSlide();
  return new Response(new Uint8Array(image), {
    headers: {
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "content-type": "image/png",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}
