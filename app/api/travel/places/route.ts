import { compressedPublicJson } from "@/lib/http/compressed-json";
import { loadOutingDirectory, loadOutingProgrammes } from "@/lib/travel/outing-places";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const view = new URL(request.url).searchParams.get("view");
  try {
    if (view === "programmes") return compressedPublicJson({ programmes: await loadOutingProgrammes() }, request.headers, { headers });
    if (view === null) return compressedPublicJson({ places: await loadOutingDirectory() }, request.headers, { headers });
    return Response.json({ error: "Invalid view." }, { status: 400, headers });
  } catch {
    return Response.json({ error: "Public listings unavailable." }, { status: 503, headers });
  }
}
