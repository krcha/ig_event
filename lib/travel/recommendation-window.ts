import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { buildPublicCalendarDateWindows } from "../events/public-calendar-windows";
import { isPriorityCalendarWindow, prunePublicEventReadCache } from "../events/public-event-read-cache";
import type { RecommendationCandidate } from "./event-recommendations";

const DAY_CACHE_MS = 60_000;
const MAX_CACHED_DAYS = 64;
const MAX_CONCURRENT_READS = 2;

type DateWindow = { fromDate: string; beforeDate: string };
type CachedDay = { expiresAt: number; priority: boolean; rows: RecommendationCandidate[] };

const completedDays = new Map<string, CachedDay>();
const pendingDays = new Map<string, Promise<RecommendationCandidate[]>>();
const waiting: Array<() => void> = [];
let activeReads = 0;

// Share the query budget between reference pages, including cold requests for different dates.
async function readDay(client: ConvexHttpClient, day: DateWindow) {
  if (activeReads >= MAX_CONCURRENT_READS) {
    await new Promise<void>(resume => waiting.push(resume));
  } else {
    activeReads++;
  }
  try {
    const rows: RecommendationCandidate[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { page: RecommendationCandidate[]; isDone: boolean; continueCursor: string } =
        await client.query(api.events.listPublicRecommendationWindowPaginated, { ...day, cursor });
      rows.push(...page.page);
      if (page.isDone) return rows;
      if (!page.continueCursor || page.continueCursor === cursor) throw new Error("Recommendation pagination made no progress.");
      cursor = page.continueCursor;
    }
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeReads--;
  }
}

function getDay(client: ConvexHttpClient, day: DateWindow) {
  const key = JSON.stringify([client.url, day.fromDate]);
  const now = Date.now();
  const cached = completedDays.get(key);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.rows);
  const inFlight = pendingDays.get(key);
  if (inFlight) return inFlight;

  const load = readDay(client, day).then(rows => {
    const finished = Date.now();
    completedDays.set(key, { rows, expiresAt: finished + DAY_CACHE_MS,
      priority: isPriorityCalendarWindow(day.fromDate, day.beforeDate, finished) });
    prunePublicEventReadCache(completedDays, MAX_CACHED_DAYS, finished);
    return rows;
  }).finally(() => pendingDays.delete(key));
  pendingDays.set(key, load);
  return load;
}

export async function loadRecommendationWindow(client: ConvexHttpClient, window: DateWindow) {
  const days = buildPublicCalendarDateWindows(window.fromDate, window.beforeDate, 1);
  // Each worker requests one day at a time so a long window does not fill the read queue.
  const parts: RecommendationCandidate[][] = [];
  let nextDay = 0;
  let failed = false;
  async function worker() {
    while (!failed && nextDay < days.length) {
      const index = nextDay++;
      try {
        parts[index] = await getDay(client, days[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(days.length, MAX_CONCURRENT_READS) }, worker));
    return { events: parts.flat() };
  } catch (error) {
    return { events: [], error: error instanceof Error ? error.message : "Could not load public recommendations." };
  }
}
