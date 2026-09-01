import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const eventsSource = read("convex/events.ts");
const publicReadsSource = read("convex/eventDomain/publicReads.ts");
const venuesSource = read("convex/venues.ts");
const publicEventsSource = read("lib/events/public-events.ts");
const publicVenuePagesSource = read("lib/venues/public-venue-pages.ts");
const eventDetailSource = read("app/(main)/events/[eventId]/page.tsx");
const savedPageSource = read("app/(main)/saved/page.tsx");
const discoverPageSource = read("app/(main)/discover/page.tsx");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

assert.match(
  eventsSource,
  /export const getPublicApprovedEvent = query/,
  "Convex should expose approved-only public event detail.",
);
assert.match(
  eventsSource,
  /export const listPublicEventsWindow = query/,
  "Convex should expose bounded public event windows.",
);
assert.match(
  publicReadsSource,
  /\.eq\("status", "approved"\)[\s\S]*\.gte\("date", options\.fromDate\)[\s\S]*\.lt\("date", options\.beforeDate\)/,
  "Public event windows should use the status/date index with both bounds.",
);
assert.match(
  publicReadsSource,
  /paginateVisibleRows\(/,
  "Public event windows should project one cursor-safe raw page at a time.",
);
assert.match(
  venuesSource,
  /export const listPublicVenueFieldsByIds = query/,
  "Convex should expose public venue fields by IDs.",
);
assert.match(
  venuesSource,
  /async function loadBoundedVenueEventCards/,
  "Venue pages should match approved events by bounded indexed venue identity reads.",
);
assert.match(
  venuesSource,
  /\.filter\(\(event\) => !event\.venueId\)/,
  "Venue pages should include legacy identity matches only when a stored venueId is absent.",
);
assert.match(
  venuesSource,
  /withIndex\("by_normalizedVenueHandle_status_date"/,
  "Venue page legacy-handle recovery should use the normalized identity index.",
);
assert.match(
  venuesSource,
  /withIndex\("by_normalizedVenueIdentity_status_date"/,
  "Venue page legacy-name recovery should use the normalized identity index.",
);
assert.doesNotMatch(
  venuesSource,
  /PUBLIC_VENUE_FALLBACK_SCAN_LIMIT|upcomingApprovedScan|historyApprovedScan/,
  "Venue pages should never scan global approved-event windows for identity fallback.",
);
assert.doesNotMatch(
  publicVenuePagesSource,
  /upcomingEventCount|loadPublicCalendarEventsWindow/,
  "Venue directory loading should not scan a year of events for incomplete totals.",
);
assert.match(
  publicEventsSource,
  /DEFAULT_PUBLIC_EVENTS_WINDOW_DAYS = 90/,
  "Public event loading should default to a 90-day window.",
);
assert.match(
  publicEventsSource,
  /MAX_PUBLIC_EVENTS_PAGE_SIZE = 50/,
  "Public event page size should be clamped to the production-safe 50-row bound.",
);
assert.match(
  publicEventsSource,
  /events:listPublicEventsWindow/,
  "Public loader should call the bounded Convex event window query.",
);
assert.match(
  publicEventsSource,
  /venues:listPublicVenueFieldsByIds/,
  "Public loader should fetch venue display fields by current page IDs.",
);
assert.doesNotMatch(
  publicVenuePagesSource,
  /loadFallbackUpcomingVenueEvents|PUBLIC_VENUE_FALLBACK_UPCOMING_DAYS|loadUpcomingApprovedEvents/,
  "Venue pages should trust the indexed Convex result instead of redundantly loading 366 days of events.",
);
assert.doesNotMatch(
  publicEventsSource,
  /venues:listVenues/,
  "Public loader should not fetch every venue.",
);
assert.match(
  eventDetailSource,
  /events:getPublicApprovedEvent/,
  "Public event detail should use approved-only event query.",
);
assert.match(
  eventDetailSource,
  /notFound\(\)/,
  "Public event detail should return notFound when the public query returns null.",
);
assert.match(
  savedPageSource,
  /loadUpcomingApprovedEvents\(\{ daysAhead: 90 \}\)/,
  "Saved page should use an explicit 90-day public event window.",
);
assert.match(
  discoverPageSource,
  /beforeDate,\s*[\s\S]*fromDate: date/,
  "Discover should load an explicitly bounded one-day event window.",
);
assert.ok(
  packageJson.scripts["qa:public-event-windows"]?.includes("qa-public-event-windows.mjs"),
  "package.json should expose qa:public-event-windows.",
);
assert.ok(
  packageJson.scripts["qa:public-pagination-integrity"]?.includes(
    "qa-public-pagination-integrity.mjs",
  ),
  "package.json should expose behavioral visible-pagination QA.",
);
assert.match(
  releaseCheckSource,
  /qa:public-event-windows/,
  "Release gate should include public event window QA.",
);
assert.match(
  releaseCheckSource,
  /qa:public-pagination-integrity/,
  "Release gate should include public pagination integrity QA.",
);

console.log("Public event window QA passed.");
