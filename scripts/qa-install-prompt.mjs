import assert from "node:assert/strict";
import {
  getInstallDayKey,
  isInstallPromptRoute,
  shouldShowInstallPrompt,
} from "../lib/install/prompt-policy.ts";

// The daily cap follows Belgrade midnight, regardless of the visitor's timezone.
const originalTimeZone = process.env.TZ;
try {
  process.env.TZ = "America/Los_Angeles";
  for (const [instant, expected] of [
    ["2026-11-06T22:59:59.999Z", "2026-11-06"],
    ["2026-11-06T23:00:00.000Z", "2026-11-07"],
    ["2026-06-06T21:59:59.999Z", "2026-06-06"],
    ["2026-06-06T22:00:00.000Z", "2026-06-07"],
    ["2026-11-06T00:30:00+01:00", "2026-11-06"],
    ["2026-03-29T00:30:00Z", "2026-03-29"],
    ["2026-03-29T01:30:00Z", "2026-03-29"],
    ["2026-10-25T00:30:00Z", "2026-10-25"],
    ["2026-10-25T01:30:00Z", "2026-10-25"],
    ["2026-12-31T23:00:00Z", "2027-01-01"],
    ["2028-02-28T23:00:00Z", "2028-02-29"],
  ]) {
    assert.equal(getInstallDayKey(new Date(instant)), expected, instant);
  }
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}

const firstVisit = {
  entryDay: "2026-11-06",
  currentDay: "2026-11-06",
  lastShownDay: null,
  activeMs: 10_000,
  hasBrowsed: true,
  isVisible: true,
  isBlocked: false,
  isStandalone: false,
  hasShown: false,
  pathname: "/",
};
const decide = changes => shouldShowInstallPrompt({ ...firstVisit, ...changes });

assert.equal(decide({ activeMs: 9_999 }), false, "The prompt must wait for ten visible seconds.");
assert.equal(decide({ activeMs: 10_000 }), true, "The first eligible visit can display at ten seconds.");
assert.equal(decide({ activeMs: 32_000 }), true, "Delayed hydration must not miss the display threshold.");
for (const activeMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
  assert.equal(decide({ activeMs }), false, "Invalid or negative elapsed time cannot trigger a display.");
}

// Recording the actual first display suppresses later visits, not just dismissal.
assert.equal(decide({ lastShownDay: firstVisit.entryDay }), false, "Same-day reload/new-tab visits remain suppressed.");
assert.equal(decide({ hasShown: true, lastShownDay: null }), false, "In-memory suppression survives storage failure in this visit.");
assert.equal(decide({ lastShownDay: "2026-11-05" }), true, "Yesterday's marker does not suppress today's first visit.");
const tomorrowVisit = {
  ...firstVisit,
  entryDay: "2026-11-07",
  currentDay: "2026-11-07",
  lastShownDay: "2026-11-06",
};
assert.equal(shouldShowInstallPrompt(tomorrowVisit), true, "A fresh visit on the next calendar day becomes eligible.");
assert.equal(decide({ currentDay: "2026-11-07" }), false, "An old tab must not reopen itself at midnight.");
assert.equal(decide({ currentDay: "2026-11-07", lastShownDay: "2026-11-07" }), false, "An old tab must not overwrite a newer day's marker.");
assert.equal(decide({ currentDay: "2026-11-07", lastShownDay: null, activeMs: 60_000 }), false, "Even an unshown old visit needs a new visit after midnight.");

for (const pathname of ["/", "/events", "/calendar", "/discover"]) {
  assert.equal(isInstallPromptRoute(pathname), true, pathname);
  assert.equal(decide({ pathname }), true, `Public browsing is eligible on ${pathname}.`);
}
for (const pathname of [null, "", "/admin", "/admin/scraper", "/sign-in", "/sign-up", "/install", "/map", "/saved", "/you", "/events/example", "/venues/example", "/discovery"]) {
  assert.equal(isInstallPromptRoute(pathname), false, String(pathname));
  assert.equal(decide({ pathname }), false, `The popup must not interrupt ${pathname}.`);
}

for (const changes of [
  { hasBrowsed: false },
  { isVisible: false },
  { isBlocked: true },
  { isStandalone: true },
  { hasShown: true },
]) {
  assert.equal(decide(changes), false, JSON.stringify(changes));
}
assert.equal(decide({ isBlocked: true, activeMs: 30_000 }), false, "A dialog or focused input delays display even after the timer completes.");
assert.equal(decide({ isBlocked: false, activeMs: 30_000 }), true, "Display can resume when the interaction blocker clears.");

console.log("Install prompt QA passed: Belgrade calendar-day and DST boundaries, daily visits, ten-second gating, midnight safety, public route scope, and interaction suppression.");
