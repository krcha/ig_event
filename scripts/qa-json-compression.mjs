import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { getCalendarDateKeyInTimeZone, getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";
import { publicJsonResponse } from "../lib/http/compressed-json.ts";

const calendarDate = getCalendarDateKeyInTimeZone();
const discoverDate = getNightlifeDefaultDateKey();
const id = index => String(index + 1).padStart(32, "a");
const venues = Array.from({ length: 20 }, (_, i) => ({
  _id: id(i), name: `QA public venue ${i}`, location: "Beograd", instagramHandle: `public_${i}`, latitude: 44.81, longitude: 20.46,
}));
const events = Array.from({ length: 8 }, (_, i) => ({
  _id: id(i), title: `Public concert ${i}`, description: "Confirmed programme. ".repeat(20),
  status: "approved", date: discoverDate, eventType: "live music", venue: "QA club", artists: [], createdAt: 1, updatedAt: 1,
}));
const page = rows => ({ page: rows, isDone: true, continueCursor: "", scanLimitReached: false, rawPageCount: 1 });
const revision = createHash("sha256").update(events.map(event => event._id + "\n").join("")).digest("hex");

function queryResult(path, args) {
  switch (path) {
    case "venues:listPublicCompassVenues": return venues;
    case "events:listPublicRecommendationWindowPaginated":
      return page(args.fromDate <= calendarDate && calendarDate < args.beforeDate ? events.map(event => ({ ...event, date: calendarDate, venueId: venues[0]._id,
        eventTaxonomy: { primaryCategory: "live", categories: ["live"], genres: ["rock"], formats: ["concert"] }, genreEstimated: false })) : []);
    case "events:listPublicCalendarEventsWindowPaginated": return page(events);
    case "events:listPublicCalendarOverviewRowsPaginated":
      return page(venues.map(venue => ({ date: args.fromDate, category: "live", title: "Concert", artists: [], venueId: venue._id, venue: venue.name })));
    default: throw new Error(`Unexpected Convex fixture request: ${path}`);
  }
}

const fixture = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.ok(["/api/query", "/api/action"].includes(req.url));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { path, args } = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "success", value: queryResult(path, args[0]) }));
  } catch (error) { res.writeHead(500).end(String(error)); }
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
const rpcPort = await listen(fixture);
const reservation = createServer();
const port = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  env: { ...process.env, NODE_ENV: "production", CONVEX_PUBLIC_READ_URL: `http://127.0.0.1:${rpcPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { serverOutput = (serverOutput + chunk).slice(-2000); });

function wire(path, accept) {
  return new Promise((resolve, reject) => {
    const req = get(origin + path, { headers: { "Accept-Encoding": accept }, signal: AbortSignal.timeout(10_000) }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}
function decodeOnce({ bytes, headers }) {
  const codec = headers["content-encoding"] ?? "identity";
  const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync, identity: buffer => buffer }[codec];
  assert.ok(decode, `Unrecognized Content-Encoding: ${codec}`);
  return JSON.parse(decode(bytes).toString("utf8"));
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try { if ((await wire("/api/health", "identity")).status === 200) { ready = true; break; } } catch { /* starting */ }
    await delay(100);
  }
  assert.ok(ready, `Built Next server did not start: ${serverOutput}`);
  const routes = [
    ["/api/travel/places", "places", 20],
    ["/api/travel/places?view=programmes", "programmes", 1],
    [`/api/calendar/overview?month=${calendarDate.slice(0, 7)}&weekStart=${calendarDate.slice(0, 7)}-10`, "venues", 20],
    [`/api/discover/posts?date=${discoverDate}&after=${id(0)}&revision=${revision}`, "events", events.length - 1],
  ];
  for (const [path, key, count] of routes) {
    let expected;
    for (const accept of ["identity", "br", "gzip", "gzip, br"]) {
      const response = await wire(path, accept);
      assert.equal(response.status, 200, path);
      assert.match(response.headers["cache-control"], /no-store/);
      assert.match(response.headers.vary, /accept-encoding/i);
      assert.match(response.headers["content-type"], /application\/json/);
      if (accept === "identity") assert.equal(response.headers["content-encoding"], undefined);
      const data = decodeOnce(response);
      assert.equal(data[key].length, count, path);
      if ("generatedAt" in data) { assert.equal(typeof data.generatedAt, "number"); delete data.generatedAt; }
      if (expected) assert.deepEqual(data, expected);
      else expected = data;
    }
    for (const accept of ["*;q=0", "identity;q=0,gzip"]) {
      const refused = await wire(path, accept);
      assert.equal(refused.status, 406);
      assert.equal(refused.bytes.length, 0);
      assert.match(refused.headers.vary, /accept-encoding/i);
    }
  }

  const init = { headers: { Vary: "Origin", "Cache-Control": "private, no-store" } };
  const payload = { value: "plain JSON" };
  for (const accept of ["br", "gzip", "deflate", "br;q=0,*;q=0.5", "gzip;q=NaN", "identity;q=1,gzip;q=0.2"]) {
    const response = publicJsonResponse(payload, new Headers({ "Accept-Encoding": accept }), init);
    assert.equal(response.headers.get("vary"), "Origin, Accept-Encoding");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.deepEqual(await response.json(), payload);
  }
  assert.equal(publicJsonResponse(payload, new Headers({ "Accept-Encoding": "br,identity;q=0" })).status, 406);
  console.log("Public JSON transport QA passed. Both compass views, Discover and calendar decoded after one HTTP decoding step in the built Next server.");
} finally {
  if (child.exitCode === null) {
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await closed;
    clearTimeout(deadline);
  }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
