import assert from "node:assert/strict";
import {
  getBelgradeNow,
  getOpenNowEventState,
  getOpenNowEventWindow,
  getVenueClosingForEventStart,
  isVenueOpenNow,
  matchesOpenNowEvent,
} from "../lib/venues/venue-open-now.ts";

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

// Open now describes venue availability. Event times only identify the outing.
const saturdayEvening = Date.parse("2026-10-17T16:30:00Z");
for (const time of ["21:00", "21:00-22:00", "10:00-12:00", "12:00", "TBD", "", undefined]) {
  assert.equal(matchesOpenNowEvent({ date: "2026-10-17", time, venueHours: saturdaySplit }, saturdayEvening), true,
    `A currently open venue qualifies before/after its announced event time: ${time}.`);
}
for (const [date, time, venueHours, instant] of [
  ["2026-10-17", "12:00-22:00", saturdaySplit, "2026-10-17T13:00:00Z"],
  ["2026-10-17", "21:00-02:00", saturdaySplit, "2026-10-17T21:30:00Z"],
  ["2026-10-17", "18:00-23:00", venue([day(6, [], true)]), "2026-10-17T16:30:00Z"],
  ["2026-10-16", "22:00", saturdaySplit, "2026-10-17T16:30:00Z"],
  ["2026-10-18", "22:00", saturdaySplit, "2026-10-17T16:30:00Z"],
]) {
  assert.equal(matchesOpenNowEvent({ date, time, venueHours }, Date.parse(instant)), false,
    "Announced ranges cannot override venue closing gaps/closures, or revive another outing.");
}
const fridayEvent = { date: "2026-10-16", time: "23:30", venueHours: fridayOvernight };
for (const [instant, expected] of [["2026-10-16T21:00:00Z", true], ["2026-10-17T01:59:59Z", true], ["2026-10-17T02:00:00Z", false]]) {
  assert.equal(matchesOpenNowEvent(fridayEvent, Date.parse(instant)), expected,
    "The venue's opening is inclusive and closing exclusive, independently of event time.");
}
const saturday02 = Date.parse("2026-10-17T00:00:00Z");
assert.equal(matchesOpenNowEvent({ ...fridayEvent, time: "23:00-01:00" }, saturday02), true,
  "A venue still open at 02:00 stays available after the event's announced end.");
assert.equal(matchesOpenNowEvent({ date: "2026-10-17", time: "01:00", venueHours: fridayOvernight }, saturday02), true,
  "Saturday 01:00 belongs to Friday's ongoing outing.");
for (const event of [{ date: "2026-10-17" }, { date: "2026-10-16", time: "01:00" }, { date: "2026-10-15" }]) {
  assert.equal(matchesOpenNowEvent({ ...event, venueHours: fridayOvernight }, saturday02), false,
    "The following outing and old early-morning listings cannot borrow the current outing.");
}
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: clippedGoogleWindows }, saturday02), true,
  "A verified Google midnight opening establishes current venue availability.");
const alwaysOpen = venue(Array.from({ length: 7 }, (_, weekday) => day(weekday, [["00:00", "00:00", true]])));
for (const time of [undefined, "TBD", "23:00", "09:00-10:00"]) {
  assert.equal(matchesOpenNowEvent({ date: "2026-10-17", time, venueHours: alwaysOpen }, saturdayEvening), true,
    "A 24/7 venue needs no finite event ending to establish availability.");
}
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: alwaysOpen }, saturdayEvening), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: alwaysOpen }, saturday02), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-17", venueHours: alwaysOpen }, saturday02), false);
const unknownSchedules = [undefined, null, {}, { hoursJson: "bad" }, venue([]), venue([day(6, [])]),
  venue([day(6, [], true)], "none"), venue([day(1, [["20:00", "23:00"]])]),
  { ...alwaysOpen, hoursSource: "none" }, { ...alwaysOpen, hoursSource: "google" }, { ...alwaysOpen, hoursTimezone: "UTC" },
  { hoursJson: JSON.stringify({ ...JSON.parse(alwaysOpen.hoursJson), timezone: "UTC" }) }];
for (const venueHours of unknownSchedules) {
  const event = { date: "2026-10-17", time: "18:00-23:00", venueHours };
  assert.equal(isVenueOpenNow(venueHours, saturdayEvening), false);
  assert.equal(getOpenNowEventState(event, saturdayEvening), "possible",
    "Missing or contradictory venue evidence stays unknown even with a complete event range.");
  assert.equal(matchesOpenNowEvent(event, saturdayEvening), false,
    "Unknown venue hours never become public Open now results.");
}
assert.equal(getOpenNowEventState({ date: "2026-10-17", venueHours: venue([day(6, [], true)]) }, saturdayEvening), "inactive");
assert.equal(isVenueOpenNow({ ...alwaysOpen, hoursSource: "manual", hoursExpiresAt: 1 }, saturdayEvening), true,
  "Manual schedules remain nonexpiring under the existing refresh policy.");
assert.equal(isVenueOpenNow({ ...clippedGoogleWindows, hoursSource: "google", hoursExpiresAt: 1 }, saturday02), true,
  "Provider expiry schedules refresh rather than silently removing stored hours.");
assert.equal(isVenueOpenNow({ ...alwaysOpen, hoursSource: undefined }, saturdayEvening), true,
  "Legacy caches without duplicate metadata retain valid JSON hours.");
for (const date of [undefined, "not-a-date", "2026-02-30"]) {
  assert.equal(matchesOpenNowEvent({ date, time: "00:00-23:59", venueHours: alwaysOpen }, saturdayEvening), false);
}
for (const now of [Number.NaN, new Date("invalid")]) {
  assert.equal(isVenueOpenNow(alwaysOpen, now), false);
  assert.equal(getOpenNowEventState({ date: "2026-10-17", venueHours: alwaysOpen }, now), "inactive");
}
const midnightGap = venue([day(5, [["23:00", "00:00", true]]), day(6, [["00:30", "06:00"]])]);
assert.equal(matchesOpenNowEvent({ ...fridayEvent, venueHours: midnightGap }, Date.parse("2026-10-16T22:15:00Z")), false,
  "The venue is unavailable during its actual closing gap.");
assert.equal(matchesOpenNowEvent({ ...fridayEvent, venueHours: midnightGap }, Date.parse("2026-10-16T22:30:00Z")), true,
  "A later opening makes the current outing's venue available again.");
const clippedAdjacent = venue([day(5, [["23:00", "00:00", true]]), day(6, [["00:00", "06:00"], ["23:00", "00:00", true]])]);
assert.equal(matchesOpenNowEvent({ ...fridayEvent, venueHours: clippedAdjacent }, Date.parse("2026-10-17T03:59:59Z")), true);
assert.equal(matchesOpenNowEvent({ ...fridayEvent, venueHours: clippedAdjacent }, Date.parse("2026-10-17T04:00:00Z")), false);
// Existing display-only inference remains separate from canonical event times.
for (const [date, startTime, venueHours, expected] of [
  ["2026-10-17", "12:00", saturdaySplit, { date: "2026-10-17", time: "14:00" }],
  ["2026-10-16", "23:30", fridayOvernight, { date: "2026-10-17", time: "04:00" }],
  ["2026-10-17", "01:00", saturdayOvernight, null],
  ["2026-10-16", "23:30", clippedAdjacent, { date: "2026-10-17", time: "06:00" }],
  ["2026-10-16", "23:30", midnightGap, { date: "2026-10-17", time: "00:00" }],
  ["2026-10-17", "21:00", alwaysOpen, null],
]) assert.deepEqual(getVenueClosingForEventStart({ date, startTime, venueHours }), expected);
const dstOvernight = venue([day(6, [["23:00", "04:00", true]])]);
for (const [instant, expected] of [
  ["2026-10-25T00:30:00Z", true], ["2026-10-25T01:30:00Z", true], ["2026-10-25T02:59:59Z", true], ["2026-10-25T03:00:00Z", false],
  ["2026-03-29T01:30:00Z", true], ["2026-03-29T02:00:00Z", false],
]) {
  const date = instant.startsWith("2026-03") ? "2026-03-28" : "2026-10-24";
  assert.equal(matchesOpenNowEvent({ date, time: "23:30-00:00", venueHours: dstOvernight }, Date.parse(instant)), expected,
    "Venue availability spans DST changes independently of the announced event ending.");
}
const repeatedHourClosing = venue([day(6, [["23:00", "02:30", true]])]);
for (const instant of ["2026-10-25T00:29:59Z", "2026-10-25T00:30:00Z", "2026-10-25T00:59:59Z", "2026-10-25T01:00:00Z", "2026-10-25T01:29:59Z"]) {
  assert.equal(matchesOpenNowEvent({ date: "2026-10-24", venueHours: repeatedHourClosing }, Date.parse(instant)), true,
    "The venue stays continuously open until the second 02:30.");
}
assert.equal(matchesOpenNowEvent({ date: "2026-10-24", venueHours: repeatedHourClosing }, Date.parse("2026-10-25T01:30:00Z")), false);
assert.deepEqual(getVenueClosingForEventStart({ date: "2026-10-25", startTime: "02:30", venueHours: dstOvernight }), { date: "2026-10-25", time: "04:00" });
assert.equal(getVenueClosingForEventStart({ date: "2026-03-29", startTime: "02:30", venueHours: dstOvernight }), null);
const nonexistentClosing = venue([day(6, [["23:00", "02:30", true]])]);
assert.equal(getVenueClosingForEventStart({ date: "2026-03-28", startTime: "23:30", venueHours: nonexistentClosing }), null);
assert.equal(isVenueOpenNow(nonexistentClosing, Date.parse("2026-03-29T00:00:00Z")), false,
  "An impossible spring-gap closing stays unresolved instead of receiving an invented instant.");
const tuesdayVenue = venue([day(2, [["20:00", "04:00", true]])]);
const tuesdayEvent = { date: "2026-10-20", time: "23:00-00:00", venueHours: tuesdayVenue };
const wednesday01 = Date.parse("2026-10-20T23:00:00Z");
assert.equal(matchesOpenNowEvent(tuesdayEvent, wednesday01), true);
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, date: "2026-10-21", time: "01:00" }, wednesday01), true);
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, date: "2026-10-20", time: "01:00" }, wednesday01), false);
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, date: "2026-10-21", time: "23:00" }, wednesday01), false);
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, venueHours: alwaysOpen }, Date.parse("2026-10-21T04:59:59Z")), true);
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, venueHours: alwaysOpen }, Date.parse("2026-10-21T05:00:00Z")), false,
  "The previous outing expires at 07:00 Belgrade even in a 24/7 venue.");
assert.equal(matchesOpenNowEvent({ ...tuesdayEvent, venueHours: alwaysOpen }, Date.parse("2026-10-21T23:00:00Z")), false);
for (const [instant, fromDate, beforeDate] of [
  ["2026-10-20T21:00:00Z", "2026-10-19", "2026-10-21"], ["2026-10-20T23:00:00Z", "2026-10-20", "2026-10-22"],
  ["2026-10-31T23:15:00Z", "2026-10-31", "2026-11-02"], ["2026-12-31T23:15:00Z", "2026-12-31", "2027-01-02"],
  ["2026-03-29T00:30:00Z", "2026-03-28", "2026-03-30"], ["2026-03-29T01:30:00Z", "2026-03-28", "2026-03-30"],
  ["2026-10-25T00:30:00Z", "2026-10-24", "2026-10-26"], ["2026-10-25T01:30:00Z", "2026-10-24", "2026-10-26"],
]) {
  const now = Date.parse(instant);
  assert.deepEqual(getOpenNowEventWindow(now), { beforeDate, fromDate });
  assert.deepEqual(getOpenNowEventWindow(new Date(now)), { beforeDate, fromDate });
}
for (const [date, instant] of [["2026-10-31", "2026-10-31T23:15:00Z"], ["2026-12-31", "2026-12-31T23:15:00Z"]]) {
  assert.equal(matchesOpenNowEvent({ date, time: "23:00", venueHours: alwaysOpen }, Date.parse(instant)), true);
}
console.log("QA passed: venue-hours Open now, event-time independence, confirmed availability, unknown/closed distinction, 24/7, outing rollover, overnight/split windows, cache consistency, and DST.");
