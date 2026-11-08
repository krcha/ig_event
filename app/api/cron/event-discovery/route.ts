import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { classifyEventDiscoveryBatch, type EventDiscoveryInput } from "@/lib/ai/classify-event-discovery";
import { estimatePerformerGenresBatch } from "@/lib/ai/estimate-performer-genres";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { getEventDiscoveryTaxonomy } from "@/lib/taxonomy/event-discovery";
import { getPerformerGenreResearchActs, getPerformerGenreResearchFormat } from "@/lib/taxonomy/performer-genre-research";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

const listDailyInputs = "eventDiscovery:listDailyInputs" as unknown as FunctionReference<"query">;
const recordDailyBatch = "eventDiscovery:recordDailyBatch" as unknown as FunctionReference<"mutation">;
type Candidate = EventDiscoveryInput & { key: string; expectedUpdatedAt: number; eventType: string; artists: string[]; description?: string };
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
  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const page: { events: Candidate[]; cursor: string | null } = await convex.query(listDailyInputs, { serviceSecret, runId, cursor });
    if (!page.events.length) {
      return NextResponse.json({ state: page.cursor ? "processed" : "idle", cursor: page.cursor, tested: 0 });
    }

    const classified = await classifyEventDiscoveryBatch(page.events);
    const candidates = new Map<string | number, Candidate>(page.events.map((event) => [event.key, event]));
    const toEstimate = classified.results.flatMap(({ key, taxonomy }) => {
      const event = candidates.get(key);
      if (!event) throw new Error("Missing daily classification input.");
      const format = getPerformerGenreResearchFormat(taxonomy ?? getEventDiscoveryTaxonomy(event));
      if (!format) return [];
      const acts = getPerformerGenreResearchActs(event, format).filter(({ titleOnly }) => !titleOnly);
      return acts.length ? [{ key, eventTitle: event.title, acts }] : [];
    });
    // An optional estimate must not hold back the advertised event labels.
    const estimated = toEstimate.length ? await estimatePerformerGenresBatch(toEstimate).catch(() => null) : null;
    const applied = await convex.mutation(recordDailyBatch, {
      serviceSecret, runId, model: classified.model,
      results: classified.results.map(({ key, taxonomy, credits, evidence, discardedClaims }) => {
        const estimatedGenres = estimated?.results.get(key);
        return {
          eventId: key, expectedUpdatedAt: candidates.get(key)!.expectedUpdatedAt, taxonomy,
          ...(estimatedGenres?.length ? { estimatedGenres } : {}),
          auditJson: JSON.stringify({ credits, evidence, discardedClaims, ...(estimatedGenres?.length ? { estimateModel: estimated?.model } : {}) }),
        };
      }),
    });
    return NextResponse.json({ state: "processed", cursor: page.cursor, tested: classified.results.length,
      estimated: [...(estimated?.results.values() ?? [])].filter((genres) => genres.length).length,
      estimateDeferred: toEstimate.length > 0 && !estimated, applied, usage: classified.usage, estimateUsage: estimated?.usage });
  } catch {
    return NextResponse.json({ state: "deferred" }, { status: 503 });
  } finally {
    processing = false;
  }
}
