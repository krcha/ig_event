import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as dates from "../lib/events/nightlife-date.ts";
import * as maps from "../lib/events/event-map.ts";
import { discoverPhotoSnapTarget } from "../lib/discover/photo-scroll-snap.ts";
import * as localizedSeo from "../lib/i18n/seo.ts";
import { LOCALES } from "../i18n/config.ts";

function compile(file, imports, extra = {}) {
  const compiledModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports: compiledModule.exports, require(name) { if (name in imports) return imports[name]; throw Error(`Unexpected import: ${name}`); }, Date, ...extra });
  return compiledModule.exports;
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
  const { useDiscoverPhotoSnap: invokePhotoSnapEffect } = compile("components/discover/use-discover-photo-snap.ts", { react: { useEffect: effect => { cleanup = effect(); } }, "@/lib/discover/photo-scroll-snap": { discoverPhotoSnapTarget } }, {
    window, document, setTimeout: callback => { scheduled = callback; return 1; }, clearTimeout: () => { scheduled = undefined; },
  });
  invokePhotoSnapEffect({ current: { getBoundingClientRect: () => ({ top: 192-window.scrollY }) } }, true, "photo-snap");
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

// Reproduce the production streaming race: Discover mounts before its toolbar,
// then the header shifts the stage without a browser resize event.
{
  const listeners = new Map(), viewportListeners = new Map(), documentListeners = new Map(), fontListeners = new Map();
  const frames = new Map(), values = new Map(), observed = new Set();
  let cleanup, mutation, resized, fontsReady, frameId = 0, writes = 0;
  let stageTop = 124, navigation = null, navigationHeight = 0;
  let resizeDisconnected = false, mutationDisconnected = false;
  const controls = { contains: () => false };
  const main = { children: [controls] };
  const window = {
    innerHeight: 844, scrollY: 0,
    visualViewport: { height: 844, addEventListener: (name, callback) => viewportListeners.set(name, callback), removeEventListener: name => viewportListeners.delete(name) },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
  };
  const surface = {
    closest: () => main,
    getBoundingClientRect: () => ({ top: stageTop-window.scrollY }),
    style: { getPropertyValue: name => values.get(name), setProperty: (name, value) => { writes++; values.set(name,value); } },
  };
  const document = {
    body: {}, documentElement: {},
    querySelector: selector => selector === ".mobile-nav-shell" ? navigation : null,
    fonts: { ready: { then: callback => { fontsReady=callback; } }, addEventListener: (name, callback) => fontListeners.set(name,callback), removeEventListener: name => fontListeners.delete(name) },
    addEventListener: (name, callback) => documentListeners.set(name,callback),
    removeEventListener: name => documentListeners.delete(name),
  };
  class ResizeObserver { constructor(callback) { resized=callback; } observe(element) { observed.add(element); } disconnect() { resizeDisconnected=true; } }
  class MutationObserver { constructor(callback) { mutation=callback; } observe() {} disconnect() { mutationDisconnected=true; } }
  const { useDiscoverViewportFit } = compile("components/discover/use-discover-viewport-fit.ts", {
    react: { useLayoutEffect: effect => { cleanup=effect(); } },
  }, { window, document, ResizeObserver, MutationObserver });
  const settle = () => {
    for (let turn=0;frames.size;turn++) {
      assert.ok(turn<12,"Viewport fitting must settle, rather than resize itself forever.");
      const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback());
    }
  };
  const height = () => values.get("--discover-stage-height");
  useDiscoverViewportFit({current:surface},true);settle();
  assert.equal(height(),"614px","An absent streamed nav uses a safe height estimate, not a zero top edge.");
  navigation={getBoundingClientRect:()=>({height:navigationHeight})};navigationHeight=93;stageTop=180;
  mutation();settle();
  assert.equal(height(),"553px","A late header/nav mount automatically fills the available first viewport.");
  assert.ok(observed.has(navigation),"Late navigation nodes join size observation.");
  stageTop=196;fontsReady();settle();assert.equal(height(),"537px","Font layout settling recomputes the space above the poster.");
  window.scrollY=300;resized();settle();assert.equal(height(),"537px","Scrolling does not grow the deck or hide the global header.");
  window.visualViewport.height=780;stageTop=180;viewportListeners.get("resize")();settle();assert.equal(height(),"489px");
  navigationHeight=0;resized();settle();assert.equal(height(),"494px","A not-yet-laid-out nav cannot collapse the poster to its minimum.");
  const stableWrites=writes;mutation();resized();settle();assert.equal(writes,stableWrites,"Unchanged geometry never rewrites inline styles.");
  mutation();cleanup();assert.equal(frames.size,0);assert.ok(resizeDisconnected&&mutationDisconnected);
  assert.equal(listeners.size+viewportListeners.size+documentListeners.size+fontListeners.size,0);
  fontsReady();assert.equal(frames.size,0,"A late font promise cannot revive an unmounted deck.");
}

const jsx = (type, props) => ({ type, props });
for (const [instant, expected] of [
  ["2026-11-01T02:00:00+01:00", "2026-11-01"],
  ["2027-01-01T00:30:00+01:00", "2027-01-01"],
  ["2026-03-29T01:15:00Z", "2026-03-29"],
  ["2026-10-25T01:15:00Z", "2026-10-25"],
]) {
  for (const locale of LOCALES) {
  let readWindow, readOverviewWindow;
  const events=[{_id:"today",date:expected,title:"Today",venue:"Venue",eventType:"live"},{_id:"yesterday",date:dates.addDaysToDateKey(expected,-1)}];
  class FixedDate extends Date { static now() { return Date.parse(instant); } }
  const pageModule=compile("app/(main)/map/page.tsx", {
    react: { Suspense: "suspense" }, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/maps/event-calendar-map": { EventCalendarMap: "map" },
    "@/components/maps/event-map-loading": { EventMapLoading: "loading" },
    "@/lib/events/event-map": maps, "@/lib/events/nightlife-date": dates,
    "@/lib/events/public-events": { loadPublicCalendarEventsWindow: async value => { readWindow=value; return { events }; } },
    "@/lib/events/public-calendar-overview": { loadPublicCalendarOverviewWindow: async value => { readOverviewWindow=value; return {groups:[]}; } },
    "@/lib/seo/site": { SITE_ORIGIN: "https://eventzeka.com" },
    "@/data/venue-coordinates-2026-10-15.json": { default: { venues: [] } },
    "@/i18n/server": { getLocale: async () => locale },
    "@/lib/i18n/seo": localizedSeo,
  }, { Date: FixedDate });
  const tree=await pageModule.default({searchParams:Promise.resolve({})});
  const result=await tree.props.children.type(tree.props.children.props);
  assert.equal(result.props.selectedDate,expected,"Map defaults to the civil date in Belgrade, including before the nightlife rollover.");
  assert.equal(result.props.todayDate,expected);
  assert.equal(readWindow.fromDate,expected);
  assert.equal(readWindow.beforeDate,dates.addDaysToDateKey(expected,1));
  assert.deepEqual(result.props.events.map(event=>event._id),["today"],"Yesterday's events must not leak into today's ordinary map.");
  const weekday=dates.dateKeyToLocalNoonDate(expected).getDay();
  const expectedWeekStart=dates.addDaysToDateKey(expected,-((weekday+6)%7));
  assert.equal(readOverviewWindow.fromDate,expectedWeekStart,"Locale must not broaden the map count-read scope.");
  assert.equal(readOverviewWindow.beforeDate,dates.addDaysToDateKey(expectedWeekStart,7));
  const metadata=await pageModule.generateMetadata({searchParams:Promise.resolve({})});
  assert.equal(metadata.title,localizedSeo.SITE_COPY[locale].mapTitle);
  assert.equal(metadata.alternates.canonical,localizedSeo.localizedAbsoluteUrl("/map",locale));
  assert.equal(metadata.openGraph.locale,localizedSeo.OG_LOCALES[locale]);
  assert.equal(metadata.robots.index,true);
  const filteredMetadata=await pageModule.generateMetadata({searchParams:Promise.resolve({date:expected})});
  assert.equal(filteredMetadata.robots.index,false,"Date-filtered map variants retain their exclusion policy in every language.");
  }
}
console.log("QA passed: streaming-safe Discover viewport fitting, stable scroll baseline, font/viewport settling and cleanup, legacy photo snapping, and identical map date windows across languages and midnight/year/DST.");
