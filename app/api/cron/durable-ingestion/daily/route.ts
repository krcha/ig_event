import { createHash } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { getActiveVenueHandles } from "@/lib/pipeline/run-instagram-ingestion";

export const dynamic = "force-dynamic";

const queueDaily = "durableIngestionRuns:queueRun" as unknown as FunctionReference<"mutation">;

function snapshotKey(handles: string[]): string {
  return createHash("sha256").update(handles.join("\n")).digest("hex");
}

/**
 * The sole scheduled entry point for daily paid work.  It freezes the current
 * active-source snapshot and either queues it or resumes the prior unfinished
 * daily run.  It never invokes Apify itself: the host runner starts the
 * bounded receipt executors only after this endpoint has returned a run id.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  try {
    const handles = await getActiveVenueHandles();
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const runId = await convex.mutation(queueDaily, {
      mode: "daily",
      sourceSnapshotKey: snapshotKey(handles),
      handles,
      resumeDaily: true,
      serviceSecret,
    });
    return NextResponse.json({ queuedOrResumed: true, mode: "daily", runId, selectedHandleCount: handles.length }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue daily durable ingestion." },
      { status: 500 },
    );
  }
}
