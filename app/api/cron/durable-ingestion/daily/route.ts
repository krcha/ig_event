import { createHash } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { getActiveVenueHandles } from "@/lib/pipeline/run-instagram-ingestion";

export const dynamic = "force-dynamic";

const queueDaily = "durableIngestionRuns:queueDailyRun" as unknown as FunctionReference<"mutation">;
const buildQueueBatch = "durableIngestionRuns:buildQueueBatch" as unknown as FunctionReference<"mutation">;

function snapshotKey(handles: string[]): string {
  return createHash("sha256").update(handles.join("\n")).digest("hex");
}

/**
 * The sole scheduled entry point for daily paid work.  It freezes the current
 * active-source snapshot and either queues it or resumes the prior unfinished
 * durable run. Today's snapshot is persisted before an older run is returned,
 * so the host launcher can drain both without losing the timer occurrence. It
 * never invokes Apify itself: the host runner starts the bounded receipt
 * executors only after this endpoint has returned a run id.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  try {
    const handles = await getActiveVenueHandles();
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const admission = await convex.mutation(queueDaily, {
      sourceSnapshotKey: snapshotKey(handles),
      handles,
      serviceSecret,
    }) as {
      runId: string;
      runMode: "canary" | "catch_up" | "daily";
      runStatus: "building" | "queued" | "running" | "completed" | "failed";
      currentDayKey: string;
      runDayKey: string | null;
      currentDayQueued: boolean;
      followUpRequired: boolean;
      executeRequired: boolean;
      selectedHandleCount: number;
      builtCount: number;
    };
    const runId = admission.runId;
    let built: { builtCount: number; selectedHandleCount: number; complete: boolean } | null = null;
    if (admission.executeRequired) {
      for (let attempt = 0; attempt < 128; attempt += 1) {
        built = await convex.mutation(buildQueueBatch, { runId, serviceSecret }) as { builtCount: number; selectedHandleCount: number; complete: boolean };
        if (built.complete) break;
      }
    }
    const finalBuild = built;
    return NextResponse.json({
      queuedOrResumed: admission.executeRequired
        ? finalBuild?.complete === true
        : admission.currentDayQueued,
      building: admission.executeRequired && finalBuild?.complete !== true,
      mode: "daily",
      runMode: admission.runMode,
      runId,
      runStatus: admission.runStatus,
      currentDayKey: admission.currentDayKey,
      runDayKey: admission.runDayKey,
      currentDayQueued: admission.currentDayQueued,
      followUpRequired: admission.followUpRequired,
      executeRequired: admission.executeRequired,
      selectedHandleCount: admission.selectedHandleCount,
      builtCount: finalBuild?.builtCount ?? admission.builtCount,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue daily durable ingestion." },
      { status: 500 },
    );
  }
}
