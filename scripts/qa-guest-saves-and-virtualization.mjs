import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Virtualizer } from "@tanstack/virtual-core";
import * as guests from "../lib/user-library/guest-saved-events.ts";
import * as requests from "../lib/user-library/saved-events-client.ts";
import { virtualListRange } from "../lib/events/virtual-list-range.ts";

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, value); }
  removeItem(key) { this.map.delete(key); }
}
const event = id => ({ _id: id, title: `Event ${id}`, date: "2099-11-01", venue: "Venue", eventType: "live", time: "21:00" });
const success = id => ({ success: true, saved: true, eventId: id, event: event(id), authenticationRequired: false, error: null });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

{
  const storage = new MemoryStorage();
  storage.setItem("other-app", "keep");
  storage.setItem(guests.GUEST_SAVED_EVENT_PREFIX + "broken", "{bad");
  assert.deepEqual(guests.readGuestSavedEvents(storage), []);
  guests.writeGuestSavedEvent(storage, "one", true, { ...event("one"), rawExtractionJson: "PRIVATE", sourceCaption: "SOURCE" });
  guests.writeGuestSavedEvent(storage, "two", true, event("two"));
  assert.equal(guests.readGuestSavedEvents(storage).length, 2, "Independent event keys survive other-tab saves.");
  assert.doesNotMatch(storage.getItem(guests.GUEST_SAVED_EVENT_PREFIX + "one"), /PRIVATE|SOURCE/);
  const unknown = guests.guestEventSnapshot({ ...event("unknown"), timeStatus: "unknown", displayTimeStart: "21:00" });
  assert.equal(unknown.time, undefined); assert.equal(unknown.displayTimeStart, undefined);
  guests.writeGuestSavedEvent(storage, "one", false);
  assert.deepEqual(guests.readGuestSavedEvents(storage).map(x => x.event._id), ["two"]);
  assert.equal(storage.getItem("other-app"), "keep");
  assert.throws(() => guests.writeGuestSavedEvent(storage, "../invalid", true, event("../invalid")));
}
{
  const storage = new MemoryStorage();
  for (const id of ["one", "two", "three", "four", "five"]) guests.writeGuestSavedEvent(storage, id, true, event(id));
  let inFlight = 0, peak = 0;
  const result = await guests.syncGuestSavedEvents(storage, "A", async id => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 1)); inFlight--;
    return id === "two" ? requests.failedSavedEventResult(id, "offline") : success(id);
  }, () => true);
  assert.equal(peak, 3); assert.deepEqual(result.failedEventIds, ["two"]);
  assert.equal(guests.readGuestSavedEvents(storage, "A").length, 1);
  assert.equal(guests.readGuestSavedEvents(storage).length, 0, "Claimed account saves do not leak to a signed-out/shared session.");
  let otherCalls = 0;
  await guests.syncGuestSavedEvents(storage, "B", async id => { otherCalls++; return success(id); }, () => true);
  assert.equal(otherCalls, 0, "A failed account-A import must never be claimed by account B.");
  await guests.syncGuestSavedEvents(storage, "A", async id => success(id), () => true);
  assert.equal(guests.readGuestSavedEvents(storage, "A").length, 0, "Retry imports only failed records.");
}
{
  const storage = new MemoryStorage(); guests.writeGuestSavedEvent(storage, "one", true, event("one"));
  const wait = deferred();
  const sync = guests.syncGuestSavedEvents(storage, "A", () => wait.promise, () => true);
  guests.writeGuestSavedEvent(storage, "one", true, { ...event("one"), title: "Newer selection" });
  wait.resolve(success("one")); await sync;
  assert.equal(guests.readGuestSavedEvents(storage)[0].event.title, "Newer selection", "A late import must not delete a newer same-ID save.");
  let owner = "A"; const wait2 = deferred();
  const sync2 = guests.syncGuestSavedEvents(storage, "A", () => wait2.promise, () => owner === "A");
  owner = "B"; wait2.resolve(success("one")); await sync2;
  assert.equal(guests.readGuestSavedEvents(storage, "A").length, 1, "An account switch fences a late response and retains an idempotent retry.");
}

// Execute the actual provider with a deterministic hook scheduler and transport.
// This drives effect/auth/request ordering, including delayed reads and account switches.
function providerHarness(storage, transport, initial = { isLoaded: true, isSignedIn: false, userId: null }) {
  let identity = initial, slots = [], cursor = 0, dirty = true, effects = [], snapshot;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    createContext: () => ({ Provider: "provider" }), useContext: () => snapshot,
    useState(initial) {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(make, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: make() }; return slots[i].value; },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(callback, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; }); },
  };
  const jsx = (_type, props) => { if (props.value) snapshot = props.value; return { props }; };
  const mod = { exports: {} }, listeners = new Set();
  const compiled = ts.transpileModule(readFileSync("components/providers/user-library-provider.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled + "\nexports.TestProvider = LibraryStateProvider;", {
    exports: mod.exports, window: { localStorage: storage, addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) },
    Set, Map, Date, Promise, fetch: transport,
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name.endsWith("guest-saved-events")) return guests;
      if (name.endsWith("saved-events-client")) return { ...requests, requestSavedEventState: (id, saved) => requests.requestSavedEventState(id, saved, transport) };
      if (name.endsWith("use-require-auth")) return { useRequireAuth: () => identity };
      throw Error(`Unexpected provider import ${name}`);
    },
  });
  return {
    get value() { return snapshot; },
    identity(value) { identity = value; dirty = true; },
    async settle() {
      let quiet = 0;
      for (let turn = 0; turn < 100; turn++) {
        if (dirty) { dirty = false; cursor = 0; mod.exports.TestProvider({ children: null, identity: { ...identity, requireAuth: () => { throw Error("Guest save redirected to sign-in"); } } }); for (const effect of effects.splice(0)) effect(); quiet = 0; }
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty && ++quiet >= 3) return snapshot;
      }
      throw Error("Provider did not stabilize");
    },
  };
}
const account = id => ({ isLoaded: true, isSignedIn: true, userId: id });
const library = events => Response.json({ savedEventIds: events.map(e => e._id), savedEvents: events, favoriteVenueIds: [], favoriteVenues: [] });
{
  const storage = new MemoryStorage(); guests.writeGuestSavedEvent(storage, "guest", true, event("guest"));
  let posts = [], server = [event("cloud")];
  const test = providerHarness(storage, async (url, options) => {
    if (!options?.method) return library(server);
    const body = JSON.parse(options.body); posts.push(body); server = [...server.filter(e => e._id !== body.eventId), ...(body.saved ? [event(body.eventId)] : [])];
    return Response.json({ saved: body.saved, event: body.saved ? event(body.eventId) : null });
  });
  await test.settle(); assert.equal(test.value.savedEventIds.has("guest"), true);
  assert.equal(await test.value.toggleSavedEvent("new", { expectedSaved: false, event: event("new") }), true);
  await test.settle(); assert.equal(posts.length, 0, "Guest actions never need a private HTTP request.");
  const reload = providerHarness(storage, async () => { throw Error("Guest requested the network"); }); await reload.settle(); assert.equal(reload.value.savedEventIds.size, 2);
  test.identity(account("A")); await test.settle();
  assert.deepEqual([...test.value.savedEventIds].sort(), ["cloud", "guest", "new"]);
  assert.equal(posts.length, 2); assert.ok(posts.every(body => body.saved === true));
  assert.equal(guests.readGuestSavedEvents(storage, "A").length, 0);
  test.identity({ isLoaded: true, isSignedIn: false, userId: null }); await test.settle();
  assert.equal(test.value.savedEventIds.size, 0, "Signing out cannot copy account saves back into guest storage.");
}
{
  const storage = new MemoryStorage(); guests.writeGuestSavedEvent(storage, "guest", true, event("guest"));
  const wait = deferred(); let postCount = 0;
  const test = providerHarness(storage, async (_url, options) => {
    if (!options?.method) return library([]);
    postCount++; return wait.promise;
  }, account("A"));
  await test.settle(); assert.equal(postCount, 1);
  test.identity(account("B")); await test.settle();
  assert.equal(test.value.savedEventIds.size, 0);
  wait.resolve(Response.json({ saved: true, event: event("guest") })); await test.settle();
  assert.equal(postCount, 1); assert.equal(test.value.savedEventIds.size, 0);
  assert.equal(guests.readGuestSavedEvents(storage, "A").length, 1);
}
{
  const storage = new MemoryStorage(); let readWait = null;
  const test = providerHarness(storage, async (_url, options) => options?.method
    ? Response.json({ saved: true, event: event("new") })
    : readWait ? readWait.promise : library([]), account("A"));
  await test.settle(); readWait = deferred();
  const refresh = test.value.refreshLibrary();
  await test.value.setSavedEvent("new", true); await test.settle();
  readWait.resolve(library([])); await refresh; await test.settle();
  assert.equal(test.value.savedEventIds.has("new"), true, "A stale library GET must not undo a confirmed write.");
}
{
  const storage = new MemoryStorage(); storage.setItem = () => { throw Error("Quota exceeded"); };
  const test = providerHarness(storage, async () => { throw Error("Guest requested private data"); }); await test.settle();
  const result = await test.value.setSavedEvent("event", true, event("event")); await test.settle();
  assert.equal(result.success, false); assert.equal(result.authenticationRequired, false);
  assert.equal(test.value.savedEventIds.size, 0); assert.match(test.value.error, /browser storage/);
}

for (const offset of [0, 2_000, 20_000, 70_000]) {
  const virtualizer = new Virtualizer({ count: 1000, getScrollElement: () => null, estimateSize: () => 80,
    initialRect: { width: 390, height: 844 }, initialOffset: offset, overscan: 4,
    scrollToFn() {}, observeElementOffset() {}, observeElementRect() {},
    rangeExtractor: range => virtualListRange(range, [2]),
  });
  const rows = virtualizer.getVirtualItems();
  assert.ok(rows.length > 0 && rows.length <= 25, "A 1000-event list must mount only a bounded viewport, including a focused off-screen row.");
  assert.equal(new Set(rows.map(row => row.index)).size, rows.length);
  assert.ok(rows.some(row => row.index === 2));
  const before = virtualizer.getTotalSize(); virtualizer.resizeItem(2, 600);
  assert.equal(virtualizer.getTotalSize(), before + 520, "Expanded posts must reserve their measured height.");
}
console.log("Guest saves and virtualization QA passed: persistence, safe snapshots, blocked storage, partial retry, account fences, additive import, stale reads, bounded DOM ranges and expanded-row sizing.");
