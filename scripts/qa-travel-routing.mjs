import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTravelRouteService, handleTravelRouteRequest, parseTravelRouteInput } from "../lib/travel/route-service.ts";

const origin = { latitude: 44.8151234, longitude: 20.4601234 };
const destination = { latitude: 44.816, longitude: 20.461 };
const input = { origin, destination, mode: "foot" };
const geometry = [[20.46012, 44.81512], [20.4606, 44.8152], [20.461, 44.816]];
const upstreamBody = { code: "Ok", routes: [{ distance: 156.7, geometry: { type: "LineString", coordinates: geometry } }] };
const response = () => Response.json(upstreamBody);
const errorStatus = status => error => error.status === status;

for (const value of [null, [], {}, { ...input, mode: "bicycle" }, { ...input, url: "http://169.254.169.254" },
  { ...input, origin: { latitude: "44.815", longitude: 20.46 } },
  { ...input, origin: { latitude: Infinity, longitude: 20.46 } },
  { ...input, origin: { latitude: 0, longitude: 0 } },
  { ...input, destination: { latitude: 45.9, longitude: 20.46 } },
  { ...input, origin: { latitude: 45.6, longitude: 20.46 }, destination: { latitude: 44.1, longitude: 20.46 } }]) {
  assert.throws(() => parseTravelRouteInput(value), errorStatus(400));
}
assert.deepEqual(parseTravelRouteInput(input), input);

let calls = [];
let clock = 1_000;
let resolveFirst;
const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
const service = createTravelRouteService({ now: () => clock, fetcher: async (url, options) => {
  calls.push({ url, options });
  return calls.length === 1 ? firstResponse : response();
} });
const pending = service(input);
const duplicate = service({ ...input, origin: { latitude: 44.81512349, longitude: 20.46012349 } });
assert.equal(calls.length, 1, "rounded duplicate GPS requests must share the inflight route");
await assert.rejects(service({ ...input, mode: "car" }), errorStatus(429));
assert.equal(calls.length, 1, "global profile/visitor budget must fail immediately without queueing");
await assert.rejects(service({ ...input, url: "http://169.254.169.254/latest/meta-data" }), errorStatus(400));
assert.equal(calls.length, 1, "caller-provided URLs must be rejected before fetching");
resolveFirst(response());
assert.deepEqual(await pending, { distance: 156.7, coordinates: geometry });
assert.deepEqual(await duplicate, await pending);
assert.equal(calls[0].url, "https://routing.openstreetmap.de/routed-foot/route/v1/driving/20.46012,44.81512;20.46100,44.81600?overview=full&geometries=geojson&steps=false");
assert.equal(calls[0].options.cache, "no-store");
assert.equal(calls[0].options.redirect, "error", "upstream redirects cannot redirect GPS to another host");
assert.ok(calls[0].options.signal instanceof AbortSignal);
await service(input);
assert.equal(calls.length, 1, "cache hits do not spend the upstream budget");
clock += 1_000;
await service({ ...input, mode: "car" });
assert.equal(new URL(calls[1].url).pathname.split("/")[1], "routed-car");
clock += 300_001;
await service(input);
assert.equal(calls.length, 3, "GPS route cache expires after five minutes");

let lruCalls = 0;
let lruClock = 1_000;
const lru = createTravelRouteService({ now: () => lruClock, fetcher: async () => { lruCalls++; return response(); } });
const shifted = index => ({ ...input, destination: { latitude: 44.816 + index / 10_000, longitude: 20.461 } });
for (let index = 0; index < 128; index++) { await lru(shifted(index)); lruClock += 1_000; }
await lru(shifted(0)); // Refresh the oldest entry before inserting the 129th.
await lru(shifted(128));
lruClock += 1_000;
await lru(shifted(0));
assert.equal(lruCalls, 129, "recent cache entries survive the 128-entry cap");
await lru(shifted(1));
assert.equal(lruCalls, 130, "least recently used coordinates are evicted");

let timeoutSignal;
const timeout = createTravelRouteService({ timeoutMs: 15, fetcher: async (_url, options) => {
  timeoutSignal = options.signal;
  return new Promise(() => {}); // An uncooperative upstream must still meet our deadline.
} });
const started = performance.now();
await assert.rejects(timeout(input), errorStatus(504));
assert.ok(timeoutSignal.aborted);
assert.ok(performance.now() - started < 500, "deadline must bound an unresponsive upstream");

let failures = 0;
let failureClock = 1_000;
const failing = createTravelRouteService({ now: () => failureClock, fetcher: async () => { failures++; throw new Error("private URL and GPS must not escape"); } });
await assert.rejects(failing(input), error => error.status === 502 && !error.message.includes("private"));
await assert.rejects(failing(input), errorStatus(429));
failureClock += 1_000;
await assert.rejects(failing(input), errorStatus(502));
assert.equal(failures, 2, "failed inflight work must clear and must not retry in the background");

for (const body of [{ code: "NoRoute", routes: [] }, { code: "Ok", routes: [{ distance: -1, geometry: { type: "LineString", coordinates: geometry } }] },
  { code: "Ok", routes: [{ distance: 100, geometry: { type: "LineString", coordinates: [[20, 44], [NaN, 44]] } }] }]) {
  const invalid = createTravelRouteService({ fetcher: async () => Response.json(body) });
  await assert.rejects(invalid(input), errorStatus(502));
}
const throttled = createTravelRouteService({ fetcher: async () => new Response(null, { status: 429 }) });
await assert.rejects(throttled(input), error => error.status === 429 && error.retryAfter === 5);

function request(body = JSON.stringify(input), headers = {}, url = "https://eventzeka.com/api/travel/route") {
  return new Request(url, { method: "POST", headers: {
    origin: "https://eventzeka.com", "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers,
  }, body });
}
let boundaryCalls = 0;
const fakeService = async value => { boundaryCalls++; parseTravelRouteInput(value); return { distance: 156.7, coordinates: geometry }; };
for (const [req, status] of [
  [request(undefined, { origin: "https://evil.example" }), 403],
  [request(undefined, { origin: "null" }), 403],
  [request(undefined, { "sec-fetch-site": "cross-site" }), 403],
  [request(undefined, { "content-type": "text/plain" }), 415],
  [request(undefined, { "content-length": "2049" }), 413],
  [request(" ".repeat(2049)), 413],
  [request("{not json"), 400],
]) {
  const result = await handleTravelRouteRequest(req, fakeService);
  assert.equal(result.status, status);
  assert.equal(result.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(Object.keys(await result.json()), ["error"]);
}
assert.equal(boundaryCalls, 0, "rejected bodies/origins must never contact the route service");
const ok = await handleTravelRouteRequest(request(), fakeService);
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), { distance: 156.7, coordinates: geometry });
assert.equal(ok.headers.get("cache-control"), "private, no-store, max-age=0");
const busy = await handleTravelRouteRequest(request(), service);
assert.equal(busy.status, 200, "cached routes are available even when fresh upstream work is busy");
const freshBusy = await handleTravelRouteRequest(request(JSON.stringify({ ...input, destination: { latitude: 44.817, longitude: 20.461 } })), service);
assert.equal(freshBusy.status, 429);
assert.equal(freshBusy.headers.get("retry-after"), "1");
assert.equal(freshBusy.headers.get("cache-control"), "private, no-store, max-age=0");
const rejected = await handleTravelRouteRequest(request(), async () => { throw Object.assign(new Error("private GPS")); });
assert.equal(rejected.status, 502);
assert.ok(!(await rejected.text()).includes("private GPS"));
const proxyHost = await handleTravelRouteRequest(request(undefined, { host: "eventzeka.com" }, "http://internal-container:3000/api/travel/route"), fakeService);
assert.equal(proxyHost.status, 200, "preserved public Host works behind the existing ingress");

const source = await readFile(new URL("../lib/travel/route-service.ts", import.meta.url), "utf8");
assert.ok(!/console\.|unstable_cache|localStorage|redis|convex/i.test(source), "GPS routing must not log or persist visitor coordinates");
console.log("Travel routing QA passed: fixed-host street geometry, local bounds, same-origin/stream limits, private responses, rounded inflight dedupe, TTL/LRU, global request budget, deadline and safe failures.");
