import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { hasClerkEnv } from "@/lib/utils/env";

type ScrapeRequestBody = {
  handles?: string[];
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

  let body: ScrapeRequestBody;
  try {
    body = (await request.json()) as ScrapeRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const handles = (body.handles ?? [])
    .map((handle) => handle.trim())
    .filter((handle) => handle.length > 0);

  if (handles.length === 0) {
    return NextResponse.json(
      { error: "At least one Instagram handle is required." },
      { status: 400 },
    );
  }

  try {
    const summary = await runInstagramIngestion({
      handles,
      resultsLimit: body.resultsLimit,
      daysBack: body.daysBack,
    });
    return NextResponse.json({
      source: "manual",
      handles,
      summary,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run ingestion pipeline.",
      },
      { status: 500 },
    );
  }
}
