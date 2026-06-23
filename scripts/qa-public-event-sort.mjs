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
