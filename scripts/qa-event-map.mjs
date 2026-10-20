import assert from "node:assert/strict";

import {
  MAP_MAX_DATE,
  MAP_MIN_DATE,
  attachReviewedEventMapAddresses,
  buildEventMapData,
  buildEventMapHref,
  enrichEventMapCoordinates,
  filterEventMapEvents,
  getEventMapEventWindow,
  getEventMapOpenNowDateKey,
  getEventMapOpenNowWindow,
  normalizeMapDateKey,
} from "../lib/events/event-map.ts";

const fallbackDate = "2026-10-15";
assert.equal(MAP_MIN_DATE, "2000-01-01");
assert.equal(MAP_MAX_DATE, "2099-12-31");
for (const date of [MAP_MIN_DATE, MAP_MAX_DATE, "2026-10-15", "2024-02-29", "2000-02-29", "2026-12-31"]) {
  assert.equal(normalizeMapDateKey(date, fallbackDate), date);
}
for (const date of [
  undefined, "", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-15",
  "2026-13-01", "2026-10-00", "2026-10-32", "2026-1-5", "2026-10-15T12:00:00Z",
  " 2026-10-15 ", "not-a-date",
  "0000-01-01", "0099-12-31", "1999-12-31", "2100-01-01", "9999-12-31",
]) {
  assert.equal(normalizeMapDateKey(date, fallbackDate), fallbackDate, `Reject invalid date ${date}.`);
}
assert.equal(buildEventMapHref("2026-10-16"), "/map?date=2026-10-16");
assert.equal(buildEventMapHref("2026-10-16", { openNow: true }), "/map?date=2026-10-16&open=now");
assert.equal(
  new URL(buildEventMapHref("2026-10-16&category=club"), "https://eventzeka.com").searchParams.get("date"),
  "2026-10-16&category=club",
  "Date links must encode their value without introducing another query parameter.",
);

for (const [instant, expectedDate] of [
  ["2026-10-16T23:59:00+02:00", "2026-10-16"],
  ["2026-10-17T00:00:00+02:00", "2026-10-16"],
  ["2026-10-17T05:59:00+02:00", "2026-10-16"],
  ["2026-10-17T06:00:00+02:00", "2026-10-17"],
  ["2026-10-19T05:59:00+02:00", "2026-10-18"],
  ["2026-10-19T06:00:00+02:00", "2026-10-19"],
  ["2026-11-01T00:00:00+01:00", "2026-10-31"],
  ["2027-01-01T00:00:00+01:00", "2026-12-31"],
  ["2027-01-01T06:00:00+01:00", "2027-01-01"],
  // Both sides of the spring jump and autumn repeated hour retain last night.
  ["2026-03-29T00:59:00Z", "2026-03-28"],
  ["2026-03-29T01:00:00Z", "2026-03-28"],
  ["2026-03-29T05:59:00+02:00", "2026-03-28"],
  ["2026-03-29T06:00:00+02:00", "2026-03-29"],
  ["2026-10-25T00:59:00Z", "2026-10-24"],
  ["2026-10-25T01:00:00Z", "2026-10-24"],
  ["2026-10-25T05:59:00+01:00", "2026-10-24"],
  ["2026-10-25T06:00:00+01:00", "2026-10-25"],
]) {
  assert.equal(getEventMapOpenNowDateKey(Date.parse(instant)), expectedDate,
    `Open now should change its Belgrade map date at 06:00: ${instant}.`);
  assert.equal(getEventMapOpenNowDateKey(new Date(instant)), expectedDate,
    "Date and timestamp inputs must select the same Open now date.");
}

for (const [instant, fromDate, beforeDate] of [
  ["2026-10-19T00:00:00+02:00", "2026-10-18", "2026-10-20"],
  ["2026-10-19T06:00:00+02:00", "2026-10-18", "2026-10-20"],
  ["2026-11-01T00:00:00+01:00", "2026-10-31", "2026-11-02"],
  ["2027-01-01T00:00:00+01:00", "2026-12-31", "2027-01-02"],
  ["2026-03-29T01:00:00Z", "2026-03-28", "2026-03-30"],
  ["2026-10-25T01:00:00Z", "2026-10-24", "2026-10-26"],
]) {
  assert.deepEqual(getEventMapOpenNowWindow(Date.parse(instant)), { fromDate, beforeDate },
    "Open now must load civil yesterday and today across week, month, year, and DST boundaries.");
}

for (const [date, previous, next] of [
  ["2026-10-19", "2026-10-18", "2026-10-20"],
  ["2026-03-29", "2026-03-28", "2026-03-30"],
  ["2026-10-25", "2026-10-24", "2026-10-26"],
  ["2026-12-31", "2026-12-30", "2027-01-01"],
]) {
  assert.deepEqual(getEventMapEventWindow(date, false), { fromDate: date, beforeDate: next },
    "Ordinary map browsing must load only the selected date, including DST and year boundaries.");
  assert.deepEqual(getEventMapEventWindow(date, true), { fromDate: previous, beforeDate: next },
    "The generic date window includes the prior date; Open now must use its clock-derived civil window instead.");
}

function makeEvent(overrides = {}) {
  return {
    _id: "base",
    artists: [],
    createdAt: 1,
    date: "2026-10-15",
    eventType: "club_night",
    status: "approved",
    time: "22:00",
    title: "Night",
    updatedAt: 1,
    venue: "Same Brand",
    venueId: "branch-one",
    venueLatitude: 44.81,
    venueLongitude: 20.46,
    ...overrides,
  };
}

const venues = [
  { _id: "branch-one", latitude: 44.82, longitude: 20.47 },
  { _id: "branch-two", latitude: 44.83, longitude: 20.48 },
  { _id: "incomplete", latitude: 44.84 },
  { _id: "invalid", latitude: 95, longitude: 20.49 },
];
const originalEvents = [
  makeEvent({ _id: "branch-one" }),
  makeEvent({ _id: "branch-two", venueId: "branch-two" }),
  makeEvent({ _id: "unbound", venueId: undefined, venueLatitude: undefined, venueLongitude: undefined }),
  makeEvent({ _id: "legacy-coordinate", venueId: undefined }),
  makeEvent({ _id: "unknown-id", venueId: "missing" }),
  makeEvent({ _id: "incomplete-current", venueId: "incomplete" }),
  makeEvent({ _id: "invalid-current", venueId: "invalid" }),
];
const originalSnapshot = structuredClone(originalEvents);
const enriched = enrichEventMapCoordinates(originalEvents, venues);
assert.deepEqual(originalEvents, originalSnapshot, "Map reads must never mutate source events.");
assert.deepEqual(
  enriched.map((event) => [event.venueLatitude, event.venueLongitude]),
  [[44.82, 20.47], [44.83, 20.48], [undefined, undefined], [44.81, 20.46],
    [44.81, 20.46], [44.81, 20.46], [44.81, 20.46]],
  "Current coordinate pairs must match the exact venue ID; incomplete pairs must fall back together.",
);
assert.equal(enriched[2].venueId, undefined, "An unbound venue name must never guess a branch ID.");

const reviewedLocations = [
  { id: "branch-one", latitude: 44.82, longitude: 20.47, address: "Verified venue address" },
  { id: "branch-two", latitude: 44.83, longitude: 20.49, address: "Old point address" },
  { id: "invalid", latitude: 44.81, longitude: 20.46, address: "Old invalidated point" },
];
const withAddresses = enrichEventMapCoordinates(originalEvents, venues, reviewedLocations);
assert.equal(withAddresses[0].venueLocation, "Verified venue address", "A reviewed address must match the exact current venue ID and coordinate pair.");
assert.equal(withAddresses[1].venueLocation, originalEvents[1].venueLocation, "A changed longitude must invalidate the prior reviewed address.");
assert.equal(withAddresses[2].venueLocation, originalEvents[2].venueLocation, "Unbound events must not acquire an address from the reviewed directory.");
assert.equal(withAddresses[6].venueLocation, originalEvents[6].venueLocation, "Invalid current coordinates must not authorize an old reviewed address.");
assert.deepEqual(originalEvents, originalSnapshot, "Reviewed address enrichment must not mutate persisted events.");

const projectedEvents = [
  makeEvent({ _id: "reviewed", venueLatitude: 44.82, venueLongitude: 20.47, venueLocation: "Current address" }),
  makeEvent({ _id: "moved", venueLatitude: 44.82, venueLongitude: 20.48, venueLocation: "Updated address" }),
  makeEvent({ _id: "removed", venueLatitude: undefined, venueLongitude: undefined }),
  makeEvent({ _id: "unbound", venueId: undefined, venueLatitude: 44.82, venueLongitude: 20.47 }),
  makeEvent({ _id: "other-branch", venueId: "branch-two", venueLatitude: 44.82, venueLongitude: 20.47 }),
  makeEvent({ _id: "invalid", venueLatitude: NaN, venueLongitude: 20.47 }),
];
const projectedSnapshot = structuredClone(projectedEvents);
const projectedAddresses = attachReviewedEventMapAddresses(projectedEvents, reviewedLocations);
assert.equal(projectedAddresses[0].venueLocation, "Verified venue address",
  "An exact projected venue ID and coordinate pair may retain its reviewed address without a full directory read.");
assert.equal(projectedAddresses[1].venueLocation, "Updated address",
  "A moved point must retain the current address rather than a prior reviewed point's address.");
for (const index of [2, 3, 4, 5]) {
  assert.deepEqual(projectedAddresses[index], projectedEvents[index],
    "Missing/invalid coordinates, unbound venue names and different branch IDs cannot acquire reviewed location facts.");
}
assert.deepEqual(projectedEvents, projectedSnapshot, "Address display projection must not mutate loaded events.");
assert.deepEqual(
  projectedAddresses.map((event) => [event.venueLatitude, event.venueLongitude]),
  projectedEvents.map((event) => [event.venueLatitude, event.venueLongitude]),
  "Reviewed snapshots must never add, replace or restore map coordinates.",
);

for (const [latitude, longitude] of [
  [undefined, undefined], [44.8, undefined], [undefined, 20.4], [NaN, 20.4],
  [44.8, Infinity], [91, 20.4], [-91, 20.4], [44.8, 181], [44.8, -181],
  [0, 0], ["44.8", "20.4"], [null, null],
]) {
  const event = makeEvent({ venueLatitude: latitude, venueLongitude: longitude });
  const map = buildEventMapData([event]);
  assert.equal(map.locations.length, 0, `Do not invent a marker for ${latitude}, ${longitude}.`);
  assert.deepEqual(map.unmappedEvents, [event], "Events with no valid map point must remain discoverable.");
}
for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 20.4], [44.8, 0]]) {
  assert.equal(buildEventMapData([makeEvent({ venueLatitude: latitude, venueLongitude: longitude })]).locations.length, 1);
}

const lineup = [
  makeEvent({ _id: "late", title: "Late set", time: "23:30", venueLocation: "Main Street 1" }),
  makeEvent({ _id: "unknown", time: "TBD", title: "Unannounced start" }),
  makeEvent({ _id: "earlier", time: "20:00", venue: "Same Brand Original Name" }),
  makeEvent({ _id: "midnight", time: "00:30" }),
  makeEvent({ _id: "explicit-unknown", timeStatus: "unknown", displayTimeStart: "19:00", time: "19:00" }),
  makeEvent({ _id: "range", time: "21:00-02:00" }),
  makeEvent({ _id: "other-branch", venueId: "branch-two", venueLatitude: 44.83, venueLongitude: 20.48 }),
  makeEvent({ _id: "stale-physical-point", venueLatitude: 44.84, venueLongitude: 20.49 }),
  makeEvent({ _id: "idless-a", venueId: undefined, venue: "  Legacy  Venue  " }),
  makeEvent({ _id: "idless-b", venueId: undefined, venue: "legacy venue" }),
  makeEvent({ _id: "same-name-other-point", venueId: undefined, venue: "legacy venue", venueLatitude: 44.85 }),
  makeEvent({ _id: "same-name-other-id", venueId: "another-id", venue: "legacy venue" }),
  makeEvent({ _id: "no-location", venueLatitude: undefined }),
];
const mapData = buildEventMapData(lineup);
assert.equal(mapData.locations.length, 6, "Different canonical IDs and physical points must retain distinct markers.");
const sharedVenue = mapData.locations.find((location) => location.venueId === "branch-one" && location.latitude === 44.81);
assert.deepEqual(
  sharedVenue.events.map((event) => event._id),
  ["midnight", "earlier", "range", "late", "explicit-unknown", "unknown"],
  "One venue marker must expose the full lineup in time order, including midnight and unknown starts last.",
);
assert.equal(sharedVenue.address, "Main Street 1");
assert.deepEqual(
  mapData.locations.find((location) => location.venueId === null && location.latitude === 44.81).events.map((event) => event._id),
  ["idless-a", "idless-b"],
  "Unbound events may share a marker only when both the normalized venue label and coordinate pair match.",
);
assert.deepEqual(mapData.unmappedEvents.map((event) => event._id), ["no-location"]);
assert.deepEqual(
  buildEventMapData([...lineup].reverse()),
  mapData,
  "Marker and lineup order must be stable regardless of incoming event order.",
);
assert.deepEqual(buildEventMapData([]), { locations: [], unmappedEvents: [] });

const overnightHours = {
  hoursJson: JSON.stringify({
    generatedAt: "2026-10-16T12:00:00.000Z",
    source: "manual",
    timezone: "Europe/Belgrade",
    version: 1,
    weekly: [{ day: 5, closed: false, windows: [{ day: 5, start: "18:00", end: "04:00", spansNextDay: true }] }],
  }),
};
const openNowEvents = [
  makeEvent({ _id: "ongoing", date: "2026-10-16", time: "22:00", venueHours: overnightHours }),
  makeEvent({ _id: "ended", date: "2026-10-16", time: "22:00-01:00", venueHours: overnightHours }),
  makeEvent({ _id: "no-start", date: "2026-10-16", time: "TBD", venueHours: overnightHours }),
  makeEvent({ _id: "future", date: "2026-10-18", time: "22:00", venueHours: overnightHours }),
  makeEvent({ _id: "unknown-hours", date: "2026-10-16", time: "TBD" }),
];
const openNowOptions = { selectedDate: "2026-10-17", openNow: true, now: Date.parse("2026-10-17T00:00:00Z") };
const filteredOpenEvents = filterEventMapEvents(openNowEvents, openNowOptions);
assert.deepEqual(filteredOpenEvents.map((event) => event._id), ["ongoing", "no-start", "unknown-hours"],
  "The map retains verified openings and labelled possible events from this night, excluding ended and future events.");
assert.deepEqual(buildEventMapData(filteredOpenEvents).locations[0].events.map((event) => event._id), ["ongoing", "no-start", "unknown-hours"],
  "Pins and popups must use the same filtered event set as the map lineup.");
assert.deepEqual(filterEventMapEvents(openNowEvents, { ...openNowOptions, now: Date.parse("2026-10-17T02:00:00Z") }).map((event) => event._id), ["unknown-hours"],
  "Confirmed openings end at the exact closing boundary; unresolved events remain separately labelled possible.");
assert.deepEqual(filterEventMapEvents(openNowEvents, { ...openNowOptions, now: Date.parse("2026-10-17T05:00:00Z") }), [],
  "Possible events must not carry into the next nightlife day.");
assert.deepEqual(filterEventMapEvents(openNowEvents, { ...openNowOptions, selectedDate: "2026-10-16", openNow: false }),
  openNowEvents.filter((event) => event.date === "2026-10-16"),
  "Date browsing must retain its complete lineup when Open now is off.");

const beforeStart = [makeEvent({ _id: "later-tonight", date: "2026-10-16", time: "22:00", venueHours: overnightHours })];
assert.deepEqual(filterEventMapEvents(beforeStart, { ...openNowOptions, selectedDate: "2026-10-16", now: Date.parse("2026-10-16T18:00:00Z") }), [],
  "An open venue must not put tonight's event on the Open now map before its announced start.");

const mondayAfterMidnight = Date.parse("2026-10-19T02:00:00+02:00");
assert.deepEqual(filterEventMapEvents([
  makeEvent({ _id: "sunday-night", date: "2026-10-18", time: "22:00-05:00" }),
  makeEvent({ _id: "monday-start", date: "2026-10-19", time: "01:00-03:00" }),
], { selectedDate: getEventMapOpenNowDateKey(mondayAfterMidnight), openNow: true, now: mondayAfterMidnight })
  .map((event) => event._id), ["sunday-night", "monday-start"],
"The previous display day must keep both overnight events and current-day starts in Open now results.");

console.log("Event map QA passed.");
