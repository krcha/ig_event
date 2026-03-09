import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { runActiveVenueIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { hasClerkEnv } from "@/lib/utils/env";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
};

const DEFAULT_REPAIR_RESULTS_LIMIT = 100;
const DEFAULT_REPAIR_DAYS_BACK = 365;

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

  const resultsLimit = body.resultsLimit ?? DEFAULT_REPAIR_RESULTS_LIMIT;
  const daysBack = body.daysBack ?? DEFAULT_REPAIR_DAYS_BACK;

  try {
    const result = await runActiveVenueIngestion({
      resultsLimit,
      daysBack,
    });

    return NextResponse.json({
      source: "repair_active_venues",
      handles: result.venueHandles,
      summary: result.summary,
      config: { resultsLimit, daysBack },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run repair ingestion.",
      },
      { status: 500 },
    );
  }
}
