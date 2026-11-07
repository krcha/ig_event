import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { classifyEventDiscoveryBatch, type EventDiscoveryInput } from "@/lib/ai/classify-event-discovery";
import {
  PERFORMER_GENRE_RESEARCH_BATCH_LIMIT,
  researchPerformerGenresBatch,
} from "@/lib/ai/research-performer-genres";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  EMPTY_RESEARCH_RETRY_MS,
  canPublishPerformerGenreSource,
  type PerformerGenreAct,
  type PerformerGenreFormat,
  type PerformerGenreMatch,
} from "@/lib/taxonomy/performer-genre-research";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const listRecentInputs = "eventDiscovery:listRecentInputs" as unknown as FunctionReference<"query">;
const recordBatch = "eventDiscovery:recordBatch" as unknown as FunctionReference<"mutation">;
const listGenreResearchInputs = "eventDiscovery:listGenreResearchInputs" as unknown as FunctionReference<"query">;
const recordGenreResearch = "eventDiscovery:recordGenreResearch" as unknown as FunctionReference<"mutation">;
const BATCH_SIZE = 12;
const RESEARCH_EVENT_BATCH_SIZE = 2;
let processing = false;
let prioritizeResearch = false;
let researchCursor: string | null = null;

type Candidate = {
  key: string;
  expectedUpdatedAt: number;
  title: string;
  venue: string;
  date: string;
  city: string;
  format: PerformerGenreFormat;
  acts: PerformerGenreAct[];
};
let pendingResearch: Candidate[] = [];

async function researchNextBatch(convex: ReturnType<typeof createConvexHttpClient>, serviceSecret: string) {
  if (!pendingResearch.length) {
    const hourMs = 60 * 60 * 1000;
    const retryBefore = Math.floor(Date.now() / hourMs) * hourMs - EMPTY_RESEARCH_RETRY_MS;
    for (let page = 0; page < 4; page++) {
      let result: { events: Candidate[]; cursor: string | null };
      try {
        result = await convex.query(listGenreResearchInputs, { serviceSecret, cursor: researchCursor, retryBefore });
      } catch (error) {
        researchCursor = null;
        throw error;
      }
      researchCursor = result.cursor;
      pendingResearch = result.events;
      if (pendingResearch.length || !researchCursor) break;
    }
  }
  const candidates: Candidate[] = [];
  let count = 0;
  for (const candidate of pendingResearch) {
    if (candidates.length >= RESEARCH_EVENT_BATCH_SIZE ||
      count + candidate.acts.length > PERFORMER_GENRE_RESEARCH_BATCH_LIMIT) break;
    count += candidate.acts.length;
    candidates.push(candidate);
  }
  if (!candidates.length) return;

  const researched = await Promise.allSettled(candidates.map(async (candidate) => {
    const inputs = candidate.acts.map((act, key) => ({
      ...act, key, eventTitle: candidate.title, venue: candidate.venue,
      date: candidate.date, city: candidate.city, trustedFormat: candidate.format,
    }));
    const { model, results, searchCalls, usage, responseId } = await researchPerformerGenresBatch(inputs, { thorough: true });
    const acts = inputs.map(({ key }) => results.get(key));
    if (acts.some((act) => !act)) throw new Error("Incomplete performer research batch.");
    const matches: PerformerGenreMatch[] = acts.flatMap((act) => {
      if (act?.status !== "resolved" || !act.identityEvidence ||
        !canPublishPerformerGenreSource(act.identityEvidence.url)) return [];
      const identityUrl = act.identityEvidence.url;
      return act.genreEvidence
        .filter(({ url }) => canPublishPerformerGenreSource(url))
        .map(({ genre, url }) => ({ performer: act.billedName, genre, url, identityUrl }));
    });
    return { searchCalls, usage, row: {
      eventId: candidate.key, expectedUpdatedAt: candidate.expectedUpdatedAt, model, matches,
      auditJson: JSON.stringify({ responseId, searchCalls, acts }),
    } };
  }));
  const successful = researched.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  if (!successful.length) {
    pendingResearch = [...pendingResearch.slice(candidates.length), ...candidates];
    throw new Error("Performer research deferred.");
  }
  const applied = await convex.mutation(recordGenreResearch, {
    serviceSecret,
    results: successful.map(({ row }) => row),
  });
  const completed = new Set(successful.map(({ row }) => row.eventId));
  pendingResearch = [...pendingResearch.slice(candidates.length), ...candidates.filter(({ key }) => !completed.has(key))];
  const searchCalls = successful.reduce((sum, row) => sum + row.searchCalls, 0);
  const usage = successful.reduce((sum, { usage }) => ({
    inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens,
    totalTokens: sum.totalTokens + usage.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return { state: "researched", tested: successful.length, deferred: candidates.length - successful.length, searchCalls, applied, usage };
}

export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }
  if (processing) return NextResponse.json({ state: "busy" }, { status: 202 });
  processing = true;
  try {
    const serviceSecret = requireServiceSecret();
    const convex = createConvexHttpClient();
    const shouldResearch = prioritizeResearch;
    prioritizeResearch = false;
    if (shouldResearch) {
      const researched = await researchNextBatch(convex, serviceSecret);
      if (researched) return NextResponse.json(researched);
    }
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
    if (!candidates.length) {
      const researched = shouldResearch ? undefined : await researchNextBatch(convex, serviceSecret);
      return NextResponse.json(researched ?? { state: "idle" });
    }

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
    prioritizeResearch = true;
    return NextResponse.json({ state: "processed", tested: results.length, applied, usage });
  } catch {
    return NextResponse.json({ state: "deferred" }, { status: 503 });
  } finally {
    processing = false;
  }
}
