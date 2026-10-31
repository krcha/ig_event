import { createHmac } from "node:crypto";
import { NextResponse, userAgent, type NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { cleanLabel, cleanPath } from "@/lib/analytics/model";
import { getVisitorCountry } from "@/lib/analytics/geolocation";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  let sameOrigin = origin === request.nextUrl.origin;
  try {
    // Standalone Next.js can construct nextUrl with its internal container host.
    // Host is the public host preserved by the ingress; do not trust arbitrary
    // X-Forwarded-Host values supplied by clients.
    const parsed = new URL(origin ?? "");
    const publicHost = request.headers.get("host");
    sameOrigin ||= parsed.origin === origin && parsed.host === publicHost &&
      (parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:"));
  } catch { /* Missing or invalid Origin is rejected. */ }
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
    return new NextResponse(null, { status: 403, headers: noStore });
  }
  const agent = userAgent(request);
  if (agent.isBot || request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") {
    return new NextResponse(null, { status: 204, headers: noStore });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new NextResponse(null, { status: 415, headers: noStore });
  }
  if (Number(request.headers.get("content-length")) > 4096) return new NextResponse(null, { status: 413, headers: noStore });
  try {
    // Bound streamed bodies too; a missing Content-Length cannot bypass the limit.
    const reader = request.body?.getReader();
    if (!reader) return new NextResponse(null, { status: 400, headers: noStore });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return new NextResponse(null, { status: 413, headers: noStore }); }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const path = cleanPath(data.path);
    if (!path || !uuid.test(data.eventId) || !uuid.test(data.visitorId) || !uuid.test(data.sessionId) || !["pageview", "click"].includes(data.kind)) {
      return new NextResponse(null, { status: 400, headers: noStore });
    }
    const secret = requireServiceSecret();
    const hash = (value: string) => createHmac("sha256", secret).update(`analytics:${value}`).digest("hex");
    const country = await getVisitorCountry(request.headers);
    await createConvexHttpClient().mutation(api.analytics.record, {
      serviceSecret: secret,
      event: {
        eventId: data.eventId, visitorId: hash(data.visitorId), sessionId: hash(data.sessionId),
        kind: data.kind, path, target: data.kind === "click" ? cleanLabel(data.target, 160) || "Button" : "",
        source: cleanLabel(data.source, 100) || "Direct", medium: cleanLabel(data.medium, 80), campaign: cleanLabel(data.campaign, 100),
        country, device: agent.device.type === "tablet" ? "Tablet" : agent.device.type === "mobile" ? "Mobile" : agent.device.type ? "Other" : "Desktop",
        browser: cleanLabel(agent.browser.name, 40) || "Unknown", os: cleanLabel(agent.os.name, 40) || "Unknown", at: Date.now(),
      },
    });
    return new NextResponse(null, { status: 204, headers: noStore });
  } catch {
    // No submitted body, identifiers, or service credentials in logs/responses.
    return new NextResponse(null, { status: 503, headers: noStore });
  }
}
