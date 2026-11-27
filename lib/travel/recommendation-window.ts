import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { buildPublicCalendarDateWindows } from "../events/public-calendar-windows";
import { isPriorityCalendarWindow, prunePublicEventReadCache } from "../events/public-event-read-cache";
import type { RecommendationCandidate } from "./event-recommendations";

const DAY_CACHE_MS = 60_000;
const MAX_CACHED_DAYS = 64;
const MAX_CONCURRENT_READS = 2;
const MAX_DAYS_PER_READ = 3;

type DateWindow = { fromDate: string; beforeDate: string };
type CachedDay = { expiresAt: number; priority: boolean; rows: RecommendationCandidate[] };

const completedDays = new Map<string, CachedDay>();
const pendingDays = new Map<string, Promise<RecommendationCandidate[]>>();
const waiting: Array<() => void> = [];
let activeReads = 0;

// Release the shared slot after each page: a long comparison cannot monopolize it
// while a location-based programme request waits for its first page.
async function readPage(client: ConvexHttpClient, window: DateWindow, cursor: string | null) {
  if (activeReads >= MAX_CONCURRENT_READS) {
    await new Promise<void>(resume => waiting.push(resume));
  } else {
    activeReads++;
  }
  try {
    return await client.query(api.events.listPublicRecommendationWindowPaginated, { ...window, cursor });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeReads--;
  }
}

async function readDates(client: ConvexHttpClient, window: DateWindow) {
  const rows: RecommendationCandidate[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await readPage(client, window, cursor);
    rows.push(...page.page);
    if (page.isDone) return rows;
    if (!page.continueCursor || page.continueCursor === cursor) throw new Error("Recommendation pagination made no progress.");
    cursor = page.continueCursor;
  }
}

function cacheKey(client: ConvexHttpClient, day: DateWindow) {
  return JSON.stringify([client.url, day.fromDate]);
}

function reusableDay(client: ConvexHttpClient, day: DateWindow) {
  const key = cacheKey(client, day);
  const cached = completedDays.get(key);
  return cached && cached.expiresAt > Date.now() ? Promise.resolve(cached.rows) : pendingDays.get(key);
}

function requestDays(client: ConvexHttpClient, days: DateWindow[]) {
  const batch = readDates(client, { fromDate: days[0].fromDate, beforeDate: days[days.length - 1].beforeDate });
  return days.map(day => {
    const key = cacheKey(client, day);
    const load = batch.then(events => {
      const rows = events.filter(event => event.date === day.fromDate);
      const now = Date.now();
      completedDays.set(key, { rows, expiresAt: now + DAY_CACHE_MS,
        priority: isPriorityCalendarWindow(day.fromDate, day.beforeDate, now) });
      prunePublicEventReadCache(completedDays, MAX_CACHED_DAYS, now);
      return rows;
    }).finally(() => pendingDays.delete(key));
    pendingDays.set(key, load);
    return load;
  });
}

export async function loadRecommendationWindow(client: ConvexHttpClient, window: DateWindow) {
  const days = buildPublicCalendarDateWindows(window.fromDate, window.beforeDate, 1);
  const batchLimit = days.length <= MAX_DAYS_PER_READ ? 1 : MAX_DAYS_PER_READ;
  const parts: RecommendationCandidate[][] = [];
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < days.length) {
      const first = next++;
      try {
        const reused = reusableDay(client, days[first]);
        if (reused) {
          parts[first] = await reused;
          continue;
        }
        // Read adjacent misses in one paginated range. Cache and share individual civil
        // days so concurrent Compass and Compare requests still reuse their overlap.
        while (next < days.length && next - first < batchLimit && !reusableDay(client, days[next])) next++;
        const batch = await Promise.all(requestDays(client, days.slice(first, next)));
        batch.forEach((rows, offset) => { parts[first + offset] = rows; });
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(days.length, MAX_CONCURRENT_READS) }, worker));
  const failure = workers.find(result => result.status === "rejected");
  if (failure) return { events: [], error: failure.reason instanceof Error ? failure.reason.message : "Could not load public recommendations." };
  return { events: parts.flat() };
}
