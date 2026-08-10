import { createHash } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import {
  selectDeterministicCanary,
  type DurableIngestionMode,
} from "@/lib/pipeline/durable-ingestion-controller";
import { getActiveVenueHandles } from "@/lib/pipeline/run-instagram-ingestion";

const queueRunMutation =
  "durableIngestionRuns:queueRun" as unknown as FunctionReference<"mutation">;

type Body = { mode?: DurableIngestionMode; handles?: string[] };

function isMode(value: unknown): value is DurableIngestionMode {
  return value === "canary" || value === "catch_up" || value === "daily";
}

function snapshotKey(handles: string[]): string {
  return createHash("sha256")
    .update(handles.join("\n"))
    .digest("hex");
}

/** Queue only. A separate authenticated executor must claim receipts before it
 * can call Apify, keeping queue/probe/paid execution independently auditable. */
export async function POST(request: Request) {
  const adminAccess = await requireAdminApiAccess();
  if (!adminAccess.ok) return adminAccess.response;
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  if (!isMode(body.mode)) {
    return NextResponse.json({ error: "mode must be canary, catch_up, or daily." }, { status: 400 });
  }
  // An explicit handle list is permitted only for the deterministic canary;
  // catch-up and daily must snapshot the active source list at queue time.
  const activeHandles = body.mode === "canary" && Array.isArray(body.handles)
    ? body.handles
    : await getActiveVenueHandles();
  const handles = body.mode === "canary" ? selectDeterministicCanary(activeHandles) : activeHandles;
  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const runId = await convex.mutation(queueRunMutation, {
      mode: body.mode,
      sourceSnapshotKey: snapshotKey(handles),
      handles,
    });
    return NextResponse.json({ queued: true, runId, mode: body.mode, selectedHandleCount: handles.length }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not queue durable ingestion run." }, { status: 500 });
  }
}
