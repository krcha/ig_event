import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  DiscoverFeed,
  type DiscoverFeedData,
} from "@/components/discover/discover-feed";

export const revalidate = 60;

const getDiscoverFeedQuery =
  "events:getDiscoverFeed" as unknown as FunctionReference<"query">;

const EMPTY_DISCOVER_FEED: DiscoverFeedData = {
  featured: [],
  free: [],
  promoted: [],
  tonight: [],
  weekend: [],
};

function getBelgradeDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Belgrade",
    year: "numeric",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function formatDiscoverSubline(dateKey: string): string {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return `${dateKey} · Belgrade`;
  }

  const date = new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
      12,
    ),
  );

  const label = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Belgrade",
    weekday: "long",
  }).format(date);
  return `${label} · Belgrade`;
}

function normalizeFeed(value: unknown): DiscoverFeedData {
  const candidate = value as Partial<DiscoverFeedData>;
  return {
    featured: Array.isArray(candidate.featured) ? candidate.featured : [],
    free: Array.isArray(candidate.free) ? candidate.free : [],
    promoted: Array.isArray(candidate.promoted) ? candidate.promoted : [],
    tonight: Array.isArray(candidate.tonight) ? candidate.tonight : [],
    weekend: Array.isArray(candidate.weekend) ? candidate.weekend : [],
  };
}

async function loadDiscoverFeed(today: string): Promise<{
  error?: string;
  feed: DiscoverFeedData;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return {
      error: "Convex is not configured yet.",
      feed: EMPTY_DISCOVER_FEED,
    };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const feed = await convex.query(getDiscoverFeedQuery, { today });
    return { feed: normalizeFeed(feed) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to load Discover.",
      feed: EMPTY_DISCOVER_FEED,
    };
  }
}

export default async function DiscoverPage() {
  const today = getBelgradeDateKey();
  const { error, feed } = await loadDiscoverFeed(today);

  return (
    <DiscoverFeed
      error={error}
      feed={feed}
      subline={formatDiscoverSubline(today)}
    />
  );
}
