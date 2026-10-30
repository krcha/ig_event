import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("components/navigation/navigation-feedback.tsx", "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const jsx = (type, props) => ({ type, props });
const slots = [];
const listeners = new Map();
const timers = new Map();
const assigned = [];
let cursor = 0;
let pendingEffects = [];
let href = "https://eventzeka.com/?day=2026-10-29";
const root = { dataset: {} };
const react = {
  useRef(initial) {
    const index = cursor++;
    return slots[index] ??= { current: initial };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { value: initial };
    return [slots[index].value, value => { slots[index].value = value; }];
  },
  useEffect(callback, deps) {
    const index = cursor++;
    if (slots[index]?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, slots[index].deps[i]))) return;
    const previous = slots[index];
    slots[index] = { deps };
    pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
  },
};
class Element {
  constructor(anchor) { this.anchor = anchor; }
  closest(selector) {
    if (selector === "a[href]") return this.anchor;
    if (selector.includes("data-calendar-client-navigation") && this.anchor?.managed === "calendar") return this.anchor;
    if (selector.includes("data-global-navigation") && this.anchor?.managed === "client") return this.anchor;
    return null;
  }
}
class HTMLAnchorElement extends Element {
  constructor(destination, managed) {
    super(null); this.anchor = this; this.href = new URL(destination, href).href;
    this.target = ""; this.managed = managed;
  }
  hasAttribute() { return false; }
}
class HTMLFormElement extends Element {}
const exports = {};
runInNewContext(code, {
  exports, URL, Element, HTMLAnchorElement, HTMLFormElement,
  setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
  clearTimeout(id) { timers.delete(id); },
  document: { documentElement: root },
  window: {
    get location() { const url = new URL(href); return { href, origin: url.origin, pathname: url.pathname, search: url.search, assign: value => assigned.push(value) }; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  },
  require(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "next/navigation") return { usePathname: () => new URL(href).pathname, useSearchParams: () => new URL(href).searchParams };
    throw new Error(`Unexpected dependency ${name}`);
  },
});
function render() {
  cursor = 0; pendingEffects = [];
  const tree = exports.NavigationFeedback();
  pendingEffects.forEach(effect => effect());
  return tree;
}
function click(destination, managed, modifiers = {}) {
  const event = { target: new Element(new HTMLAnchorElement(destination, managed)), button: 0, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...modifiers };
  listeners.get("click")(event);
  return event;
}
render();
for (const managed of ["calendar", "client"]) {
  const event = click("/?day=2026-10-30", managed);
  assert.equal(event.defaultPrevented, false, "Managed links must reach the React router.");
  assert.equal(event.stopped, undefined);
  assert.equal(assigned.length, 0, "A date or mobile tab must not reload the document.");
  assert.equal(root.dataset.navigationPending, "true");
  const tree = render();
  assert.equal(tree.props.children[0].props["data-pending"], "true", "The visible progress bar must receive its own pending state.");
}
href = "https://eventzeka.com/?day=2026-10-30";
render();
assert.equal(root.dataset.navigationPending, "false", "A completed URL transition clears feedback.");
assert.equal(render().props.children[0].props["data-pending"], "false");
assert.equal(timers.size, 0);
const legacy = click("/?day=2026-10-31");
assert.equal(legacy.defaultPrevented, true, "Unmanaged legacy calendar links retain their document fallback.");
assert.equal(assigned.length, 1);
for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
  assert.equal(click("/?day=2026-11-01", "client", modifiers).defaultPrevented, false);
}
assert.equal(assigned.length, 1, "Modified and middle clicks must keep native browser behavior.");
assert.equal(click("https://example.com/outside").defaultPrevented, false);
assert.equal(assigned.length, 1);
for (const slot of slots) slot?.cleanup?.();
assert.equal(listeners.size, 0);
assert.equal(root.dataset.navigationPending, "false");
console.log("Navigation feedback QA passed: managed soft navigation, visible pending bar, URL completion, native modified clicks, legacy fallback and cleanup.");
