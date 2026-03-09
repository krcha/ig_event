import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  runActiveVenueIngestion,
  type IngestionRunMode,
} from "@/lib/pipeline/run-instagram-ingestion";
import { hasClerkEnv } from "@/lib/utils/env";

type Body = {
  resultsLimit?: number;
  daysBack?: number;
  mode?: IngestionRunMode;
};

function normalizeMode(value: unknown): IngestionRunMode {
  return value === "saved_posts" ? "saved_posts" : "full_scrape";
}

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
    const mode = normalizeMode(body.mode);
    const result = await runActiveVenueIngestion({
      resultsLimit: body.resultsLimit,
      daysBack: body.daysBack,
      mode,
    });
    return NextResponse.json({
      source: "active_venues",
      mode,
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
