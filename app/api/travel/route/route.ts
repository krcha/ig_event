import { handleTravelRouteRequest } from "@/lib/travel/route-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleTravelRouteRequest(request);
}
