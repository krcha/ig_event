// Read-only smoke/timing harness for `next start`. No authenticated storage is
// loaded. Pass --playwright=/absolute/index.mjs and optionally --executable=... .
// These are automated action-to-visible-result timings, not field INP.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const repetitions = Number(args.runs || 3);
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--runs must be a positive integer.");
const origin = args.origin || "http://localhost:3100";
const output = resolve(args.output || ".seo-cache/performance/interactions.json");
const flows = (args.flows || "calendar,map,directory,discover").split(",");
const profiles = {
  desktop: { viewport: { width: 1440, height: 900 }, mobile: false, cpu: 1, latency: 20, download: 1_250_000, upload: 625_000 },
  mobile: { viewport: { width: 390, height: 844 }, mobile: true, cpu: 4, latency: 150, download: 200_000, upload: 93_750 },
};
const selectedProfiles = (args.profiles || "desktop,mobile").split(",");
for (const name of selectedProfiles) if (!profiles[name]) throw new Error(`Unknown profile: ${name}`);
const { chromium } = await import(args.playwright ? pathToFileURL(args.playwright).href : "playwright");
const browser = await chromium.launch({ headless: true, ...(args.executable ? { executablePath: args.executable } : {}) });
const results = [];
const errors = [];
const skip = (reason) => ({ skipped: reason });

try {
  for (const profile of selectedProfiles) {
    const settings = profiles[profile];
    for (let run = 1; run <= repetitions; run++) {
      const context = await browser.newContext({ viewport: settings.viewport, isMobile: settings.mobile, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.setDefaultNavigationTimeout(60_000);
      await page.addInitScript(() => {
        for (const name of ["pointerdown", "keydown", "change", "submit"]) {
          window.addEventListener(name, () => {
            try {
              if (!sessionStorage.getItem("eventzeka-performance-input")) {
                sessionStorage.setItem("eventzeka-performance-input", String(performance.timeOrigin + performance.now()));
              }
            } catch { /* Action wall time remains available without storage. */ }
          }, true);
        }
      });
      const requests = [];
      page.on("request", (request) => requests.push({
        url: request.url(),
        document: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        rsc: request.headers().rsc === "1" || new URL(request.url()).searchParams.has("_rsc"),
        api: new URL(request.url()).pathname.startsWith("/api/"),
      }));
      page.on("pageerror", (error) => errors.push({ profile, run, url: page.url(), message: error.message }));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: settings.latency, downloadThroughput: settings.download, uploadThroughput: settings.upload });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: settings.cpu });

      async function visit(path) {
        const response = await page.goto(new URL(path, origin).href, { waitUntil: "load" });
        if (!response?.ok()) throw new Error(`Setup ${path} returned ${response?.status()}.`);
        await page.waitForTimeout(1800);
      }
      async function ready() {
        await page.waitForLoadState("domcontentloaded");
        await page.waitForFunction(() => document.documentElement.dataset.navigationPending !== "true");
      }
      async function painted() {
        return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const resultAt = performance.timeOrigin + performance.now();
          let inputAt = 0;
          try { inputAt = Number(sessionStorage.getItem("eventzeka-performance-input")); } catch {}
          done({ firstInputToResultMs: inputAt ? resultAt - inputAt : null });
        }))));
      }
      async function step(flow, action, perform) {
        const requestStart = requests.length;
        const errorStart = errors.length;
        const from = page.url();
        await page.evaluate(() => { try { sessionStorage.removeItem("eventzeka-performance-input"); } catch {} });
        const started = performance.now();
        let result;
        try {
          const detail = await perform();
          if (detail?.skipped) result = { status: "skipped", reason: detail.skipped, actionToResultMs: null, firstInputToResultMs: null };
          else {
            const timing = await painted();
            result = { status: "passed", actionToResultMs: performance.now() - started, ...timing, ...detail };
            await ready();
          }
        } catch (error) {
          result = { status: "failed", message: error.message, actionToResultMs: null, firstInputToResultMs: null };
        }
        const activity = requests.slice(requestStart);
        if (result.clientOnly && activity.some((request) => request.document || request.rsc)) {
          result = { ...result, status: "failed", message: "A selected-day facet initiated a document or server component navigation." };
        }
        const entry = { profile, run, flow, action, from, to: page.url(), ...result,
          documents: activity.filter((request) => request.document).length,
          rscRequests: activity.filter((request) => request.rsc).length,
          apiRequests: activity.filter((request) => request.api).length,
          pageerrors: errors.slice(errorStart),
        };
        results.push(entry);
        console.log(JSON.stringify(entry));
      }
      async function follow(locator) {
        const href = await locator.getAttribute("href");
        if (!href) throw new Error("Navigation link has no href.");
        const expected = new URL(href, page.url()).href;
        await Promise.all([page.waitForURL(expected, { waitUntil: "domcontentloaded" }), locator.click()]);
        await ready();
      }
      async function queryEquals(key, value) {
        await page.waitForURL((url) => (url.searchParams.get(key) || "") === value, { waitUntil: "domcontentloaded" });
        await ready();
      }
      async function searchInput() {
        const opener = page.locator('[data-calendar-mobile-search-button="true"]:visible').first();
        if (await opener.count()) {
          const details = opener.locator("..");
          if (await details.getAttribute("open") === null) await opener.click();
        }
        return page.locator('input[name="q"][type="search"]:visible').first();
      }
      async function followAdjacentCalendarDay(direction) {
        const date = await page.locator('[data-calendar-week-date="true"]:visible').evaluateAll((links, delta) => {
          const selected = links.findIndex((link) => link.dataset.calendarDateSelected === "true");
          return selected < 0 ? null : links[selected + delta]?.dataset.calendarDate;
        }, direction);
        if (!date) return skip("The selected day has no adjacent day in the visible week.");
        await follow(page.locator(`[data-calendar-week-date="true"][data-calendar-date="${date}"]:visible`));
        await page.locator(`[data-calendar-date="${date}"][data-calendar-date-selected="true"]:visible`).waitFor();
        return { date };
      }
      async function openCalendarFilters() {
        const trigger = page.locator('button[aria-controls="events-extra-filters"]:visible');
        if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
      }

      try {
        if (flows.includes("calendar")) {
          await visit("/en");
          const initialUrl = page.url();
          let nextDate;
          await step("calendar", "next-day", async () => {
            const detail = await followAdjacentCalendarDay(1);
            nextDate = detail.date;
            return detail;
          });
          await step("calendar", "browser-back", async () => {
            if (!nextDate) return skip("No next-day history entry was created.");
            await page.goBack({ waitUntil: "domcontentloaded" });
            await page.waitForURL(initialUrl);
            await ready();
          });
          if (nextDate) await followAdjacentCalendarDay(1);
          await step("calendar", "previous-day", () => followAdjacentCalendarDay(-1));
          await step("calendar", "next-day-return", () => followAdjacentCalendarDay(1));
          const firstEvent = page.locator('[data-calendar-event-id]:visible').first();
          const category = await firstEvent.count() ? (await firstEvent.getAttribute("data-calendar-event-discovery-categories"))?.split(",")[0] : null;
          await step("calendar", "focus-category", async () => {
            if (!category) return skip("No selected-day event is available to verify category filtering.");
            const categoryButton = page.locator(`[data-calendar-kind-toggle="${category}"]`);
            if (!await categoryButton.isVisible()) await page.getByRole("button", { name: "More categories" }).click();
            await categoryButton.click();
            await queryEquals("category", category);
            await page.waitForFunction((kind) => {
              const rows = [...document.querySelectorAll('[data-calendar-event-id]')];
              return rows.length > 0 && rows.every((row) => row.dataset.calendarEventDiscoveryCategories.split(",").includes(kind));
            }, category);
            return { category, clientOnly: true };
          });
          await step("calendar", "filter-genre", async () => {
            const genreButton = page.locator('[data-calendar-genre-filter]:visible').first();
            if (!await genreButton.count()) return skip("The selected category has no confirmed genre.");
            const genre = await genreButton.getAttribute("data-calendar-genre-filter");
            await genreButton.click();
            await queryEquals("genre", genre);
            await page.locator(`[data-calendar-genre-filter="${genre}"][aria-pressed="true"]:visible`).waitFor();
            return { genre, clientOnly: true };
          });
          await step("calendar", "show-all-categories", async () => {
            if (!category) return skip("No category was selected.");
            await page.locator('[data-calendar-kind-toggle="all"]:visible').first().click();
            await queryEquals("category", "");
            await queryEquals("genre", "");
            await page.locator('[data-calendar-kind-toggle="all"][aria-pressed="true"]:visible').waitFor();
            return { clientOnly: true };
          });
          await openCalendarFilters();
          await step("calendar", "filter-start-time", async () => {
            const time = await page.locator('[data-calendar-time-band]:visible').first().getAttribute("data-calendar-time-band", { timeout: 1000 }).catch(() => null);
            if (!time) return skip("No time band is available on the selected day.");
            await page.locator('[data-calendar-time-filter="true"]:visible').selectOption(time);
            await queryEquals("time", time);
            await page.waitForFunction((key) => {
              const bands = [...document.querySelectorAll('[data-calendar-time-band]')];
              return bands.length === 1 && bands[0].dataset.calendarTimeBand === key;
            }, time);
            return { time, clientOnly: true };
          });
          await step("calendar", "clear-start-time", async () => {
            if (!new URL(page.url()).searchParams.has("time")) return skip("No time band was selected.");
            await page.locator('[data-calendar-time-filter="true"]:visible').selectOption("");
            await queryEquals("time", "");
            return { clientOnly: true };
          });
          await step("calendar", "search-submit-no-match", async () => {
            const input = await searchInput();
            await input.fill("__performance_no_match__");
            await input.press("Enter");
            await queryEquals("q", "__performance_no_match__");
            await page.locator('[data-calendar-empty-state="true"]:visible').first().waitFor();
          });
          await step("calendar", "search-clear", async () => {
            const input = await searchInput();
            await input.fill("");
            await input.press("Enter");
            await queryEquals("q", "");
          });
          await openCalendarFilters();
          await step("calendar", "sort-venue", async () => {
            await page.locator('select[name="sort"]:visible').first().selectOption("venue");
            await queryEquals("sort", "venue");
          });
          const venue = page.locator('select[name="venue"]:visible').first();
          const venueValue = await venue.count() ? await venue.locator('option:not([value=""])').first().getAttribute("value") : null;
          await step("calendar", "filter-venue", async () => {
            if (!venueValue) return skip(settings.mobile ? "The mobile UI has no venue select." : "No venue option is available.");
            await page.locator('select[name="venue"]:visible').first().selectOption(venueValue);
            await queryEquals("venue", venueValue);
          });
          await step("calendar", "clear-venue", async () => {
            if (!venueValue) return skip("No venue filter was selected.");
            await page.locator('select[name="venue"]:visible').first().selectOption("");
            await queryEquals("venue", "");
          });
          for (const active of [true, false]) await step("calendar", active ? "open-now-on" : "open-now-off", async () => {
            await page.locator('[data-calendar-open-now="true"]:visible').first().click();
            await queryEquals("open", active ? "now" : "");
            await page.locator(`[data-calendar-open-now-active="${active}"]:visible`).first().waitFor();
          });
          let visitedEvent = false;
          await step("calendar", "event-detail", async () => {
            const preview = page.locator('[data-calendar-event-preview-toggle]:visible').first();
            if (!await preview.count()) return skip("No selected-day event is available for a detail visit.");
            await preview.click();
            const event = page.locator('[data-calendar-event-link="true"]:visible').first();
            await event.waitFor();
            await follow(event);
            await page.getByText("Event details", { exact: true }).waitFor();
            visitedEvent = true;
          });
          await step("calendar", "event-detail-back", async () => {
            if (!visitedEvent) return skip("The event detail step had no event.");
            await follow(page.getByRole("link", { name: "Back", exact: true }).first());
            await page.locator('[data-calendar-scroll-region="selected-day-agenda"]:visible').first().waitFor();
          });
        }
        if (flows.includes("map")) {
          await visit("/map");
          const candidate = await page.locator('nav[aria-label="Event days"] a:not([aria-current])').evaluateAll((links) => {
            const withEvents = links.find((link) => /, [1-9]\d* events?/.test(link.getAttribute("aria-label") || ""));
            return (withEvents || links[0])?.getAttribute("href");
          });
          await step("map", "select-day", async () => {
            if (!candidate) return skip("No alternate map day is available.");
            const date = new URL(candidate, page.url()).searchParams.get("date");
            if (settings.mobile) {
              await page.locator('#event-map-mobile-date').fill(date);
              await queryEquals("date", date);
            } else await follow(page.locator(`nav[aria-label="Event days"] a[href="${candidate}"]`));
          });
          await step("map", "marker-popup-or-lineup", async () => {
            const pins = page.locator('.event-map-pin[role="button"]');
            if (!await pins.count()) return skip("No mapped events are available for this day.");
            const marker = pins.first();
            const popup = await marker.getAttribute("aria-haspopup") === "dialog";
            await marker.focus();
            await marker.press("Enter");
            if (popup) await page.locator('.leaflet-popup [role="dialog"]').waitFor();
            else await page.locator('.event-map-pin[aria-pressed="true"]').waitFor();
            return { input: "keyboard", result: popup ? "popup" : "selected-lineup" };
          });
        }
        if (flows.includes("directory")) {
          await visit("/venues/directory");
          await step("directory", "next-page", async () => {
            const next = page.locator('nav[aria-label="Venue directory pages"] a[rel="next"]');
            if (!await next.count()) return skip("The directory has only one page.");
            await follow(next);
          });
          const title = await page.locator('main article h2').first().textContent().catch(() => null);
          await step("directory", "search-venue", async () => {
            if (!title?.trim()) return skip("The directory has no venue to search for.");
            await page.getByPlaceholder("Search venues").fill(title.trim());
            await page.getByRole("button", { name: "Filter", exact: true }).click();
            await queryEquals("q", title.trim());
            await page.getByRole("heading", { name: title.trim(), exact: true }).first().waitFor();
          });
        }
        if (flows.includes("discover")) {
          await visit("/discover");
          await step("discover", "read-more", async () => {
            const button = page.locator('[data-discover-post] button[aria-expanded="false"]').first();
            if (!await button.count()) return skip("No truncated caption is available.");
            await button.click();
            await page.locator('[data-discover-post] button[aria-expanded="true"]').first().waitFor();
          });
          await step("discover", "append-posts", async () => {
            const sentinel = page.locator('[data-discover-pagination="infinite"]');
            if (!await sentinel.count()) return skip("No additional feed page is available.");
            const before = await page.locator('[data-discover-post="true"]').count();
            await sentinel.scrollIntoViewIfNeeded();
            await page.waitForFunction((count) => document.querySelectorAll('[data-discover-post="true"]').length > count || !document.querySelector('[data-discover-pagination="infinite"]'), before);
            const after = await page.locator('[data-discover-post="true"]').count();
            if (after <= before) return skip("The feed reached its end without additional posts.");
            return { input: "scroll", appendedPosts: after - before };
          });
        }
      } catch (error) {
        results.push({ profile, run, action: "flow-setup", status: "failed", message: error.message, url: page.url() });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), origin, repetitions, profiles, flows,
    methodology: "Fresh anonymous context per run; production build; 1800ms setup observation. Action-to-result includes automation overhead and two animation frames. First-input-to-result uses browser input time when available. These timings are not INP. Request counts include background requests until navigation feedback clears; skipped steps are data/UI dependent.", results, errors }, null, 2));
}
if (results.some((result) => result.status === "failed") || errors.length) process.exitCode = 1;
