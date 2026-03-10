import { NextResponse } from "next/server";
import { runActiveVenueIngestion } from "@/lib/pipeline/run-instagram-ingestion";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorizedCronRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return true;
  }

  const authorizationHeader = request.headers.get("authorization");
  return authorizationHeader === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  try {
    const result = await runActiveVenueIngestion();
    return NextResponse.json({
      source: "cron_active_venues",
      handles: result.venueHandles,
      summary: result.summary,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run scheduled venue ingestion.",
      },
      { status: 500 },
    );
  }
}
