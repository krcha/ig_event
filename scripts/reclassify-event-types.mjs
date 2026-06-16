import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { toSearchableText } from "../lib/pipeline/venue-normalization.ts";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
  mainCategoryForEventType,
} from "../lib/taxonomy/venue-types.ts";

const DEFAULT_PAGE_SIZE = 100;

function loadEnvFiles() {
  for (const envFile of [".env.local", ".env"]) {
    if (!existsSync(envFile)) {
      continue;
    }
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

function readPositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildVenueCategoriesByName(venues) {
  const venueCategoriesByName = new Map();

  for (const venue of venues) {
    const key = toSearchableText(normalizeString(venue.name));
    const category = normalizeString(venue.category);
    if (key && category && !venueCategoriesByName.has(key)) {
      venueCategoriesByName.set(key, category);
    }
  }

  return venueCategoriesByName;
}

async function loadApprovedEvents(convex, pageSize, limit) {
  const events = [];
  let cursor = null;

  while (limit === null || events.length < limit) {
    const remaining = limit === null ? pageSize : Math.min(pageSize, limit - events.length);
    const page = await convex.query(api.events.listApprovedUpcomingByDatePaginated, {
      fromDate: "0000-01-01",
      paginationOpts: {
        cursor,
        numItems: remaining,
      },
    });

    events.push(...page.page);

    if (page.isDone) {
      break;
    }

    cursor = page.continueCursor;
  }

  return events;
}

loadEnvFiles();
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
}

const pageSize = readPositiveInteger(
  process.env.RECLASSIFY_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  500,
);
const limit = process.env.RECLASSIFY_LIMIT
  ? readPositiveInteger(process.env.RECLASSIFY_LIMIT, 1000, 100_000)
  : null;
const convex = new ConvexHttpClient(convexUrl);
const [events, venues] = await Promise.all([
  loadApprovedEvents(convex, pageSize, limit),
  convex.query(api.venues.listVenues, {}),
]);
const venueCategoriesByName = buildVenueCategoriesByName(venues);

const byResultingMainCategory = {
  club: 0,
  live: 0,
  culture: 0,
  day: 0,
  other: 0,
};
const wouldMoveByResultingMainCategory = {
  club: 0,
  live: 0,
  culture: 0,
  day: 0,
  other: 0,
};
const exampleTitles = [];
const examples = [];
let defaultEventTypeCount = 0;
let matchedVenueCount = 0;
let wouldMove = 0;
let unchanged = 0;

for (const event of events) {
  const storedEventType = normalizeString(event.eventType);
  const canonicalStoredEventType = canonicalizeEventType(storedEventType);
  if (canonicalStoredEventType !== DEFAULT_EVENT_TYPE) {
    continue;
  }

  defaultEventTypeCount += 1;
  const venueName = normalizeString(event.venue);
  const venueCategory = venueCategoriesByName.get(toSearchableText(venueName)) ?? null;
  if (venueCategory) {
    matchedVenueCount += 1;
  }

  const fallbackEventType = eventTypeFromVenueCategory(venueCategory);
  const resultingMainCategory = mainCategoryForEventType(fallbackEventType);
  byResultingMainCategory[resultingMainCategory] += 1;

  if (fallbackEventType === DEFAULT_EVENT_TYPE) {
    unchanged += 1;
    continue;
  }

  wouldMove += 1;
  wouldMoveByResultingMainCategory[resultingMainCategory] += 1;

  if (exampleTitles.length < 10) {
    exampleTitles.push(normalizeString(event.title) || "(untitled)");
  }

  if (examples.length < 10) {
    examples.push({
      id: event._id,
      title: normalizeString(event.title) || "(untitled)",
      date: normalizeString(event.date),
      venue: venueName,
      storedEventType,
      venueCategory,
      fallbackEventType,
      resultingMainCategory,
    });
  }
}

console.log(JSON.stringify({
  dryRun: true,
  writesPerformed: 0,
  scannedApproved: events.length,
  defaultEventTypeCount,
  matchedVenueCount,
  wouldMove,
  unchanged,
  byResultingMainCategory,
  wouldMoveByResultingMainCategory,
  exampleTitles,
  examples,
}, null, 2));
