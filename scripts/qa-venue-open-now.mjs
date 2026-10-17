import assert from "node:assert/strict";
import { getBelgradeNow, getVenueClosingForEventStart, isVenueOpenNow, matchesOpenNowEvent } from "../lib/venues/venue-open-now.ts";

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

const eveningShow = { date: "2026-10-17", time: "21:00", venueHours: saturdaySplit };
assert.equal(matchesOpenNowEvent(eveningShow, Date.parse("2026-10-17T16:30:00Z")), false,
  "An open bar must not make its later announced event active before the start.");
assert.equal(matchesOpenNowEvent(eveningShow, Date.parse("2026-10-17T19:00:00Z")), true);
assert.equal(matchesOpenNowEvent(eveningShow, Date.parse("2026-10-17T20:59:59Z")), true);
assert.equal(matchesOpenNowEvent(eveningShow, Date.parse("2026-10-17T21:00:00Z")), false);
assert.deepEqual(getVenueClosingForEventStart({
  date: "2026-10-17", startTime: "12:00", venueHours: saturdaySplit,
}), { date: "2026-10-17", time: "14:00" });
assert.equal(matchesOpenNowEvent({ ...eveningShow, time: "12:00" }, Date.parse("2026-10-17T16:30:00Z")), false,
  "A morning event must not revive during the later, separate venue opening.");

const overnightShow = { date: "2026-10-16", time: "23:30", venueHours: fridayOvernight };
assert.deepEqual(getVenueClosingForEventStart({ ...overnightShow, startTime: "23:30" }), {
  date: "2026-10-17", time: "04:00",
});
assert.equal(matchesOpenNowEvent(overnightShow, Date.parse("2026-10-16T21:29:59Z")), false);
assert.equal(matchesOpenNowEvent(overnightShow, Date.parse("2026-10-16T21:30:00Z")), true);
assert.equal(matchesOpenNowEvent(overnightShow, Date.parse("2026-10-17T01:59:59Z")), true);
assert.equal(matchesOpenNowEvent(overnightShow, Date.parse("2026-10-17T02:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ ...overnightShow, date: "2026-10-17", time: "01:00" }, Date.parse("2026-10-17T00:00:00Z")), true,
  "An after-midnight event start can use the previous day's ongoing opening.");
assert.equal(getVenueClosingForEventStart({ date: "2026-10-17", startTime: "01:00", venueHours: saturdayOvernight }), null,
  "Tonight's overnight closing cannot be borrowed by an early-morning start.");

assert.deepEqual(getVenueClosingForEventStart({
  date: "2026-10-16", startTime: "23:30", venueHours: clippedAdjacent,
}), { date: "2026-10-17", time: "06:00" },
"Clipped Google midnight windows must form one continuous event duration.");
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", time: "23:30", venueHours: clippedAdjacent }, Date.parse("2026-10-17T03:59:59Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", time: "23:30", venueHours: clippedAdjacent }, Date.parse("2026-10-17T04:00:00Z")), false);
const midnightGap = venue([
  day(5, [["23:00", "00:00", true]]),
  day(6, [["00:30", "06:00"]]),
]);
assert.deepEqual(getVenueClosingForEventStart({
  date: "2026-10-16", startTime: "23:30", venueHours: midnightGap,
}), { date: "2026-10-17", time: "00:00" });
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", time: "23:30", venueHours: midnightGap }, Date.parse("2026-10-16T23:00:00Z")), false,
  "Any verified closing gap must end the inferred event duration.");

const announcedRange = { date: "2026-10-17", time: "21:00-02:00", venueHours: saturdaySplit };
assert.equal(matchesOpenNowEvent(announcedRange, Date.parse("2026-10-17T18:59:59Z")), false);
assert.equal(matchesOpenNowEvent(announcedRange, Date.parse("2026-10-17T21:30:00Z")), true,
  "An explicit event end is authoritative even when regular venue hours end earlier.");
assert.equal(matchesOpenNowEvent(announcedRange, Date.parse("2026-10-17T23:59:59Z")), true);
assert.equal(matchesOpenNowEvent(announcedRange, Date.parse("2026-10-18T00:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ ...announcedRange, venueHours: null }, Date.parse("2026-10-17T20:00:00Z")), true,
  "A complete announced event range requires no venue-hours evidence.");
assert.equal(matchesOpenNowEvent({ ...announcedRange, time: "21:00-22:00" }, Date.parse("2026-10-17T20:30:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-18", time: "00:00-06:00", venueHours: allDay }, Date.parse("2026-10-17T12:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", time: "21:00-02:00", venueHours: allDay }, Date.parse("2026-10-17T12:00:00Z")), false);

for (const venueHours of [undefined, venue([]), venue([day(6, [])]), venue([day(6, [], true)]), { hoursJson: "bad" }]) {
  assert.equal(getVenueClosingForEventStart({ date: "2026-10-17", startTime: "21:00", venueHours }), null);
  assert.equal(matchesOpenNowEvent({ date: "2026-10-17", time: "21:00", venueHours }, Date.parse("2026-10-17T20:00:00Z")), false,
    "A start alone with no confirmed closing cannot establish that an event is still active.");
}
for (const date of [undefined, "not-a-date", "2026-02-30"]) {
  assert.equal(matchesOpenNowEvent({ date, time: "00:00-23:59", venueHours: allDay }, Date.parse("2026-10-17T12:00:00Z")), false);
}
const alwaysOpen = venue(Array.from({ length: 7 }, (_, weekday) => day(weekday, [["00:00", "00:00", true]])));
assert.equal(isVenueOpenNow(alwaysOpen, Date.parse("2026-10-17T16:30:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-17", venueHours: alwaysOpen }, Date.parse("2026-10-17T16:30:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: alwaysOpen }, Date.parse("2026-10-17T16:30:00Z")), false,
  "Adjacent all-day cycles do not prove that yesterday's unknown-time event continues today.");
const nonMidnightAllDay = venue([
  day(5, [["10:00", "10:00", true]]),
  day(6, [["10:00", "10:00", true]]),
]);
assert.equal(isVenueOpenNow(nonMidnightAllDay, Date.parse("2026-10-17T01:00:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-10-16", venueHours: nonMidnightAllDay }, Date.parse("2026-10-17T01:00:00Z")), false,
  "A full continuous all-day cycle starting later than midnight is still insufficient event carry evidence.");
assert.equal(getVenueClosingForEventStart({ date: "2026-10-17", startTime: "21:00", venueHours: alwaysOpen }), null,
  "A 24/7 venue has no confirmed closing from which to invent an event end.");
assert.equal(matchesOpenNowEvent({ date: "2026-10-17", time: "21:00", venueHours: alwaysOpen }, Date.parse("2026-10-17T21:00:00Z")), false);

const dstOvernight = venue([day(6, [["23:00", "04:00", true]])]);
for (const instant of ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-10-25T02:59:59Z"]) {
  assert.equal(matchesOpenNowEvent({ date: "2026-10-24", time: "23:30", venueHours: dstOvernight }, Date.parse(instant)), true,
    "The autumn repeated Belgrade hour must remain inside an overnight event.");
}
assert.equal(matchesOpenNowEvent({ date: "2026-10-24", time: "23:30", venueHours: dstOvernight }, Date.parse("2026-10-25T03:00:00Z")), false);
assert.equal(matchesOpenNowEvent({ date: "2026-03-28", time: "23:30", venueHours: dstOvernight }, Date.parse("2026-03-29T01:30:00Z")), true);
assert.equal(matchesOpenNowEvent({ date: "2026-03-28", time: "23:30", venueHours: dstOvernight }, Date.parse("2026-03-29T02:00:00Z")), false);

const repeatedHourClosing = venue([day(6, [["23:00", "02:30", true]])]);
for (const instant of ["2026-10-25T00:29:59Z", "2026-10-25T00:30:00Z", "2026-10-25T00:59:59Z", "2026-10-25T01:00:00Z", "2026-10-25T01:29:59Z"]) {
  const now = Date.parse(instant);
  assert.equal(matchesOpenNowEvent({ date: "2026-10-24", time: "23:30-02:30" }, now), true,
    "An announced ambiguous end must stay continuously active until the second 02:30.");
  assert.equal(matchesOpenNowEvent({ date: "2026-10-24", time: "23:30", venueHours: repeatedHourClosing }, now), true,
    "An inferred ambiguous closing must not disappear and revive when the clock rolls back.");
  assert.equal(isVenueOpenNow(repeatedHourClosing, now), true,
    "Venue opening state must use the same continuous repeated-hour interval.");
  assert.equal(matchesOpenNowEvent({ date: "2026-10-24", venueHours: repeatedHourClosing }, now), true,
    "Unknown-time events must use the same continuous overnight venue interval.");
}
for (const event of [
  { date: "2026-10-24", time: "23:30-02:30" },
  { date: "2026-10-24", time: "23:30", venueHours: repeatedHourClosing },
  { date: "2026-10-24", venueHours: repeatedHourClosing },
]) {
  assert.equal(matchesOpenNowEvent(event, Date.parse("2026-10-25T01:30:00Z")), false);
}
assert.equal(isVenueOpenNow(repeatedHourClosing, Date.parse("2026-10-25T01:30:00Z")), false);
for (const time of ["02:30-03:30", "02:30"]) {
  const event = { date: "2026-10-25", time, venueHours: dstOvernight };
  assert.equal(matchesOpenNowEvent(event, Date.parse("2026-10-25T00:29:59Z")), false);
  for (const instant of ["2026-10-25T00:30:00Z", "2026-10-25T00:59:59Z", "2026-10-25T01:00:00Z", "2026-10-25T01:29:59Z"]) {
    assert.equal(matchesOpenNowEvent(event, Date.parse(instant)), true,
      "An ambiguous announced start begins at its earliest supported instant and stays active through the rollback.");
  }
}
assert.deepEqual(getVenueClosingForEventStart({ date: "2026-10-25", startTime: "02:30", venueHours: dstOvernight }), {
  date: "2026-10-25", time: "04:00",
});

for (const time of ["02:30-04:00", "02:30"]) {
  const event = { date: "2026-03-29", time, venueHours: dstOvernight };
  for (const instant of ["2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z"]) {
    assert.equal(matchesOpenNowEvent(event, Date.parse(instant)), false,
      "A nonexistent spring-gap announced start cannot identify an active event instant.");
  }
}
assert.equal(getVenueClosingForEventStart({ date: "2026-03-29", startTime: "02:30", venueHours: dstOvernight }), null);
const nonexistentClosing = venue([day(6, [["23:00", "02:30", true]])]);
assert.equal(getVenueClosingForEventStart({ date: "2026-03-28", startTime: "23:30", venueHours: nonexistentClosing }), null,
  "An impossible spring-gap closing must stay unresolved instead of receiving an invented instant.");
assert.equal(matchesOpenNowEvent({ date: "2026-03-28", time: "23:30-02:30" }, Date.parse("2026-03-29T00:00:00Z")), false);
assert.equal(isVenueOpenNow(nonexistentClosing, Date.parse("2026-03-29T00:00:00Z")), false);

console.log("QA passed: Belgrade open-now event bounds, venue closing inference, DST, split windows, and overnight carry.");
