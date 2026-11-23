import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { resolveEventGenresBatch, type EventGenreCandidate, type EventGenreResolution } from "@/lib/ai/resolve-event-genres";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

const listDailyInputs = "eventDiscovery:listDailyInputs" as unknown as FunctionReference<"query">;
const recordDailyBatch = "eventDiscovery:recordDailyBatch" as unknown as FunctionReference<"mutation">;
const claimUpcomingBatch = "eventDiscovery:claimUpcomingBatch" as unknown as FunctionReference<"mutation">;
const completeUpcomingBatch = "eventDiscovery:completeUpcomingBatch" as unknown as FunctionReference<"mutation">;
const MAX_SWEEP_PAGES = 8;
let processing = false;

function storageRows(results: readonly EventGenreResolution[]) {
  return results.map(({ eventId, expectedUpdatedAt, taxonomy, auditJson, estimatedGenres, webResearch, deferred }) => ({
    eventId, expectedUpdatedAt, taxonomy, auditJson,
    ...(estimatedGenres ? { estimatedGenres } : {}), ...(webResearch ? { webResearch } : {}), ...(deferred ? { deferred } : {}),
  }));
}

export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  const cursor = searchParams.get("cursor");
  if ((runId !== null && !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(runId)) || (cursor !== null && (!runId || !cursor || cursor.length > 4096))) {
    return NextResponse.json({ error: "Invalid discovery run or page cursor." }, { status: 400 });
  }
  if (!runId && !process.env.OPENAI_API_KEY?.trim()) return NextResponse.json({ state: "idle", tested: 0 });
  if (processing) return NextResponse.json({ state: "busy" }, { status: 409 });
  processing = true;
  const deadlineAt = Date.now() + 220_000;
  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    if (!runId) {
      const owner = randomUUID();
      for (let page = 0; page < MAX_SWEEP_PAGES && Date.now() < deadlineAt; page++) {
        const batch = await convex.mutation(claimUpcomingBatch, { serviceSecret, owner }) as {
          state: "claimed" | "scanned" | "idle" | "busy"; events: EventGenreCandidate[];
        };
        if (batch.state === "scanned") continue;
        if (batch.state !== "claimed") return NextResponse.json({ state: batch.state, tested: 0 });
        try {
          const resolved = await resolveEventGenresBatch(batch.events, { deadlineAt });
          const applied = await convex.mutation(completeUpcomingBatch, { serviceSecret, owner, model: resolved.model,
            results: storageRows(resolved.results) }) as { completed: boolean; counts: { written: number; unchanged: number; stale: number } };
          if (!applied.completed) return NextResponse.json({ state: "deferred" }, { status: 503 });
          return NextResponse.json({ state: "processed", tested: resolved.results.length, searchCalls: resolved.searchCalls, applied });
        } catch {
          // Advance the sweep so one failing batch never blocks later events.
          await convex.mutation(completeUpcomingBatch, { serviceSecret, owner, model: "deferred", results: [] });
          return NextResponse.json({ state: "deferred" }, { status: 503 });
        }
      }
      return NextResponse.json({ state: "scanned", tested: 0 });
    }
    const page: { events: EventGenreCandidate[]; cursor: string | null } = await convex.query(listDailyInputs, { serviceSecret, runId, cursor });
    if (!page.events.length) {
      return NextResponse.json({ state: page.cursor ? "processed" : "idle", cursor: page.cursor, tested: 0 });
    }

    const resolved = await resolveEventGenresBatch(page.events, { deadlineAt });
    const applied = await convex.mutation(recordDailyBatch, {
      serviceSecret, runId, model: resolved.model,
      results: storageRows(resolved.results),
    });
    return NextResponse.json({ state: "processed", cursor: page.cursor, tested: resolved.results.length,
      localClassified: resolved.localClassified,
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
