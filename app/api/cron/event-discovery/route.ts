import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { classifyEventDiscoveryBatch, type EventDiscoveryInput } from "@/lib/ai/classify-event-discovery";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const listRecentInputs = "eventDiscovery:listRecentInputs" as unknown as FunctionReference<"query">;
const recordBatch = "eventDiscovery:recordBatch" as unknown as FunctionReference<"mutation">;
const BATCH_SIZE = 12;
let processing = false;

export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  if (processing) return NextResponse.json({ state: "busy" }, { status: 202 });
  processing = true;
  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const candidates: Array<EventDiscoveryInput & { key: string; expectedUpdatedAt: number }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4 && candidates.length < BATCH_SIZE; page++) {
      const result = await convex.query(listRecentInputs, { serviceSecret, cursor }) as {
        events: typeof candidates; cursor: string | null;
      };
      candidates.push(...result.events.slice(0, BATCH_SIZE - candidates.length));
      cursor = result.cursor;
      if (!cursor) break;
    }
    if (!candidates.length) return NextResponse.json({ state: "idle" });

    const { model, results, usage } = await classifyEventDiscoveryBatch(candidates);
    const revisions = new Map(candidates.map((item) => [item.key, item.expectedUpdatedAt]));
    const applied = await convex.mutation(recordBatch, {
      serviceSecret,
      model,
      results: results.map(({ key, taxonomy, credits, evidence, discardedClaims }) => ({
        eventId: key,
        expectedUpdatedAt: revisions.get(String(key)),
        taxonomy,
        auditJson: JSON.stringify({ credits, evidence, discardedClaims }),
      })),
    });
    return NextResponse.json({ state: "processed", tested: results.length, applied, usage });
  } catch {
    return NextResponse.json({ state: "deferred" }, { status: 503 });
  } finally {
    processing = false;
  }
}
