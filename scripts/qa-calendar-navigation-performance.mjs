import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import * as categories from "../lib/taxonomy/event-categories.ts";
import * as eventTime from "../lib/events/event-time.ts";
import * as presentation from "../lib/events/event-time-presentation.ts";
import * as bands from "../lib/events/calendar-time-bands.ts";
import * as sessions from "../lib/events/event-session.ts";
import * as nightlife from "../lib/events/nightlife-date.ts";
import * as week from "../lib/events/mobile-week.ts";
import * as grouping from "../lib/events/venue-day-grouping.ts";
import * as venueFilter from "../lib/events/public-event-venue-filter.ts";
import * as search from "../lib/events/public-event-search.ts";
import * as openNow from "../lib/venues/venue-open-now.ts";
import * as seo from "../lib/seo/site.ts";
import { buildCalendarOverviewPresentation } from "../lib/events/calendar-overview-data.ts";
import { fetchCalendarOverview, peekCalendarOverview } from "../lib/events/calendar-overview-client.ts";

const require = createRequire(import.meta.url);
const jsx = (type, props) => ({ type, props: props ?? {} });
const components = new Proxy({ __esModule: true }, { get: (target, name) => name in target ? target[name] : String(name) });
function compile(file, mocks) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", output)(name => {
    if (name in mocks) return mocks[name];
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "lucide-react" || name.startsWith("@/components/") || name.startsWith("./calendar-") || name === "./event-kind-toggle-chips" || name === "./open-now-filter") return components;
    if (name === "next/link") return { __esModule: true, default: "link" };
    if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_target, name) => String(name) }) };
    if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
    throw new Error(`Unexpected QA import: ${name}`);
  }, module.exports, module);
  return module.exports;
}
const projection = compile("lib/events/calendar-agenda-projection.ts", {
  "server-only": {}, "../taxonomy/event-categories": categories, "./event-time-presentation": presentation,
  "./event-time": eventTime, "./calendar-time-bands": bands, "./event-session": sessions,
});
function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const events = Array.from({ length: 8 }, (_, index) => ({
  _id: `event-${index}`, date: "2026-10-31", title: index === 0 ? "Children workshop" : `Concert ${index}`,
  description: index === 0 ? "For ages 5-8. Art workshop." : "Jazz live concert.",
  time: index === 0 ? "11:00" : `${19 + index % 4}:00`, timeStatus: index === 7 ? "unknown" : "confirmed",
  venue: index < 4 ? "Busy venue" : `Venue ${index}`, venueId: index < 4 ? "venue-busy" : `venue-${index}`,
  venueHours: { hoursJson: "private-sized-hours-data" }, artists: ["Artist"], eventType: "event",
  status: "approved", createdAt: 1, updatedAt: 1,
}));
const projected = projection.projectCalendarAgendaEvents(events, new Map(events.map((event, index) => [event._id, 7 - index])), new Map());
for (let index = 0; index < events.length; index++) {
  assert.equal(projected[index]._id, events[index]._id);
  assert.equal(projected[index].category, categories.getEventPrimaryCategory(events[index]));
  assert.deepEqual(projected[index].tags, categories.getEventTags(events[index]));
  assert.deepEqual(projected[index].presentation, presentation.resolveEventTimePresentation(events[index]));
  assert.equal(projected[index].sessionLabel, sessions.getEventSessionLabel(events[index]));
  assert.ok(!Object.hasOwn(projected[index], "description") && !Object.hasOwn(projected[index], "venueHours"));
}
assert.match(projected[0].sessionLabel, /5\u20138/);
assert.equal(projected[7].band, "time-not-announced");
assert.equal(events[0].description, "For ages 5-8. Art workshop.", "Compact projection must not mutate the server/SEO snapshot.");

let selectionReads = 0;
const legacyOptions = [{ value: "id:venue-a", label: "Current name", names: ["Current name", "Old alias"] }];
const selection = compile("lib/events/calendar-venue-selection.ts", {
  "server-only": {}, "./public-event-venue-filter": venueFilter,
  "./public-calendar-overview": { loadPublicCalendarOverviewWindow: async () => { selectionReads++; return { venues: legacyOptions }; } },
});
for (const value of [undefined, "id:venue-a", "name:unknown venue"]) {
  assert.equal((await selection.resolveCalendarVenueSelection(value, { fromDate: "2026-10-01", beforeDate: "2026-11-01" })).value, value);
}
assert.equal(selectionReads, 0, "Ordinary day/ID filters must not wait for monthly identity reads.");
assert.equal((await selection.resolveCalendarVenueSelection("Old alias", {})).value, "id:venue-a");
legacyOptions.push({ value: "id:venue-b", label: "Other venue", names: ["Old alias"] });
assert.equal((await selection.resolveCalendarVenueSelection("Old alias", {})).value, "Old alias", "Ambiguous legacy aliases must retain the existing name-matching behavior.");

for (const mobile of [false, true]) {
  const { CalendarAgenda } = compile("components/calendar/calendar-agenda.tsx", {
    react: { useMemo: callback => callback(), useSyncExternalStore: () => mobile },
    "@/lib/taxonomy/event-categories": categories,
    "@/lib/events/calendar-time-band-definitions": bands,
    "@/lib/events/venue-day-grouping": grouping,
  });
  const tree = CalendarAgenda({ events: projected, hiddenDayCategories: [], selectedDayEventCount: 8, dayLabel: "Saturday", openNowActive: false, openNowHref: "/?open=now", now: 0, authEnabled: true, hasActiveFilters: false, clearFiltersHref: "/" });
  const rows = nodes(tree, node => node.props?.["data-calendar-event-id"]);
  assert.equal(rows.length, events.length, "Both responsive modes must render exactly one row for every event.");
  assert.equal(new Set(rows.map(node => node.props["data-calendar-event-id"])).size, events.length);
  assert.equal(nodes(tree, node => node.props?.["data-calendar-venue-group"]).length, mobile ? 0 : 1, "Retain desktop busy-venue grouping and the mobile chronological list.");
  if (mobile) {
    const evening = nodes(tree, node => node.props?.["data-calendar-time-band"] === "evening")[0];
    const ids = nodes(evening, node => node.props?.["data-calendar-event-id"]).map(node => node.props["data-calendar-event-id"]);
    assert.deepEqual(ids, projected.filter(event => event.band === "evening").sort((a, b) => a.mobileOrder - b.mobileOrder).map(event => event._id));
  }
}

let dayReads = 0;
const page = compile("app/(main)/events-browse-page.tsx", {
  "@/lib/events/public-events": { loadPublicCalendarEventsWindow: async () => { dayReads++; return { events }; }, parseNormalizedEventDate: nightlife.parseDateKeyToUtcNoon },
  "@/components/events/event-meta": { getEventCategoryKind: categories.getEventPrimaryCategory },
  "@/lib/events/calendar-agenda-projection": projection,
  "@/lib/events/calendar-venue-selection": { resolveCalendarVenueSelection: async requested => ({ value: requested }) },
  "@/lib/events/mobile-week": week,
  "@/lib/taxonomy/event-categories": categories,
  "@/lib/events/event-time": eventTime,
  "@/lib/events/nightlife-date": nightlife,
  "@/lib/venues/venue-open-now": openNow,
  "@/lib/events/public-event-search": search,
  "@/lib/seo/site": seo,
  "@/lib/events/public-event-venue-filter": venueFilter,
  "@/lib/events/public-calendar-overview": { loadPublicCalendarOverviewWindow: () => assert.fail("Rendering the day must never await month counters.") },
}).default;
const tree = await page({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31" }) });
assert.equal(dayReads, 1);
const agendas = nodes(tree, node => node.type === "CalendarAgenda");
assert.equal(agendas.length, 1);
assert.equal(agendas[0].props.events.length, 8);
assert.ok(!JSON.stringify(agendas[0].props.events).includes("private-sized-hours-data"));
for (const link of nodes(tree, node => node.type === "link" && node.props.href?.startsWith("/?"))) {
  assert.equal(link.props["data-calendar-client-navigation"], "true", "Calendar date/filter links must opt out of the global document-reload handler.");
}

const data = { generatedAt: 1, venues: [], groups: [
  { date: "2026-10-31", category: "club", venueValue: "id:a", count: 99, legacyVenueMatchCount: 99 },
  { date: "2026-10-30", category: "live", venueValue: "id:b", count: 3, legacyVenueMatchCount: 1 },
  { date: "2026-11-01", category: "event", venueValue: "id:c", count: 4, legacyVenueMatchCount: 2 },
] };
const snapshot = { date: "2026-10-31", groups: [{ date: "2026-10-31", category: "club", venueValue: "id:a", count: 2, legacyVenueMatchCount: 2 }] };
const options = { month: "2026-10", weekStart: "2026-10-30" };
const counts = buildCalendarOverviewPresentation(data, options, snapshot, []);
assert.equal(counts.days.get("2026-10-31").eventCount, 2, "The selected day's fresh detail snapshot overrides older month counters.");
assert.equal(counts.metrics.events, 5, "Extra week dates must not enter the selected month's totals.");
assert.equal(counts.metrics.venues, 2);
assert.equal(counts.metrics.weekend, 2);
assert.equal(buildCalendarOverviewPresentation(data, options, snapshot, ["club"]).metrics.events, 3);
assert.equal(buildCalendarOverviewPresentation(data, { ...options, venue: "id:b" }, snapshot, []).metrics.events, 3);
assert.equal(buildCalendarOverviewPresentation(data, { ...options, venue: "Legacy name" }, snapshot, []).metrics.events, 3);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = 1000; let calls = 0; let release;
try {
  Date.now = () => now;
  globalThis.fetch = async url => {
    calls++;
    assert.ok(!String(url).includes("day="), "Overview transport must not be keyed to the clicked day.");
    return new Promise(resolve => { release = () => resolve(Response.json(data)); });
  };
  const first = fetchCalendarOverview(options);
  const pending = fetchCalendarOverview({ ...options, day: "2026-10-31" });
  assert.equal(first, pending);
  assert.equal(calls, 1);
  release(); await first;
  await fetchCalendarOverview({ ...options, day: "2026-10-30" });
  assert.equal(calls, 1, "Changing days in a month must reuse the same fresh counters.");
  assert.ok(peekCalendarOverview(options));
  now += 60_001;
  assert.equal(peekCalendarOverview(options), undefined);
  globalThis.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
  await assert.rejects(fetchCalendarOverview(options));
  globalThis.fetch = async () => { calls++; return Response.json(data); };
  await fetchCalendarOverview(options);
  assert.equal(calls, 3, "A failed refresh must remain retryable.");
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; }

const apiCalls = [];
const api = compile("app/api/calendar/overview/route.ts", {
  "next/server": require("next/server.js"),
  "@/lib/events/nightlife-date": nightlife,
  "@/lib/events/mobile-week": week,
  "@/lib/events/public-calendar-overview": { loadPublicCalendarOverviewWindow: async args => { apiCalls.push(args); return { groups: [], venues: [] }; } },
});
const response = await api.GET(new NextRequest("https://eventzeka.com/api/calendar/overview?month=2026-10&weekStart=2026-10-30"));
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
assert.deepEqual(apiCalls.map(({ fromDate, beforeDate }) => ({ fromDate, beforeDate })), [{ fromDate: "2026-10-01", beforeDate: "2026-11-01" }, { fromDate: "2026-11-01", beforeDate: "2026-11-06" }]);
for (const query of ["month=2026-13&weekStart=2026-10-30", "month=2026-10&weekStart=2026-02-30", "month=9999-12&weekStart=2026-10-30"]) {
  assert.equal((await api.GET(new NextRequest(`https://eventzeka.com/api/calendar/overview?${query}`))).status, 400);
}
assert.equal(apiCalls.length, 2, "Invalid counter ranges must not dispatch backend reads.");
const unavailableApi = compile("app/api/calendar/overview/route.ts", {
  "next/server": require("next/server.js"), "@/lib/events/nightlife-date": nightlife, "@/lib/events/mobile-week": week,
  "@/lib/events/public-calendar-overview": { loadPublicCalendarOverviewWindow: async () => ({ groups: [], venues: [], error: "Internal backend failure" }) },
});
const unavailable = await unavailableApi.GET(new NextRequest("https://eventzeka.com/api/calendar/overview?month=2026-10&weekStart=2026-10-30"));
assert.equal(unavailable.status, 503);
assert.ok(!(await unavailable.text()).includes("Internal backend failure"));
console.log("Calendar navigation QA passed: one responsive event tree, compact metadata parity, independent day rendering, selected-day counter authority, bounded overview API, shared requests, expiry and recovery.");
