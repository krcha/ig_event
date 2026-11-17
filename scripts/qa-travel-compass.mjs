import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { travelText } from "../lib/travel/copy.ts";
import { bearingDegrees, estimateTravel, haversineMeters, isCoordinates, yandexDestinationHref } from "../lib/travel/location.ts";
import { matchesVibe, compassCandidates, eventEndedBeforeArrival } from "../lib/travel/compass.ts";
import { sortDiscoverByDistance } from "../lib/discover/distance-sort.ts";

const origin = { latitude: 44.8125, longitude: 20.4612 };
const point = { latitude: 44.8135, longitude: 20.4612 };
assert.equal(isCoordinates({ latitude: "44", longitude: 20 }), false);
assert.equal(isCoordinates({ latitude: 91, longitude: 20 }), false);
assert.equal(haversineMeters(origin, origin), 0);
assert.ok(Math.abs(haversineMeters(origin, point) - 111.195) < .1);
assert.equal(bearingDegrees(origin, point), 0);
assert.equal(estimateTravel(origin, point).walkMinutes, 2);
assert.equal(estimateTravel(origin, { latitude: 44.83, longitude: 20.49 }).walkMinutes > 10, true);
assert.equal(yandexDestinationHref({ latitude: NaN, longitude: 20 }), null);
const taxi = new URL(yandexDestinationHref(point));
assert.equal(taxi.protocol, "https:");
assert.equal(taxi.searchParams.get("end-lat"), String(point.latitude));
assert.equal(taxi.searchParams.get("end-lon"), String(point.longitude));
assert.equal(taxi.searchParams.has("start-lat"), false);
assert.equal(taxi.searchParams.has("start-lon"), false);
assert.equal([...taxi.searchParams.keys()].length, 3);
const deck = [{ _id: "unknown" }, { _id: "far", venueLatitude: 45, venueLongitude: 20 },
  { _id: "near", venueLatitude: point.latitude, venueLongitude: point.longitude },
  { _id: "tie", venueLatitude: point.latitude, venueLongitude: point.longitude }];
assert.deepEqual(sortDiscoverByDistance(deck, origin).map(event => event._id), ["near", "tie", "far", "unknown"]);

const now = Date.parse("2026-11-17T20:00:00Z");
const hours = { hoursSource: "manual", hoursTimezone: "Europe/Belgrade", hoursJson: JSON.stringify({ version: 1, timezone: "Europe/Belgrade", source: "manual", generatedAt: "2026-11-17T00:00:00Z", weekly: Array.from({ length: 7 }, (_, day) => ({ day, closed: false, windows: [{ day, start: "18:00", end: "04:00", spansNextDay: true }] })) }) };
const place = (id, genres, primaryCategory = "party", coords = point) => ({ id, name: id, ...coords, hours, event: { id, title: id, date: "2026-11-17", time: "20:00", taxonomy: { primaryCategory, categories: [primaryCategory], genres, formats: [] } } });
const source = place("source", ["house"]);
const techno = place("techno", ["techno"]);
const rock = place("rock", ["rock"]);
const unknown = place("unknown", []);
assert.equal(matchesVibe(source, techno, "same"), true);
assert.equal(matchesVibe(source, techno, "different"), false);
assert.equal(matchesVibe(source, rock, "different"), true);
assert.equal(matchesVibe(source, unknown, "same"), false);
assert.equal(matchesVibe(source, unknown, "different"), false);
assert.equal(matchesVibe(source, place("film", [], "culture"), "different"), true);
assert.equal(matchesVibe({ ...source, event: undefined }, rock, "different"), false);
assert.equal(eventEndedBeforeArrival({ ...source.event, time: "20:00–21:00" }, now), true);
assert.equal(eventEndedBeforeArrival({ ...source.event, time: "20:00–04:00" }, now), false);
assert.equal(eventEndedBeforeArrival({ ...source.event, time: "20:00–04:00" }, Date.parse("2026-11-18T03:00:00Z")), true);
const far = place("far", ["techno"], "party", { latitude: 44.82, longitude: 20.49 });
const closed = { ...techno, id: "closed", hours: undefined };
const expired = { ...techno, id: "expired", hours: { ...hours, hoursExpiresAt: now - 1 } };
assert.deepEqual(compassCandidates([far, source, closed, expired, rock, techno], source, origin, "same", now).map(x => x.id), ["techno", "far"]);
assert.deepEqual(compassCandidates([far, source, closed, rock, techno], source, origin, "different", now).map(x => x.id), ["rock"]);
assert.deepEqual(compassCandidates([techno], source, origin, "same", Date.parse("2026-11-18T08:00:00Z")), []);

const locationSource = await readFile(new URL("../components/travel/user-location.tsx", import.meta.url), "utf8");
assert.doesNotMatch(locationSource, /sessionStorage|console\.|sendBeacon/);

// Execute the actual provider: browser permission state, automatic first visit,
// fresh fixes after backgrounding, denial persistence and stale async cleanup.
function locationHarness({ permission = "prompt", saved = null, deferred = false, permissionApi = true, hidden = false } = {}) {
  const slots = [], effects = [], documentListeners = new Map(), permissionListeners = new Map(), watches = new Map();
  const storage = new Map(saved ? [["eventzeka.location-permission.v1", saved]] : []), writes = [], calls = [], cleared = [];
  let cursor = 0, watchId = 0, resolvePermission;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    createContext: value => ({ Provider: "provider", value }),
    useContext: context => context.value,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: initial }; return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo(callback, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: callback() }; return slots[index].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) { const index = cursor++, old = slots[index]; if (same(old?.deps, deps)) return; slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = callback(); }); },
  };
  const permissionStatus = { state: permission, addEventListener: (name, callback) => permissionListeners.set(name, callback), removeEventListener: name => permissionListeners.delete(name) };
  const document = { hidden, addEventListener: (name, callback) => documentListeners.set(name, callback), removeEventListener: name => documentListeners.delete(name) };
  const navigator = {
    geolocation: {
      watchPosition(success, error, options) { const id = ++watchId; watches.set(id, { success, error }); calls.push({ id, options }); return id; },
      clearWatch(id) { cleared.push(id); watches.delete(id); },
    },
    ...(permissionApi ? { permissions: { query: () => deferred ? new Promise(resolve => { resolvePermission = resolve; }) : Promise.resolve(permissionStatus) } } : {}),
  };
  const compiled = { exports: {} };
  const output = ts.transpileModule(locationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = { react, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) }, "@/i18n/client": { useLocale: () => "sr" }, "@/lib/travel/copy": { travelText }, "@/lib/travel/location": { isCoordinates } };
  runInNewContext(output, { exports: compiled.exports, require: name => { if (name in imports) return imports[name]; throw Error(name); }, navigator, document, window: { isSecureContext: true }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); writes.push([key, value]); } } });
  const render = () => { cursor = 0; return compiled.exports.UserLocationProvider({ children: null }).props.value; };
  render(); effects.splice(0).forEach(callback => callback());
  return {
    calls, cleared, storage, writes, state: render,
    settle: async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve(); },
    fix: (latitude = 44.81) => watches.get(calls.at(-1).id)?.success({ coords: { latitude, longitude: 20.46, accuracy: 8 }, timestamp: 1_000 + calls.length }),
    deny: () => watches.get(calls.at(-1).id)?.error({ code: 1 }),
    visibility(value) { document.hidden = value; documentListeners.get("visibilitychange")?.(); },
    permission(value) { permissionStatus.state = value; permissionListeners.get("change")?.(); },
    resolvePermission: () => resolvePermission?.(permissionStatus),
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
    listenerCount: () => documentListeners.size + permissionListeners.size,
  };
}
{
  const h = locationHarness(); await h.settle();
  assert.equal(h.calls.length, 1, "The first visit requests GPS automatically.");
  assert.equal(h.calls[0].options.maximumAge, 0, "Restoring permission must never restore an old coordinate fix.");
  h.fix(); assert.equal(h.state().position.latitude, 44.81);
  assert.equal(h.storage.get("eventzeka.location-permission.v1"), "granted");
  h.visibility(true); assert.equal(h.state().position, null); assert.equal(h.cleared.length, 1);
  h.visibility(false); assert.equal(h.calls.length, 2); assert.equal(h.state().status, "loading");
  h.fix(44.82); assert.equal(h.state().position.latitude, 44.82);
  h.permission("denied"); assert.equal(h.state().position, null); assert.equal(h.state().status, "error");
  h.visibility(true); h.visibility(false); assert.equal(h.calls.length, 2, "Denied permissions must not repeatedly prompt on resume.");
  assert.ok(h.writes.every(([key, value]) => key === "eventzeka.location-permission.v1" && ["granted", "denied"].includes(value)), "Storage must contain permission only, never GPS coordinates.");
  h.unmount(); assert.equal(h.listenerCount(), 0);
}
for (const permissionApi of [true, false]) {
  const h = locationHarness({ saved: "denied", permissionApi }); await h.settle();
  assert.equal(h.calls.length, 0, "A remembered refusal is respected even without the Permissions API.");
  h.state().requestLocation(); assert.equal(h.calls.length, 1, "An explicit retry remains available after browser settings change.");
  h.fix(); assert.equal(h.state().status, "ready"); h.unmount();
}
{
  const h = locationHarness({ permission: "granted", saved: "denied" }); await h.settle();
  assert.equal(h.calls.length, 1, "A fresh browser grant overrides a stale remembered refusal."); h.unmount();
}
{
  const h = locationHarness({ permission: "granted" }); await h.settle(); h.fix(); h.permission("prompt");
  assert.equal(h.state().position, null, "Revoking a browser grant immediately invalidates the fix.");
  h.visibility(true); h.visibility(false); assert.equal(h.calls.length, 1, "Revocation cannot start a surprise prompt when the tab resumes.");
  h.permission("granted"); assert.equal(h.calls.length, 2, "A new grant resumes a fresh GPS watch."); h.unmount();
}
{
  const h = locationHarness({ deferred: true }); h.state().requestLocation(); h.resolvePermission(); await h.settle();
  assert.equal(h.calls.length, 1, "A late permission query cannot duplicate an explicit request."); h.unmount();
}
{
  const h = locationHarness({ deferred: true }); h.unmount(); h.resolvePermission(); await h.settle();
  assert.equal(h.calls.length, 0, "A late permission query cannot start GPS after unmount.");
}
{
  const h = locationHarness({ hidden: true, permissionApi: false }); await h.settle();
  assert.equal(h.calls.length, 0); h.visibility(false); assert.equal(h.calls.length, 1); h.unmount();
}
const yandexSource = await readFile(new URL("../components/travel/yandex-taxi-button.tsx", import.meta.url), "utf8");
assert.doesNotMatch(yandexSource, /target=["']_blank/);
assert.match(yandexSource, /width=\{32\}/);
assert.match(yandexSource, /h-11 w-11/);
const flowSource = await readFile(new URL("../components/travel/compass-flow.tsx", import.meta.url), "utf8");
// Exercise the shipped permission callback, not a separately reimplemented
// permission helper. A compass needs the absolute/magnetometer grant.
const flowAst = ts.createSourceFile("compass-flow.tsx", flowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let permissionCallback;
function findPermissionCallback(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(flowAst) === "enableCompass" && node.initializer && ts.isCallExpression(node.initializer)) {
    permissionCallback = node.initializer.arguments[0].getText(flowAst);
  }
  ts.forEachChild(node, findPermissionCallback);
}
findPermissionCallback(flowAst);
assert.ok(permissionCallback, "The actual compass permission callback must be exercised.");
function compassPermissionHarness() {
  const calls = [], listeners = new Map(), headings = [];
  let saved = null, gesture = false, requireGesture = false;
  const orientationState = { current: "idle" };
  const refs = {
    orientationState, orientationGeneration: { current: 0 }, orientationCleanup: { current: null },
    orientationReading: { current: false }, orientationTimer: { current: null }, lastHeading: { current: null },
  };
  const context = {
    ...refs, document: { hidden: false },
    window: {
      DeviceOrientationEvent: { requestPermission: async absolute => {
        calls.push({ absolute, gesture });
        if (requireGesture && !gesture) throw new Error("User activation required");
        return "granted";
      } },
      addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
    },
    rememberedCompassPermission: () => saved, rememberCompassPermission: value => { saved = value; },
    setOrientationMessage: () => {}, setHeading: value => headings.push(value), setTimeout: () => 1,
  };
  const output = ts.transpileModule(`globalThis.invoke = ${permissionCallback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(output, context);
  return {
    calls, headings, listeners, invoke: context.invoke,
    gesture(value) { gesture = value; }, requireGesture(value) { requireGesture = value; },
    saved: () => saved, state: () => orientationState.current,
    resume() { refs.orientationCleanup.current?.(); orientationState.current = "idle"; },
  };
}
{
  const h = compassPermissionHarness();
  await h.invoke(); assert.equal(h.calls.length, 0, "The first iOS permission request waits for an existing user gesture.");
  h.gesture(true); await h.invoke(true);
  assert.deepEqual(h.calls, [{ absolute: true, gesture: true }], "The first gesture must request absolute orientation, including the magnetometer.");
  assert.equal(h.saved(), "granted");
  h.listeners.get("deviceorientationabsolute")({ absolute: true, alpha: 270 });
  assert.deepEqual(h.headings, [90], "Granted absolute readings drive the compass bearing.");
  h.resume(); h.gesture(false); h.requireGesture(true); await h.invoke();
  assert.deepEqual(h.calls.at(-1), { absolute: true, gesture: false }, "Restoring a remembered grant still requests the magnetometer.");
  assert.equal(h.state(), "gesture", "A browser that still requires a gesture must remain retryable, not be remembered as denied.");
  h.gesture(true); await h.invoke(true);
  assert.deepEqual(h.calls.at(-1), { absolute: true, gesture: true }, "The existing Yes/vibe tap retries the absolute permission request.");
  assert.equal(h.state(), "active"); assert.equal(h.saved(), "granted");
}
assert.match(flowSource, /function showRoute/);
assert.match(flowSource, /onClick=\{showRoute\}/);
assert.doesNotMatch(flowSource, /Heineken|heineken|demoOrigin|demo location/);
console.log("Travel compass QA passed: GPS distance, genre families/unknowns, confirmed hours/arrival, nearest order and destination-only taxi.");
