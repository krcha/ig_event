import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the shipped components with deterministic hooks, layout and HTTP.
// Browser QA separately verifies hit testing and the actual responsive CSS.
function createHarness({ fetchPost, ids = ["event-a", "event-b"] } = {}) {
  let currentScope;
  let now = 1_000;
  let lazyMounts = 0;
  let panel;
  let panelId;
  const calls = [];
  const scrolls = [];
  const actionCalls = [];
  const anchors = new Map(ids.map((id, index) => [id, {
    top: 120 + index * 100,
    isConnected: true,
    focusCalls: [],
    getBoundingClientRect() { return { top: this.top }; },
    focus(options) { this.focusCalls.push(options); },
  }]));
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const sameDeps = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
  const react = {
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
        if (name === "lucide-react") return Object.fromEntries(["ChevronDown", "ExternalLink", "ImageOff", "Instagram", "LoaderCircle", "X"].map((key) => [key, key]));
        if (name === "next/image") return { default: "next-image" };
        if (name === "next/link") return { default: "next-link" };
        if (name === "@/components/ui/read-more-text") return { ReadMoreText: "read-more-text" };
        if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
        if (name === "@/components/calendar/calendar-event-preview") return modules.get("controller");
        throw new Error(`Unexpected preview component import: ${name}`);
      },
      Date: class extends Date { static now() { return now; } },
      AbortController, DOMException, Error, fetch: fakeFetch, window,
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
    imageError: () => {
      find(panel?.tree, (node) => node.type === "next-image").props.onError();
      render();
    },
    imageLoaded: () => {
      find(panel?.tree, (node) => node.type === "next-image").props.onLoad();
      render();
    },
    activeId: () => provider.tree.props.value.activeId,
    lazyMounts: () => lazyMounts,
    load: (id, signal = new AbortController().signal) => provider.tree.props.value.load(id, signal),
    setNow: (value) => { now = value; },
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
  assert.ok(image.props.className.includes("object-contain"), "Posters must remain uncropped.");
  assert.match(find(h.panel(), (node) => node.props["data-calendar-event-post-image"]).props.className, /h-\[min\(\d+(?:s|d)?vh,[\d.]+rem\)\]/,
    "The active poster has a viewport-relative maximum height.");
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

console.log("QA passed: calendar previews load on demand, keep one active post, cancel stale work, bound metadata cache, retain row actions, and preserve the clicked header.");
