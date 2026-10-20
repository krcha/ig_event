import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { buildPublicCalendarDateWindows } from "./public-calendar-windows";
import { toSearchableText } from "../pipeline/venue-normalization";
import type {
  PublicCalendarOverviewGroup,
  PublicCalendarOverviewPage,
  PublicCalendarOverviewVenue,
} from "./public-calendar-overview-types";

type Overview = {
  groups: PublicCalendarOverviewGroup[];
  venues: PublicCalendarOverviewVenue[];
};
type Options = { fromDate: string; beforeDate: string; q?: string; venue?: string };
type Entry = { expiresAt: number; promise: Promise<Overview> };

const overviewCache = new Map<string, Entry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 48;
const overviewAction = "publicCalendarOverviewAction:listWindow" as unknown as FunctionReference<"action">;

async function loadOverview(convex: ConvexHttpClient, options: Options): Promise<Overview> {
  const groups = new Map<string, PublicCalendarOverviewGroup>();
  const venues = new Map<string, PublicCalendarOverviewVenue>();
  for (const window of buildPublicCalendarDateWindows(options.fromDate, options.beforeDate)) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    while (true) {
      const result: PublicCalendarOverviewPage = await convex.action(overviewAction, {
        ...window,
        cursor,
        ...(options.q ? { q: options.q } : {}),
        ...(options.venue ? { venue: options.venue } : {}),
      });
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
      if (result.isDone) break;
      if (!result.continueCursor || seenCursors.has(result.continueCursor)) {
        throw new Error("Calendar overview pagination did not advance.");
      }
      seenCursors.add(result.continueCursor);
      cursor = result.continueCursor;
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
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return { groups: [], venues: [], error: "Convex is not configured yet." };
  if (buildPublicCalendarDateWindows(options.fromDate, options.beforeDate).length === 0) {
    return { groups: [], venues: [], error: "Calendar overview requires valid date boundaries." };
  }
  const normalized = {
    ...options,
    q: options.q?.trim() || undefined,
    venue: options.venue?.trim() || undefined,
  };
  const cacheKey = JSON.stringify([convexUrl, normalized.fromDate, normalized.beforeDate, normalized.q, normalized.venue]);
  const now = Date.now();
  for (const [key, entry] of overviewCache) {
    if (entry.expiresAt <= now) overviewCache.delete(key);
  }
  let cached = overviewCache.get(cacheKey);
  if (cached) {
    overviewCache.delete(cacheKey);
    overviewCache.set(cacheKey, cached);
  } else {
    const promise = loadOverview(new ConvexHttpClient(convexUrl), normalized);
    cached = { expiresAt: Number.POSITIVE_INFINITY, promise };
    overviewCache.set(cacheKey, cached);
    void promise.then(() => {
      if (overviewCache.get(cacheKey)?.promise === promise) {
        overviewCache.get(cacheKey)!.expiresAt = Date.now() + CACHE_TTL_MS;
      }
    }, () => {
      if (overviewCache.get(cacheKey)?.promise === promise) overviewCache.delete(cacheKey);
    });
    while (overviewCache.size > CACHE_MAX_ENTRIES) {
      overviewCache.delete(overviewCache.keys().next().value!);
    }
  }
  try {
    return await cached.promise;
  } catch (error) {
    return { groups: [], venues: [], error: error instanceof Error ? error.message : "Failed to load calendar counters." };
  }
}
