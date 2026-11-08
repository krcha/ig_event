import { getVisitorIpCountry } from "@/lib/analytics/geolocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const country = await getVisitorIpCountry(request.headers);
  const headers = { "Cache-Control": "private, no-store" };
  if (country === "CN") {
    return new Response("Access is unavailable from this location.", { status: 403, headers });
  }
  return new Response(null, { status: 204, headers });
}
