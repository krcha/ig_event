import { sortAgendaEvents, normalizeAgendaSortMode } from "../lib/events/agenda-sort.ts";
import { AGENDA_SORT_OPTIONS, AGENDA_BAND_ORDER } from "../lib/events/agenda-sort-options.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sortPublicEventsByDateVenueTimeTitle } from "../lib/events/public-event-sort.ts";

function makeEvent(overrides) {
  return {
    _id: "event-base",
    title: "Base event",
    date: "2026-06-20",
    time: "22:00",
    venue: "Base Venue",
    artists: [],
    eventType: "nightlife",
    status: "approved",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const unsortedEvents = [
  makeEvent({
    _id: "later-alpha",
    date: "2026-06-21",
    time: "19:00",
    venue: "Ada Ciganlija",
    title: "Later-day event should stay after earlier dates",
  }),
  makeEvent({
    _id: "same-date-zappa-early",
    date: "2026-06-20",
    time: "20:00",
    venue: "Zappa Barka",
    title: "Zappa early",
  }),
  makeEvent({
    _id: "same-date-emoji-karusel",
    date: "2026-06-20",
    time: "21:00",
    venue: "🎪 Karusel Bar | Carousel 🎪",
    title: "Emoji-wrapped venue should sort under K",
  }),
  makeEvent({
    _id: "same-date-ben-akiba",
    date: "2026-06-20",
    time: "22:00",
    venue: "Ben Akiba Beograd",
    title: "Ben Akiba should come before Karusel",
  }),
  makeEvent({
    _id: "same-date-atom",
    date: "2026-06-20",
    time: "23:00",
    venue: "Atom Akademija",
    title: "Atom should come first by venue",
  }),
  makeEvent({
    _id: "same-date-zappa-late-alpha-title",
    date: "2026-06-20",
    time: "23:00",
    venue: "Zappa Barka",
    title: "Alpha title tie-break",
  }),
  makeEvent({
    _id: "same-date-zappa-late-beta-title",
    date: "2026-06-20",
    time: "23:00",
    venue: "Zappa Barka",
    title: "Beta title tie-break",
  }),
];

const sortedEvents = sortPublicEventsByDateVenueTimeTitle(unsortedEvents);
assert.deepEqual(
  sortedEvents.map((event) => event._id),
  [
    "same-date-atom",
    "same-date-ben-akiba",
    "same-date-emoji-karusel",
    "same-date-zappa-early",
    "same-date-zappa-late-alpha-title",
    "same-date-zappa-late-beta-title",
    "later-alpha",
  ],
  "Public events should stay chronological by date, then sort same-day events alphabetically by venue name before time and title tie-breaks.",
);
assert.deepEqual(
  unsortedEvents.map((event) => event._id),
  [
    "later-alpha",
    "same-date-zappa-early",
    "same-date-emoji-karusel",
    "same-date-ben-akiba",
    "same-date-atom",
    "same-date-zappa-late-alpha-title",
    "same-date-zappa-late-beta-title",
  ],
  "Public event sorting helper should not mutate the caller's event array.",
);

const publicEventsSource = readFileSync("lib/events/public-events.ts", "utf8");
assert.match(
  publicEventsSource,
  /sortPublicEventsByDateVenueTimeTitle/,
  "Server-side public event loading should apply the shared venue-name sort before pagination/grouping.",
);

const browsePageSource = readFileSync("app/(main)/events-browse-page.tsx", "utf8");
assert.match(browsePageSource, /sortAgendaEvents\(selectedDayAgendaEvents, selectedSortMode\)/);
assert.equal(normalizeAgendaSortMode(), "time");
assert.equal(normalizeAgendaSortMode("venue"), "venue");
assert.equal(normalizeAgendaSortMode("distance"), "distance");
assert.equal(normalizeAgendaSortMode("popularity"), "popularity");
assert.equal(normalizeAgendaSortMode("late"), "time");
assert.equal(normalizeAgendaSortMode("title"), "time");
assert.equal(normalizeAgendaSortMode("invalid"), "time");
assert.deepEqual(AGENDA_SORT_OPTIONS.map(option => [option.value, option.label]), [["time","Po vremenu"],["popularity","Po popularnosti"],["venue","Po imenu mesta"],["distance","Udaljeno od mene"]]);
const ordered = [
  makeEvent({_id:"tie-b",time:"20:00",timeStatus:"confirmed"}),
  makeEvent({_id:"unknown-a",time:"22:00",timeStatus:"unknown"}),
  makeEvent({_id:"day",time:"10:00",timeStatus:"confirmed"}),
  makeEvent({_id:"night",time:"23:00",timeStatus:"confirmed"}),
  makeEvent({_id:"tie-a",time:"20:00",timeStatus:"confirmed"}),
  makeEvent({_id:"after",time:"01:00",timeStatus:"confirmed"}),
  makeEvent({_id:"unknown-b",time:undefined,timeStatus:"unknown"}),
];
assert.deepEqual(sortAgendaEvents(ordered,"time").map(e=>e._id),["day","tie-b","tie-a","night","unknown-a","unknown-b","after"]);
assert.deepEqual(AGENDA_BAND_ORDER,["daytime","evening","night","time-not-announced","after-midnight"]);
const words=["Žurka","Đir","Čarolija","Centrala","Ćaskanje","Zabava","Šetnja","Džez"];
const alphaFixtures=words.map((word,index)=>makeEvent({_id:String(index),title:word,venue:word,time:index%2?"10:00":"23:00"}));
const expected=["Centrala","Čarolija","Ćaskanje","Džez","Đir","Šetnja","Zabava","Žurka"];
assert.deepEqual(sortAgendaEvents(alphaFixtures,"venue").map(e=>e.venue),expected);
const many=Array.from({length:125},(_,i)=>makeEvent({_id:String(i),venue:`Mesto ${124-i}`,title:`Događaj ${124-i}`}));
assert.deepEqual(sortAgendaEvents(many,"venue").slice(0,3).map(e=>e.venue),["Mesto 0","Mesto 1","Mesto 2"],"Sort the whole selection before any display page/window.");
const original=ordered.map(e=>e._id);sortAgendaEvents(ordered,"popularity");assert.deepEqual(ordered.map(e=>e._id),original,"Never mutate input snapshots.");
const popularFixtures = [
  makeEvent({ _id: "missing", time: "10:00" }),
  makeEvent({ _id: "zero", time: "18:00", venueInstagramFollowerCount: 0 }),
  makeEvent({ _id: "popular-later", time: "23:00", venueInstagramFollowerCount: 15_000 }),
  makeEvent({ _id: "invalid", time: "12:00", venueInstagramFollowerCount: -1 }),
  makeEvent({ _id: "popular-earlier", time: "20:00", venueInstagramFollowerCount: 15_000 }),
  makeEvent({ _id: "smaller", time: "14:00", venueInstagramFollowerCount: 6_000 }),
  makeEvent({ _id: "popular-tie", time: "20:00", venueInstagramFollowerCount: 15_000 }),
];
assert.deepEqual(sortAgendaEvents(popularFixtures, "popularity").map(event => event._id),
  ["popular-earlier", "popular-tie", "popular-later", "smaller", "zero", "missing", "invalid"],
  "Popularity orders by descending venue follower count, then by agenda time and source order.");
const display=[makeEvent({_id:"normalized",time:"23:00",displayTimeStart:"18:00",timeStatus:"confirmed"}),makeEvent({_id:"raw",time:"19:00",timeStatus:"confirmed"})];
assert.equal(sortAgendaEvents(display,"time")[0]._id,"normalized");
const origin = { latitude: 44.81, longitude: 20.46 };
const byDistance = [
  makeEvent({ _id: "missing", time: "10:00" }),
  makeEvent({ _id: "far", time: "11:00", venueLatitude: 44.87, venueLongitude: 20.48 }),
  makeEvent({ _id: "near-b", time: "23:00", venueLatitude: 44.811, venueLongitude: 20.46 }),
  makeEvent({ _id: "invalid", time: "12:00", venueLatitude: NaN, venueLongitude: 200 }),
  makeEvent({ _id: "near-a", time: "18:00", venueLatitude: 44.811, venueLongitude: 20.46 }),
];
assert.deepEqual(sortAgendaEvents(byDistance, "distance", origin).map(event => event._id),
  ["near-b", "near-a", "far", "missing", "invalid"],
  "Distance uses real coordinates over the complete set, keeps ties stable, and puts unavailable coordinates last.");
assert.deepEqual(sortAgendaEvents(byDistance, "distance").map(event => event._id), sortAgendaEvents(byDistance, "time").map(event => event._id),
  "Without permission or a GPS fix, distance sort safely retains the time order.");
assert.deepEqual(sortAgendaEvents(byDistance, "distance", { latitude: Infinity, longitude: 20 }).map(event => event._id),
  sortAgendaEvents(byDistance, "time").map(event => event._id), "An invalid origin must never produce a fabricated distance order.");
assert.deepEqual(byDistance.map(event => event._id), ["missing", "far", "near-b", "invalid", "near-a"], "Distance sort never mutates the original snapshot.");
assert.equal(
  browsePageSource.includes("month-events-table"),
  false,
  "Calendar browsing should not keep the removed whole-month event table.",
);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(
  packageJson.scripts["qa:public-sort"]?.includes("qa-public-event-sort.mjs"),
  "package.json should expose a focused public event sort QA script.",
);
assert.match(
  readFileSync("scripts/release-check.mjs", "utf8"),
  /qa:public-sort/,
  "Release gate should include the focused public event sort QA.",
);

console.log("QA passed: public events sort by venue name within each date.");
