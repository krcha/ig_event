import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import * as categories from "../lib/taxonomy/event-categories.ts";
import * as discovery from "../lib/taxonomy/event-discovery.ts";
import * as eventTime from "../lib/events/event-time.ts";
import * as presentation from "../lib/events/event-time-presentation.ts";
import * as bands from "../lib/events/calendar-time-bands.ts";
import * as sessions from "../lib/events/event-session.ts";
import * as nightlife from "../lib/events/nightlife-date.ts";
import * as week from "../lib/events/mobile-week.ts";
import * as venueFilter from "../lib/events/public-event-venue-filter.ts";
import * as search from "../lib/events/public-event-search.ts";
import * as openNow from "../lib/venues/venue-open-now.ts";
import * as seo from "../lib/seo/site.ts";
import { buildCalendarOverviewPresentation } from "../lib/events/calendar-overview-data.ts";
import { fetchCalendarOverview, peekCalendarOverview } from "../lib/events/calendar-overview-client.ts";
import { chunkPublicVenueIds, loadPublicVenueBatches } from "../lib/events/public-venue-batching.ts";
import * as venueFields from "../lib/events/public-event-venue-fields.ts";
import * as publicSort from "../lib/events/public-event-sort.ts";
import * as venueNormalization from "../lib/pipeline/venue-normalization.ts";
import * as calendarWindows from "../lib/events/public-calendar-windows.ts";
import * as readCache from "../lib/events/public-event-read-cache.ts";
import { rankEventRecommendations } from "../lib/travel/event-recommendations.ts";
import * as compressedJson from "../lib/http/compressed-json.ts";

import * as agendaSort from "../lib/events/agenda-sort.ts";
import * as agendaOptions from "../lib/events/agenda-sort-options.ts";
import * as localeConfig from "../i18n/config.ts";
import * as publicDisplay from "../lib/i18n/display.ts";
import * as localizedSeo from "../lib/i18n/seo.ts";
import { publicText } from "../lib/i18n/public-messages.ts";

const require = createRequire(import.meta.url);
const jsx = (type, props, key) => type?.qaRender ? type(props) : ({ type, props: props ?? {}, key });
const components = new Proxy({ __esModule: true }, { get: (target, name) => name in target ? target[name] : String(name) });
let pageLocale = "sr";
let discoveryParams = new URLSearchParams();
let userPosition = null;
const localizedComponents = new Proxy({
  PublicText: Object.assign(({ text }) => publicText(pageLocale, text), { qaRender: true }),
  LocalizedLink: Object.assign(({ href, ...props }) => jsx("link", { ...props, href: localeConfig.localizeHref(href, pageLocale) }), { qaRender: true }),
  LocalizedElement: Object.assign(({ as = "span", ...props }) => {
    for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
      if (typeof props[attribute] === "string") props[attribute] = publicText(pageLocale, props[attribute]);
    }
    return jsx(as, props);
  }, { qaRender: true }),
}, { get: (target, name) => name in target ? target[name] : components[name] });
function compile(file, mocks) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiled = { exports: {} };
  new Function("require", "exports", "module", output)(name => {
    if (name in mocks) return mocks[name];
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/i18n/server") return { getLocale: async () => pageLocale };
    if (name === "@/i18n/config") return localeConfig;
    if (name === "@/lib/i18n/display") return publicDisplay;
    if (name === "@/lib/i18n/seo") return localizedSeo;
    if (name === "@/components/i18n/public-text") return localizedComponents;
    if (name === "@/components/travel/user-location") return { useUserLocation: () => ({ position: userPosition, status: userPosition ? "ready" : "idle", error: null, requestLocation: () => {} }) };
    if (name === "@/lib/taxonomy/event-discovery") return discovery;
    if (name === "./calendar-discovery-state") return discoveryState;
    if (name === "lucide-react" || name.startsWith("@/components/") || name.startsWith("./calendar-") || name === "./event-kind-toggle-chips" || name === "./open-now-filter") return components;
    if (name === "next/image") return { __esModule: true, default: "image" };
    if (name.endsWith(".png")) return { __esModule: true, default: {src:"/skyline.png",width:2170,height:725} };
    if (name === "@/lib/events/agenda-sort-options") return agendaOptions;
    if (name === "@/lib/http/compressed-json") return compressedJson;
    if (name === "@/lib/events/agenda-sort") return agendaSort;
    if (name === "next/link") return { __esModule: true, default: "link" };
    if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_target, name) => String(name) }) };
    if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
    throw new Error(`Unexpected QA import: ${name}`);
  }, compiled.exports, compiled);
  return compiled.exports;
}
const discoveryState = compile("components/calendar/calendar-discovery-state.ts", {
  "next/navigation": { useSearchParams: () => discoveryParams },
  react: { useMemo: callback => callback() },
  "@/lib/events/calendar-time-band-definitions": bands,
  "@/lib/taxonomy/event-categories": categories,
});
const projection = compile("lib/events/calendar-agenda-projection.ts", {
  "../taxonomy/event-discovery": discovery,
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

// The actual compact agenda must display its server-computed hours fallback,
// including split and overnight openings, without claiming an event start.
{
  const hours = windows => ({ hoursJson: JSON.stringify({
    version: 1, source: "manual", timezone: "Europe/Belgrade", generatedAt: "2026-10-31T12:00:00.000Z",
    weekly: [{ day: 6, closed: false, windows }],
  }) });
  const fallbackEvents = [
    { _id: "hours", venueHours: hours([{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "split", venueHours: hours([{ day: 6, start: "10:00", end: "18:00" }, { day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "all-day", venueHours: hours([{ day: 6, start: "00:00", end: "00:00", spansNextDay: true }]) },
    { _id: "missing-hours" },
    { _id: "different-weekday", date: "2026-11-01", venueHours: hours([{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "announced", time: "21:00-23:00", timeStatus: "confirmed", venueHours: hours([{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "start-only", time: "21:00", timeStatus: "confirmed", venueHours: hours([{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "outside-opening", time: "19:00", timeStatus: "confirmed", venueHours: hours([{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
    { _id: "first-session", time: "17:00", timeStatus: "confirmed", venueHours: hours([{ day: 6, start: "10:00", end: "18:00" }, { day: 6, start: "20:00", end: "02:00", spansNextDay: true }]) },
  ].map(event => ({ title: event._id, venue: "Place", date: "2026-10-31", timeStatus: "unknown", ...event }));
  const compact = projection.projectCalendarAgendaEvents(fallbackEvents, new Map(), new Map());
  const VirtualAgendaList = Object.assign(({ items, children }) => items.map(children), { qaRender: true });
  const { CalendarAgenda } = compile("components/calendar/calendar-agenda.tsx", {
    react: { useMemo: cb => cb(), useState: value => [value, () => {}], useEffect: () => {} },
    "./virtual-agenda-list": { VirtualAgendaList }, "@/lib/events/calendar-time-band-definitions": bands,
  });
  const tree = CalendarAgenda({ events: compact, openNowActive: false, hasActiveFilters: false, clearFiltersHref: "/" });
  const rows = nodes(tree, node => node.props?.["data-calendar-event-id"]);
  function row(id) {
    return rows.find(row => row.props["data-calendar-event-id"] === id);
  }
  function timeBlock(id) {
    return nodes(row(id), node => ["event", "unknown"].includes(node.props?.["data-time-source"]))[0];
  }
  function text(tree) {
    if (Array.isArray(tree)) return tree.map(text).join("");
    if (tree && typeof tree === "object") return text(tree.props?.children);
    return typeof tree === "string" ? tree : "";
  }
  function venueHours(id) {
    return text(nodes(row(id), node => node.props?.["data-time-source"] === "venue_hours"));
  }
  assert.equal(timeBlock("hours").props["aria-label"], "Vreme nije najavljeno");
  assert.equal(venueHours("hours"), "Radno vreme mesta: 20:00–02:00");
  assert.equal(venueHours("split"), "Radno vreme mesta: 10:00–18:00, 20:00–02:00");
  assert.equal(venueHours("all-day"), "Radno vreme mesta: 24 h");
  for (const id of ["hours", "split", "all-day", "missing-hours", "different-weekday"]) {
    assert.equal(timeBlock(id).props["data-time-source"], "unknown");
    assert.equal(text(timeBlock(id)), "—");
  }
  for (const id of ["missing-hours", "different-weekday", "announced", "start-only"]) assert.equal(venueHours(id), "");
  assert.equal(timeBlock("announced").props["data-time-source"], "event");
  assert.equal(text(timeBlock("announced")), "21:0023:00");
  assert.equal(text(timeBlock("start-only")), "21:0002:00");
  assert.match(timeBlock("start-only").props["aria-label"], /Pretpostavljeni završetak.*02:00/);
  assert.equal(nodes(timeBlock("start-only"), node => node.props?.["data-inferred-end"] === "true").length, 1);
  assert.equal(compact.find(event => event._id === "start-only").time, "21:00", "The inferred closing must remain display context, not replace the source's start-only time.");
  assert.equal(text(timeBlock("outside-opening")), "19:00");
  assert.equal(text(timeBlock("first-session")), "17:0018:00", "Use the matching opening's close rather than the last close of the day.");
  for (const event of compact.filter(event => event.timeStatus === "unknown")) {
    assert.equal(event.band, "time-not-announced");
    assert.equal(event.timeParts.startLabel, undefined);
    assert.equal(event.time, undefined);
  }
  assert.ok(!JSON.stringify(compact).includes("hoursJson"));
}

let selectionReads = 0;
const venueLabelReads = [];
let publicVenueRecords = [{ _id: "venue-a", name: "Current name" }];
const legacyOptions = [{ value: "id:venue-a", label: "Current name", names: ["Current name", "Old alias"] }];
const selection = compile("lib/events/calendar-venue-selection.ts", {
  "server-only": {}, "./public-event-venue-filter": venueFilter,
  "./calendar-convex-url": { getCalendarConvexUrl: () => "http://127.0.0.1:3210" },
  "convex/browser": { ConvexHttpClient: class {
    async query(name, args) {
      assert.equal(name, "venues:listPublicVenueFieldsByIds");
      venueLabelReads.push(args);
      if (publicVenueRecords instanceof Error) throw publicVenueRecords;
      return publicVenueRecords;
    }
  } },
  "./public-calendar-overview": { loadPublicCalendarOverviewWindow: async () => { selectionReads++; return { venues: legacyOptions }; } },
});
for (const value of [undefined, "id:venue-a", "name:unknown venue"]) {
  assert.equal((await selection.resolveCalendarVenueSelection(value, { fromDate: "2026-10-01", beforeDate: "2026-11-01" })).value, value);
}
assert.equal(selectionReads, 0, "Ordinary day/ID filters must not wait for monthly identity reads.");
assert.deepEqual(venueLabelReads, [{ ids: ["venue-a"] }], "An ID label reads exactly one public venue, even without an event on the selected day.");
assert.equal((await selection.resolveCalendarVenueSelection("id:venue-a", {})).label, "Current name");
assert.equal((await selection.resolveCalendarVenueSelection("name:unknown venue", {})).label, "unknown venue");
publicVenueRecords = [];
assert.equal((await selection.resolveCalendarVenueSelection("id:private-or-deleted", {})).label, undefined, "A nonpublic venue must not acquire a name from an unbounded/private lookup.");
publicVenueRecords = new Error("Invalid venue ID");
assert.equal((await selection.resolveCalendarVenueSelection("id:invalid", {})).label, undefined, "Malformed IDs must not break public browsing.");
assert.equal(selectionReads, 0, "Canonical ID/name labels must never fetch monthly counters.");
assert.equal((await selection.resolveCalendarVenueSelection("Old alias", {})).value, "id:venue-a");
legacyOptions.push({ value: "id:venue-b", label: "Other venue", names: ["Old alias"] });
assert.equal((await selection.resolveCalendarVenueSelection("Old alias", {})).value, "Old alias", "Ambiguous legacy aliases must retain the existing name-matching behavior.");

for (const mobile of [false, true]) for (const sortMode of ["time", "popularity", "venue", "distance"]) {
  const VirtualAgendaList = Object.assign(({items,children})=>items.map(children),{qaRender:true});
  const {CalendarAgenda}=compile("components/calendar/calendar-agenda.tsx",{
    react:{useMemo:cb=>cb(),useState:v=>[v,()=>{}],useEffect:()=>{}},"./virtual-agenda-list":{VirtualAgendaList},
    "@/lib/events/calendar-time-band-definitions":bands,
  });
  const ordered=agendaSort.sortAgendaEvents(events,sortMode);
  const compact=projection.projectCalendarAgendaEvents(ordered,new Map(ordered.map((e,i)=>[e._id,i])),new Map());
  const tree=CalendarAgenda({events:compact,sortMode,openNowActive:false,hasActiveFilters:false,clearFiltersHref:"/"});
  const rows=nodes(tree,node=>node.props?.["data-calendar-event-id"]);
  assert.deepEqual(rows.map(node=>node.props["data-calendar-event-id"]),ordered.map(e=>e._id),`The whole ${sortMode} ordering must survive the ${mobile?"mobile":"desktop"} rendering path.`);
  assert.equal(new Set(rows.map(node=>node.props["data-calendar-event-id"])).size,events.length);
  if (sortMode !== "time") assert.equal(nodes(tree,node=>node.props?.["data-calendar-time-band"]!==undefined).length,0,"Popularity, venue and distance lists cannot be regrouped by time.");
}

{
  const VirtualAgendaList = Object.assign(({ items, children }) => items.map(children), { qaRender: true });
  const { CalendarAgenda } = compile("components/calendar/calendar-agenda.tsx", {
    react: { useMemo: cb => cb() }, "./virtual-agenda-list": { VirtualAgendaList },
    "@/lib/events/calendar-time-band-definitions": bands,
  });
  const compact = projected.map((event, index) => ({ ...event, venueLatitude: 44.81 + (7 - index) * .001, venueLongitude: 20.46 }));
  userPosition = { latitude: 44.81, longitude: 20.46 };
  const tree = CalendarAgenda({ events: compact, sortMode: "distance", openNowActive: false, hasActiveFilters: false, clearFiltersHref: "/" });
  assert.deepEqual(nodes(tree, node => node.props?.["data-calendar-event-id"]).map(row => row.props["data-calendar-event-id"]),
    [...compact].reverse().map(event => event._id), "The complete client matching set must be sorted from the shared GPS fix before virtualization.");
  assert.equal(nodes(tree, node => node.props?.["data-calendar-distance-location"]).length, 0, "A valid GPS fix does not show a redundant permission prompt.");
  assert.equal(nodes(tree, node => node.type === "img").length, 0, "Collapsed event rows must not request poster images.");
  userPosition = null;
  const fallback = CalendarAgenda({ events: compact, sortMode: "distance", openNowActive: false, hasActiveFilters: false, clearFiltersHref: "/" });
  assert.equal(nodes(fallback, node => node.props?.["data-calendar-distance-location"]).length, 1, "A distance link without a GPS fix offers an explicit permission action.");
}

{
  const VirtualAgendaList = Object.assign(({ items, getKey, children }) => {
    assert.equal(new Set(items.map(getKey)).size, items.length, "Virtual rows require unique occurrence keys.");
    return items.map(children);
  }, { qaRender: true });
  const { CalendarAgenda } = compile("components/calendar/calendar-agenda.tsx", {
    react: { useMemo: callback => callback() },
    "./virtual-agenda-list": { VirtualAgendaList }, "@/lib/events/calendar-time-band-definitions": bands,
  });
  const hybrid = {
    ...projected[1], band: "evening",
    eventTaxonomy: { primaryCategory: "party", categories: ["party", "live"], genres: ["house", "techno"], formats: ["concert", "dj-set"] },
  };
  const jazz = {
    ...projected[2], band: "evening", category: "culture",
    eventTaxonomy: { primaryCategory: "live", categories: ["live", "talk"], genres: ["jazz-blues"], formats: ["talk", "concert"] },
  };
  const late = {
    ...projected[3], band: "night",
    eventTaxonomy: { primaryCategory: "party", categories: ["party"], genres: ["techno"], formats: ["dj-set"] },
  };
  const [legacy] = projection.projectCalendarAgendaEvents([
    { ...events[4], title: "Friday night", description: "Doors open at 22:00.", eventType: "nightlife" },
  ], new Map(), new Map());
  const [described] = projection.projectCalendarAgendaEvents([
    { ...events[0], _id: "described", title: "Friday trio", description: "Live jazz concert.", eventType: "live music" },
  ], new Map(), new Map());
  const standUp = {
    ...projected[5], band: "evening",
    eventTaxonomy: { primaryCategory: "culture", categories: ["culture"], genres: [], formats: ["stand-up"] },
  };
  const film = {
    ...projected[6], band: "evening",
    eventTaxonomy: { primaryCategory: "culture", categories: ["culture"], genres: [], formats: ["screening"] },
  };
  const render = (query, day = [hybrid, jazz, late, legacy, hybrid, standUp, film]) => {
    discoveryParams = new URLSearchParams(query);
    const tree = CalendarAgenda({ events: day, openNowActive: false, hasActiveFilters: false, clearFiltersHref: "/" });
    const rows = nodes(tree, node => node.props?.["data-calendar-event-id"]);
    return {
      ids: rows.map(node => node.props["data-calendar-event-id"]),
      row: id => rows.find(node => node.props["data-calendar-event-id"] === id),
      facets: nodes(tree, node => node.type === "CalendarDiscoveryFilters")[0].props,
      count: nodes(tree, node => node.type === "PublicEventCount")[0].props.count,
    };
  };
  const categoriesOnly = render("category=party,live");
  assert.equal(categoriesOnly.count, 4, "An occurrence that matches both intents still counts once.");
  assert.equal(categoriesOnly.facets.categoryCounts.get("party"), 3);
  assert.equal(categoriesOnly.facets.categoryCounts.get("live"), 2);
  assert.equal(categoriesOnly.facets.genreCounts.get("electronic"), 2, "The electronic parent genre counts each matching event once.");
  const jazzCategory = nodes(categoriesOnly.row(jazz._id), node => node.props?.["data-category-tone"])[0];
  assert.equal(jazzCategory.props["data-category-tone"], "live");
  assert.match(JSON.stringify(jazzCategory.props.children), /Koncert/);
  assert.doesNotMatch(JSON.stringify(jazzCategory.props.children), /Razgovor/);
  assert.equal(nodes(categoriesOnly.row(jazz._id), node => node.props?.["data-calendar-genre-label"] === "jazz-blues")[0].props.children, "Džez i bluz");
  assert.match(JSON.stringify(nodes(categoriesOnly.row(hybrid._id), node => node.props?.["data-category-tone"])[0].props.children), /DJ set/);
  const filtered = render("category=party,live&genre=electronic&time=evening");
  assert.deepEqual(filtered.ids, [hybrid._id, late._id], "Category choices are OR, the genre is AND, and retired time links no longer filter events.");
  assert.equal(filtered.count, 2);
  assert.equal(filtered.facets.categoryCounts.get("party"), 2);
  assert.equal(filtered.facets.categoryCounts.get("live"), 1);
  assert.equal(filtered.facets.genreCounts.get("house"), 1, "Legacy title tags must not become verified genre filters.");
  assert.deepEqual(render("genre=unknown").ids, [legacy._id], "Unknown genre matches music without an announced genre only.");
  assert.deepEqual(render("category=live&genre=jazz-blues", [described]).ids, [described._id],
    "The genre filter must retain explicit programme evidence from a server-only description.");
  assert.deepEqual(render("genre=unknown", [described]).ids, []);
  assert.ok(!Object.hasOwn(described, "description"));
  const comedy = render("category=culture&format=stand-up");
  assert.deepEqual(comedy.ids, [standUp._id], "Stand-up narrows the culture category without matching films.");
  assert.equal(comedy.facets.standUpCount, 1);
  discoveryParams = new URLSearchParams();
}

let dayReads = 0;
const dayReadWindows = [];
let pageEvents = events;
const page = compile("app/(main)/events-browse-page.tsx", {
  "@/lib/events/public-events": { loadPublicCalendarEventsWindow: async window => { dayReads++; dayReadWindows.push(window); return { events: pageEvents }; }, parseNormalizedEventDate: nightlife.parseDateKeyToUtcNoon },
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
{
  pageEvents = events.map((event, index) => ({
    ...event, performerGenreResearch: { sources: [{ performer: "Sample act", url: "https://example.org/music-profile" }] },
    venueInstagramFollowerCount: index === events.length - 1 ? 42_424_242 : undefined,
  }));
  const popular = await page({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31", sort: "popularity", time: "evening" }) });
  const agenda = nodes(popular, node => node.type === "CalendarAgenda")[0];
  assert.ok(agenda.props.events.every(event => !Object.hasOwn(event, "performerGenreResearch")),
    "The home agenda carries searchable genre values without shipping artist research links to the client.");
  assert.equal(agenda.props.events[0]._id, events.at(-1)._id, "The selected-day server route sorts by canonical venue followers before projection.");
  assert.ok(!JSON.stringify(agenda.props.events).includes("42424242"), "The calendar agenda hydrates the ranked events without follower counts.");
  const toolbar = nodes(popular, node => node.type === "EventsToolbar")[0];
  const params = new URL(toolbar.props.openNowHref, seo.SITE_ORIGIN).searchParams;
  assert.equal(params.get("sort"), "popularity");
  assert.equal(params.has("time"), false);
  pageEvents = events;
}
const canonicalAgenda = JSON.stringify(agendas[0].props.events);
for (const locale of localeConfig.LOCALES) {
  pageLocale = locale;
  const readsBefore = dayReads;
  const localizedTree = await page({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31" }) });
  assert.equal(dayReads - readsBefore, 1, "Each locale must render with the same single bounded day read, without month reads or translation fetches.");
  assert.deepEqual(dayReadWindows.at(-1), { fromDate: "2026-10-31", beforeDate: "2026-11-01", includeEventTaxonomy: true }, "Locale must not alter the exclusive selected-day backend window or its compact discovery projection.");
  const heading = nodes(localizedTree, node => node.props?.id === "events-heading")[0];
  assert.equal(heading.props.lang, localeConfig.LOCALE_LANGUAGE_TAGS[locale]);
  assert.equal(heading.props.children, publicDisplay.publicDayHeading(locale, "2026-10-31", nightlife.getNightlifeDefaultDateKey(new Date())));
  const agenda = nodes(localizedTree, node => node.type === "CalendarAgenda")[0];
  assert.equal(JSON.stringify(agenda.props.events), canonicalAgenda, "Language projection must leave event identity, source metadata, timing, categories and payload size unchanged.");
  const weekCalendar = nodes(localizedTree, node => node.type === "MobileWeekCalendar")[0];
  assert.equal(weekCalendar.props.selectedDayKey, "2026-10-31");
  const toolbar = nodes(localizedTree, node => node.type === "EventsToolbar")[0];
  assert.equal(new URL(toolbar.props.openNowHref, seo.SITE_ORIGIN).searchParams.get("open"), "now");
  assert.ok(!JSON.stringify(localizedTree).includes("private-sized-hours-data"));
  const discover = nodes(localizedTree, node => node.type === "link" && node.props.href === localeConfig.localizeHref("/discover", locale));
  assert.equal(discover.length, 1, "The locale fixture must execute localized links rather than silently rendering inert component placeholders.");
}
pageLocale = "sr";
for (const link of nodes(tree, node => node.type === "link" && node.props.href?.startsWith("/?"))) {
  assert.equal(link.props["data-calendar-client-navigation"], "true", "Calendar date/filter links must opt out of the global document-reload handler.");
}
for (const [venue, expected] of [["id:venue-busy", "Busy venue"], ["name:busy venue", "Busy venue"], ["id:missing", "Mesto nije dostupno"]]) {
  pageEvents = venue.startsWith("name:") ? events.map(event => ({ ...event, venueId: undefined })) : events;
  const filteredTree = await page({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31", venue }) });
  const label = nodes(filteredTree, node => node.type === "p" && node.props.children?.[0] === "Izabrano mesto: ")[0];
  assert.equal(label?.props.children[1], expected, "The actual browse page must show a human label even when the lookup is unavailable.");
  assert.ok(!JSON.stringify(label).includes(venue), "Internal filter values must not leak into the displayed selection or clear link.");
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

// A new day must reset Suspense before the day-data promise is resolved.
const home = compile("app/page.tsx", {
  react: { Suspense: "suspense" }, "./(main)/events-browse-page": { __esModule: true, default: "DayPage" },
  "@/lib/seo/site": seo,
});
for (const locale of localeConfig.LOCALES) {
  pageLocale = locale;
  const metadata = await home.generateMetadata({ searchParams: Promise.resolve({}) });
  assert.equal(metadata.alternates.canonical, localizedSeo.localizedAbsoluteUrl("/", locale));
  assert.equal(metadata.title.absolute, `${localizedSeo.SITE_COPY[locale].homeTitle} | Event Zeka`);
  assert.equal(metadata.robots.index, true);
  const filteredMetadata = await home.generateMetadata({ searchParams: Promise.resolve({ day: "2026-10-31" }) });
  assert.equal(filteredMetadata.robots.index, false, "Filtered calendar pages must remain noindex in every language.");
}
pageLocale = "sr";
const firstDay = await home.default({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-30" }) });
const secondDay = await home.default({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31" }) });
assert.notEqual(firstDay.key, secondDay.key, "Transitions must show the new day's loading boundary instead of retaining a stale list.");
assert.equal(secondDay.props.fallback.props.day, "2026-10-31");
assert.equal(secondDay.props.children.type, "DayPage");
assert.equal((await secondDay.props.children.props.searchParams).day, "2026-10-31");
const categoryOnly = await home.default({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31", hide: "live,culture,event" }) });
const sortedOnly=await home.default({searchParams:Promise.resolve({month:"2026-10",day:"2026-10-31",sort:"venue",q:"jazz"})});
assert.equal(secondDay.key,sortedOnly.key,"Sorting/searching should retain the toolbar DOM and keyboard focus.");
assert.equal(secondDay.key, categoryOnly.key, "Optimistic category filtering must retain its current content boundary.");

const budget = compile("lib/events/calendar-overview-budget.ts", { "server-only": {} });
let releaseBudget; const budgetOrder = [];
const monthRead = budget.runCalendarOverviewRead(async () => { budgetOrder.push("month"); await new Promise(resolve => { releaseBudget = resolve; }); });
const weekRead = budget.runCalendarOverviewRead(async () => { budgetOrder.push("week"); throw new Error("counter failure"); });
const retryRead = budget.runCalendarOverviewRead(async () => { budgetOrder.push("retry"); return "ok"; });
const weekFailure = assert.rejects(weekRead, /counter failure/);
assert.deepEqual(budgetOrder, ["month"], "Month and extra-week scopes share one counter RPC slot.");
const foreground = await page({ searchParams: Promise.resolve({ month: "2026-10", day: "2026-10-31" }) });
assert.equal(nodes(foreground, node => node.type === "CalendarAgenda").length, 1, "The shipped day page must render while background counter work is pending.");
assert.doesNotMatch(readFileSync("lib/events/public-events.ts", "utf8"), /runCalendarOverviewRead/, "Day detail reads must never enter the background counter queue.");
releaseBudget(); await monthRead; await weekFailure;
assert.equal(await retryRead, "ok");
assert.deepEqual(budgetOrder, ["month", "week", "retry"], "A rejected counter read must release the slot in FIFO order.");

// Independent venue batches overlap, keep deterministic order, and stop scheduling on failure.
const batches = chunkPublicVenueIds(Array.from({ length: 350 }, (_, index) => String(index)));
const releases = new Map(); let active = 0; let maximum = 0;
const batchRead = loadPublicVenueBatches(batches, async ids => {
  active++; maximum = Math.max(maximum, active);
  await new Promise(resolve => releases.set(ids[0], resolve));
  active--; return [ids[0]];
});
assert.equal(active, 2);
releases.get("100")(); await new Promise(setImmediate);
assert.ok(releases.has("200"), "The second batch must not wait for the first batch to finish.");
releases.get("200")(); await new Promise(setImmediate);
releases.get("300")(); releases.get("0")();
assert.deepEqual(await batchRead, ["0", "100", "200", "300"]);
assert.equal(maximum, 2, "Parallel reads must remain bounded.");
let attempted = 0;
await assert.rejects(loadPublicVenueBatches(batches, async () => { attempted++; throw new Error("venue query failed"); }), /venue query failed/);
assert.equal(attempted, 2);

const transport = compile("lib/events/calendar-convex-url.ts", { "server-only": {} });
const previousPrivate = process.env.CONVEX_PUBLIC_READ_URL;
const previousPublic = process.env.NEXT_PUBLIC_CONVEX_URL;
try {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://same-backend.example";
  delete process.env.CONVEX_PUBLIC_READ_URL;
  assert.equal(transport.getCalendarConvexUrl(), "https://same-backend.example");
  process.env.CONVEX_PUBLIC_READ_URL = "http://private-same-backend:3210";
  assert.equal(transport.getCalendarConvexUrl(), "http://private-same-backend:3210");
  assert.equal(process.env.NEXT_PUBLIC_CONVEX_URL, "https://same-backend.example", "Internal server transport must not rewrite browser configuration.");
} finally {
  if (previousPrivate === undefined) delete process.env.CONVEX_PUBLIC_READ_URL; else process.env.CONVEX_PUBLIC_READ_URL = previousPrivate;
  if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL; else process.env.NEXT_PUBLIC_CONVEX_URL = previousPublic;
}
// Exercise the shipped loader: distant-date traffic must not evict a fresh or
// in-flight near-term day, while its existing TTL/error behavior stays intact.
let dayCalls = 0; let failDay = false; let pendingDay;
const dayQueryArgs = [];
const dayLoader = compile("lib/events/public-events.ts", {
  "server-only": {},
  "convex/browser": { ConvexHttpClient: class {
    constructor(url) { this.url = url; }
    async query(_reference, args) {
      dayCalls++;
      dayQueryArgs.push(args);
      if (failDay) { failDay = false; throw new Error("Day read failed"); }
      if (args.fromDate === "2026-11-04") await new Promise(resolve => { pendingDay = resolve; });
      return { page: [], isDone: true, continueCursor: "" };
    }
  } },
  "@/lib/events/event-time": eventTime,
  "@/lib/events/public-event-venue-fields": venueFields,
  "@/lib/events/public-event-sort": publicSort,
  "@/lib/pipeline/venue-normalization": venueNormalization,
  "@/lib/events/public-venue-batching": { chunkPublicVenueIds, loadPublicVenueBatches },
  "@/lib/events/calendar-convex-url": { getCalendarConvexUrl: () => "https://cache-test.example" },
  "@/lib/events/public-calendar-windows": calendarWindows,
  "@/lib/events/public-event-read-cache": readCache,
});
const realNow = Date.now;
let dayNow = Date.UTC(2026, 9, 31, 12);
const dayWindow = { fromDate: "2026-10-31", beforeDate: "2026-11-01" };
try {
  Date.now = () => dayNow;
  await dayLoader.loadPublicCalendarEventsWindow(dayWindow);
  const waitingWindow = { fromDate: "2026-11-04", beforeDate: "2026-11-05" };
  const waiting = dayLoader.loadPublicCalendarEventsWindow(waitingWindow);
  for (let index = 0; index < 80; index++) {
    const from = new Date(Date.UTC(2021, 0, 1 + index)).toISOString().slice(0, 10);
    const before = new Date(Date.UTC(2021, 0, 2 + index)).toISOString().slice(0, 10);
    await dayLoader.loadPublicCalendarEventsWindow({ fromDate: from, beforeDate: before });
  }
  assert.equal(dayCalls, 82);
  const coalesced = dayLoader.loadPublicCalendarEventsWindow(waitingWindow);
  assert.equal(dayCalls, 82, "Random dates must not evict the pending day or create duplicate reads.");
  pendingDay(); await waiting; await coalesced;
  await dayLoader.loadPublicCalendarEventsWindow(dayWindow);
  assert.equal(dayCalls, 82, "Fresh near-term data must survive distant-date cache churn.");
  await dayLoader.loadPublicCalendarEventsWindow({ fromDate: "2021-01-01", beforeDate: "2021-01-02" });
  assert.equal(dayCalls, 83, "Distant dates still use bounded LRU eviction.");
  dayNow += 60_001;
  await dayLoader.loadPublicCalendarEventsWindow(dayWindow);
  assert.equal(dayCalls, 84, "Protected days must still expire after 60 seconds.");
  failDay = true;
  const retryWindow = { fromDate: "2026-11-02", beforeDate: "2026-11-03" };
  assert.match((await dayLoader.loadPublicCalendarEventsWindow(retryWindow)).error, /Day read failed/);
  assert.equal((await dayLoader.loadPublicCalendarEventsWindow(retryWindow)).error, undefined);
  const enrichedWindow = { ...dayWindow, includeEventTaxonomy: true };
  const callsBeforeEnrichment = dayCalls;
  await Promise.all([dayLoader.loadPublicCalendarEventsWindow(enrichedWindow), dayLoader.loadPublicCalendarEventsWindow(enrichedWindow)]);
  assert.equal(dayCalls, callsBeforeEnrichment + 1, "Enriched day reads coalesce separately from the plain day cache.");
  assert.deepEqual(dayQueryArgs.at(-1), { ...enrichedWindow, includePerformerGenreResearch: true, cursor: null });
  await dayLoader.loadPublicCalendarEventsWindow(dayWindow);
  await dayLoader.loadPublicCalendarEventsWindow(enrichedWindow);
  assert.equal(dayCalls, callsBeforeEnrichment + 1, "Both day variants must keep their own fresh cache entry.");
} finally { Date.now = realNow; }
const bounded = new Map(Array.from({ length: 80 }, (_, index) => [String(index), { expiresAt: Infinity, priority: true }]));
readCache.prunePublicEventReadCache(bounded, 48, dayNow);
assert.equal(bounded.size, 48, "Priority must never increase the cache's memory bound.");
bounded.set("expired", { expiresAt: dayNow, priority: true });
readCache.prunePublicEventReadCache(bounded, 48, dayNow);
assert.ok(!bounded.has("expired"));
assert.equal(readCache.isPriorityCalendarWindow("2026-10-31", "2026-11-01", dayNow), true);
assert.equal(readCache.isPriorityCalendarWindow("2026-10-31", "2026-11-03", dayNow), false);
assert.equal(readCache.isPriorityCalendarWindow("2031-10-31", "2031-11-01", dayNow), false);
console.log("Calendar navigation QA passed: one responsive tree, compact metadata parity, independent day rendering, exact counts, bounded reads, near-term cache protection, expiry and recovery.");

{
  const { loadRecommendationWindow } = compile("lib/travel/recommendation-window.ts", {
    "server-only": {}, "../../convex/_generated/api": { api: { events: { listPublicRecommendationWindowPaginated: "recommendations" } } },
    "../events/public-calendar-windows": calendarWindows, "../events/public-event-read-cache": readCache,
  });
  const calls = [];
  let active = 0, peak = 0, fail = false;
  const client = { url: "https://compare.example", async query(ref, args) {
    assert.equal(ref, "recommendations");
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      calls.push(args);
      if (fail) throw new Error("unavailable");
      return args.cursor === null ? { page: [], isDone: false, continueCursor: "page2" }
        : { page: calendarWindows.buildPublicCalendarDateWindows(args.fromDate, args.beforeDate, 1).map(day => ({ _id: day.fromDate, date: day.fromDate })), isDone: true, continueCursor: "" };
    } finally { active--; }
  } };
  const window = { fromDate: "2026-11-27", beforeDate: "2026-12-11" };
  const [first, concurrent] = await Promise.all([loadRecommendationWindow(client, window), loadRecommendationWindow(client, window)]);
  assert.equal(first.events.length, 14);
  assert.deepEqual(concurrent, first);
  assert.equal(peak, 2);
  assert.equal(calls.length, 10, "Two references share all reads, including continuations after an empty page.");
  assert.deepEqual(await loadRecommendationWindow(client, window), first);
  assert.equal(calls.length, 10);
  const overlap = await loadRecommendationWindow(client, { fromDate: "2026-11-28", beforeDate: "2026-12-12" });
  assert.equal(calls.length, 12, "Changing the reference day reloads only the new day.");
  assert.equal(overlap.events[0]._id, "2026-11-28");
  const isolated = { ...client, url: "https://other.example" };
  fail = true;
  assert.ok((await loadRecommendationWindow(isolated, window)).error);
  fail = false;
  assert.equal((await loadRecommendationWindow(isolated, window)).events.length, 14);

  // Warming a single GPS programme day must preserve the shared Convex keys
  // of a subsequent 14-day comparison, including an empty, already-read day.
  const compareWindow = { fromDate: "2026-11-28", beforeDate: "2026-12-12" };
  const days = calendarWindows.buildPublicCalendarDateWindows(compareWindow.fromDate, compareWindow.beforeDate, 1);
  const ranges = calendarWindows.buildPublicCalendarDateWindows(compareWindow.fromDate, compareWindow.beforeDate, 3);
  const key = ({ fromDate, beforeDate }) => fromDate + "/" + beforeDate;
  const now = Date.parse("2026-11-27T17:00:00Z");
  const candidates = days.filter((_, index) => index !== 7).flatMap(({ fromDate: date }) => ["house", "folk"].map(genre => ({
    _id: date + genre, date, title: genre, venue: "Test venue", status: "approved", genreEstimated: false,
    eventTaxonomy: { primaryCategory: "party", categories: ["party"], formats: ["dj-set"], genres: [genre] },
  })));
  const reference = { ...candidates[0], _id: "reference" };
  const expected = rankEventRecommendations(reference, candidates, now);
  assert.equal(expected.same.length, 6);
  assert.equal(expected.different.length, 6);
  for (const warm of [[], [0], [7], [0, 7], [0, 1, 2]]) {
    const requested = [];
    const isolatedClient = { url: "https://partial-cache.example/" + warm.join("-"), async query(_ref, args) {
      requested.push(key(args));
      const page = candidates.filter(event => event.date >= args.fromDate && event.date < args.beforeDate);
      return { page, isDone: true, continueCursor: "" };
    } };
    for (const index of warm) await loadRecommendationWindow(isolatedClient, days[index]);
    requested.length = 0;
    const actual = await loadRecommendationWindow(isolatedClient, compareWindow);
    const expectedKeys = ranges.filter(range => days.some((day, index) =>
      day.fromDate >= range.fromDate && day.fromDate < range.beforeDate && !warm.includes(index))).map(key);
    assert.deepEqual(requested.sort(), expectedKeys.sort(), "Warmed days " + warm.join(",") + " must preserve the original RPC ranges.");
    assert.deepEqual(actual.events, candidates, "Each original event appears once, in chronological order. Empty days stay empty.");
    assert.deepEqual(rankEventRecommendations(reference, actual.events, now), expected);
  }

}
