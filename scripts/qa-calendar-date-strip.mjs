import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as venueTypes from "../lib/taxonomy/venue-types.ts";

const source = readFileSync("components/calendar/mobile-month-day-strip.tsx", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storagePrefix = "eventzeka:date-strip:v1:";

function mount({ selectedDay = 20, surface = "mobile", month = "2026-10", storage = new Map(), reducedMotion = false, storageDisabled = false, width = 300 } = {}) {
  const layoutEffects = [];
  const effects = [];
  const resizeObservers = [];
  const frames = new Map();
  const pageListeners = new Map();
  const containerListeners = new Map();
  const calls = [];
  const routes = [];
  const refs = [];
  let frameId = 0;
  const window = {
    location: { href: `https://eventzeka.com/?month=${month}&day=${month}-${String(selectedDay).padStart(2, "0")}&hide=club&category=live` },
    matchMedia: () => ({ matches: reducedMotion }),
    sessionStorage: {
      getItem: (key) => { if (storageDisabled) throw new Error("Storage disabled"); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageDisabled) throw new Error("Storage disabled"); storage.set(key, value); },
    },
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    addEventListener: (name, callback) => pageListeners.set(name, callback),
    removeEventListener: (name) => pageListeners.delete(name),
    scrollTo: () => assert.fail("Date-strip actions must not move the document vertically."),
  };
  const container = {
    clientWidth: width,
    scrollWidth: 31 * 60,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 27 }),
    scrollTo: (options) => { calls.push({ ...options }); container.scrollLeft = options.left; },
    addEventListener: (name, callback) => containerListeners.set(name, callback),
    removeEventListener: (name) => containerListeners.delete(name),
  };
  const componentModule = { exports: {} };
  const react = {
    useRef: (current) => { const ref = { current }; refs.push(ref); return ref; },
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
    useLayoutEffect: (callback) => layoutEffects.push(callback),
    useEffect: (callback) => effects.push(callback),
    useTransition: () => [false, (callback) => callback()],
  };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compiled, {
    exports: componentModule.exports,
    require: (name) => {
      if (name === "./calendar-overview") return { useCalendarOverviewDays: days => days };
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/link") return { default: "link" };
      if (name === "next/navigation") return { useRouter: () => ({ push: (...args) => routes.push(args) }) };
      if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
      throw new Error(`Unexpected component import: ${name}`);
    },
    URL,
    window,
    ResizeObserver: class {
      constructor(callback) { resizeObservers.push(callback); }
      observe() {}
      disconnect() {}
    },
  });
  const days = Array.from({ length: 31 }, (_, index) => {
    const dayNumber = index + 1;
    const dayKey = `${month}-${String(dayNumber).padStart(2, "0")}`;
    return { dayKey, dayNumber, href: `/?month=${month}&day=${dayKey}`, weekdayLabel: "Tue", eventCount: 1,
      categoryCounts: {}, isSelected: dayNumber === selectedDay, isAnchor: dayNumber === selectedDay };
  });
  const tree = componentModule.exports.MobileMonthDayStrip({ days, surface });
  tree.props.ref.current = container;
  const anchors = tree.props.children.map((node, index) => ({
    node,
    href: `https://eventzeka.com${days[index].href}`,
    getBoundingClientRect: () => ({ left: 27 + index * 60 - container.scrollLeft, width: 54 }),
    scrollIntoView: () => assert.fail("Use container.scrollTo, not scrollIntoView."),
  }));
  anchors[selectedDay - 1].node.props.ref.current = anchors[selectedDay - 1];
  layoutEffects.forEach((effect) => effect());
  const cleanup = effects.map((effect) => effect()).filter(Boolean);
  return {
    calls, routes, storage, container, tree,
    click: (day) => {
      const anchor = anchors[day - 1];
      anchor.node.props.onClick({ currentTarget: anchor, button: 0, preventDefault() {}, defaultPrevented: false });
    },
    save: () => {
      containerListeners.get("scroll")?.();
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach((callback) => callback());
    },
    pagehide: () => pageListeners.get("pagehide")?.(),
    resize: () => resizeObservers.forEach((callback) => callback()),
    changeScope: (nextKey) => {
      const previousKey = `${storagePrefix}${surface}:${month}`;
      refs.filter((ref) => ref.current === previousKey).forEach((ref) => { ref.current = nextKey; });
    },
    cleanup: () => cleanup.forEach((callback) => callback()),
  };
}

const initial = mount();
assert.equal(initial.calls.length, 1);
assert.equal(initial.calls[0].behavior, "instant", "First positioning must not animate from day 1.");
assert.equal(initial.calls[0].left, 1017, "Center within the strip, independently of its document offset.");
assert.ok(!initial.tree.props.className.includes("scroll-smooth"));
initial.click(21);
assert.equal(initial.calls.at(-1).behavior, "smooth", "An intentional nearby selection may animate.");
assert.equal(initial.routes.length, 1);
const navigated = new URL(initial.routes[0][0], "https://eventzeka.com");
assert.equal(navigated.searchParams.get("hide"), "club");
assert.equal(navigated.searchParams.get("category"), null);
assert.equal(initial.routes[0][1].scroll, false);
assert.equal(initial.tree.props.children[20].props["data-calendar-client-navigation"], "true");

initial.container.scrollLeft = 930;
initial.save();
assert.equal(JSON.parse(initial.storage.get(`${storagePrefix}mobile:2026-10`)).left, 930);
initial.container.scrollLeft = 950;
initial.pagehide();
assert.equal(JSON.parse(initial.storage.get(`${storagePrefix}mobile:2026-10`)).left, 950);
const restored = mount({ storage: initial.storage });
assert.equal(restored.calls[0].left, 950, "Document reload/back must restore the strip position.");
assert.equal(restored.calls[0].behavior, "instant");
const desktop = mount({ storage: initial.storage, surface: "desktop" });
assert.equal(desktop.calls[0].left, 1017, "Mobile storage must not move the desktop strip.");
const otherMonth = mount({ storage: initial.storage, month: "2026-11" });
assert.equal(otherMonth.calls[0].left, 1017, "Another month must have independent position state.");
const distant = mount({ storage: initial.storage, selectedDay: 31 });
assert.equal(distant.calls[0].left, 1560, "A directly opened distant day should align instantly.");
assert.equal(distant.calls[0].behavior, "instant");
const reduced = mount({ reducedMotion: true });
reduced.click(21);
assert.equal(reduced.calls.at(-1).behavior, "instant");
const disabled = mount({ storageDisabled: true });
disabled.save();
disabled.click(21);
assert.equal(disabled.routes.length, 1, "Unavailable storage must not disable navigation.");
const hidden = mount({ width: 0 });
assert.equal(hidden.calls.length, 0);
hidden.container.clientWidth = 300;
hidden.resize();
assert.equal(hidden.calls[0].behavior, "instant", "A newly visible responsive strip must not sweep.");
const changedScope = mount();
changedScope.container.scrollLeft = 900;
changedScope.save();
changedScope.changeScope(`${storagePrefix}mobile:2026-11`);
changedScope.container.scrollLeft = 50;
changedScope.cleanup();
assert.equal(JSON.parse(changedScope.storage.get(`${storagePrefix}mobile:2026-10`)).left, 900,
  "An old month's effect cleanup must not overwrite its snapshot after the new month aligned.");
for (const harness of [initial, restored, desktop, otherMonth, distant, reduced, disabled, hidden]) harness.cleanup();

// Exercise real category effects alongside server-rendered date/metric text.
// Replacing even equal text recreates its Text node, which can invalidate a
// different island's pending hydration cursor.
function mountCategoryChips(initialHiddenCategories = []) {
  const slots = [], effects = [], listeners = new Map(), routes = [];
  let cursor = 0, dirty = false, queries = 0, writes = 0, tree;
  let props = { initialHiddenCategories };
  const target = (text) => ({
    node: { text },
    get textContent() { return this.node.text; },
    set textContent(value) { writes += 1; this.node = { text: value }; },
  });
  const count = initialHiddenCategories.includes("club") || initialHiddenCategories.includes("event") ? "1" : "2";
  const dateTargets = [target(count), target(count)];
  const metrics = { events: target(count), "active-days": target("1"), weekend: target(count) };
  const dates = dateTargets.map((value) => ({
    dataset: { calendarDateKindCounts: JSON.stringify({ club: 1, live: 0, culture: 0, event: 1 }),
      calendarDate: "2026-10-30", calendarDateWeekend: "true", calendarDateUpcoming: "true" },
    querySelectorAll: (selector) => selector === "[data-calendar-date-visible-event-count]"
      ? [value] : [{ classList: { toggle() {} } }],
  }));
  const window = {
    location: new URL("https://eventzeka.com/?month=2026-10&day=2026-10-30"),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  const document = {
    querySelectorAll(selector) {
      queries += 1;
      if (selector === "[data-calendar-date-kind-counts]") return dates;
      const metric = selector.match(/^\[data-calendar-stat-value="([^"]+)"\]$/)?.[1];
      return metric ? [metrics[metric]] : [];
    },
    addEventListener() {}, removeEventListener() {},
  };
  const sameDeps = (before, after) => Boolean(before && after && before.length === after.length &&
    before.every((value, index) => Object.is(value, after[index])));
  const react = {
    useState(initialValue) {
      const index = cursor++;
      slots[index] ??= { value: typeof initialValue === "function" ? initialValue() : initialValue };
      return [slots[index].value, (next) => {
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: callback(), deps };
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useTransition: () => [false, (callback) => callback()],
    useEffect(callback, deps) {
      const index = cursor++, before = slots[index];
      if (sameDeps(before?.deps, deps)) return;
      slots[index] = { deps };
      effects.push(() => { before?.cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const compile = (path) => ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const categories = { exports: {} };
  runInNewContext(compile("lib/taxonomy/event-categories.ts"), {
    exports: categories.exports, require: () => venueTypes,
  });
  const component = { exports: {} };
  const router = { replace: (...args) => routes.push(args) };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compile("components/calendar/event-kind-toggle-chips.tsx"), {
    exports: component.exports, URL, window, document,
    require(name) {
      if (name === "./calendar-overview") return { useCalendarOverviewDays: days => days };
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/navigation") return { usePathname: () => "/", useRouter: () => router };
      if (name === "@/lib/taxonomy/event-categories") return categories.exports;
      if (name === "@/components/events/event-meta") return { EVENT_CATEGORY_TONES: Object.fromEntries(
        ["club", "live", "culture", "event"].map((key) => [key, {}])) };
      if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
      throw new Error(`Unexpected category chip import: ${name}`);
    },
  });
  function render() {
    let remaining = 10;
    do {
      assert.ok(remaining-- > 0, "Category effects must settle");
      dirty = false; cursor = 0;
      tree = component.exports.EventKindToggleChips(props);
      effects.splice(0).forEach((effect) => effect());
    } while (dirty);
  }
  render();
  return {
    dateTargets, metrics, routes, get queries() { return queries; }, get writes() { return writes; },
    click(key) { tree.props.children[0].props.children.find((chip) => chip.props["data-calendar-kind-toggle"] === key).props.onClick(); render(); },
    popstate(hide) { window.location = new URL(`https://eventzeka.com/?hide=${hide}`); listeners.get("popstate")(); render(); },
    serverNavigation(hide) { props = { initialHiddenCategories: hide }; render(); },
    cleanup() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
for (const hidden of [[], ["club"]]) {
  const chips = mountCategoryChips(hidden);
  assert.equal(chips.queries, 0, "Initial server category state must not traverse other hydration islands");
  assert.equal(chips.writes, 0, "Mount must preserve server-rendered Text nodes");
  chips.popstate("club");
  const writesBeforeToggle = chips.writes;
  const nodes = [...chips.dateTargets, ...Object.values(chips.metrics)].map((target) => target.node);
  chips.click("live");
  assert.ok(chips.queries > 0, "A real category toggle still updates visible counts");
  assert.equal(chips.writes, writesBeforeToggle, "Equal date and metric values must preserve their Text nodes");
  assert.ok([...chips.dateTargets, ...Object.values(chips.metrics)].every((target, index) => target.node === nodes[index]));
  assert.equal(chips.routes[0][1].scroll, false);
  chips.popstate("club");
  assert.equal(chips.dateTargets[0].textContent, "1");
  chips.popstate("");
  assert.equal(chips.dateTargets[0].textContent, "2", "Back navigation restores previously hidden events");
  const beforeNavigation = chips.queries;
  chips.serverNavigation(["event"]);
  assert.equal(chips.queries, beforeNavigation, "Fresh server state must not rewrite sibling islands on navigation");
  chips.popstate("club");
  chips.popstate("event");
  assert.equal(chips.dateTargets[0].textContent, "1", "Popstate still applies even when returning to the original server key");
  chips.click("all");
  assert.equal(chips.metrics.events.textContent, "2");
  const beforeRepeat = chips.queries;
  chips.click("all");
  assert.equal(chips.queries, beforeRepeat, "Repeated unchanged category selections must not mutate the DOM");
  chips.cleanup();
}
console.log("QA passed: category hydration preserves server text nodes; real toggles, back navigation and fresh server state stay synchronized.");
console.log("QA passed: calendar strip aligns instantly, restores by surface/month, and navigates horizontally with reduced-motion support.");
