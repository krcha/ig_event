import assert from "node:assert/strict";
import process from "node:process";
import { mapGoogleOpeningHoursToVenueHoursJson } from "../lib/venues/google-hours.ts";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";

function map(periods) {
  return mapGoogleOpeningHoursToVenueHoursJson(
    { periods },
    { generatedAt: GENERATED_AT, placeId: "test" },
  );
}

function dayOf(hoursJson, day) {
  const entry = hoursJson.weekly.find((candidate) => candidate.day === day);
  assert.ok(entry, `expected a weekly entry for day ${day}`);
  return entry;
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

// 1. Normal same-day window (Monday 09:00-17:00).
test("normal weekday window", () => {
  const hours = map([
    { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } },
  ]);
  const monday = dayOf(hours, 1);
  assert.equal(monday.closed, false);
  assert.deepEqual(monday.windows, [{ day: 1, end: "17:00", start: "09:00" }]);
  assert.equal(dayOf(hours, 2).closed, true);
});

// 2. Overnight window (Friday 18:00 -> Saturday 02:00) belongs to Friday with spansNextDay.
test("overnight window spans to next day", () => {
  const hours = map([
    { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
  ]);
  const friday = dayOf(hours, 5);
  assert.deepEqual(friday.windows, [
    { day: 5, end: "02:00", spansNextDay: true, start: "18:00" },
  ]);
  // The window lives on the open day only, not duplicated onto Saturday.
  assert.equal(dayOf(hours, 6).windows.length, 0);
});

// 3. Split day (Tuesday lunch + dinner) yields two windows sorted by start.
test("split day keeps two windows", () => {
  const hours = map([
    { open: { day: 2, hour: 19, minute: 0 }, close: { day: 2, hour: 23, minute: 0 } },
    { open: { day: 2, hour: 12, minute: 0 }, close: { day: 2, hour: 15, minute: 0 } },
  ]);
  const tuesday = dayOf(hours, 2);
  assert.deepEqual(tuesday.windows, [
    { day: 2, end: "15:00", start: "12:00" },
    { day: 2, end: "23:00", start: "19:00" },
  ]);
});

// 4. 24/7 (single open period, no close) -> every day open 00:00-23:59.
test("always-open maps to full week", () => {
  const hours = map([{ open: { day: 0, hour: 0, minute: 0 } }]);
  for (let day = 0; day < 7; day += 1) {
    const entry = dayOf(hours, day);
    assert.equal(entry.closed, false);
    assert.deepEqual(entry.windows, [{ day, end: "23:59", start: "00:00" }]);
  }
});

// 5. Week wrap (Saturday 22:00 -> Sunday 04:00) spans next day off Saturday.
test("week wrap saturday into sunday", () => {
  const hours = map([
    { open: { day: 6, hour: 22, minute: 0 }, close: { day: 0, hour: 4, minute: 0 } },
  ]);
  assert.deepEqual(dayOf(hours, 6).windows, [
    { day: 6, end: "04:00", spansNextDay: true, start: "22:00" },
  ]);
});

console.log(`\n${passed} passed`);
