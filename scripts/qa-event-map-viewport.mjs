import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { publicText } from "../lib/i18n/public-messages.ts";
import { formatEventCount, formatVenueCount } from "../lib/i18n/display.ts";
import { localizeHref } from "../i18n/config.ts";

// Run the actual map component's Leaflet lifecycle and reset handler. A Novi Sad
// marker stays present, but cannot decide the initial or reset viewport.
const code = ts.transpileModule(readFileSync("components/maps/event-location-map.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const center = [44.8125, 20.4612];
function element() {
  const attributes = new Map();
  return {
    style: {}, dataset: {}, classList: { toggle() {} },
    append() {}, addEventListener() {}, removeAttribute: key => attributes.delete(key),
    setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key),
    querySelector: () => null, contains: () => false, focus() {},
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return undefined;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
const locations = [
  { id: "belgrade", name: "Belgrade venue", latitude: 44.81, longitude: 20.46, events: [] },
  { id: "novi-sad", name: "Novi Sad venue", latitude: 45.2671, longitude: 19.8335, events: [] },
];
for (const desktop of [false, true]) for (const pins of [[], locations]) {
  let refsCursor = 0, stateCursor = 0, effects = [];
  const refs = [], states = [], markers = [], views = [], viewportListeners = new Set();
  let initialOptions, removed = false, locationFix;
  const viewport = { matches: desktop, addEventListener: (_type, cb) => viewportListeners.add(cb), removeEventListener: (_type, cb) => viewportListeners.delete(cb) };
  const map = {
    createPane: () => element(), closePopup() {}, invalidateSize() {}, hasLayer: () => false,
    setView(point, zoom) { views.push({ point: [...point], zoom }); return this; },
    fitBounds() { assert.fail("Distant venue points must not fit the city viewport."); },
    getZoom: () => views.at(-1)?.zoom ?? initialOptions.zoom,
    remove() { removed = true; },
  };
  function layer() {
    return { addTo() { return this; }, setLatLng() { return this; }, setRadius() { return this; }, getElement: element, remove() {} };
  }
  const leaflet = {
    map(_element, options) { initialOptions = options; return map; },
    control: { zoom: () => ({ addTo() {} }) },
    tileLayer: () => ({ on() {}, addTo() {} }),
    circle: layer, circleMarker: layer, divIcon: value => value,
    marker(point) {
      const marker = { ...layer(), getLatLng: () => point, bindTooltip() {}, on() {}, closeTooltip() {}, setZIndexOffset() {} };
      markers.push(marker); return marker;
    },
    popup: () => ({ setContent() { return this; }, setLatLng() { return this; }, openOn() { return this; } }),
  };
  const jsx = (type, props) => {
    if (typeof type === "function") return type(props);
    if (props?.ref && !props.ref.current) props.ref.current = element();
    return { type, props };
  };
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useEffect: effect => effects.push(effect), useId: () => "map-qa", useMemo: cb => cb(),
      useRef(value) { const index = refsCursor++; return refs[index] ??= { current: value }; },
      useState(value) { const index = stateCursor++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = next; }]; },
    },
    "lucide-react": { Expand: "expand", LoaderCircle: "loader", LocateFixed: "locate", MapPin: "pin" },
    leaflet,
    "@/lib/events/event-session": { getEventSessionLabel: () => "" },
    "@/lib/events/event-time-presentation": { resolveEventTimePresentation: () => ({ label: "Unknown" }) },
    "@/components/events/open-now-status": { OPEN_NOW_POSSIBLE_LABEL: "Possible" },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "@/components/i18n/public-text": { LocalizedElement: "localized-element", PublicText: ({ text }) => text ? publicText("en", text) : "" },
    "@/i18n/client": { useLocale: () => "en" },
    "@/i18n/config": { localizeHref },
    "@/lib/i18n/public-messages": { publicText },
    "@/lib/i18n/display": { formatEventCount, formatVenueCount },
    "leaflet/dist/leaflet.css": {}, "./event-map.css": {},
  };
  const compiled = { exports: {} };
  new Function("require", "exports", "module", "window", "document", "navigator", "ResizeObserver", code)(
    name => { assert.ok(name in imports, `Unexpected map QA import ${name}`); return imports[name]; }, compiled.exports, compiled,
    { matchMedia: query => query.includes("1024px") ? viewport : { matches: true } },
    { createElement: element },
    { geolocation: { watchPosition(fix) { locationFix = fix; return 1; }, clearWatch() {} } },
    class { observe() {} disconnect() {} },
  );
  let selectedLocationId = null;
  function render() {
    refsCursor = 0; stateCursor = 0; effects = [];
    return compiled.exports.EventLocationMap({ locations: pins, possibleEventIds: [], selectedLocationId, onSelectLocation() {} });
  }
  render();
  const cleanup = effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(initialOptions.center, center);
  assert.equal(initialOptions.zoom, 14);
  assert.deepEqual(views, [{ point: center, zoom: 14 }]);
  assert.equal(markers.length, pins.length, "All locations, including the outlier, remain mapped.");
  let tree = render();
  assert.equal(find(tree, node => node.props?.role === "status")?.props.children, "", "The map must finish initializing.");
  const reset = find(tree, node => node.props?.["aria-label"] === "Reset map to Belgrade");
  assert.ok(reset, "The ready map exposes its city reset.");
  map.setView([45.2671, 19.8335], 8);
  reset.props.onClick();
  assert.deepEqual(views.at(-1), { point: center, zoom: 14 });
  viewport.matches = !desktop;
  viewportListeners.forEach(listener => listener());
  assert.deepEqual(views.at(-1), { point: center, zoom: 14 }, "Crossing the desktop breakpoint keeps the Belgrade focus.");
  if (pins.length) {
    selectedLocationId = "novi-sad";
    tree = render(); effects[1]();
    assert.deepEqual(views.at(-1).point, [45.2671, 19.8335], "An explicit venue selection can still move to an outlier.");
  }
  find(tree, node => node.props?.["aria-label"] === "Show my location").props.onClick();
  locationFix({ coords: { latitude: 44.82, longitude: 20.48, accuracy: 8 } });
  assert.deepEqual(views.at(-1), { point: [44.82, 20.48], zoom: 15 }, "Intentional geolocation keeps its existing focus behavior.");
  reset.props.onClick();
  assert.deepEqual(views.at(-1), { point: center, zoom: 14 });
  cleanup();
  assert.equal(removed, true);
  assert.equal(viewportListeners.size, 0);
}
console.log("Map viewport QA passed: empty/mixed-city pins, mobile/desktop, city reset, breakpoint, explicit selection, geolocation and cleanup.");
