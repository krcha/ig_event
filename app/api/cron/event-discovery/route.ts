import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { classifyEventDiscoveryBatch, type EventDiscoveryInput } from "@/lib/ai/classify-event-discovery";
import {
  PERFORMER_GENRE_RESEARCH_BATCH_LIMIT,
  researchPerformerGenresBatch,
} from "@/lib/ai/research-performer-genres";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
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
const SCAN_PAGE_LIMIT = 4;
let processing = false;
let prioritizeResearch = false;
let upcomingDateKey: string | undefined;
let recentClassificationIds: string[] = [];

type ClassificationCandidate = EventDiscoveryInput & { key: string; expectedUpdatedAt: number };
type ResearchCandidate = {
  key: string;
  expectedUpdatedAt: number;
  title: string;
  venue: string;
  date: string;
  city: string;
  format: PerformerGenreFormat;
  acts: PerformerGenreAct[];
};
type CandidatePage<T> = { events: T[]; cursor: string | null };
type UpcomingScan<T> = { pending: T[]; cursor: string | null };
const upcomingClassification: UpcomingScan<ClassificationCandidate> = { pending: [], cursor: null };
const upcomingResearch: UpcomingScan<ResearchCandidate> = { pending: [], cursor: null };
const historicalResearch: UpcomingScan<ResearchCandidate> = { pending: [], cursor: null };

async function refillUpcomingScan<T>(scan: UpcomingScan<T>, readPage: (cursor: string | null) => Promise<CandidatePage<T>>) {
  if (scan.pending.length) return;
  for (let page = 0; page < SCAN_PAGE_LIMIT; page++) {
    try {
      const result = await readPage(scan.cursor);
      scan.cursor = result.cursor;
      scan.pending = result.events;
      if (scan.pending.length || !scan.cursor) return;
    } catch (error) {
      scan.cursor = null;
      throw error;
    }
  }
}

function distinctByLatestRevision<T extends { key: string; expectedUpdatedAt: number }>(candidates: T[]) {
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.key);
    if (!existing || existing.expectedUpdatedAt < candidate.expectedUpdatedAt) unique.set(candidate.key, candidate);
  }
  return [...unique.values()];
}

async function researchNextBatch(
  convex: ReturnType<typeof createConvexHttpClient>, serviceSecret: string, upcomingFrom: string,
) {
  const hourMs = 60 * 60 * 1000;
  const retryBefore = Math.floor(Date.now() / hourMs) * hourMs - EMPTY_RESEARCH_RETRY_MS;
  await refillUpcomingScan(upcomingResearch, (cursor) =>
    convex.query(listGenreResearchInputs, { serviceSecret, cursor, retryBefore, upcomingFrom }));
  const focused: CandidatePage<ResearchCandidate> = recentClassificationIds.length
    ? await convex.query(listGenreResearchInputs, {
      serviceSecret, cursor: null, retryBefore, upcomingFrom, eventIds: recentClassificationIds,
    })
    : { events: [], cursor: null };
  // Keep one ordinary slot when freshly classified events are ready as well.
  let ordered = distinctByLatestRevision([
    ...upcomingResearch.pending.slice(0, 1), ...focused.events, ...upcomingResearch.pending.slice(1),
  ]);
  if (!ordered.length && !upcomingResearch.cursor) {
    await refillUpcomingScan(historicalResearch, async (cursor) => {
      const page: CandidatePage<ResearchCandidate> = await convex.query(listGenreResearchInputs, {
        serviceSecret, cursor, retryBefore,
      });
      return { ...page, events: page.events.filter(({ date }) => date < upcomingFrom) };
    });
    ordered = historicalResearch.pending;
  }
  const candidates: ResearchCandidate[] = [];
  let count = 0;
  for (const candidate of ordered) {
    if (candidates.length >= RESEARCH_EVENT_BATCH_SIZE ||
      count + candidate.acts.length > PERFORMER_GENRE_RESEARCH_BATCH_LIMIT) break;
    count += candidate.acts.length;
    candidates.push(candidate);
  }
  const attempted = new Set(candidates.map(({ key }) => key));
  // Failed attempts remain eligible when the scan wraps. They cannot block this page.
  upcomingResearch.pending = upcomingResearch.pending.filter(({ key }) => !attempted.has(key));
  historicalResearch.pending = historicalResearch.pending.filter(({ key }) => !attempted.has(key));
  recentClassificationIds = focused.events.filter(({ key }) => !attempted.has(key)).map(({ key }) => key);
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
  if (!successful.length) throw new Error("Performer research deferred.");
  const applied = await convex.mutation(recordGenreResearch, {
    serviceSecret,
    results: successful.map(({ row }) => row),
  });
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
    const upcomingFrom = getNightlifeDefaultDateKey();
    if (upcomingFrom !== upcomingDateKey) {
      upcomingDateKey = upcomingFrom;
      upcomingClassification.cursor = upcomingResearch.cursor = null;
      upcomingClassification.pending = [];
      upcomingResearch.pending = [];
    }
    const shouldResearch = prioritizeResearch;
    prioritizeResearch = !shouldResearch;
    if (shouldResearch) {
      const researched = await researchNextBatch(convex, serviceSecret, upcomingFrom);
      if (researched) return NextResponse.json(researched);
    }
    const recent: ClassificationCandidate[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SCAN_PAGE_LIMIT && recent.length < BATCH_SIZE; page++) {
      const result: CandidatePage<ClassificationCandidate> = await convex.query(listRecentInputs, { serviceSecret, cursor });
      recent.push(...result.events.slice(0, BATCH_SIZE - recent.length));
      cursor = result.cursor;
      if (!cursor) break;
    }
    await refillUpcomingScan(upcomingClassification, (cursor) =>
      convex.query(listRecentInputs, { serviceSecret, cursor, upcomingFrom }));
    const reserved = recent.length ? BATCH_SIZE / 2 : BATCH_SIZE;
    const candidates = distinctByLatestRevision([
      ...upcomingClassification.pending.slice(0, reserved), ...recent, ...upcomingClassification.pending.slice(reserved),
    ]).slice(0, BATCH_SIZE);
    if (!candidates.length) {
      const researched = shouldResearch ? undefined : await researchNextBatch(convex, serviceSecret, upcomingFrom);
      return NextResponse.json(researched ?? { state: "idle" });
    }

    const attempted = new Set(candidates.map(({ key }) => key));
    upcomingClassification.pending = upcomingClassification.pending.filter(({ key }) => !attempted.has(key));
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
    recentClassificationIds = [...new Set([...candidates.map(({ key }) => key), ...recentClassificationIds])].slice(0, BATCH_SIZE);
    prioritizeResearch = true;
    return NextResponse.json({ state: "processed", tested: results.length, applied, usage });
  } catch {
    return NextResponse.json({ state: "deferred" }, { status: 503 });
  } finally {
    processing = false;
  }
}
