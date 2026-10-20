// Run against `next start`, never `next dev`. Playwright is a measurement-only
// dependency: pass its installed index.mjs with --playwright=/absolute/path.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const { chromium } = await import(args.playwright ? pathToFileURL(args.playwright).href : "playwright");
const origin = args.origin || "http://localhost:3100";
const repetitions = Number(args.runs || 3);
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--runs must be a positive integer.");
const output = resolve(args.output || ".seo-cache/performance/browser.json");
const routes = args.routes ? args.routes.split(",") : ["/", "/discover", "/map", "/venues/directory"];
const profiles = {
  desktop: { viewport: { width: 1440, height: 900 }, mobile: false, cpu: 1, latency: 20, download: 1_250_000, upload: 625_000 },
  mobile: { viewport: { width: 390, height: 844 }, mobile: true, cpu: 4, latency: 150, download: 200_000, upload: 93_750 },
};
const browser = await chromium.launch({ headless: true, ...(args.executable ? { executablePath: args.executable } : {}) });
const results = [];
try {
  for (const [profile, settings] of Object.entries(profiles)) {
    for (const route of routes) {
      for (let run = 1; run <= repetitions; run++) {
        const context = await browser.newContext({ viewport: settings.viewport, isMobile: settings.mobile, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.addInitScript(() => {
          window.__perf = { lcp: 0, cls: 0, longTasks: [], events: [] };
          let shiftSession = { start: 0, last: 0, value: 0 };
          for (const [type, callback] of [
            ["largest-contentful-paint", (e) => { window.__perf.lcp = e.startTime; }],
            ["layout-shift", (e) => {
              if (e.hadRecentInput) return;
              if (e.startTime - shiftSession.last >= 1000 || e.startTime - shiftSession.start >= 5000) {
                shiftSession = { start: e.startTime, last: e.startTime, value: e.value };
              } else {
                shiftSession.last = e.startTime;
                shiftSession.value += e.value;
              }
              window.__perf.cls = Math.max(window.__perf.cls, shiftSession.value);
            }],
            ["longtask", (e) => { window.__perf.longTasks.push(e.duration); }],
            ["event", (e) => { if (e.interactionId) window.__perf.events.push({ name: e.name, duration: e.duration }); }],
          ]) {
            try { new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({ type, buffered: true, durationThreshold: 16 }); } catch {}
          }
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: settings.latency, downloadThroughput: settings.download, uploadThroughput: settings.upload });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: settings.cpu });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        for (const visit of ["first", "repeat"]) {
          const transfers = [];
          const responses = new Map();
          const onResponse = (e) => responses.set(e.requestId, { url: e.response.url, type: e.type, cached: Boolean(e.response.fromDiskCache || e.response.fromServiceWorker), status: e.response.status });
          const onFinished = (e) => transfers.push({ ...responses.get(e.requestId), bytes: e.encodedDataLength });
          cdp.on("Network.responseReceived", onResponse);
          cdp.on("Network.loadingFinished", onFinished);
          const started = Date.now();
          const response = await page.goto(`${origin}${route}`, { waitUntil: "load", timeout: 90_000 });
          // Fixed observation window; avoids waiting indefinitely for auth/maps.
          await page.waitForTimeout(1800);
          const metrics = await page.evaluate(() => {
            const nav = performance.getEntriesByType("navigation")[0];
            const resources = performance.getEntriesByType("resource");
            return {
              ttfb: nav.responseStart - nav.requestStart,
              fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
              ...window.__perf,
              domContentLoaded: nav.domContentLoadedEventEnd,
              load: nav.loadEventEnd,
              htmlDecodedBytes: nav.decodedBodySize,
              resourceCount: resources.length,
              eventCount: document.querySelectorAll("[data-calendar-event-id]").length,
              images: [...document.images].map((img) => ({ src: img.currentSrc, naturalWidth: img.naturalWidth, displayedWidth: img.clientWidth, complete: img.complete })),
            };
          });
          cdp.off("Network.responseReceived", onResponse);
          cdp.off("Network.loadingFinished", onFinished);
          const result = { profile, route, run, visit, status: response.status(), elapsed: Date.now() - started, ...metrics, transferredBytes: transfers.reduce((n, r) => n + r.bytes, 0), jsBytes: transfers.filter((r) => r.type === "Script").reduce((n, r) => n + r.bytes, 0), imageBytes: transfers.filter((r) => r.type === "Image").reduce((n, r) => n + r.bytes, 0), transfers, errors: [...errors] };
          results.push(result);
          console.log(JSON.stringify({ profile, route, run, visit, ttfb: Math.round(metrics.ttfb), lcp: Math.round(metrics.lcp), bytes: result.transferredBytes, status: result.status }));
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), origin, profiles, repetitions, observationMs: 1800, results }, null, 2));
}
