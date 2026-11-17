import { loadVenueMusicContext } from "@/lib/travel/venue-music-profile";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (!/^[a-z0-9]{16,64}$/u.test(venueId)) return Response.json({ error: "Invalid venue." }, { status: 400, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), 6_000); });
    return Response.json(await Promise.race([loadVenueMusicContext(venueId), deadline]), { headers });
  } catch {
    return Response.json({ error: "Music data is unavailable. Please retry." }, { status: 503, headers });
  } finally { if (timer) clearTimeout(timer); }
}
