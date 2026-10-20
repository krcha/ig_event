import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { loadPublicCalendarOverviewWindow } from "../lib/events/public-calendar-overview.ts";
import { resolvePublicEventVenueFilter } from "../lib/events/public-event-venue-filter.ts";

const originalQuery = ConvexHttpClient.prototype.query;
const originalAction = ConvexHttpClient.prototype.action;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const originalDateNow = Date.now;
const queries = [];
let transport;

function page(overrides = {}) {
  return {
    page: [],
    venues: [],
    continueCursor: "done",
    isDone: true,
    rawPageCount: 1,
    scanLimitReached: false,
    ...overrides,
  };
}

function setCase(name, handler) {
  process.env.NEXT_PUBLIC_CONVEX_URL = `https://${name}.convex.cloud`;
  queries.length = 0;
  transport = handler;
}

function group(overrides = {}) {
  return {
    date: "2026-10-20",
    category: "live",
    venueValue: "id:venue-one",
    count: 1,
    legacyVenueMatchCount: 1,
    ...overrides,
  };
}

const options = { fromDate: "2026-10-01", beforeDate: "2026-11-01" };
globalThis.fetch = async () => {
  throw new Error("Calendar overview loader QA must never make external requests.");
};
ConvexHttpClient.prototype.query = async function query() {
  throw new Error("The overview loader must use its action transport, not a nested query or detailed-event fallback.");
};
ConvexHttpClient.prototype.action = async function action(name, args) {
  assert.equal(name, "publicCalendarOverviewAction:listWindow", "The counter loader must use the cache-preserving overview action.");
  queries.push({ name, args: structuredClone(args) });
  return transport(args);
};

try {
  const responses = [
    page({
      page: [group({ count: 2, legacyVenueMatchCount: 1 })],
      venues: [{ value: "id:venue-one", label: "Same Brand", names: ["Same Brand", "Old Name"], location: "First Street 1" }],
      continueCursor: "after-first",
      isDone: false,
    }),
    page({ continueCursor: "after-empty", isDone: false }),
    page({
      page: [group({ count: 3, legacyVenueMatchCount: 2 }), group({ category: "culture", count: 4, legacyVenueMatchCount: 0 })],
      venues: [
        { value: "id:venue-one", label: "Same Brand", names: ["Same Brand", "Former Name"] },
        { value: "id:venue-two", label: "Same Brand", names: ["Same Brand"], location: "Second Street 2" },
      ],
    }),
  ];
  const snapshots = structuredClone(responses);
  setCase("overview-merge-qa", async ({ cursor }) => {
    const expected = [null, "after-first", "after-empty"][queries.length - 1];
    assert.equal(cursor, expected, "An empty non-terminal page must still advance the cursor.");
    return structuredClone(responses[queries.length - 1]);
  });
  const merged = await loadPublicCalendarOverviewWindow(options);
  assert.equal(merged.error, undefined);
  assert.deepEqual(merged.groups, [
    group({ count: 5, legacyVenueMatchCount: 3 }),
    group({ category: "culture", count: 4, legacyVenueMatchCount: 0 }),
  ]);
  assert.deepEqual(merged.venues, [
    { value: "id:venue-one", label: "Same Brand (First Street 1)", names: ["Same Brand", "Old Name", "Former Name"], location: "First Street 1" },
    { value: "id:venue-two", label: "Same Brand (Second Street 2)", names: ["Same Brand"], location: "Second Street 2" },
  ]);
  assert.equal(resolvePublicEventVenueFilter("Old Name", merged.venues), "id:venue-one");
  assert.equal(resolvePublicEventVenueFilter("Same Brand", merged.venues), "Same Brand");
  assert.deepEqual(responses, snapshots, "The loader must not mutate backend response fixtures.");
  assert.equal(queries.length, 3);

  let advanceClock = 10_000;
  Date.now = () => advanceClock;
  let settle;
  const deferred = new Promise((resolve) => { settle = resolve; });
  setCase("overview-coalesce-qa", async () => deferred);
  const first = loadPublicCalendarOverviewWindow({ ...options, q: " jazz ", venue: " id:venue-one " });
  const second = loadPublicCalendarOverviewWindow({ ...options, q: "jazz", venue: "id:venue-one" });
  assert.equal(queries.length, 1, "Concurrent normalized keys must share one pending read.");
  advanceClock += 120_000;
  const third = loadPublicCalendarOverviewWindow({ ...options, q: "jazz", venue: "id:venue-one" });
  assert.equal(queries.length, 1, "A slow in-flight request must not expire and duplicate its work.");
  settle(page({ page: [group()] }));
  const settled = await Promise.all([first, second, third]);
  for (const result of settled) assert.deepEqual(result.groups, [group()]);
  assert.equal(queries[0].args.q, "jazz");
  assert.equal(queries[0].args.venue, "id:venue-one");
  advanceClock += 59_999;
  await loadPublicCalendarOverviewWindow({ ...options, q: "jazz", venue: "id:venue-one" });
  assert.equal(queries.length, 1, "The success TTL must start when the pending request finishes.");
  advanceClock += 1;
  await loadPublicCalendarOverviewWindow({ ...options, q: "jazz", venue: "id:venue-one" });
  assert.equal(queries.length, 2, "Expired successful counters must be refreshed.");
  Date.now = originalDateNow;

  let attempts = 0;
  setCase("overview-retry-qa", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Transient summary query failure");
    return page({ page: [group()] });
  });
  const failed = await Promise.all([
    loadPublicCalendarOverviewWindow(options),
    loadPublicCalendarOverviewWindow(options),
  ]);
  for (const result of failed) {
    assert.equal(result.error, "Transient summary query failure");
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.venues, []);
  }
  assert.equal(attempts, 1, "Concurrent failures should also share their in-flight read.");
  const retried = await loadPublicCalendarOverviewWindow(options);
  assert.equal(retried.error, undefined);
  assert.equal(attempts, 2, "Failures must not poison the cache or trigger detailed-event fallback.");

  setCase("overview-key-qa", async () => page());
  const filtered = { ...options, q: "jazz", venue: "id:venue-one" };
  await loadPublicCalendarOverviewWindow(filtered);
  await loadPublicCalendarOverviewWindow({ ...filtered, q: " jazz ", venue: " id:venue-one " });
  assert.equal(queries.length, 1);
  await loadPublicCalendarOverviewWindow({ ...filtered, q: "rock" });
  await loadPublicCalendarOverviewWindow({ ...filtered, venue: "id:venue-two" });
  await loadPublicCalendarOverviewWindow({ ...filtered, fromDate: "2026-10-02" });
  await loadPublicCalendarOverviewWindow({ ...filtered, beforeDate: "2026-11-02" });
  assert.equal(queries.length, 5, "Query, venue, and both date boundaries must participate in the cache key.");
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://overview-other-backend-qa.convex.cloud";
  await loadPublicCalendarOverviewWindow(filtered);
  assert.equal(queries.length, 6, "Counter caches must remain isolated by backend URL.");
  assert.deepEqual(queries.slice(0, 5).map(({ args }) => [args.q, args.venue]), [
    ["jazz", "id:venue-one"], ["rock", "id:venue-one"],
    ["jazz", "id:venue-two"], ["jazz", "id:venue-one"], ["jazz", "id:venue-one"],
  ]);

  setCase("overview-stalled-qa", async () => page({ isDone: false, continueCursor: "stalled" }));
  const stalled = await loadPublicCalendarOverviewWindow(options);
  assert.match(stalled.error, /pagination did not advance/);
  assert.equal(queries.length, 2);
  setCase("overview-empty-cursor-qa", async () => page({ isDone: false, continueCursor: "" }));
  const emptyCursor = await loadPublicCalendarOverviewWindow(options);
  assert.match(emptyCursor.error, /pagination did not advance/);
  assert.equal(queries.length, 1);
  setCase("overview-cycle-qa", async () => page({
    isDone: false, continueCursor: queries.length % 2 === 1 ? "one" : "two",
  }));
  const cycle = await loadPublicCalendarOverviewWindow(options);
  assert.match(cycle.error, /pagination did not advance/);
  assert.equal(queries.length, 3, "A longer cursor cycle must terminate without partial results.");
  assert.deepEqual(cycle.groups, []);

  setCase("overview-date-qa", async () => page());
  for (const boundaries of [
    { fromDate: "2026-02-30", beforeDate: "2026-03-31" },
    { fromDate: "2026-10-1", beforeDate: "2026-11-01" },
    { fromDate: "2026-10-01", beforeDate: "not-a-date" },
    { fromDate: "2026-10-01", beforeDate: "2026-10-01" },
    { fromDate: "2026-11-01", beforeDate: "2026-10-01" },
  ]) {
    const invalid = await loadPublicCalendarOverviewWindow(boundaries);
    assert.match(invalid.error, /valid date boundaries/);
    assert.deepEqual(invalid.groups, []);
    assert.deepEqual(invalid.venues, []);
  }
  assert.equal(queries.length, 0, "Malformed or reversed dates must fail before a backend read.");
  await loadPublicCalendarOverviewWindow({ fromDate: "2026-01-01", beforeDate: "2026-04-01" });
  assert.deepEqual(queries.map(({ args }) => [args.fromDate, args.beforeDate, args.cursor]), [
    ["2026-01-01", "2026-02-15", null],
    ["2026-02-15", "2026-04-01", null],
  ], "Long overview ranges must use contiguous server-safe 45-day windows.");
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  const unconfigured = await loadPublicCalendarOverviewWindow(options);
  assert.match(unconfigured.error, /not configured/);
  assert.equal(queries.length, 2, "Missing backend configuration must not perform a read.");

  console.log("Calendar overview loader QA passed: aggregation, aliases, pagination, cache isolation, coalescing, failure retries, and bounded windows.");
} finally {
  ConvexHttpClient.prototype.query = originalQuery;
  ConvexHttpClient.prototype.action = originalAction;
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
}
