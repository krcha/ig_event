import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const eventsSource = read("convex/events.ts");
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
  eventsSource,
  /\.eq\("status", "approved"\)\.gte\("date", args\.fromDate\)\.lt\("date", args\.beforeDate\)/,
  "Public event windows should use the status/date index with both bounds.",
);
assert.match(
  venuesSource,
  /export const listPublicVenueFieldsByIds = query/,
  "Convex should expose public venue fields by IDs.",
);
assert.match(
  venuesSource,
  /function eventMatchesVenueIdentity/,
  "Venue pages should match approved events by venue identity, not only stored venueId.",
);
assert.match(
  venuesSource,
  /!event\.venueId && eventMatchesVenueIdentity\(event, venue\)/,
  "Venue pages should include legacy approved events that match by name/handle but are missing venueId.",
);
assert.match(
  venuesSource,
  /withIndex\("by_status_venueInstagramHandle_date"/,
  "Venue page legacy-handle recovery should use the dedicated identity index.",
);
assert.match(
  venuesSource,
  /withIndex\("by_status_venue_date"/,
  "Venue page legacy-name recovery should use the dedicated identity index.",
);
assert.doesNotMatch(
  venuesSource,
  /PUBLIC_VENUE_FALLBACK_SCAN_LIMIT|upcomingApprovedScan|historyApprovedScan/,
  "Venue pages should never scan global approved-event windows for identity fallback.",
);
assert.match(
  venuesSource,
  /const venueIdByHandle = new Map/,
  "Venue directory fallback counting should index venues by normalized Instagram handle.",
);
assert.match(
  venuesSource,
  /const venueIdByName = new Map/,
  "Venue directory fallback counting should index venues by normalized name.",
);
assert.match(
  venuesSource,
  /event\.venueId \?\?[\s\S]*venueIdByHandle\.get\(eventHandle\)[\s\S]*venueIdByName\.get\(eventVenueName\)/,
  "Venue directory counts should include approved upcoming events missing venueId without an events-by-venues scan.",
);
assert.match(
  publicEventsSource,
  /DEFAULT_PUBLIC_EVENTS_WINDOW_DAYS = 90/,
  "Public event loading should default to a 90-day window.",
);
assert.match(
  publicEventsSource,
  /MAX_PUBLIC_EVENTS_PAGE_SIZE = 100/,
  "Public event page size should be clamped to 100.",
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
assert.match(
  releaseCheckSource,
  /qa:public-event-windows/,
  "Release gate should include public event window QA.",
);

console.log("Public event window QA passed.");
