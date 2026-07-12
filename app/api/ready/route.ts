import { NextResponse } from "next/server";
import { getReadinessStatus } from "@/lib/config/readiness";

export const dynamic = "force-dynamic";

export function GET() {
  const readiness = getReadinessStatus();
  return NextResponse.json(readiness, {
    headers: { "Cache-Control": "no-store, max-age=0" },
    status: readiness.ok ? 200 : 503,
  });
}
