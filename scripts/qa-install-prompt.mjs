import assert from "node:assert/strict";
import {
  getInstallDayKey,
  isInstallPromptRoute,
  shouldShowInstallPrompt,
} from "../lib/install/prompt-policy.ts";
import { startInstallGuideLanding } from "../lib/install/guide-landing.ts";

// The daily cap follows Belgrade midnight, regardless of the visitor's timezone.
const originalTimeZone = process.env.TZ;
try {
  process.env.TZ = "America/Los_Angeles";
  for (const [instant, expected] of [
    ["2026-11-06T22:59:59.999Z", "2026-11-06"],
    ["2026-11-06T23:00:00.000Z", "2026-11-07"],
    ["2026-06-06T21:59:59.999Z", "2026-06-06"],
    ["2026-06-06T22:00:00.000Z", "2026-06-07"],
    ["2026-11-06T00:30:00+01:00", "2026-11-06"],
    ["2026-03-29T00:30:00Z", "2026-03-29"],
    ["2026-03-29T01:30:00Z", "2026-03-29"],
    ["2026-10-25T00:30:00Z", "2026-10-25"],
    ["2026-10-25T01:30:00Z", "2026-10-25"],
    ["2026-12-31T23:00:00Z", "2027-01-01"],
    ["2028-02-28T23:00:00Z", "2028-02-29"],
  ]) {
    assert.equal(getInstallDayKey(new Date(instant)), expected, instant);
  }
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}

const firstVisit = {
  entryDay: "2026-11-06",
  currentDay: "2026-11-06",
  lastShownDay: null,
  activeMs: 10_000,
  hasBrowsed: true,
  isVisible: true,
  isBlocked: false,
  isStandalone: false,
  hasShown: false,
  pathname: "/",
};
const decide = changes => shouldShowInstallPrompt({ ...firstVisit, ...changes });

assert.equal(decide({ activeMs: 9_999 }), false, "The prompt must wait for ten visible seconds.");
assert.equal(decide({ activeMs: 10_000 }), true, "The first eligible visit can display at ten seconds.");
assert.equal(decide({ activeMs: 32_000 }), true, "Delayed hydration must not miss the display threshold.");
for (const activeMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
  assert.equal(decide({ activeMs }), false, "Invalid or negative elapsed time cannot trigger a display.");
}

// Recording the actual first display suppresses later visits, not just dismissal.
assert.equal(decide({ lastShownDay: firstVisit.entryDay }), false, "Same-day reload/new-tab visits remain suppressed.");
assert.equal(decide({ hasShown: true, lastShownDay: null }), false, "In-memory suppression survives storage failure in this visit.");
assert.equal(decide({ lastShownDay: "2026-11-05" }), true, "Yesterday's marker does not suppress today's first visit.");
const tomorrowVisit = {
  ...firstVisit,
  entryDay: "2026-11-07",
  currentDay: "2026-11-07",
  lastShownDay: "2026-11-06",
};
assert.equal(shouldShowInstallPrompt(tomorrowVisit), true, "A fresh visit on the next calendar day becomes eligible.");
assert.equal(decide({ currentDay: "2026-11-07" }), false, "An old tab must not reopen itself at midnight.");
assert.equal(decide({ currentDay: "2026-11-07", lastShownDay: "2026-11-07" }), false, "An old tab must not overwrite a newer day's marker.");
assert.equal(decide({ currentDay: "2026-11-07", lastShownDay: null, activeMs: 60_000 }), false, "Even an unshown old visit needs a new visit after midnight.");

for (const pathname of ["/", "/events", "/calendar", "/discover"]) {
  assert.equal(isInstallPromptRoute(pathname), true, pathname);
  assert.equal(decide({ pathname }), true, `Public browsing is eligible on ${pathname}.`);
}
for (const pathname of [null, "", "/admin", "/admin/scraper", "/sign-in", "/sign-up", "/install", "/map", "/saved", "/you", "/events/example", "/venues/example", "/discovery"]) {
  assert.equal(isInstallPromptRoute(pathname), false, String(pathname));
  assert.equal(decide({ pathname }), false, `The popup must not interrupt ${pathname}.`);
}

for (const changes of [
  { hasBrowsed: false },
  { isVisible: false },
  { isBlocked: true },
  { isStandalone: true },
  { hasShown: true },
]) {
  assert.equal(decide(changes), false, JSON.stringify(changes));
}
assert.equal(decide({ isBlocked: true, activeMs: 30_000 }), false, "A dialog or focused input delays display even after the timer completes.");
assert.equal(decide({ isBlocked: false, activeMs: 30_000 }), true, "Display can resume when the interaction blocker clears.");

function createLandingHarness({ hash = "", fonts = true, resizeObserver = true } = {}) {
  const calls = [];
  const listeners = new Map();
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  let sequence = 0;
  let resolveFonts;
  const fontsReady = new Promise(resolve => { resolveFonts = resolve; });
  const view = {
    location: { hash },
    scrollY: 4000,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  if (resizeObserver) {
    view.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe(element) { this.element = element; this.connected = true; }
      disconnect() { this.connected = false; }
    };
  }
  const document = { defaultView: view, ...(fonts ? { fonts: { ready: fontsReady } } : {}) };
  const heading = {
    ownerDocument: document,
    isConnected: true,
    focus(options) { calls.push({ action: "focus", options }); },
    scrollIntoView(options) { calls.push({ action: "scroll", options }); view.scrollY = 354; },
  };
  const surface = { ownerDocument: document, isConnected: true };
  return {
    calls, frames, timers, observers, heading, surface, view,
    listenerCount: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
    emit(type, details = {}) {
      for (const callback of [...listeners.get(type) ?? []]) callback({ type, ...details });
    },
    resize() { for (const observer of observers) if (observer.connected) observer.callback([]); },
    flushFrames() {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(0);
    },
    expire() {
      for (const { callback } of [...timers.values()]) callback();
    },
    async fontsReady() { resolveFonts(); await Promise.resolve(); },
  };
}

const expectedPosition = [
  { action: "focus", options: { preventScroll: true } },
  { action: "scroll", options: { block: "start", behavior: "instant" } },
];

for (const hash of ["", "#install-guide-title"]) {
  const harness = createLandingHarness({ hash });
  const stop = startInstallGuideLanding(harness.heading, harness.surface);
  assert.deepEqual(harness.calls, [], "Guide positioning must wait until after parent layout effects.");
  harness.emit("load");
  harness.emit("pageshow", { persisted: false });
  harness.resize();
  assert.equal(harness.frames.size, 1, "Initial settling events coalesce into one animation frame.");
  harness.flushFrames();
  assert.deepEqual(harness.calls, expectedPosition, "Both old plain links and heading links focus without scrolling, then position instantly.");
  assert.equal(harness.observers[0].element, harness.surface, "Observe the guide whose content changes during initialization.");
  await harness.fontsReady();
  harness.resize();
  assert.equal(harness.frames.size, 1, "Font and content changes must share one positioning frame.");
  harness.flushFrames();
  assert.deepEqual(harness.calls, [...expectedPosition, ...expectedPosition], "Late initial fonts/content can correct the landing before user interaction.");
  assert.equal([...harness.timers.values()][0].delay, 1500, "Initial correction must have a bounded lifetime.");
  stop();
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers[0].connected, false);
}

const otherAnchor = createLandingHarness({ hash: "#install-help-title" });
startInstallGuideLanding(otherAnchor.heading, otherAnchor.surface)();
assert.equal(otherAnchor.listenerCount(), 0, "An explicit link to another guide section must retain its target.");
assert.equal(otherAnchor.frames.size, 0);
assert.equal(otherAnchor.observers.length, 0);

const restored = createLandingHarness();
const stopRestored = startInstallGuideLanding(restored.heading, restored.surface);
restored.flushFrames();
restored.emit("scroll");
assert.equal(restored.frames.size, 0, "The controller's own scroll event must not schedule a feedback loop.");
restored.view.scrollY = 1200;
restored.emit("scroll");
assert.equal(restored.frames.size, 1, "Late browser restoration is corrected even without a resize or load event.");
restored.flushFrames();
assert.deepEqual(restored.calls, [...expectedPosition, ...expectedPosition]);
assert.equal(restored.view.scrollY, 354);
restored.emit("scroll");
assert.equal(restored.frames.size, 0, "The correction's own event remains ignored.");
restored.view.scrollY += 0.25;
restored.emit("scroll");
assert.equal(restored.frames.size, 0, "Fractional pixel rounding must not keep the initial landing alive.");
stopRestored();

for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "popstate", "pageshow"]) {
  const harness = createLandingHarness();
  const stop = startInstallGuideLanding(harness.heading, harness.surface);
  harness.flushFrames();
  harness.resize();
  harness.emit(event, { persisted: true });
  await harness.fontsReady();
  harness.emit("load");
  harness.view.scrollY = 1200;
  harness.emit("scroll");
  harness.resize();
  harness.flushFrames();
  assert.deepEqual(harness.calls, expectedPosition, `${event} must stop pending and late corrections instead of taking over the visitor's position.`);
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers[0].connected, false);
  stop();
}

for (const exit of ["cleanup", "deadline", "disconnected"]) {
  const harness = createLandingHarness();
  const stop = startInstallGuideLanding(harness.heading, harness.surface);
  if (exit === "cleanup") stop();
  if (exit === "deadline") harness.expire();
  if (exit === "disconnected") { harness.heading.isConnected = false; harness.flushFrames(); }
  await harness.fontsReady();
  harness.resize();
  harness.emit("load");
  harness.view.scrollY = 1200;
  harness.emit("scroll");
  harness.flushFrames();
  assert.deepEqual(harness.calls, [], `${exit} must prevent late positioning and focus changes.`);
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.timers.size, 0);
}

const optionalApis = createLandingHarness({ fonts: false, resizeObserver: false });
const stopOptional = startInstallGuideLanding(optionalApis.heading, optionalApis.surface);
optionalApis.flushFrames();
assert.deepEqual(optionalApis.calls, expectedPosition, "The initial landing works without font or resize observation APIs.");
stopOptional();
assert.doesNotThrow(() => startInstallGuideLanding({ ownerDocument: { defaultView: null } }, {} )());

console.log("Install prompt QA passed: daily/DST policy, route and interaction suppression; destination-owned guide landing, settling, user control, cleanup, and expiry.");
