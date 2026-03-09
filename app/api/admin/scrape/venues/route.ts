import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { runActiveVenueIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { hasClerkEnv } from "@/lib/utils/env";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
};

export async function POST(request: Request) {
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }

  try {
    const result = await runActiveVenueIngestion({
      resultsLimit: body.resultsLimit,
      daysBack: body.daysBack,
    });
    return NextResponse.json({
      source: "active_venues",
      handles: result.venueHandles,
      summary: result.summary,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run venue ingestion.",
      },
      { status: 500 },
    );
  }
}
