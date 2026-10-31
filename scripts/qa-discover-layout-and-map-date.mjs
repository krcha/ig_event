import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as dates from "../lib/events/nightlife-date.ts";
import * as maps from "../lib/events/event-map.ts";
import { discoverPhotoSnapTarget } from "../lib/discover/photo-scroll-snap.ts";

function compile(file, imports, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports: module.exports, require(name) { if (name in imports) return imports[name]; throw Error(`Unexpected import: ${name}`); }, Date, ...extra });
  return module.exports;
}

assert.equal(discoverPhotoSnapTarget(0, 192, 1), 180);
assert.equal(discoverPhotoSnapTarget(80, 112, 1), 180);
assert.equal(discoverPhotoSnapTarget(80, 112, -1), null, "Scrolling up must escape to the header.");
assert.equal(discoverPhotoSnapTarget(180, 12, 1), null, "An aligned photo must not repeatedly snap.");
assert.equal(discoverPhotoSnapTarget(400, -208, 1), null, "Further scrolling below the photo stays natural.");

function snapHarness(reduced = false) {
  const listeners = new Map(), classes = new Set(), calls = [];
  let cleanup, scheduled;
  const window = { scrollY: 0, matchMedia: () => ({ matches: reduced }), addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), scrollTo: options => calls.push(options) };
  const document = { documentElement: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } };
  const { useDiscoverPhotoSnap } = compile("components/discover/use-discover-photo-snap.ts", { react: { useEffect: effect => { cleanup = effect(); } }, "@/lib/discover/photo-scroll-snap": { discoverPhotoSnapTarget } }, {
    window, document, setTimeout: callback => { scheduled = callback; return 1; }, clearTimeout: () => { scheduled = undefined; },
  });
  useDiscoverPhotoSnap({ current: { getBoundingClientRect: () => ({ top: 192-window.scrollY }) } }, true, "photo-snap");
  return { calls, classes, cleanup: () => cleanup(), listeners, event: (name, event) => listeners.get(name)?.(event), scroll(y) { window.scrollY=y; listeners.get("scroll")(); }, settle() { const callback=scheduled; scheduled=undefined; callback?.(); } };
}
for (const reduced of [false, true]) {
  const h=snapHarness(reduced);
  assert.equal(h.calls.length, 0, "Opening Discover must not scroll the page.");
  h.scroll(100); h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].top, 180);
  assert.equal(h.calls[0].behavior, reduced ? "instant" : "smooth");
  h.scroll(250); h.settle(); assert.equal(h.calls.length, 1, "The first anchor does not trap later scrolling.");
  h.scroll(0); h.settle(); assert.equal(h.classes.size, 0);
  h.scroll(260); h.settle(); assert.equal(h.calls.at(-1).top, 180, "A first touch flick that overshoots still aligns the photo.");
  assert.equal(h.calls.at(-1).behavior, "instant", "Correcting an overshoot must not be interrupted by a reversed smooth-scroll event.");
  h.cleanup(); assert.equal(h.listeners.size, 0); assert.equal(h.classes.size, 0);
}

const jsx = (type, props) => ({ type, props });
for (const [instant, expected] of [
  ["2026-11-01T02:00:00+01:00", "2026-11-01"],
  ["2027-01-01T00:30:00+01:00", "2027-01-01"],
  ["2026-03-29T01:15:00Z", "2026-03-29"],
  ["2026-10-25T01:15:00Z", "2026-10-25"],
]) {
  let readWindow;
  const events=[{_id:"today",date:expected,title:"Today",venue:"Venue",eventType:"live"},{_id:"yesterday",date:dates.addDaysToDateKey(expected,-1)}];
  class FixedDate extends Date { static now() { return Date.parse(instant); } }
  const page=compile("app/(main)/map/page.tsx", {
    react: { Suspense: "suspense" }, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/maps/event-calendar-map": { EventCalendarMap: "map" },
    "@/components/maps/event-map-loading": { EventMapLoading: "loading" },
    "@/lib/events/event-map": maps, "@/lib/events/nightlife-date": dates,
    "@/lib/events/public-events": { loadPublicCalendarEventsWindow: async value => { readWindow=value; return { events }; } },
    "@/lib/events/public-calendar-overview": { loadPublicCalendarOverviewWindow: async () => ({groups:[]}) },
    "@/lib/seo/site": { SITE_ORIGIN: "https://eventzeka.com" },
    "@/data/venue-coordinates-2026-10-15.json": { default: { venues: [] } },
  }, { Date: FixedDate }).default;
  const tree=await page({searchParams:Promise.resolve({})});
  const result=await tree.props.children.type(tree.props.children.props);
  assert.equal(result.props.selectedDate,expected,"Map defaults to the civil date in Belgrade, including before the nightlife rollover.");
  assert.equal(result.props.todayDate,expected);
  assert.equal(readWindow.fromDate,expected);
  assert.equal(readWindow.beforeDate,dates.addDaysToDateKey(expected,1));
  assert.deepEqual(result.props.events.map(event=>event._id),["today"],"Yesterday's events must not leak into today's ordinary map.");
}
console.log("QA passed: deliberate photo snapping, upward escape, reduced motion, cleanup, and today's map events across midnight/year/DST.");
