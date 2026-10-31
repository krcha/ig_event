import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import { buildAnalyticsReport } from "../lib/analytics/aggregate.ts";
import { getAnalyticsOwnerId, isAnalyticsOwner } from "../lib/analytics/access.ts";
import { bucketKey, cleanPath, getAnalyticsRange, localDay, localMidnight } from "../lib/analytics/model.ts";
import { cleanup, readPage, record, report } from "../convex/analytics.ts";

const require = createRequire(import.meta.url);
const savedEnv = { ...process.env };
const originalNow = Date.now;
const now = Date.parse("2026-10-31T12:00:00Z");
Date.now = () => now;
process.env.ADMIN_CLERK_USER_IDS = "user_owner,user_other";
process.env.ANALYTICS_OWNER_CLERK_USER_ID = "user_owner";
process.env.CRON_SECRET = "analytics-qa-service-value";
delete process.env.VERCEL;
delete process.env.ANALYTICS_COUNTRY_HEADER;

function compile(file, mocks, extra = "") {
  const source = ts.transpileModule(readFileSync(file, "utf8") + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", source)((name) => mocks[name] ?? require(name), module.exports, module);
  return module.exports;
}

function database() {
  const rows = [];
  return {
    rows,
    db: {
      query(table) {
        assert.equal(table, "analyticsEvents");
        const filters = [];
        const index = {
          eq: (key, value) => { filters.push((row) => row[key] === value); return index; },
          gte: (key, value) => { filters.push((row) => row[key] >= value); return index; },
          lt: (key, value) => { filters.push((row) => row[key] < value); return index; },
        };
        const selected = () => rows.filter((row) => filters.every((filter) => filter(row))).sort((a, b) => a.at - b.at);
        const query = {
          withIndex(_name, build) { build(index); return query; },
          first: async () => selected()[0] ?? null,
          take: async (limit) => selected().slice(0, limit),
          paginate: async ({ cursor, numItems }) => {
            const from = Number(cursor ?? 0);
            const values = selected();
            return { page: values.slice(from, from + numItems), continueCursor: String(from + numItems), isDone: from + numItems >= values.length };
          },
        };
        return query;
      },
      async insert(_table, row) { rows.push({ ...row, _id: `event-${rows.length}`, _creationTime: now }); },
      async delete(id) { const index = rows.findIndex((row) => row._id === id); if (index >= 0) rows.splice(index, 1); },
    },
  };
}

const base = {
  eventId: "event-a", visitorId: "visitor-a", sessionId: "session-a", kind: "pageview", path: "/calendar", target: "",
  source: "Instagram", medium: "social", campaign: "weekend", country: "RS", device: "Mobile", browser: "Safari", os: "iOS", at: now - 60_000,
};

try {
  assert.equal(getAnalyticsOwnerId({ ADMIN_CLERK_USER_IDS: "one" }), "one");
  assert.equal(getAnalyticsOwnerId({ ADMIN_CLERK_USER_IDS: "one,two" }), null);
  assert.equal(getAnalyticsOwnerId({ ADMIN_CLERK_USER_IDS: "one", ANALYTICS_OWNER_CLERK_USER_ID: "two" }), null);
  assert.equal(isAnalyticsOwner("user_other", process.env), false);
  assert.equal(isAnalyticsOwner("user_owner", process.env), true);
  assert.equal(isAnalyticsOwner(null, process.env), false);
  assert.equal(localDay(Date.parse("2026-10-30T23:30:00Z")), "2026-10-31");
  assert.equal(localMidnight("2026-03-30") - localMidnight("2026-03-29"), 23 * 3_600_000);
  assert.equal(localMidnight("2026-10-26") - localMidnight("2026-10-25"), 25 * 3_600_000);
  assert.notEqual(bucketKey(Date.parse("2026-10-25T00:30:00Z"), "hour"), bucketKey(Date.parse("2026-10-25T01:30:00Z"), "hour"));
  assert.throws(() => getAnalyticsRange("2026-02-30", "2026-03-01", "day", now));
  assert.throws(() => getAnalyticsRange("2026-10-01", "2026-10-31", "hour", now));
  assert.throws(() => getAnalyticsRange("2026-11-01", "2026-11-02", "day", now));
  assert.equal(cleanPath("/calendar?email=private@example.com"), "/calendar");
  assert.equal(cleanPath("//outside.example/events"), null);
  assert.equal(cleanPath("/admin"), null);
  assert.equal(cleanPath("/sign-in"), null);

  const savedGlobals = new Map(["localStorage", "sessionStorage", "document", "location"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const unavailableStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    for (const [key, value] of Object.entries({ localStorage: unavailableStorage, sessionStorage: unavailableStorage, document: { referrer: "https://instagram.com/profile?private=not-stored" }, location: { origin: "https://eventzeka.com" } })) {
      Object.defineProperty(globalThis, key, { value, configurable: true });
    }
    const tracker = compile("components/analytics/visitor-tracker.tsx", {
      "next/navigation": {}, "@/lib/analytics/model": await import("../lib/analytics/model.ts"),
    }, "\nexport { identity as qaIdentity };\n");
    const first = tracker.qaIdentity(new URLSearchParams("utm_medium=social"));
    const second = tracker.qaIdentity(new URLSearchParams("utm_source=internal-navigation"));
    assert.equal(first.visitorId, second.visitorId, "write-blocked storage must retain the in-memory visitor");
    assert.equal(first.sessionId, second.sessionId, "write-blocked storage must retain the in-memory session");
    assert.equal(second.source, "instagram.com", "session entry attribution must survive navigation");
    Date.now = () => now + 31 * 60_000;
    const afterIdle = tracker.qaIdentity(new URLSearchParams("utm_source=newsletter"));
    assert.equal(afterIdle.visitorId, first.visitorId);
    assert.notEqual(afterIdle.sessionId, first.sessionId);
    assert.equal(afterIdle.source, "newsletter");
  } finally {
    Date.now = () => now;
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }

  const events = [base, { ...base, eventId: "b", at: now - 86_400_000 }, { ...base, eventId: "c", kind: "click", target: "instagram.com/eventzeka/" }, { ...base, eventId: "d", visitorId: "visitor-b", sessionId: "session-b", country: "Unknown", source: "Direct" }];
  const month = buildAnalyticsReport(events, "2026-10-01", "2026-10-31", "day", now);
  assert.deepEqual(month.totals, { views: 3, clicks: 1, visitors: 2, sessions: 2, clickers: 1, conversion: 50 });
  assert.equal(month.series.length, 31);
  assert.equal(month.series.reduce((sum, point) => sum + point.views, 0), 3);
  assert.equal(month.countries.find((row) => row.name === "Unknown").views, 1);
  assert.equal(month.sources.every((row) => row.visitors <= row.views), true);
  assert.equal(buildAnalyticsReport([], "2026-10-01", "2026-10-31", "day", now).totals.conversion, 0);
  assert.equal(buildAnalyticsReport(events, "2026-10-01", "2026-10-31", "month", now).series.length, 1);
  const autumn = buildAnalyticsReport([], "2026-10-25", "2026-10-25", "hour", now);
  const spring = buildAnalyticsReport([], "2026-03-29", "2026-03-29", "hour", now);
  assert.equal(autumn.series.length, 25);
  assert.equal(spring.series.length, 23);
  const partialAutumn = getAnalyticsRange("2026-10-25", "2026-10-25", "hour", Date.parse("2026-10-24T22:30:00Z"));
  assert.equal(partialAutumn.previousTo - partialAutumn.previousFrom, 30 * 60_000 + 1);

  const store = database();
  const ctx = { db: store.db };
  await assert.rejects(record._handler(ctx, { event: base, serviceSecret: "wrong" }), /not authorized/);
  await record._handler(ctx, { event: base, serviceSecret: process.env.CRON_SECRET });
  await record._handler(ctx, { event: base, serviceSecret: process.env.CRON_SECRET });
  assert.equal(store.rows.length, 1, "retrying one event must not count it twice");
  await assert.rejects(record._handler(ctx, { event: { ...base, path: "/admin", eventId: "bad" }, serviceSecret: process.env.CRON_SECRET }), /Invalid/);
  await assert.rejects(record._handler(ctx, { event: { ...base, at: now - 120_000, eventId: "old" }, serviceSecret: process.env.CRON_SECRET }), /timestamp/);
  for (let i = 0; i < 65; i++) await record._handler(ctx, { event: { ...base, eventId: `limit-${i}` }, serviceSecret: process.env.CRON_SECRET });
  assert.equal(store.rows.length, 60, "collection must be rate limited per visitor");

  const actionCtx = (subject) => ({
    auth: { getUserIdentity: async () => subject ? { subject } : null },
    runQuery: (_ref, args) => readPage._handler(ctx, args),
  });
  await assert.rejects(report._handler(actionCtx(null), { start: "2026-10-01", end: "2026-10-31", group: "day" }), /Authentication/);
  await assert.rejects(report._handler(actionCtx("user_other"), { start: "2026-10-01", end: "2026-10-31", group: "day" }), /owner/);
  const ownerReport = await report._handler(actionCtx("user_owner"), { start: "2026-10-01", end: "2026-10-31", group: "day" });
  assert.equal(ownerReport.totals.views, 60);
  // Report payload must never expose stored pseudonymous identifiers.
  assert.equal(JSON.stringify(ownerReport).includes("visitor-a"), false);
  const historic = await report._handler(actionCtx("user_owner"), { start: "2026-10-29", end: "2026-10-29", group: "day" });
  assert.equal(historic.totals.views, 0);
  assert.equal(historic.activeVisitors, 1, "live activity remains current for historical periods");

  let apiAccess = { ok: true, userId: "user_owner" };
  let backendCalls = 0;
  const adminApi = compile("app/api/admin/analytics/route.ts", {
    "@/convex/_generated/api": { api: { analytics: { report: "analytics:report" } } },
    "@/lib/auth/admin-api": { requireAdminApiAccess: async () => apiAccess },
    "@/lib/convex/server": { createAuthenticatedConvexHttpClient: async () => ({ action: (_ref, args) => { backendCalls++; return report._handler(actionCtx(apiAccess.userId), args); } }) },
    "@/lib/analytics/access": await import("../lib/analytics/access.ts"),
    "@/lib/analytics/model": await import("../lib/analytics/model.ts"),
  });
  const reportRequest = new NextRequest("https://eventzeka.com/api/admin/analytics?start=2026-10-01&end=2026-10-31&group=day");
  const response = await adminApi.GET(reportRequest);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).totals.views, 60);
  apiAccess = { ok: true, userId: "user_other" };
  assert.equal((await adminApi.GET(reportRequest)).status, 403);
  assert.equal(backendCalls, 1, "another admin must be denied before the backend call");
  apiAccess = { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  assert.equal((await adminApi.GET(reportRequest)).status, 401);
  assert.equal(apiAccess.response.headers.get("cache-control"), "private, no-store");
  apiAccess = { ok: true, userId: "user_owner" };
  assert.equal((await adminApi.GET(new NextRequest("https://eventzeka.com/api/admin/analytics?start=bad&end=bad&group=day"))).status, 400);

  const collected = database();
  let geoReads = 0;
  const geo = compile("lib/analytics/geolocation.ts", {
    "server-only": {},
    "node:fs/promises": { readFile: async () => { geoReads++; return Buffer.from("geo-fixture"); } },
    "mmdb-lib": { Reader: class { get() { return { country_code: "RS" }; } } },
  });
  const forwarded = new Headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.5" });
  assert.equal(geo.getTrustedVisitorIp(forwarded, false), null);
  assert.equal(geo.getTrustedVisitorIp(forwarded, true), "203.0.113.5");
  assert.equal(geo.getTrustedVisitorIp(new Headers({ "x-forwarded-for": "203.0.113.5, invalid" }), true), null);
  assert.equal(await geo.getVisitorCountry(forwarded, { ANALYTICS_COUNTRY_DB_PATH: "/country.mmdb" }), "Unknown");
  assert.equal(geoReads, 0, "untrusted proxy headers must not reach a lookup");
  assert.equal(await geo.getVisitorCountry(forwarded, { ANALYTICS_COUNTRY_DB_PATH: "/country.mmdb", ANALYTICS_TRUST_PROXY: "true" }), "RS");
  assert.equal(await geo.getVisitorCountry(forwarded, { ANALYTICS_COUNTRY_DB_PATH: "/country.mmdb", ANALYTICS_TRUST_PROXY: "true" }), "RS");
  assert.equal(geoReads, 1, "the immutable country database is loaded once");
  const collector = compile("app/api/analytics/route.ts", {
    "@/convex/_generated/api": { api: { analytics: { record: "analytics:record" } } },
    "@/lib/convex/server": {
      requireServiceSecret: () => process.env.CRON_SECRET,
      createConvexHttpClient: () => ({ mutation: (_ref, args) => record._handler({ db: collected.db }, args) }),
    },
    "@/lib/analytics/model": await import("../lib/analytics/model.ts"),
    "@/lib/analytics/geolocation": geo,
  });
  const payload = { eventId: "d26ed1ac-31ee-4c4e-88b0-062db05e3312", visitorId: "d26ed1ac-31ee-4c4e-88b0-062db05e3313", sessionId: "d26ed1ac-31ee-4c4e-88b0-062db05e3314", kind: "pageview", path: "/calendar?token=do-not-store", source: "instagram.com" };
  const request = (body = payload, headers = {}) => new NextRequest("https://eventzeka.com/api/analytics", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://eventzeka.com", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", ...headers }, body: JSON.stringify(body) });
  assert.equal((await collector.POST(request())).status, 204);
  assert.equal(collected.rows.length, 1);
  assert.equal(collected.rows[0].path, "/calendar");
  assert.equal(collected.rows[0].device, "Mobile");
  assert.equal(collected.rows[0].browser, "Mobile Safari");
  assert.equal(collected.rows[0].country, "Unknown");
  assert.notEqual(collected.rows[0].visitorId, payload.visitorId);
  assert.equal((await collector.POST(request(payload, { Origin: "https://attacker.example" }))).status, 403);
  assert.equal((await collector.POST(request(payload, { DNT: "1" }))).status, 204);
  assert.equal((await collector.POST(request(payload, { "Sec-GPC": "1" }))).status, 204);
  assert.equal((await collector.POST(request(payload, { "User-Agent": "Googlebot/2.1" }))).status, 204);
  assert.equal(collected.rows.length, 1, "privacy signals and bots must not be recorded");
  assert.equal((await collector.POST(request({ ...payload, path: "/admin" }))).status, 400);
  assert.equal((await collector.POST(request({ ...payload, visitorId: "bad" }))).status, 400);
  assert.equal((await collector.POST(request({ ...payload, extra: "x".repeat(5000) }))).status, 413);
  await collector.POST(request({ ...payload, eventId: "d26ed1ac-31ee-4c4e-88b0-062db05e3315" }, { "CF-IPCountry": "US" }));
  assert.equal(collected.rows.at(-1).country, "Unknown", "unconfigured client country headers are untrusted");
  process.env.ANALYTICS_COUNTRY_HEADER = "CF-IPCountry";
  await collector.POST(request({ ...payload, eventId: "d26ed1ac-31ee-4c4e-88b0-062db05e3316" }, { "CF-IPCountry": "RS" }));
  assert.equal(collected.rows.at(-1).country, "RS");
  const proxiedRequest = new NextRequest("http://0.0.0.0:3000/api/analytics", {
    method: "POST", headers: { Origin: "https://eventzeka.com", Host: "eventzeka.com", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ ...payload, eventId: "d26ed1ac-31ee-4c4e-88b0-062db05e3317" }),
  });
  assert.equal((await collector.POST(proxiedRequest)).status, 204, "standalone container URLs must accept the same public Host");

  let nextCleanup = false;
  store.rows.push({ ...base, _id: "expired", at: now - 401 * 86_400_000 });
  await cleanup._handler({ db: store.db, scheduler: { runAfter: async () => { nextCleanup = true; } } }, {});
  assert.equal(store.rows.some((row) => row._id === "expired"), false);
  assert.equal(store.rows.length, 60);
  assert.equal(nextCleanup, false);
  for (let i = 0; i < 501; i++) store.rows.push({ ...base, _id: `expired-${i}`, at: now - 401 * 86_400_000 });
  await cleanup._handler({ db: store.db, scheduler: { runAfter: async () => { nextCleanup = true; } } }, {});
  assert.equal(nextCleanup, true, "large cleanup batches must schedule bounded continuation");
  assert.equal(store.rows.length, 61);
} finally {
  Date.now = originalNow;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
console.log("Visitor analytics QA passed: owner isolation, DST, distinct counts, collection-to-report flow, privacy, deduplication, rate limits, trusted countries, and retention.");
