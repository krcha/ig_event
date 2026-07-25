import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const schemaSource = read("convex/schema.ts");
const eventsSource = read("convex/events.ts");
const venuesSource = read("convex/venues.ts");
const publicEventsSource = read("lib/events/public-events.ts");
const publicVenuePagesSource = read("lib/venues/public-venue-pages.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");
const projectionPath = "convex/publicEventProjection.ts";

assert.match(
  schemaSource,
  /\.index\("by_status_venueInstagramHandle_date", \["status", "venueInstagramHandle", "date"\]\)/,
  "Legacy venue-event fallback must use an index keyed by approved status, handle, and date.",
);
assert.match(
  schemaSource,
  /\.index\("by_status_venue_date", \["status", "venue", "date"\]\)/,
  "Legacy venue-event fallback must use an index keyed by approved status, canonical venue name, and date.",
);
assert.doesNotMatch(
  venuesSource,
  /PUBLIC_VENUE_FALLBACK_SCAN_LIMIT|upcomingApprovedScan|historyApprovedScan/,
  "A venue page must never scan a global approved-event window to recover legacy venue links.",
);
assert.match(
  venuesSource,
  /withIndex\("by_status_venueInstagramHandle_date"/,
  "Venue pages must recover legacy handle-linked events through the dedicated index.",
);
assert.match(
  venuesSource,
  /withIndex\("by_status_venue_date"/,
  "Venue pages must recover legacy name-linked events through the dedicated index.",
);

const calendarQuerySource = eventsSource.slice(
  eventsSource.indexOf("export const listPublicCalendarEventsWindowPaginated"),
  eventsSource.indexOf("// Temporary rollout compatibility"),
);
assert.match(
  calendarQuerySource,
  /paginationOpts:\s*paginationOptsValidator/,
  "Compact calendar reads must accept Convex pagination options.",
);
assert.match(
  calendarQuerySource,
  /\.paginate\(args\.paginationOpts\)/,
  "Compact calendar reads must paginate rather than collecting a whole month in one isolate.",
);
assert.doesNotMatch(
  calendarQuerySource,
  /\.collect\(\)/,
  "Compact calendar reads must not collect a whole month in one isolate.",
);
assert.match(
  publicEventsSource,
  /events:listPublicCalendarEventsWindowPaginated[\s\S]*async function queryPublicCalendarEventsWindowPage/,
  "The web loader must expose a bounded compact-calendar page reader.",
);
assert.match(
  publicEventsSource,
  /queryPublicCalendarEventsWindowPage\([\s\S]*paginationOpts:/,
  "The compact-calendar page reader must send Convex pagination options.",
);
assert.match(
  publicEventsSource,
  /while \(true\) \{[\s\S]*queryPublicCalendarEventsWindowPage[\s\S]*page\.isDone/,
  "The web loader must exhaust compact calendar pages without skipping events.",
);

assert.ok(existsSync(projectionPath), "Public event responses must use an explicit projection module.");
const projectionSource = read(projectionPath);
for (const privateField of [
  "rawExtractionJson",
  "moderationNote",
  "reviewedAt",
  "reviewedBy",
  "sourceOccurrenceKey",
]) {
  assert.doesNotMatch(
    projectionSource,
    new RegExp(`\\b${privateField}\\b`),
    `Public event projections must not expose or copy ${privateField}.`,
  );
}
assert.match(
  eventsSource,
  /projectPublicEvent/,
  "Public event detail and list queries must use the explicit safe projection.",
);

assert.doesNotMatch(
  publicVenuePagesSource,
  /loadFallbackUpcomingVenueEvents|PUBLIC_VENUE_FALLBACK_UPCOMING_DAYS/,
  "A public venue page must not launch a redundant full upcoming-event scan.",
);
assert.match(
  publicVenuePagesSource,
  /listPublicVenueDirectoryQuery\s*=\s*\n\s*"venues:listPublicVenueFields"/,
  "The venue directory must load public venue fields without scanning full event documents.",
);
assert.match(
  publicVenuePagesSource,
  /loadPublicVenueDirectory[\s\S]*loadPublicCalendarEventsWindow/,
  "The venue directory must derive counts from the paginated compact calendar projection.",
);

assert.ok(
  packageJson.scripts["qa:public-query-pressure"]?.includes("qa-public-query-pressure.mjs"),
  "package.json must expose the public query-pressure regression gate.",
);
assert.match(
  releaseCheckSource,
  /qa:public-query-pressure/,
  "The full release gate must run the public query-pressure regression.",
);

console.log("Public query-pressure QA passed: public reads are indexed, paginated, projected, and non-redundant.");
