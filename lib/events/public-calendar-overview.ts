import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { buildPublicCalendarDateWindows } from "./public-calendar-windows";
import { getCalendarConvexUrl } from "./calendar-convex-url";
import { runCalendarOverviewRead } from "./calendar-overview-budget";
import { toSearchableText } from "../pipeline/venue-normalization";
import { buildPublicCalendarOverviewPage } from "./public-calendar-overview-types";
import type {
  PublicCalendarOverviewGroup,
  PublicCalendarOverviewRow,
  PublicCalendarOverviewVenue,
} from "./public-calendar-overview-types";

type Overview = {
  groups: PublicCalendarOverviewGroup[];
  venues: PublicCalendarOverviewVenue[];
};
type Options = { fromDate: string; beforeDate: string; q?: string; venue?: string };
type Bounds = Pick<Options, "fromDate" | "beforeDate">;
type RowsPage = { page: PublicCalendarOverviewRow[]; isDone: boolean; continueCursor: string };
type Entry = { expiresAt: number; bytes: number; promise: Promise<PublicCalendarOverviewRow[][]> };

const overviewCache = new Map<string, Entry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const OVERVIEW_WINDOW_DAYS = 7;
const rowsQuery = "events:listPublicCalendarOverviewRowsPaginated" as unknown as FunctionReference<"query">;

async function loadRows(convex: ConvexHttpClient, bounds: Bounds): Promise<PublicCalendarOverviewRow[][]> {
  const pages = [];
  for (const window of buildPublicCalendarDateWindows(bounds.fromDate, bounds.beforeDate, OVERVIEW_WINDOW_DAYS)) {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    while (true) {
      // Single shared RPC slot leaves room for foreground selected-day reads.
      const result: RowsPage = await runCalendarOverviewRead(() => convex.query(rowsQuery, { ...window, cursor }));
      pages.push(result.page);
      if (result.isDone) break;
      if (!result.continueCursor || seenCursors.has(result.continueCursor)) {
        throw new Error("Calendar overview pagination did not advance.");
      }
      seenCursors.add(result.continueCursor);
      cursor = result.continueCursor;
    }
  }
  return pages;
}

function aggregate(pages: PublicCalendarOverviewRow[][], options: Options): Overview {
  const groups = new Map<string, PublicCalendarOverviewGroup>();
  const venues = new Map<string, PublicCalendarOverviewVenue>();
  // Merge in date-window/page order, independent of response timing, so venue
  // aliases, labels and fallback locations retain deterministic precedence.
  for (const rows of pages) {
    const result = buildPublicCalendarOverviewPage(rows, options);
    for (const group of result.page) {
      const key = JSON.stringify([group.date, group.category, group.venueValue]);
      const previous = groups.get(key);
      groups.set(key, previous ? {
        ...previous,
        count: previous.count + group.count,
        legacyVenueMatchCount: previous.legacyVenueMatchCount + group.legacyVenueMatchCount,
      } : { ...group });
    }
    for (const venue of result.venues) {
      const previous = venues.get(venue.value);
      venues.set(venue.value, previous ? {
        ...venue,
        names: [...new Set([...previous.names, ...venue.names])],
        ...(venue.location || previous.location ? { location: venue.location ?? previous.location } : {}),
      } : { ...venue });
    }
  }
  const optionsList = [...venues.values()];
  const labelCounts = new Map<string, number>();
  for (const venue of optionsList) {
    const key = toSearchableText(venue.label);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  for (const venue of optionsList) {
    if ((labelCounts.get(toSearchableText(venue.label)) ?? 0) > 1 && venue.location) {
      venue.label = `${venue.label} (${venue.location})`;
    }
  }
  optionsList.sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return { groups: [...groups.values()], venues: optionsList };
}

/** Counters and venue choices only; event details are loaded separately for one day. */
export async function loadPublicCalendarOverviewWindow(options: Options): Promise<Overview & { error?: string }> {
  const convexUrl = getCalendarConvexUrl();
  if (!convexUrl) return { groups: [], venues: [], error: "Convex is not configured yet." };
  if (buildPublicCalendarDateWindows(options.fromDate, options.beforeDate).length === 0) {
    return { groups: [], venues: [], error: "Calendar overview requires valid date boundaries." };
  }
  const cacheKey = JSON.stringify([convexUrl, options.fromDate, options.beforeDate]);
  const now = Date.now();
  for (const [key, entry] of overviewCache) {
    if (entry.expiresAt <= now) overviewCache.delete(key);
  }
  let cached = overviewCache.get(cacheKey);
  if (cached) {
    overviewCache.delete(cacheKey);
    overviewCache.set(cacheKey, cached);
  } else {
    // Never evict a pending read: coalesce all names and venues for one range.
    if (overviewCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = [...overviewCache].find(([, entry]) => Number.isFinite(entry.expiresAt));
      if (!oldest) return { groups: [], venues: [], error: "Calendar counts are busy." };
      overviewCache.delete(oldest[0]);
    }
    const promise = loadRows(new ConvexHttpClient(convexUrl), options);
    const entry: Entry = { expiresAt: Infinity, bytes: 0, promise };
    cached = entry;
    overviewCache.set(cacheKey, entry);
    void promise.then(pages => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      entry.bytes = pages.reduce((size, page) => size + Buffer.byteLength(JSON.stringify(page)), 0);
      if (entry.bytes > CACHE_MAX_BYTES) {
        overviewCache.delete(cacheKey); // Serve this request without retaining a large snapshot.
        return;
      }
      let bytes = [...overviewCache.values()].reduce((total, item) => total + item.bytes, 0);
      for (const [key, item] of overviewCache) {
        if (bytes <= CACHE_MAX_BYTES) break;
        if (item !== entry && Number.isFinite(item.expiresAt)) {
          overviewCache.delete(key);
          bytes -= item.bytes;
        }
      }
    }, () => overviewCache.delete(cacheKey));
  }
  try {
    return aggregate(await cached.promise, { ...options, q: options.q?.trim(), venue: options.venue?.trim() });
  } catch (error) {
    return { groups: [], venues: [], error: error instanceof Error ? error.message : "Failed to load calendar counters." };
  }
}
