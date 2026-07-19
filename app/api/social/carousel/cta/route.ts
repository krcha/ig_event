import { renderCtaCarouselSlide } from "@/lib/social/carousel-images";

export const runtime = "nodejs";

export async function GET() {
  const image = await renderCtaCarouselSlide();
  return new Response(new Uint8Array(image), {
    headers: {
      "cache-control": "public, max-age=604800, stale-while-revalidate=2592000",
      "content-type": "image/jpeg",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff",
    },
  });
}
