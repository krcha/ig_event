import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { loadPublicCalendarOverviewWindow } from "../lib/events/public-calendar-overview.ts";
import { buildPublicCalendarDateWindows } from "../lib/events/public-calendar-windows.ts";
import { buildPublicCalendarOverviewPage, toPublicCalendarOverviewRow } from "../lib/events/public-calendar-overview-types.ts";
import { resolvePublicEventVenueFilter } from "../lib/events/public-event-venue-filter.ts";

const original = { query: ConvexHttpClient.prototype.query, action: ConvexHttpClient.prototype.action, now: Date.now, fetch: globalThis.fetch,
  url: process.env.NEXT_PUBLIC_CONVEX_URL, privateUrl: process.env.CONVEX_PUBLIC_READ_URL };
const origin = "https://calendar-overview-loader-qa.convex.cloud";
const bounds = { fromDate: "2026-10-01", beforeDate: "2026-11-01" };
const windows = buildPublicCalendarDateWindows(bounds.fromDate, bounds.beforeDate, 7);
const turn = () => new Promise(resolve => setImmediate(resolve));
const load = (options = {}) => loadPublicCalendarOverviewWindow({ ...bounds, ...options });
const calls = [];
const fixtures = [];
let now = 10_000;
let active = 0, peak = 0, waitMs = 0;
let holdFirst;
let releaseFirst;
let currentName = "Darija Popović";
let query;
const empty = { page: [], isDone: true, continueCursor: "" };

function sample(date, p) {
  const shared = { date, venue: "Club", venueId: "one", venueAliases: ["Source Venue", "Stari klub"], venueLocation: "Address A", eventType: "music",
    title: "Night", description: "A live band concert", artists: ["@credited"], performerSearchNames: [currentName] };
  return p === 0
    ? [shared, { ...shared, venueAliases: ["Stari klub"], performerSearchNames: ["Sanja Živković"] }]
    : [{ ...shared, venueId: "two", venueLocation: "Address B", venueAliases: ["Other"], title: "Late programme", artists: ["@guest"], performerSearchNames: ["Sanja Živković"] }];
}
async function monthlyPage({ fromDate, beforeDate, cursor }) {
  const p = cursor === null ? 0 : 1;
  assert.ok(windows.some(w => w.fromDate === fromDate && w.beforeDate === beforeDate));
  assert.equal(cursor, p === 0 ? null : "next-" + fromDate);
  if (holdFirst) { const current = holdFirst; holdFirst = undefined; await current; }
  const events = fromDate === windows[1].fromDate && p === 0 ? [] : sample(fromDate, p);
  fixtures.push(...events);
  return { page: events.map(toPublicCalendarOverviewRow), isDone: p === 1, continueCursor: "next-" + fromDate };
}
function checkParity(result, filters, fixtures) {
  const expected = buildPublicCalendarOverviewPage(fixtures, filters);
  const sort = a => [...a].sort((one, two) => JSON.stringify(one).localeCompare(JSON.stringify(two)));
  assert.deepEqual(sort(result.groups), sort(expected.page));
  assert.deepEqual(result.venues.map(x => [x.value, x.names, x.location]), expected.venues.map(x => [x.value, x.names, x.location]));
  assert.deepEqual(result.venues.map(x => x.label), ["Club (Address A)", "Club (Address B)"]);
}
try {
  delete process.env.CONVEX_PUBLIC_READ_URL;
  process.env.NEXT_PUBLIC_CONVEX_URL = origin;
  Date.now = () => now;
  globalThis.fetch = () => assert.fail("No external calls in loader QA");
  ConvexHttpClient.prototype.action = () => assert.fail("Use the authoritative bounded public projection");
  ConvexHttpClient.prototype.query = async function (ref, args) {
    assert.equal(ref, "events:listPublicCalendarOverviewRowsPaginated");
    assert.deepEqual(Object.keys(args).sort(), ["beforeDate", "cursor", "fromDate"]);
    calls.push(args);
    peak = Math.max(peak, ++active);
    try {
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      return await query(args);
    } finally { active--; }
  };

  query = monthlyPage;
  waitMs = 4;
  holdFirst = new Promise(resolve => { releaseFirst = resolve; });
  const coldStart = performance.now();
  const first = load({q:"Darija Popović"});
  const differentPending = load({q:"Sanja Živković", venue:" Source Venue "});
  await turn();
  assert.equal(calls.length, 1);
  now += 120_000;
  const samePending = load({q:"Darija Popović"});
  releaseFirst();
  const [darija,sanja,same] = await Promise.all([first,differentPending,samePending]);
  const coldMs = performance.now() - coldStart;
  waitMs = 0;
  assert.equal(peak, 1);
  assert.equal(calls.length, 10, "Concurrent searches and a slow in-flight load share one five-window scan");
  const firstFixtures = structuredClone(fixtures);
  checkParity(darija,{q:"Darija Popović"},firstFixtures);
  checkParity(sanja,{q:"Sanja Živković",venue:"Source Venue"},firstFixtures);
  assert.deepEqual(same,darija);
  const warmStart = performance.now();
  const warm = await load({q:"SANJA ZIVKOVIC",venue:"id:two"});
  const warmMs = performance.now() - warmStart;
  checkParity(warm,{q:"SANJA ZIVKOVIC",venue:"id:two"},firstFixtures);
  assert.equal(calls.length,10,"A distinct accent-insensitive query and venue perform zero further RPCs");
  assert.equal(resolvePublicEventVenueFilter("Other",warm.venues),"id:two");
  assert.equal(resolvePublicEventVenueFilter("Club",warm.venues),"Club");
  const miss = await load({q:"Missing name"});
  assert.deepEqual(miss.groups,[]); assert.equal(miss.venues.length,2);
  checkParity(await load({q:"  ",venue:" Source Venue "}),{venue:"Source Venue"},firstFixtures);
  assert.deepEqual(fixtures,firstFixtures,"Aggregation must not mutate source rows");
  console.log(`Simulated month/2 performer searches: first ${coldMs.toFixed(1)}ms, 10 RPCs; warmed second ${warmMs.toFixed(1)}ms, zero RPCs (4ms simulated latency per RPC).`);

  currentName = "New Name"; now += 59_999;
  assert.deepEqual(await load({q:"Darija Popović"}),darija);
  assert.equal(calls.length,10);
  now++;
  const removed = await load({q:"Darija Popović"});
  assert.deepEqual(removed.groups,[]);
  assert.equal(calls.length,20,"A new read after the 60-second TTL must drop withdrawn names");
  assert.ok((await load({q:"New Name"})).groups.length);
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://other.convex.cloud";
  query = () => empty;
  assert.deepEqual(await load(),{groups:[],venues:[]});
  assert.equal(calls.length,25,"Backend origins must stay isolated");

  const day = {fromDate:"2026-01-01",beforeDate:"2026-01-02"};
  const prefix = calls.length;
  query = () => { throw new Error("Authority unavailable"); };
  for (const result of await Promise.all([load(day),load({...day,q:"A"})])) {
    assert.deepEqual(result,{groups:[],venues:[],error:"Authority unavailable"});
  }
  assert.equal(calls.length,prefix+1);
  query = () => empty;
  await load(day); assert.equal(calls.length,prefix+2,"Failures release capacity and retry immediately");
  await load(); assert.equal(calls.length,prefix+2,"Unrelated fresh snapshots must survive failures");
  for (const [i,tokens] of [[],["a","a"],["a","b","a"]].entries()) {
    let read = 0;
    query = () => ({page:[],isDone:false,continueCursor:tokens[read++] ?? ""});
    const invalid = await load({fromDate:`2026-02-0${i+1}`,beforeDate:`2026-02-0${i+2}`});
    assert.match(invalid.error,/pagination did not advance/);
    assert.equal(read,Math.max(1,tokens.length));
    assert.deepEqual(invalid.groups,[]);
  }
  const beforeInvalid=calls.length;
  for(const bounds of [{fromDate:"2026-02-30",beforeDate:"2026-03-30"},{fromDate:"2026-2-1",beforeDate:"2026-03-30"},
    {fromDate:"2026-02-01",beforeDate:"not-a-date"},{fromDate:"2026-02-01",beforeDate:"2026-02-01"},
    {fromDate:"2026-03-02",beforeDate:"2026-02-01"}]) assert.match((await load(bounds)).error,/valid date boundaries/);
  assert.equal(calls.length,beforeInvalid);
  query = () => empty;
  const beforeLong=calls.length;
  const long={fromDate:"2026-01-01",beforeDate:"2026-04-01"};
  await load(long);
  assert.deepEqual(calls.slice(beforeLong),buildPublicCalendarDateWindows(long.fromDate,long.beforeDate,7).map(w=>({...w,cursor:null})));
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  const beforeConfig=calls.length; assert.match((await load()).error,/not configured/); assert.equal(calls.length,beforeConfig);
  process.env.NEXT_PUBLIC_CONVEX_URL="https://lru.convex.cloud";
  for(let i=1;i<=13;i++)await load({fromDate:`2026-03-${String(i).padStart(2,"0")}`,beforeDate:`2026-03-${String(i+1).padStart(2,"0")}`});
  const atCapacity=calls.length;
  await load({fromDate:"2026-03-01",beforeDate:"2026-03-02"});
  assert.equal(calls.length,atCapacity+1,"Evict least-recently-used ranges beyond the bound");
  const big = {date:"2026-04-01", category:"live", title:"a".repeat(800_000), artists:[], venue:"Hall"};
  query = () => ({...empty, page:Array(11).fill(big)});
  const bigRange = {fromDate:"2026-04-01",beforeDate:"2026-04-02"};
  const beforeBig = calls.length;
  for (let i=0;i<2;i++) assert.equal((await load(bigRange)).groups[0].count,11);
  assert.equal(calls.length,beforeBig+2,"Deliver complete results but do not retain snapshots over 8 MiB");
} finally {
  ConvexHttpClient.prototype.query=original.query;ConvexHttpClient.prototype.action=original.action;
  Date.now=original.now;globalThis.fetch=original.fetch;
  for (const [key,value] of [["NEXT_PUBLIC_CONVEX_URL",original.url],["CONVEX_PUBLIC_READ_URL",original.privateUrl]]) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
