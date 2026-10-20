import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
console.log("QA passed: calendar strip aligns instantly, restores by surface/month, and navigates horizontally with reduced-motion support.");
