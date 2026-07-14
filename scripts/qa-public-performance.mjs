import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_PUBLIC_VENUE_DIRECTORY_PAGE_SIZE,
  PUBLIC_VENUE_DIRECTORY_PAGE_SIZE,
  paginatePublicVenueDirectory,
} from "../lib/venues/public-venue-directory-pagination.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

function assertDoesNotInclude(source, value, message) {
  assert.equal(source.includes(value), false, message);
}

const appPageSource = read("app/page.tsx");
const browsePageSource = read("app/(main)/events-browse-page.tsx");
const publicEventsSource = read("lib/events/public-events.ts");
const convexEventsSource = read("convex/events.ts");
const mobileMonthDayStripSource = read("components/calendar/mobile-month-day-strip.tsx");
const venuesPageSource = read("app/(main)/venues/page.tsx");
const venuePaginationSource = read("lib/venues/public-venue-directory-pagination.ts");
const eventDetailSource = read("app/(main)/events/[eventId]/page.tsx");
const savedPanelSource = read("components/saved/saved-library-panel.tsx");
const middlewareSource = read("middleware.ts");
const nextConfigSource = read("next.config.mjs");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

for (const [label, source] of [
  ["root page", appPageSource],
  ["events browse page", browsePageSource],
]) {
  assert.match(
    source,
    /export const dynamic\s*=\s*"force-dynamic";/,
    `${label} should not use persisted route caching for Convex-backed event counts.`,
  );
  assert.match(
    source,
    /export const fetchCache\s*=\s*"force-no-store";/,
    `${label} should avoid serving stale cached event-count pages.`,
  );
  assertDoesNotInclude(source, "export const revalidate", `${label} should not use ISR caching.`);
}

assert.match(
  eventDetailSource,
  /export const revalidate\s*=\s*60;/,
  "Approved public event details should use short ISR caching instead of repeating Convex work.",
);
assertDoesNotInclude(
  eventDetailSource,
  'export const dynamic = "force-dynamic"',
  "Event details should not force a fresh server render on every request.",
);
assertDoesNotInclude(
  eventDetailSource,
  'export const fetchCache = "force-no-store"',
  "Event details should not opt out of the short public cache.",
);

assert.match(
  eventDetailSource,
  /sourceCaption\?: string;/,
  "Event detail type should keep the scraped Instagram caption available for the What to know section.",
);
assert.match(
  eventDetailSource,
  /const whatToKnowText = event[\s\S]*event\.sourceCaption\?\.trim\(\) \|\| event\.description\?\.trim\(\)/,
  "Event detail What to know text should prefer the exact scraped Instagram caption over generated descriptions.",
);

assertDoesNotInclude(
  publicEventsSource,
  "unstable_noStore",
  "Public event loaders should not disable Next route caching with unstable_noStore.",
);
assertDoesNotInclude(
  publicEventsSource,
  "noStore()",
  "Public event loaders should not call noStore().",
);

assert.equal(PUBLIC_VENUE_DIRECTORY_PAGE_SIZE, 24);
assert.equal(MAX_PUBLIC_VENUE_DIRECTORY_PAGE_SIZE, 50);
const venueFixture = Array.from({ length: 83 }, (_, index) => `venue-${index + 1}`);
const pagedVenueIds = [];
for (let page = 1; page <= 4; page += 1) {
  const result = paginatePublicVenueDirectory(venueFixture, page);
  assert.ok(result.pageItems.length <= 24, "A venue page must remain bounded.");
  pagedVenueIds.push(...result.pageItems);
}
assert.deepEqual(
  pagedVenueIds,
  venueFixture,
  "Venue pages must preserve deterministic order without missing or duplicate IDs.",
);
assert.equal(
  paginatePublicVenueDirectory(venueFixture, 1, 100).pageItems.length,
  50,
  "Caller-provided venue page sizes must be hard-capped at 50.",
);
assert.match(
  venuesPageSource,
  /visibleVenues\.map\(\(venue\)/,
  "The venue page should serialize only the current bounded page of cards.",
);
assertDoesNotInclude(
  venuesPageSource,
  "filteredVenues.map((venue)",
  "The venue page must not serialize every matching venue into the initial response.",
);
assert.ok(
  (venuesPageSource.match(/prefetch=\{false\}/g) ?? []).length >= 4,
  "Venue cards and pagination should avoid eager background RSC prefetches.",
);
assert.match(
  venuePaginationSource,
  /PUBLIC_VENUE_DIRECTORY_PAGE_SIZE = 24/,
  "The default public venue response should stay comfortably below the 50-card ceiling.",
);

for (const field of ["fromDate?: string", "beforeDate?: string", "daysAhead?: number"]) {
  assert.ok(
    publicEventsSource.includes(field),
    `loadUpcomingApprovedEvents options should expose ${field} for bounded month loads.`,
  );
}

assert.match(
  publicEventsSource,
  /events:listPublicEventsWindow/,
  "Public event loader should keep the full bounded Convex public window query for detail/feed use.",
);
assert.match(
  publicEventsSource,
  /events:listPublicCalendarEventsWindow/,
  "Calendar browse page should use the compact Convex public calendar window query.",
);
assert.match(
  publicEventsSource,
  /venues:listPublicVenueFieldsByIds/,
  "Public event loader should fetch only public venue fields for venue IDs on the current page.",
);
assert.match(
  convexEventsSource,
  /export const listPublicEventsWindow = query/,
  "Convex should expose a bounded full public events window query.",
);
assert.match(
  convexEventsSource,
  /export const listPublicCalendarEventsWindow = query/,
  "Convex should expose a compact public calendar window query for fast browse loads.",
);
assert.match(
  convexEventsSource,
  /beforeDate:\s*v\.string\(\)/,
  "Convex public event windows should require an explicit upper date bound.",
);
assert.match(
  convexEventsSource,
  /\.eq\("status", "approved"\)\.gte\("date", args\.fromDate\)\.lt\("date", args\.beforeDate\)/,
  "Convex public event windows should apply both lower and upper date bounds through the status/date index.",
);

assert.match(
  publicEventsSource,
  /const cacheKey = `\$\{fromDate\}:\$\{beforeDate \?\? ""\}`;/,
  "Public event cache should include both date boundaries.",
);
assert.match(
  publicEventsSource,
  /const PUBLIC_EVENTS_CACHE_MAX_ENTRIES = 48;/,
  "Public event cache should have a bounded maximum size for VPS memory safety.",
);
assert.match(
  publicEventsSource,
  /while \(publicEventsCache\.size > PUBLIC_EVENTS_CACHE_MAX_ENTRIES\)/,
  "Public event cache should prune oldest entries when it exceeds the maximum size.",
);
assertDoesNotInclude(
  publicEventsSource,
  "loadUpcomingApprovedEventsPage",
  "Public event loaders should not keep the unused load-all-then-slice page helper.",
);
assert.match(
  publicEventsSource,
  /const eventsByDate = new Map<string, PublicEvent\[\]>\(\);/,
  "Duplicate cleanup should bucket events by date before running pairwise matching.",
);
assert.doesNotMatch(
  publicEventsSource,
  /buildApprovedEventAutoCleanupGroups\(\s*events\.map\(mapPublicEventToDuplicateRecord\)/,
  "Duplicate cleanup should not run the O(n^2) grouping over the entire cross-date event set.",
);
assert.match(
  publicEventsSource,
  /const PUBLIC_DUPLICATE_CLEANUP_MAX_PAIRWISE_EVENTS = 20;/,
  "Duplicate cleanup should cap expensive pairwise matching for high-volume public days.",
);
assert.match(
  publicEventsSource,
  /hideExactSourceDuplicates\(sameDateEvents, hiddenDuplicateIds\);/,
  "Duplicate cleanup should still remove exact same-source duplicates even when pairwise matching is skipped.",
);
assert.match(
  publicEventsSource,
  /sameDateEvents\.length > PUBLIC_DUPLICATE_CLEANUP_MAX_PAIRWISE_EVENTS/,
  "Large same-day batches should skip expensive pairwise duplicate heuristics on public page loads.",
);

assert.match(
  browsePageSource,
  /const beforeDate = formatDateKey\(nextMonthStart\);[\s\S]*loadPublicCalendarEventsWindow\(\{ beforeDate, fromDate \}\)/,
  "Calendar page should request only the selected month date range from the compact public calendar loader.",
);
assert.match(
  browsePageSource,
  /const fromDate = monthStartKey;/,
  "Calendar page should load the full selected month so stored past days remain visible.",
);
assertDoesNotInclude(
  browsePageSource,
  "const fromDate = monthStartKey < yesterdayKey ? yesterdayKey : monthStartKey;",
  "Calendar page should not clamp the selected month query to yesterday.",
);
assertDoesNotInclude(
  browsePageSource,
  "MonthEventsTable",
  "Calendar page should not serialize a whole-month event table into the client payload.",
);
assertDoesNotInclude(
  browsePageSource,
  "list?: string",
  "Calendar page should not keep a list=1 whole-month table query option.",
);
assertDoesNotInclude(
  browsePageSource,
  'list: "1"',
  "Calendar page should not link to a list=1 whole-month table mode.",
);
assertDoesNotInclude(
  browsePageSource,
  "Open the complete table",
  "Selected-day overflow should not offer the memory-heavy whole-month table.",
);
assertDoesNotInclude(
  browsePageSource,
  "DEFAULT_SELECTED_DAY_AGENDA_LIMIT",
  "Selected-day agenda should not hide matching events behind a preview cap.",
);
assertDoesNotInclude(
  browsePageSource,
  "previewEvents",
  "Month grid should avoid serializing per-day event preview cards on the initial page.",
);
assertDoesNotInclude(
  browsePageSource,
  "const filteredEvents =",
  "Calendar page should not copy the whole selected month into a filtered event array.",
);
assertDoesNotInclude(
  browsePageSource,
  "const monthEvents =",
  "Calendar page should not keep a whole-month event list in memory.",
);
assertDoesNotInclude(
  browsePageSource,
  "const monthEventSummaries =",
  "Calendar page should not materialize summaries for every event in the selected month.",
);
assert.match(
  browsePageSource,
  /selectedDayAgendaEvents\.push\(summary\);/,
  "Selected-day agenda should render every matching event for the selected day.",
);
assertDoesNotInclude(
  browsePageSource,
  'Open {pluralize(dayEventCount, "event")}',
  "The full bottom month calendar grid should be removed now that the horizontal date selector handles day navigation.",
);
assert.ok(
  (browsePageSource.match(/prefetch=\{false\}/g) ?? []).length >= 12,
  "High-density calendar links should disable App Router prefetch to avoid background RSC work during taps.",
);
assert.match(
  mobileMonthDayStripSource,
  /<Link prefetch=\{false\}/,
  "Mobile month day strip should disable prefetch for its many date links.",
);
assertDoesNotInclude(
  browsePageSource,
  "Showing {agendaEvents.length} of {selectedDayEventCount}",
  "Selected-day agenda should not show a partial-results message.",
);

assertDoesNotInclude(
  browsePageSource,
  'href="/events"',
  "Browse page should not link to the redirect-only /events route.",
);
assertDoesNotInclude(
  eventDetailSource,
  'href="/events"',
  "Event detail page should not link to the redirect-only /events route.",
);
assertDoesNotInclude(
  savedPanelSource,
  'href="/events"',
  "Saved empty states should not link to the redirect-only /events route.",
);
assertDoesNotInclude(
  eventDetailSource,
  "`/calendar?${query.toString()}`",
  "Event detail calendar shortcut should link directly to the canonical root calendar route.",
);
assert.match(
  middlewareSource,
  /matcher:\s*\["\/admin\/:path\*", "\/api\/admin\/:path\*", "\/saved\/:path\*", "\/api\/user\/:path\*"\]/,
  "Clerk middleware should stay scoped to auth-backed routes so public browsing avoids auth overhead.",
);
assertDoesNotInclude(
  middlewareSource,
  '/((?!.*\\\\..*|_next).*)',
  "Clerk middleware should not match every public page.",
);
assert.match(
  nextConfigSource,
  /const CANONICAL_APP_ORIGIN = "https:\/\/events\.ineedtofeedmyrabbit\.com";/,
  "Next config should define the canonical public app origin.",
);
assert.match(
  nextConfigSource,
  /const VERCEL_PRODUCTION_HOST = "ig-event\.vercel\.app";/,
  "Next config should define the Vercel production alias host.",
);
assert.match(
  nextConfigSource,
  /has:\s*\[\{ type: "host", value: VERCEL_PRODUCTION_HOST \}\]/,
  "Vercel production alias should redirect by Host header.",
);
assert.match(
  nextConfigSource,
  /destination: `\$\{CANONICAL_APP_ORIGIN\}\/:path\*`/,
  "Vercel production alias should preserve the path on the canonical origin.",
);

assert.ok(
  packageJson.scripts["qa:public-performance"]?.includes("qa-public-performance.mjs"),
  "package.json should expose qa:public-performance.",
);
assert.match(
  releaseCheckSource,
  /qa:public-performance/,
  "Release gate should include qa:public-performance.",
);

console.log("QA passed: public pages use bounded data loads, dynamic rendering, and avoid redirect hops.");
