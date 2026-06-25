import { NextResponse } from "next/server";
import { getReadinessStatus } from "@/lib/config/readiness";

export const dynamic = "force-dynamic";

export function GET() {
  const readiness = getReadinessStatus();
  return NextResponse.json(readiness, {
    status: readiness.ok ? 200 : 503,
  });
}
