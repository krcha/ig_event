import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const eventDetailSource = read("app/(main)/events/[eventId]/page.tsx");
const savedPanelSource = read("components/saved/saved-library-panel.tsx");
const middlewareSource = read("middleware.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

for (const [label, source] of [
  ["root page", appPageSource],
  ["events browse page", browsePageSource],
]) {
  assert.match(source, /export const revalidate\s*=\s*60;/, `${label} should use short ISR caching.`);
  assertDoesNotInclude(source, 'dynamic = "force-dynamic"', `${label} should not force dynamic rendering.`);
  assertDoesNotInclude(source, 'fetchCache = "force-no-store"', `${label} should not force no-store fetch caching.`);
}

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

for (const field of ["fromDate?: string", "beforeDate?: string"]) {
  assert.ok(
    publicEventsSource.includes(field),
    `loadUpcomingApprovedEvents options should expose ${field} for bounded month loads.`,
  );
}

assert.match(
  publicEventsSource,
  /const reachedBeforeDate = beforeDate[\s\S]*page\.page\.some\(\(event\) => event\.date >= beforeDate\)/,
  "Public event loader should stop paginating once it reaches the selected month upper bound.",
);
assert.match(
  publicEventsSource,
  /const pageEvents = beforeDate[\s\S]*page\.page\.filter\(\(event\) => event\.date < beforeDate\)/,
  "Public event loader should discard events beyond the selected month upper bound.",
);
assert.doesNotMatch(
  convexEventsSource,
  /beforeDate:\s*v\.optional/,
  "Public date bounding should avoid requiring a Convex production function deploy for the beforeDate arg.",
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
  /const beforeDate = formatDateKey\(nextMonthStart\);[\s\S]*loadUpcomingApprovedEvents\(\{ beforeDate, fromDate \}\)/,
  "Calendar page should request only the selected month date range from the public loader.",
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
assert.match(
  browsePageSource,
  /const DEFAULT_SELECTED_DAY_AGENDA_LIMIT = 24;/,
  "Default calendar load should cap selected-day agenda previews to keep high-volume days fast.",
);
assert.match(
  browsePageSource,
  /visibleSelectedDayEvents\.slice\(0, DEFAULT_SELECTED_DAY_AGENDA_LIMIT\)/,
  "Selected-day agenda should slice the default preview instead of serializing every event card.",
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
assert.match(
  browsePageSource,
  /Showing \{agendaEvents\.length\} of \{selectedDayEventCount\} matching events for this day\./,
  "Selected-day agenda overflow should tell users when only a preview is rendered.",
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

assert.ok(
  packageJson.scripts["qa:public-performance"]?.includes("qa-public-performance.mjs"),
  "package.json should expose qa:public-performance.",
);
assert.match(
  releaseCheckSource,
  /qa:public-performance/,
  "Release gate should include qa:public-performance.",
);

console.log("QA passed: public pages use bounded data loads, short caching, and avoid redirect hops.");
