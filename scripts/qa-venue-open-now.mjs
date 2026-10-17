import assert from "node:assert/strict";
import { getBelgradeNow, isVenueOpenNow, matchesOpenNowEvent } from "../lib/venues/venue-open-now.ts";

function venue(weekly, source = "manual") {
  return {
    hoursJson: JSON.stringify({
      generatedAt: "2026-10-17T12:00:00.000Z",
      source,
      timezone: "Europe/Belgrade",
      version: 1,
      weekly,
    }),
  };
}

function day(weekday, windows, closed = false) {
  return {
    closed,
    day: weekday,
    windows: windows.map(([start, end, spansNextDay]) => ({
      day: weekday,
      end,
      ...(spansNextDay ? { spansNextDay: true } : {}),
      start,
    })),
  };
}

const summer = getBelgradeNow(Date.parse("2026-06-17T12:34:00Z"));
assert.deepEqual(summer, {
  date: "2026-06-17", minuteOfDay: 14 * 60 + 34, month: "2026-06", time: "14:34", weekday: 3,
});
assert.equal(getBelgradeNow(Date.parse("2026-12-17T12:34:00Z")).time, "13:34");
assert.equal(getBelgradeNow(Date.parse("2026-03-29T00:30:00Z")).time, "01:30");
assert.equal(getBelgradeNow(Date.parse("2026-03-29T01:30:00Z")).time, "03:30");
assert.equal(getBelgradeNow(Date.parse("2026-10-25T00:30:00Z")).time, "02:30");
assert.equal(getBelgradeNow(Date.parse("2026-10-25T01:30:00Z")).time, "02:30");
assert.deepEqual(getBelgradeNow(Date.parse("2026-10-31T23:15:00Z")), {
  date: "2026-11-01", minuteOfDay: 15, month: "2026-11", time: "00:15", weekday: 0,
});

const saturdaySplit = venue([day(6, [["10:00", "14:00"], ["18:00", "23:00"]])]);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T07:59:59Z")), false);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T08:00:00Z")), true);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T11:59:59Z")), true);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T12:00:00Z")), false);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T15:59:59Z")), false);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T16:00:00Z")), true);
assert.equal(isVenueOpenNow(saturdaySplit, Date.parse("2026-10-17T21:00:00Z")), false);

const fridayOvernight = venue([
  day(5, [["23:00", "04:00", true]]),
  day(6, [], true),
]);
assert.equal(isVenueOpenNow(fridayOvernight, Date.parse("2026-10-16T21:00:00Z")), true);
assert.equal(isVenueOpenNow(fridayOvernight, Date.parse("2026-10-16T23:59:00Z")), true);
assert.equal(isVenueOpenNow(fridayOvernight, Date.parse("2026-10-17T01:59:59Z")), true);
assert.equal(isVenueOpenNow(fridayOvernight, Date.parse("2026-10-17T02:00:00Z")), false);
assert.equal(isVenueOpenNow(fridayOvernight, Date.parse("2026-10-17T21:00:00Z")), false);

const saturdayOvernight = venue([day(6, [["23:00", "04:00"]])]);
assert.equal(isVenueOpenNow(saturdayOvernight, Date.parse("2026-10-17T00:00:00Z")), false,
  "Tonight's hours must not leak into this morning before opening.");
assert.equal(isVenueOpenNow(saturdayOvernight, Date.parse("2026-10-17T21:00:00Z")), true);
assert.equal(isVenueOpenNow(saturdayOvernight, Date.parse("2026-10-18T00:00:00Z")), true);
assert.equal(isVenueOpenNow(saturdayOvernight, Date.parse("2026-10-18T02:00:00Z")), false);

const sundayOvernight = venue([day(0, [["20:00", "02:00", true]])]);
assert.equal(isVenueOpenNow(sundayOvernight, Date.parse("2026-10-18T23:00:00Z")), true,
  "Previous weekday must wrap from Monday back to Sunday.");

const allDay = venue([day(6, [["00:00", "00:00", true]])]);
assert.equal(isVenueOpenNow(allDay, Date.parse("2026-10-16T22:00:00Z")), true);
assert.equal(isVenueOpenNow(allDay, Date.parse("2026-10-17T21:59:59Z")), true);
assert.equal(isVenueOpenNow(allDay, Date.parse("2026-10-17T22:00:00Z")), false);

const clippedGoogleWindows = venue([day(6, [["00:00", "06:00"], ["23:00", "00:00", true]])], "google");
assert.equal(isVenueOpenNow(clippedGoogleWindows, Date.parse("2026-10-17T01:00:00Z")), true);
assert.equal(isVenueOpenNow(clippedGoogleWindows, Date.parse("2026-10-17T12:00:00Z")), false);
assert.equal(isVenueOpenNow(clippedGoogleWindows, Date.parse("2026-10-17T21:00:00Z")), true);

for (const unknown of [null, {}, { hoursJson: "invalid" }, venue([]), venue([day(6, [])]), venue([day(6, [], true)])]) {
  assert.equal(isVenueOpenNow(unknown, Date.parse("2026-10-17T12:00:00Z")), false);
}
assert.equal(isVenueOpenNow(venue([day(6, [["00:00", "00:00", true]])], "none"), Date.parse("2026-10-17T12:00:00Z")), false);
assert.equal(isVenueOpenNow(allDay, new Date("invalid")), false);
assert.equal(isVenueOpenNow(allDay, Number.NaN), false);

assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: fridayOvernight }, Date.parse("2026-10-17T00:00:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-17", venueHours: fridayOvernight }, Date.parse("2026-10-17T00:00:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-18", venueHours: fridayOvernight }, Date.parse("2026-10-17T00:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: saturdaySplit }, Date.parse("2026-10-17T16:30:00Z")), false,
  "Yesterday's events must not reappear when today's new opening begins.");
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: clippedGoogleWindows }, Date.parse("2026-10-17T01:00:00Z")), false,
  "A midnight window alone is insufficient proof that yesterday's event continues.");
const clippedAdjacent = venue([
  day(5, [["23:00", "00:00", true]]),
  day(6, [["00:00", "06:00"], ["23:00", "00:00", true]]),
]);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: clippedAdjacent }, Date.parse("2026-10-17T01:00:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: clippedAdjacent }, Date.parse("2026-10-17T21:00:00Z")), false);
const monthBoundary = venue([day(6, [["23:00", "04:00", true]])]);
assert.equal(matchesOpenNowEvent({ date: "2026-10-31", venueHours: monthBoundary }, Date.parse("2026-11-01T00:00:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-11-02", venueHours: monthBoundary }, Date.parse("2026-11-01T00:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-15", venueHours: fridayOvernight }, Date.parse("2026-10-17T00:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-17" }, Date.parse("2026-10-17T00:00:00Z")), false);

console.log("QA passed: Belgrade open-now hours, DST, exact boundaries, split windows, and overnight carry.");
