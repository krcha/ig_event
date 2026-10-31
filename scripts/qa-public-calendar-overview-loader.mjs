import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { loadPublicCalendarOverviewWindow } from "../lib/events/public-calendar-overview.ts";
import { buildPublicCalendarDateWindows } from "../lib/events/public-calendar-windows.ts";
import { resolvePublicEventVenueFilter } from "../lib/events/public-event-venue-filter.ts";

const originalQuery = ConvexHttpClient.prototype.query;
const originalAction = ConvexHttpClient.prototype.action;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
let now = 10_000;
Date.now = () => now;
process.env.NEXT_PUBLIC_CONVEX_URL = "https://calendar-overview-loader-qa.convex.cloud";
const turn = () => new Promise(resolve => setImmediate(resolve));
const options = { fromDate: "2026-10-01", beforeDate: "2026-11-01", q: "  artist  ", venue: "  Source Venue  " };
const windows = buildPublicCalendarDateWindows(options.fromDate, options.beforeDate, 7);
const calls = [];
const gates = [];
let active = 0;
let peak = 0;
const seenPages = new Map();
const responses = [];
const snapshots = [];
globalThis.fetch = async () => { throw new Error("Overview loader QA must never make external requests."); };
ConvexHttpClient.prototype.query = async () => {
  throw new Error("The overview loader must use its action, never nested queries or detailed-event fallback.");
};

function page(args, pageIndex) {
  const index = windows.findIndex(window => window.fromDate === args.fromDate);
  const group = {
    date: args.fromDate, category: "live", venueValue: "id:shared", count: pageIndex + 1,
    legacyVenueMatchCount: pageIndex,
  };
  return {
    // An empty nonterminal authority page still has to advance its cursor.
    page: index === 1 && pageIndex === 0 ? [] : [group,
      ...(index === 0 && pageIndex === 1 ? [{ ...group, category: "culture", count: 4, legacyVenueMatchCount: 0 }] : [])],
    venues: [{ value: "id:shared", label: "Shared", names: ["Shared", `Alias ${index}-${pageIndex}`],
      ...(index === 0 ? { location: "Address A" } : {}) },
    ...(index === 0 ? [{ value: "id:other", label: "Shared", names: ["Shared", "Other"], location: "Address B" }] : [])],
    continueCursor: `${args.fromDate}:opaque-authority-cursor`, isDone: pageIndex === 1,
    rawPageCount: 1, scanLimitReached: false,
  };
}

try {
  ConvexHttpClient.prototype.action = async function (reference, args) {
    assert.equal(reference, "publicCalendarOverviewAction:listWindow");
    assert.equal(args.q, "artist");
    assert.equal(args.venue, "Source Venue");
    const window = windows.find(window => window.fromDate === args.fromDate);
    assert.ok(window, "A request must start on an exact contiguous window boundary.");
    assert.equal(args.beforeDate, window.beforeDate);
    const index = seenPages.get(args.fromDate) ?? 0;
    assert.equal(args.cursor, index === 0 ? null : `${args.fromDate}:opaque-authority-cursor`);
    seenPages.set(args.fromDate, index + 1);
    calls.push({ ...args });
    active++;
    peak = Math.max(peak, active);
    return new Promise(resolve => gates.push(() => {
      active--;
      const response = page(args, index);
      responses.push(response); snapshots.push(structuredClone(response));
      resolve(response);
    }));
  };
  const pending = loadPublicCalendarOverviewWindow(options);
  const coalesced = loadPublicCalendarOverviewWindow({ ...options, q: "artist", venue: "Source Venue" });
  await turn();
  assert.equal(calls.length, 1, "Background counters must leave room for foreground day reads.");
  assert.equal(peak, 1);
  now += 120_000;
  const slowCoalesced = loadPublicCalendarOverviewWindow({ ...options, q: "artist", venue: "Source Venue" });
  assert.equal(calls.length, 1, "A slow pending load must not expire and dispatch duplicate reads.");
  let waves = 0;
  while (gates.length) {
    // Each gate wave represents one equal-latency round trip. Resolve in reverse
    // order to prove that output precedence is independent of response timing.
    const current = gates.splice(0).reverse();
    for (const release of current) release();
    waves++;
    await turn();
  }
  const result = await pending;
  assert.deepEqual(await coalesced, result);
  assert.deepEqual(await slowCoalesced, result);
  assert.equal(calls.length, 10, "Coalesced callers must share the five two-page window reads.");
  assert.equal(peak, 1, "Only one background counter RPC may occupy the backend at once.");
  assert.equal(waves, 10, "Counter work deliberately yields throughput to foreground day requests.");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.groups, windows.flatMap((window, index) => [{
    date: window.fromDate, category: "live", venueValue: "id:shared", count: index === 1 ? 2 : 3, legacyVenueMatchCount: 1,
  }, ...(index === 0 ? [{ date: window.fromDate, category: "culture", venueValue: "id:shared", count: 4, legacyVenueMatchCount: 0 }] : [])]));
  const shared = result.venues.find(venue => venue.value === "id:shared");
  assert.equal(shared.label, "Shared (Address A)");
  assert.deepEqual(shared.names, ["Shared", ...windows.flatMap((_window, index) => [`Alias ${index}-0`, `Alias ${index}-1`])]);
  assert.equal(result.venues.find(venue => venue.value === "id:other").label, "Shared (Address B)");
  assert.equal(resolvePublicEventVenueFilter("Alias 0-0", result.venues), "id:shared");
  assert.equal(resolvePublicEventVenueFilter("Shared", result.venues), "Shared", "Ambiguous shared aliases retain legacy filtering.");
  assert.deepEqual(responses, snapshots, "Aggregation must not mutate backend fixtures.");
  await loadPublicCalendarOverviewWindow(options);
  assert.equal(calls.length, 10, "Successful results must stay cached.");

  let directCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    directCalls++;
    return { page: [], venues: [], continueCursor: "", isDone: true };
  };
  // A distinct query or venue/origin must have its own cache entry.
  await loadPublicCalendarOverviewWindow({ ...options, q: "different artist" });
  assert.equal(directCalls, 5);
  await loadPublicCalendarOverviewWindow({ ...options, venue: "different venue" });
  assert.equal(directCalls, 10);
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://calendar-overview-loader-origin-qa.convex.cloud";
  await loadPublicCalendarOverviewWindow(options);
  assert.equal(directCalls, 15);
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://calendar-overview-loader-qa.convex.cloud";
  await loadPublicCalendarOverviewWindow({ ...options, fromDate: "2026-10-02" });
  await loadPublicCalendarOverviewWindow({ ...options, beforeDate: "2026-11-02" });
  assert.equal(directCalls, 25, "Both date boundaries must participate in cache identity.");

  now += 59_999;
  await loadPublicCalendarOverviewWindow(options);
  assert.equal(directCalls, 25);
  now += 1;
  await loadPublicCalendarOverviewWindow(options);
  assert.equal(directCalls, 30, "Cache lifetime starts at success and remains bounded at exactly 60 seconds.");

  let failureCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    failureCalls++;
    throw new Error("Authoritative page failed");
  };
  const failedOptions = { ...options, q: "transient failure" };
  const failures = await Promise.all([loadPublicCalendarOverviewWindow(failedOptions), loadPublicCalendarOverviewWindow(failedOptions)]);
  for (const failed of failures) assert.deepEqual(failed, { groups: [], venues: [], error: "Authoritative page failed" });
  assert.equal(failureCalls, 1, "Stop dispatching new windows as soon as an authoritative page fails.");
  ConvexHttpClient.prototype.action = async function () {
    directCalls++;
    return { page: [], venues: [], continueCursor: "", isDone: true };
  };
  await loadPublicCalendarOverviewWindow(failedOptions);
  assert.equal(directCalls, 35, "A failed load must be evicted so all its windows can retry.");
  await loadPublicCalendarOverviewWindow(options);
  assert.equal(directCalls, 35, "A failed scope must not evict another successful scope.");

  let cursorCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    cursorCalls++;
    return { page: [], venues: [], continueCursor: "same-cursor", isDone: false };
  };
  const nonAdvancing = await loadPublicCalendarOverviewWindow({ fromDate: "2026-10-01", beforeDate: "2026-10-02" });
  assert.equal(nonAdvancing.error, "Calendar overview pagination did not advance.");
  assert.equal(cursorCalls, 2, "Nonterminal empty pages must not loop on a repeated cursor.");
  cursorCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    cursorCalls++;
    return { page: [], venues: [], continueCursor: "", isDone: false };
  };
  const missingCursor = await loadPublicCalendarOverviewWindow({ fromDate: "2026-10-02", beforeDate: "2026-10-03" });
  assert.match(missingCursor.error, /pagination did not advance/);
  assert.equal(cursorCalls, 1);
  cursorCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    cursorCalls++;
    return { page: [], venues: [], continueCursor: cursorCalls % 2 ? "one" : "two", isDone: false };
  };
  const cursorCycle = await loadPublicCalendarOverviewWindow({ fromDate: "2026-10-03", beforeDate: "2026-10-04" });
  assert.match(cursorCycle.error, /pagination did not advance/);
  assert.equal(cursorCalls, 3);
  assert.deepEqual(cursorCycle.groups, []);

  let emptyCalls = 0;
  ConvexHttpClient.prototype.action = async function () {
    emptyCalls++;
    return { page: [], venues: [], continueCursor: "", isDone: true };
  };
  const empty = await loadPublicCalendarOverviewWindow({ fromDate: "2026-12-01", beforeDate: "2027-01-01" });
  assert.deepEqual(empty, { groups: [], venues: [] });
  assert.equal(emptyCalls, 5, "An empty month needs only one bounded read per independent window.");
  const beforeInvalid = emptyCalls;
  for (const bounds of [
    { fromDate: "2026-02-30", beforeDate: "2026-03-31" },
    { fromDate: "2026-10-1", beforeDate: "2026-11-01" },
    { fromDate: "2026-10-01", beforeDate: "not-a-date" },
    { fromDate: "2026-10-01", beforeDate: "2026-10-01" },
    { fromDate: "2026-11-01", beforeDate: "2026-10-01" },
  ]) {
    const invalid = await loadPublicCalendarOverviewWindow(bounds);
    assert.match(invalid.error, /valid date boundaries/);
    assert.deepEqual(invalid.groups, []);
    assert.deepEqual(invalid.venues, []);
  }
  assert.equal(emptyCalls, beforeInvalid, "Invalid bounds must never reach the backend.");

  const longCalls = [];
  ConvexHttpClient.prototype.action = async function (_reference, args) {
    longCalls.push(args);
    return { page: [], venues: [], continueCursor: "", isDone: true };
  };
  await loadPublicCalendarOverviewWindow({ fromDate: "2026-01-01", beforeDate: "2026-04-01" });
  assert.deepEqual(longCalls.map(({ fromDate, beforeDate, cursor }) => ({ fromDate, beforeDate, cursor })),
    buildPublicCalendarDateWindows("2026-01-01", "2026-04-01", 7).map(window => ({ ...window, cursor: null })),
    "Long ranges remain contiguous and each request is well within the backend's 45-day bound.");
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  const unconfigured = await loadPublicCalendarOverviewWindow(options);
  assert.match(unconfigured.error, /not configured/);
  assert.equal(longCalls.length, 13, "Missing configuration must not perform any read.");

  process.env.NEXT_PUBLIC_CONVEX_URL = "https://calendar-overview-loader-lru-qa.convex.cloud";
  const day = { fromDate: "2026-10-01", beforeDate: "2026-10-02" };
  for (let index = 0; index < 49; index++) await loadPublicCalendarOverviewWindow({ ...day, q: `lru-${index}` });
  const beforeEvicted = longCalls.length;
  await loadPublicCalendarOverviewWindow({ ...day, q: "lru-0" });
  assert.equal(longCalls.length, beforeEvicted + 1, "Keep the existing 48-entry cache bound.");

  console.log("Calendar overview loader QA passed: one background RPC slot, sequential cursors, exact merge, coalescing, TTL, origin/filter/error isolation, empty windows and bounded LRU.");
} finally {
  ConvexHttpClient.prototype.action = originalAction;
  ConvexHttpClient.prototype.query = originalQuery;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
}
