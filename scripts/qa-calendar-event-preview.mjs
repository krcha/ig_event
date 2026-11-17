import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadPublicTextFixture } from "./qa-support/public-text-fixture.mjs";

// Execute the shipped components with deterministic hooks, layout and HTTP.
// Browser QA separately verifies hit testing and the actual responsive CSS.
function createHarness({ fetchPost, ids = ["event-a", "event-b"], locale = "en", connection, readyState = "complete", idleSupported = true } = {}) {
  let currentScope;
  let now = 1_000;
  let lazyMounts = 0;
  let panel;
  let panelId;
  const calls = [];
  const scrolls = [];
  const actionCalls = [];
  let moduleLoads = 0;
  let nextTimer = 0;
  const timers = new Map(), idleTasks = new Map(), windowListeners = new Map();
  const document = { readyState, hidden: false, body: { style: { overflow: "auto" } }, activeElement: null };
  const anchors = new Map(ids.map((id, index) => [id, {
    top: 120 + index * 100,
    isConnected: true,
    focusCalls: [],
    getBoundingClientRect() { return { top: this.top }; },
    focus(options) { this.focusCalls.push(options); },
  }]));
  const jsx = (type, props) => typeof type === "function" ? type(props ?? {}) : { type, props: props ?? {} };
  const sameDeps = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
  const react = {
    createElement: jsx,
    createContext: (value) => {
      const context = { current: value };
      context.Provider = { context };
      return context;
    },
    useContext: (context) => context.current,
    lazy: (loader) => ({ lazy: true, loader }),
    Suspense: "suspense",
    useState: (initial) => {
      const scope = currentScope;
      const index = scope.cursor++;
      if (!scope.slots[index]) scope.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [scope.slots[index].value, (next) => {
        scope.slots[index].value = typeof next === "function" ? next(scope.slots[index].value) : next;
      }];
    },
    useRef: (value) => {
      const scope = currentScope;
      const index = scope.cursor++;
      if (!scope.slots[index]) scope.slots[index] = { current: value };
      return scope.slots[index];
    },
    useId: () => {
      const scope = currentScope;
      const index = scope.cursor++;
      if (!scope.slots[index]) scope.slots[index] = { value: `id-${index}` };
      return scope.slots[index].value;
    },
    useMemo: (callback, deps) => {
      const scope = currentScope;
      const index = scope.cursor++;
      if (!sameDeps(scope.slots[index]?.deps, deps)) scope.slots[index] = { deps, value: callback() };
      return scope.slots[index].value;
    },
    useCallback: (callback, deps) => react.useMemo(() => callback, deps),
    useLayoutEffect: (callback, deps) => scheduleEffect("layout", callback, deps),
    useEffect: (callback, deps) => scheduleEffect("effect", callback, deps),
  };
  const publicTextComponents = loadPublicTextFixture({ react, jsx, getLocale: () => locale });
  function scheduleEffect(kind, callback, deps) {
    const scope = currentScope;
    const index = scope.cursor++;
    const old = scope.slots[index];
    if (sameDeps(old?.deps, deps)) return;
    scope.slots[index] = { deps, cleanup: old?.cleanup };
    scope[kind].push(() => {
      old?.cleanup?.();
      scope.slots[index].cleanup = callback();
    });
  }
  function scope(component, props) {
    const value = {
      component, props, slots: [], cursor: 0, layout: [], effect: [], tree: null,
      render() {
        currentScope = value;
        value.cursor = 0;
        value.tree = component(value.props);
        currentScope = undefined;
        if (value.tree?.type?.context) value.tree.type.context.current = value.tree.props.value;
        return value.tree;
      },
      flush(kind) { value[kind].splice(0).forEach((callback) => callback()); },
      unmount() { value.slots.forEach((slot) => slot?.cleanup?.()); },
    };
    return value;
  }
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const id = decodeURIComponent(url.split("/").at(-2));
    return fetchPost ? fetchPost(id, options) : Response.json(post(id));
  };
  const window = {
    scrollBy: (options) => {
      scrolls.push(options);
      for (const anchor of anchors.values()) anchor.top -= options.top;
    },
    scrollTo: () => assert.fail("An inline preview must not jump the page to an absolute position."),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (type, callback) => windowListeners.set(type, callback),
    removeEventListener: (type, callback) => { if (windowListeners.get(type) === callback) windowListeners.delete(type); },
    ...(idleSupported ? {
      requestIdleCallback: callback => { const id = ++nextTimer; idleTasks.set(id, callback); return id; },
      cancelIdleCallback: id => idleTasks.delete(id),
    } : {}),
  };
  const modules = new Map();
  function compile(path) {
    const source = readFileSync(path, "utf8");
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  function loadModule(path) {
    const componentModule = { exports: {} };
    runInNewContext(compile(path), {
      exports: componentModule.exports,
      require: (name) => {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "@/components/i18n/public-text") return publicTextComponents;
        if (name === "lucide-react") return Object.fromEntries(["Clock3", "ChevronDown", "ExternalLink", "ImageOff", "Instagram", "LoaderCircle", "Maximize2", "X"].map((key) => [key, key]));
        if (name === "next/image") return { default: "next-image" };
        if (name === "@/components/events/responsive-event-image") return { ResponsiveEventImage: "next-image" };
        if (name === "next/link") return { default: "next-link" };
        if (name === "@/components/ui/read-more-text") return { ReadMoreText: "read-more-text" };
        if (name === "@/components/travel/event-travel") return { EventTravel: "event-travel" };
        if (name === "@/components/travel/yandex-taxi-button") return { YandexTaxiButton: "yandex-taxi-button" };
        if (name === "./event-post-preview.module.css" || name === "./event-poster-dialog.module.css") return { default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === "./event-poster-dialog") return { default: "event-poster-dialog" };
        if (name === "./event-post-preview") { moduleLoads++; return { default: "prefetched-preview" }; }
        if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
        if (name === "@/components/calendar/calendar-event-preview") return modules.get("controller");
        throw new Error(`Unexpected preview component import: ${name}`);
      },
      Date: class extends Date { static now() { return now; } },
      AbortController, DOMException, Error, fetch: fakeFetch, window, document, navigator: { connection },
    });
    return componentModule.exports;
  }
  const controller = loadModule("components/calendar/calendar-event-preview.tsx");
  modules.set("controller", controller);
  const body = loadModule("components/calendar/event-post-preview.tsx").default;
  const provider = scope(controller.CalendarEventPreviews, { children: null });
  const rows = new Map(ids.map((id) => [id, scope(controller.CalendarEventPreviewRow, {
    eventId: id,
    title: `Title ${id}`,
    venueHoursLabel: "17:00–04:00",
    venueLatitude: 44.81,
    venueLongitude: 20.46,
    venueName: `Venue ${id}`,
    children: [
      jsx("a", { href: `/venues/${id}`, onClick: () => actionCalls.push(`venue:${id}`), children: "Venue" }),
      jsx("button", { type: "button", onClick: (event) => { event.stopPropagation(); actionCalls.push(`save:${id}`); }, children: "Save" }),
    ],
  })]));
  function render(beforeLayout) {
    provider.render();
    for (const [id, row] of rows) {
      row.render();
      find(row.tree, (node) => node.props["data-calendar-event-preview-toggle"] === id).props.ref.current = anchors.get(id);
    }
    const activeId = provider.tree.props.value.activeId;
    if (panelId !== activeId) {
      panel?.unmount();
      panel = undefined;
      panelId = activeId;
      if (activeId) {
        const lazy = find(rows.get(activeId).tree, (node) => node.type?.lazy);
        assert.ok(lazy, "Only the expanded row should mount the lazy preview body.");
        lazyMounts += 1;
        panel = scope(body, lazy.props);
      }
    }
    panel?.render();
    beforeLayout?.();
    provider.flush("layout");
    for (const row of rows.values()) row.flush("layout");
    panel?.flush("effect");
  }
  render();
  return {
    calls, scrolls, actionCalls, anchors, render,
    row: (id) => rows.get(id).tree,
    panel: () => panel?.tree,
    panelAction: (text) => {
      const button = find(panel?.tree, (node) => node.type === "button" && node.props.children === text);
      assert.ok(button, `Expected panel action: ${text}`);
      button.props.onClick();
      render();
    },
    openPoster: () => {
      find(panel?.tree, (node) => node.props["data-calendar-poster-open"]).props.onClick();
      render();
    },
    closePoster: () => {
      find(panel?.tree, (node) => node.type === "event-poster-dialog").props.onClose();
      render();
    },
    escapePanel: () => {
      panel.tree.props.onKeyDown({ key: "Escape", stopPropagation() {} });
      render();
    },
    imageError: () => {
      find(panel?.tree, (node) => node.type === "next-image").props.onError();
      render();
    },
    imageLoaded: () => {
      find(panel?.tree, (node) => node.type === "next-image").props.onLoad({ currentTarget: { getBoundingClientRect: () => ({ width: 390, height: 487 }) } });
      render();
    },
    activeId: () => provider.tree.props.value.activeId,
    lazyMounts: () => lazyMounts,
    load: (id, signal = new AbortController().signal) => provider.tree.props.value.load(id, signal),
    setNow: (value) => { now = value; },
    moduleLoads: () => moduleLoads,
    startWarmup: () => provider.flush("effect"),
    warmupPending: () => timers.size + idleTasks.size + windowListeners.size,
    runWarmupTimers: () => { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(callback => callback()); },
    runWarmupIdle: () => { const tasks = [...idleTasks.values()]; idleTasks.clear(); tasks.forEach(callback => callback()); },
    completePageLoad: () => { document.readyState = "complete"; windowListeners.get("load")?.(); windowListeners.delete("load"); },
    mountDialog: ({ post: content = post("event-a"), error = null } = {}) => {
      let closed = 0, retried = 0;
      const opener = { isConnected: true, focusCalls: [], focus(options) { this.focusCalls.push(options); },
        closest: () => ({ querySelector: () => anchors.get("event-a") }) };
      const native = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
      const closeButton = { focusCalls: [], getClientRects: () => [{}], focus(options) { this.focusCalls.push(options); document.activeElement = this; } };
      const lastLink = { getClientRects: () => [{}], focus() { document.activeElement = this; } };
      native.querySelectorAll = () => [closeButton, lastLink];
      const component = loadModule("components/calendar/event-poster-dialog.tsx").default;
      const popup = scope(component, { eventId: "event-a", title: "Title event-a", venue: "Venue", imageUrl: "/api/discover/images/event-a",
        post: content, error, onRetry: () => { retried++; }, returnFocus: { current: opener }, onClose: () => { closed++; } });
      const render = () => {
        popup.render();
        popup.tree.props.ref.current = native;
        find(popup.tree, node => node.props["aria-label"] === "Close details").props.ref.current = closeButton;
      };
      render(); popup.flush("effect");
      return { tree: () => popup.tree, native, opener, closeButton, lastLink, active: () => document.activeElement, render,
        closed: () => closed, retried: () => retried, overflow: () => document.body.style.overflow, unmount: () => popup.unmount() };
    },
    click: (id, beforeLayout) => {
      const trigger = find(rows.get(id).tree, (node) => node.props["data-calendar-event-preview-toggle"] === id);
      trigger.props.onClick({ currentTarget: anchors.get(id) });
      render(beforeLayout);
    },
    action: (id, type) => {
      const tree = rows.get(id).tree;
      const path = findPath(tree, (node) => type === "venue" ? node.type === "a" : node.type === "button" && node.props.children === "Save");
      assert.ok(path);
      assert.equal(path.some((node) => node.props["data-calendar-event-preview-toggle"]), false,
        "Independent venue/save actions must be siblings of the preview trigger, never its descendants.");
      let stopped = false;
      const event = { stopPropagation: () => { stopped = true; }, preventDefault() {} };
      for (const node of path.toReversed()) {
        node.props.onClick?.(event);
        if (stopped) break;
      }
      render();
    },
    escape: (id) => {
      find(rows.get(id).tree, (node) => node.props["data-calendar-event-preview-toggle"] === id).props.onKeyDown({ key: "Escape" });
      render();
    },
    unmount: () => { panel?.unmount(); rows.forEach((row) => row.unmount()); provider.unmount(); },
  };
}

function* walk(tree) {
  if (Array.isArray(tree)) { for (const child of tree) yield* walk(child); return; }
  if (!tree || typeof tree !== "object" || !tree.props) return;
  yield tree;
  yield* walk(tree.props.children);
}
function find(tree, predicate) { return [...walk(tree)].find(predicate); }
function findPath(tree, predicate, parents = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) { const path = findPath(child, predicate, parents); if (path) return path; }
    return null;
  }
  if (!tree || typeof tree !== "object" || !tree.props) return null;
  const path = [...parents, tree];
  return predicate(tree) ? path : findPath(tree.props.children, predicate, path);
}
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const post = (id, fields = {}) => ({ eventId: id, title: `Title ${id}`, venue: "Venue", instagramHandle: null,
  instagramPostUrl: "https://www.instagram.com/p/source/", imageUrl: `/api/discover/images/${id}`,
  caption: `Original caption ${id}`, captionSource: "instagram", ...fields });
function deferred() { let resolve; const promise = new Promise((finish) => { resolve = finish; }); return { promise, resolve }; }

{
  const h = createHarness();
  assert.equal(h.activeId(), null);
  assert.equal(h.calls.length, 0, "The closed calendar must not load post metadata.");
  assert.equal(h.lazyMounts(), 0, "The closed calendar must not mount preview code or images.");
  for (const id of ["event-a", "event-b"]) {
    const trigger = find(h.row(id), (node) => node.props["data-calendar-event-preview-toggle"] === id);
    const region = find(h.row(id), (node) => node.props.role === "region");
    assert.equal(trigger.type, "button");
    assert.equal(trigger.props.type, "button");
    assert.equal(trigger.props["aria-expanded"], false);
    assert.equal(trigger.props["aria-controls"], region.props.id);
    assert.equal(region.props["aria-labelledby"], trigger.props.id);
    assert.equal(region.props.hidden, true);
    assert.equal(find(h.row(id), (node) => node.type === "next-image"), undefined);
    assert.equal(trigger.props["data-calendar-event-link"], undefined, "Expansion must not trigger legacy navigation scroll restoration.");
  }
  h.action("event-a", "venue");
  h.action("event-a", "save");
  assert.equal(h.activeId(), null);
  assert.equal(h.calls.length, 0, "Independent actions must not open/fetch the post.");
  assert.deepEqual(h.actionCalls, ["venue:event-a", "save:event-a"]);

  h.click("event-a");
  assert.equal(h.activeId(), "event-a");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/events/event-a/post");
  assert.equal(h.calls[0].options.cache, "no-store");
  assert.equal(find(h.panel(), (node) => node.type === "next-image").props.src, "/api/discover/images/event-a",
    "The selected image can start alongside caption metadata after the click.");
  await tick(); h.render();
  const caption = find(h.panel(), (node) => node.type === "read-more-text");
  assert.equal(caption.props.text, "Original caption event-a");
  assert.ok(caption.props.lines >= 1 && caption.props.lines <= 4, "Long captions remain compact until deliberately expanded.");
  const image = find(h.panel(), (node) => node.type === "next-image");
  const previewCss = readFileSync("components/calendar/event-post-preview.module.css", "utf8");
  assert.match(previewCss, /\.poster\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;[^}]*object-fit:\s*contain;/,
    "Mobile posters retain their full natural aspect ratio and card width.");
  assert.equal(image.props.fill, undefined, "Natural poster height must not be replaced by a cropped fill box.");
  assert.match(find(h.panel(), (node) => node.props["data-calendar-event-post-heading"]).props.className, /hidden.*md:flex/,
    "The repeated Instagram heading is removed on mobile while desktop keeps its existing header.");
  assert.equal(find(h.panel(), (node) => node.props["data-calendar-event-post-close"]), undefined,
    "Expanded posters have no inline close X; the existing row/chevron and Escape collapse them.");
  assert.match(previewCss, /\.posterButton\s*\{[^}]*width:calc\(100% - 10px\)/,
    "The natural-ratio poster shrinks by ten pixels in total, not ten on each side.");
  assert.equal(image.props.priority, true, "A deliberately opened poster has high fetch priority.");
  assert.match(image.props.sizes, /calc\(100vw - 44px\)/, "Mobile image selection reflects its true card gutter and ten-pixel inset.");
  const posterButton = find(h.panel(), node => node.props["data-calendar-poster-open"]);
  assert.equal(posterButton.type, "button");
  assert.equal(posterButton.props["aria-haspopup"], "dialog");
  assert.match(previewCss, /\.body\s*\{[^}]*margin-top:\s*-176px;[\s\S]*?background:\s*linear-gradient/,
    "Caption, arrival and actions overlap the lower poster with a continuous readable gradient.");
  assert.match(previewCss, /@media\s*\(min-width:\s*768px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    "Desktop keeps its existing two-column preview.");
  assert.ok(find(h.panel(), (node) => node.props["data-calendar-event-post-hours"]), "Factual venue hours remain available above the poster.");
  const travel = find(h.panel(), (node) => node.type === "event-travel");
  assert.equal(travel.props.venueLatitude, 44.81);
  assert.equal(travel.props.venueLongitude, 20.46);
  assert.equal(travel.props.showTaxi, false, "The arrival row must not duplicate the separate action shortcut.");
  const taxi = find(h.panel(), (node) => node.type === "yandex-taxi-button");
  assert.equal(taxi.props.latitude, 44.81);
  assert.equal(taxi.props.longitude, 20.46);
  assert.equal(taxi.props.venueName, "Venue event-a");
  h.click("event-b");
  assert.equal(h.activeId(), "event-b");
  assert.equal(find(h.row("event-a"), (node) => node.props.role === "region").props.hidden, true);
  assert.equal(find(h.row("event-a"), (node) => node.type?.lazy), undefined);
  assert.equal(h.calls.length, 2);
  h.click("event-b");
  assert.equal(h.activeId(), null, "Clicking the selected row again closes it.");
  assert.equal(h.panel(), undefined);
  assert.equal(h.calls[1].options.signal.aborted, true, "Closing aborts a pending metadata request.");
  h.click("event-a");
  await tick(); h.render();
  assert.equal(h.calls.length, 2, "Reopening a recent post uses bounded metadata cache.");
  h.escape("event-a");
  assert.equal(h.activeId(), null);
  assert.equal(h.anchors.get("event-a").focusCalls.at(-1).preventScroll, true);
  assert.equal(h.scrolls.length, 0, "Normal expansion and collapse must not force document scrolling.");
  h.click("event-a");
  await tick(); h.render();
  h.openPoster();
  const dialog = find(h.panel(), node => node.type === "event-poster-dialog");
  assert.equal(dialog.props.post.caption, "Original caption event-a");
  assert.equal(dialog.props.imageUrl, "/api/discover/images/event-a");
  assert.equal(dialog.props.title, "Title event-a");
  h.closePoster();
  assert.equal(h.activeId(), "event-a", "Closing the full poster must keep the inline event expanded.");
  h.click("event-a");
  assert.equal(h.activeId(), null, "The existing row toggle still collapses the selected post.");
  assert.equal(h.anchors.get("event-a").focusCalls.at(-1).preventScroll, true);
  h.click("event-a");
  h.escapePanel();
  assert.equal(h.activeId(), null, "Escape works from controls inside the expanded post.");
  h.unmount();
}

{
  const pending = new Map();
  const h = createHarness({ fetchPost: (id) => {
    const request = deferred(); pending.set(id, request); return request.promise;
  } });
  h.click("event-a");
  h.click("event-b");
  assert.equal(h.calls[0].options.signal.aborted, true, "Switching cancels the old panel request.");
  pending.get("event-a").resolve(Response.json(post("event-a")));
  pending.get("event-b").resolve(Response.json(post("event-b")));
  await tick(); h.render();
  assert.equal(find(h.panel(), (node) => node.type === "read-more-text").props.text, "Original caption event-b",
    "A late response from the closed event must never replace the new event's caption.");
  assert.equal(find(h.panel(), (node) => node.props.role === "alert"), undefined);
  h.click("event-a");
  assert.equal(h.calls.length, 3, "An aborted response must not seed the cache.");
  h.unmount();
}

{
  const h = createHarness();
  await h.load("cached");
  h.setNow(60_999); await h.load("cached");
  assert.equal(h.calls.length, 1);
  h.setNow(61_001); await h.load("cached");
  assert.equal(h.calls.length, 2, "Cached captions expire after one minute.");
  for (let i = 0; i < 13; i += 1) await h.load(`bounded-${i}`);
  const before = h.calls.length;
  await h.load("bounded-12");
  assert.equal(h.calls.length, before);
  await h.load("bounded-0");
  assert.equal(h.calls.length, before + 1, "Browsing many posts must evict entries beyond the 12-post bound.");
  h.unmount();
}

{
  const h = createHarness();
  h.click("event-a");
  const before = h.anchors.get("event-b").top;
  h.click("event-b", () => { h.anchors.get("event-b").top -= 320; });
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scrolls[0].top, -320);
  assert.equal(h.scrolls[0].behavior, "instant");
  assert.equal(h.anchors.get("event-b").top, before, "The clicked header stays at the same viewport position after closing a post above it.");
  h.click("event-a");
  assert.equal(h.scrolls.length, 1, "Native scroll anchoring must not receive a second unnecessary adjustment.");
  h.unmount();
}

{
  const h = createHarness({ fetchPost: () => Response.json(post("different-event")) });
  await assert.rejects(h.load("requested-event"), /could not be loaded/);
  await assert.rejects(h.load("requested-event"), /could not be loaded/);
  assert.equal(h.calls.length, 2, "A mismatched event response must never be cached.");
  h.unmount();
}

{
  const first = deferred();
  const retry = deferred();
  let requests = 0;
  const h = createHarness({ fetchPost: () => (++requests === 1 ? first : retry).promise });
  h.click("event-a");
  h.imageError();
  assert.equal(find(h.panel(), (node) => node.type === "next-image"), undefined);
  first.resolve(Response.json({ error: "Temporary source outage" }, { status: 503 }));
  await tick(); h.render();
  assert.ok(find(h.panel(), (node) => node.props.role === "alert"));
  h.panelAction("Try again");
  assert.equal(h.calls.length, 2);
  assert.equal(find(h.panel(), (node) => node.props.role === "alert"), undefined);
  assert.ok(find(h.panel(), (node) => node.type === "next-image"),
    "Retry after simultaneous metadata and image failures must reset the failed-image state and mount a new image.");
  retry.resolve(Response.json(post("event-a")));
  await tick(); h.render();
  h.imageLoaded();
  assert.ok(find(h.panel(), (node) => node.type === "next-image").props.className.includes("opacity-100"));
  assert.equal(find(h.panel(), (node) => node.type === "read-more-text").props.text, "Original caption event-a");
  h.unmount();
}

{
  let requests = 0;
  const h = createHarness({ fetchPost: () => ++requests === 1 ? Response.json({}, { status: 503 }) : Response.json(post("event-a")) });
  h.click("event-a"); h.imageLoaded();
  await tick(); h.render();
  assert.ok(find(h.panel(), node => node.props.role === "alert"));
  assert.ok(find(h.panel(), node => node.type === "next-image"), "A caption API outage must retain its independently authorized poster.");
  h.panelAction("Try again");
  assert.ok(find(h.panel(), node => node.type === "next-image").props.className.includes("opacity-100"),
    "Retrying only the caption must not blank an already loaded image.");
  await tick(); h.render();
  assert.equal(find(h.panel(), node => node.type === "read-more-text").props.text, "Original caption event-a");
  h.unmount();
}

{
  const h = createHarness();
  h.click("event-a");
  await tick(); h.render();
  h.imageError();
  h.panelAction("Retry image");
  assert.ok(find(h.panel(), (node) => node.type === "next-image"), "Image-only failures have a direct retry action.");
  await tick(); h.render();
  assert.equal(h.calls.length, 1, "Retrying the image can retain the already loaded caption metadata.");
  h.unmount();
}

for (const [locale, showLabel, prefix] of [
  ["sr", "Prikaži Instagram objavu: Title event-a", ""],
  ["en", "Show Instagram post for Title event-a", "/en"],
  ["ru", "Показать публикацию Instagram: Title event-a", "/ru"],
]) {
  const h = createHarness({ locale });
  const trigger = find(h.row("event-a"), (node) => node.props["data-calendar-event-preview-toggle"] === "event-a");
  assert.equal(trigger.props["aria-label"], showLabel, `${locale}: the event title remains intact inside the localized trigger.`);
  h.click("event-a");
  await tick(); h.render();
  assert.equal(find(h.panel(), (node) => node.props["data-calendar-event-post-close"]), undefined);
  assert.ok(find(h.panel(), (node) => node.props["data-calendar-poster-open"]).props["aria-label"].includes("Title event-a"));
  assert.equal(find(h.panel(), (node) => node.type === "next-link").props.href, `${prefix}/events/event-a`);
  assert.equal(find(h.panel(), (node) => node.type === "read-more-text").props.text, "Original caption event-a");
  assert.equal(find(h.panel(), (node) => node.type === "next-image").props.src, "/api/discover/images/event-a");
  assert.equal(h.calls[0].url, "/api/events/event-a/post", `${locale}: locale changes must not rewrite source/media API identities.`);
  h.unmount();
}

{
  const h = createHarness();
  h.startWarmup();
  assert.equal(h.moduleLoads(), 0, "Idle warming must wait until the page has settled.");
  h.runWarmupTimers(); h.runWarmupIdle();
  await tick();
  assert.equal(h.moduleLoads(), 1, "One small preview module can warm during idle time.");
  assert.equal(h.calls.length, 0, "Idle warming must not fetch event metadata or images.");
  const trigger = find(h.row("event-a"), node => node.props["data-calendar-event-preview-toggle"]);
  trigger.props.onFocus(); trigger.props.onPointerEnter(); trigger.props.onPointerDown();
  await tick();
  assert.equal(h.moduleLoads(), 1, "Focus, hover, touch and the lazy component share one import promise.");
  assert.equal(h.calls.length, 0);
  h.unmount();
}
for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
  const h = createHarness({ connection });
  h.startWarmup(); h.runWarmupTimers(); h.runWarmupIdle(); await tick();
  assert.equal(h.moduleLoads(), 0, "Automatic warming respects data saver and very slow connections.");
  assert.equal(h.calls.length, 0);
  h.unmount();
}
for (const phase of ["before-timer", "before-idle"]) {
  const h = createHarness(); h.startWarmup();
  if (phase === "before-idle") h.runWarmupTimers();
  h.unmount();
  assert.equal(h.warmupPending(), 0, "Unmounting cancels pending timers and idle work.");
  h.runWarmupTimers(); h.runWarmupIdle(); await tick();
  assert.equal(h.moduleLoads(), 0);
}
{
  const h = createHarness({ readyState: "loading", idleSupported: false });
  h.startWarmup(); h.runWarmupTimers(); await tick();
  assert.equal(h.moduleLoads(), 0, "A page still loading critical resources must not warm a post module.");
  h.completePageLoad(); h.runWarmupTimers(); await tick();
  assert.equal(h.moduleLoads(), 1, "Browsers without idle callbacks use the delayed post-load fallback.");
  assert.equal(h.calls.length, 0);
  h.unmount();
}

{
  const h = createHarness();
  const fullCaption = "Original source line.\n".repeat(250);
  const d = h.mountDialog({ post: post("event-a", { caption: fullCaption }) });
  assert.equal(d.native.open, true, "The actual popup opens as a native modal with protected keyboard focus.");
  assert.equal(d.overflow(), "hidden");
  assert.equal(d.closeButton.focusCalls.length, 1);
  let tabsPrevented = 0;
  d.tree().props.onKeyDown({ key: "Tab", shiftKey: true, currentTarget: d.native, preventDefault() { tabsPrevented++; } });
  assert.equal(d.active(), d.lastLink, "Shift+Tab wraps from the first control to the last inside the modal.");
  d.tree().props.onKeyDown({ key: "Tab", shiftKey: false, currentTarget: d.native, preventDefault() { tabsPrevented++; } });
  assert.equal(d.active(), d.closeButton, "Tab wraps back to the first control instead of escaping to the page or browser chrome.");
  assert.equal(tabsPrevented, 2);
  assert.equal(find(d.tree(), node => node.props["data-calendar-full-caption-source"]).props.children, fullCaption,
    "The popup exposes the complete original caption without clamping or a read-more control.");
  assert.equal(find(d.tree(), node => node.type === "read-more-text"), undefined);
  assert.equal(find(d.tree(), node => node.type === "next-image").props.src, "/api/discover/images/event-a");
  d.tree().props.onClose({ currentTarget: { open: true } });
  assert.equal(d.closed(), 0, "A queued close event from StrictMode cleanup must not dismiss a freshly reopened modal.");
  let stopped = false, prevented = false;
  d.tree().props.onKeyDown({ key: "Escape", stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, "Modal Escape must not also collapse the inline event underneath.");
  d.tree().props.onCancel({ preventDefault() { prevented = true; }, stopPropagation() {}, });
  assert.equal(prevented, true);
  assert.equal(d.closed(), 1);
  assert.equal(d.native.open, false);
  d.unmount();
  assert.equal(d.overflow(), "auto");
  assert.equal(d.opener.focusCalls.at(-1).preventScroll, true, "Closing restores the poster trigger without moving the page.");
  h.unmount();
}
{
  const h = createHarness();
  const d = h.mountDialog({ post: null, error: "The post could not be loaded. Please try again." });
  assert.ok(find(d.tree(), node => node.type === "next-image"), "Metadata errors do not remove an independently available full poster.");
  assert.ok(find(d.tree(), node => node.props.role === "alert"));
  find(d.tree(), node => node.type === "button" && node.props.children === "Try again").props.onClick();
  assert.equal(d.retried(), 1);
  d.tree().props.onClick({ target: {}, currentTarget: d.native });
  assert.equal(d.closed(), 0, "Clicks inside the dialog must not close it.");
  d.tree().props.onClick({ target: d.native, currentTarget: d.native });
  assert.equal(d.closed(), 1, "The native backdrop remains a close action.");
  d.opener.isConnected = false;
  d.unmount();
  assert.equal(h.anchors.get("event-a").focusCalls.at(-1).preventScroll, true,
    "If a failed inline image removed the poster trigger, restore its surviving event row trigger.");
  h.unmount();
}

console.log("QA passed: calendar previews load on demand, keep one active post, cancel stale work, bound metadata cache, retain row actions, and preserve the clicked header.");
