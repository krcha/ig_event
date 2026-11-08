import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { resolveEventGenresBatch, type EventGenreCandidate } from "@/lib/ai/resolve-event-genres";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

const listDailyInputs = "eventDiscovery:listDailyInputs" as unknown as FunctionReference<"query">;
const recordDailyBatch = "eventDiscovery:recordDailyBatch" as unknown as FunctionReference<"mutation">;
let processing = false;

export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  const cursor = searchParams.get("cursor");
  if (!runId || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(runId) || (cursor !== null && (!cursor || cursor.length > 4096))) {
    return NextResponse.json({ error: "A completed daily ingestion run is required." }, { status: 400 });
  }
  if (processing) return NextResponse.json({ state: "busy" }, { status: 409 });
  processing = true;
  const deadlineAt = Date.now() + 220_000;
  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const page: { events: EventGenreCandidate[]; cursor: string | null } = await convex.query(listDailyInputs, { serviceSecret, runId, cursor });
    if (!page.events.length) {
      return NextResponse.json({ state: page.cursor ? "processed" : "idle", cursor: page.cursor, tested: 0 });
    }

    const resolved = await resolveEventGenresBatch(page.events, { deadlineAt });
    const applied = await convex.mutation(recordDailyBatch, {
      serviceSecret, runId, model: resolved.model,
      results: resolved.results.map(({ method: _method, deferred: _deferred, ...result }) => result),
    });
    return NextResponse.json({ state: "processed", cursor: page.cursor, tested: resolved.results.length,
      estimated: resolved.results.filter(({ method }) => method === "estimate").length,
      webSourced: resolved.results.filter(({ method }) => method === "web").length,
      deferred: resolved.results.filter(({ deferred }) => deferred).length, searchCalls: resolved.searchCalls,
      applied, usage: resolved.usage, estimateUsage: resolved.estimateUsage });
  } catch {
    return NextResponse.json({ state: "deferred" }, { status: 503 });
  } finally {
    processing = false;
  }
}
