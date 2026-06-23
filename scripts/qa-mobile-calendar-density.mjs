import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDisplayEventTime, normalizeEventTime } from "../lib/events/event-time.ts";

const calendarSource = readFileSync("app/(main)/events-browse-page.tsx", "utf8");
const eventDetailSource = readFileSync("app/(main)/events/[eventId]/page.tsx", "utf8");
const eventMetaSource = readFileSync("components/events/event-meta.tsx", "utf8");
const saveEventButtonSource = readFileSync("components/events/save-event-button.tsx", "utf8");
const savedLibraryPanelSource = readFileSync("components/saved/saved-library-panel.tsx", "utf8");
const publicEventUiSources = [
  ["events browse page", calendarSource],
  ["calendar redirect page", readFileSync("app/(main)/calendar/page.tsx", "utf8")],
  ["events redirect page", readFileSync("app/(main)/events/page.tsx", "utf8")],
  ["event detail page", eventDetailSource],
  ["home page", readFileSync("app/page.tsx", "utf8")],
];

assert.ok(
  calendarSource.includes("data-calendar-mobile-event-row"),
  "Mobile calendar events should render as compact tappable rows with an explicit QA marker.",
);
assert.ok(
  calendarSource.includes("data-calendar-mobile-filter-chips"),
  "Mobile calendar category filters should be compact chips directly above the event list.",
);
assert.ok(
  calendarSource.includes("data-calendar-mobile-search-button"),
  "Mobile calendar should expose advanced search through a compact icon button.",
);
assert.ok(
  calendarSource.includes("data-calendar-mobile-filter-button"),
  "Mobile calendar should expose advanced filters through a compact icon button.",
);
assert.equal(
  calendarSource.includes("Filters & search"),
  false,
  "Mobile calendar should not keep the old large Filters & search block.",
);
assert.equal(
  calendarSource.includes("<span>Search</span>\n              <span className=\"text-border\">|</span>\n              <span>Filter</span>"),
  false,
  "Mobile search/filter controls should no longer be a wide text summary in the top calendar bar.",
);
assert.equal(
  calendarSource.includes("#{index + 1}"),
  false,
  "Compact mobile event rows should not spend vertical space on repeated row numbers.",
);

const mobileRowStart = calendarSource.indexOf("data-calendar-mobile-event-row");
const mobileRowSource = calendarSource.slice(Math.max(0, mobileRowStart - 900), mobileRowStart + 1_500);
assert.ok(
  mobileRowSource.includes("event.time") &&
    mobileRowSource.includes("event.title") &&
    mobileRowSource.includes("event.venue") &&
    mobileRowSource.includes("tone.name"),
  "Compact mobile rows should include time when available, title, venue, and category.",
);
assert.equal(
  mobileRowSource.includes("TBA"),
  false,
  "Compact mobile rows should hide the time value entirely when no event time is available, not render TBA.",
);
assert.equal(getDisplayEventTime(undefined), undefined, "Missing event time should stay hidden.");
assert.equal(getDisplayEventTime("   "), undefined, "Blank event time should stay hidden.");
assert.equal(getDisplayEventTime("TBA"), undefined, "Literal TBA event time should stay hidden.");
assert.equal(
  getDisplayEventTime("Time TBA"),
  undefined,
  "Literal Time TBA event time should stay hidden.",
);
assert.equal(getDisplayEventTime("23:30"), "23:30", "Real event time should still render.");
assert.equal(
  getDisplayEventTime("20:00-03:00"),
  "20:00–03:00",
  "Short event time ranges should render as clean compact ranges.",
);
assert.equal(
  getDisplayEventTime("until 17:00 Medonosni vrt open; 16:00-22:00 Market"),
  undefined,
  "Long descriptive schedule strings should not render inside compact time zones.",
);
assert.deepEqual(
  normalizeEventTime("until 17:00 Medonosni vrt open; 16:00-22:00 Market"),
  {
    allDay: true,
    description: "until 17:00 Medonosni vrt open; 16:00-22:00 Market",
  },
  "Long schedule strings should be carried as clamped description metadata instead of time labels.",
);
for (const [label, source] of publicEventUiSources) {
  assert.equal(
    /event\.time\s*\?\?\s*["'](?:Time )?TBA["']/.test(source) ||
      /value\s*\?\?\s*["']TBA["']/.test(source),
    false,
    `${label} should not render a TBA placeholder for missing event time.`,
  );
}
assert.equal(
  mobileRowSource.includes("formatAgendaMeta") || mobileRowSource.includes("ArrowUpRight"),
  false,
  "Compact mobile rows should not include repeated metadata or a large circular arrow action.",
);

for (const color of ["#8B86FB", "#FB7185", "#FBBF24", "#34D399"]) {
  assert.ok(eventMetaSource.includes(color), `Event category pills should include ${color}.`);
}
for (const rgba of [
  "rgba(139, 134, 251, 0.14)",
  "rgba(251, 113, 133, 0.14)",
  "rgba(251, 191, 36, 0.14)",
  "rgba(52, 211, 153, 0.14)",
]) {
  assert.ok(eventMetaSource.includes(rgba), `Event category pill background should include ${rgba}.`);
}
assert.equal(
  /EventCategoryPill[\s\S]*?className=\{cn\([\s\S]*?border/.test(eventMetaSource),
  false,
  "Event category pills should be soft filled with no border class.",
);
for (const [label, source] of [
  ["events browse page", calendarSource],
  ["saved tab", savedLibraryPanelSource],
  ["event detail page", eventDetailSource],
]) {
  assert.ok(source.includes("EventMetaRow"), `${label} should render category/price/going metadata rows.`);
}
assert.ok(
  saveEventButtonSource.includes("fill-[#8B86FB]") && saveEventButtonSource.includes("fill-transparent"),
  "Saved bookmarks should render filled accent icons while unsaved bookmarks stay outline-only.",
);
assert.ok(
  saveEventButtonSource.includes("isLibraryLoaded ? savedEventIds.has(eventId)") &&
    saveEventButtonSource.includes("defaultSaved"),
  "Saved bookmark state should stop relying on defaultSaved after the library hydrates.",
);

console.log("QA passed: mobile calendar uses compact event rows and chip-style filters.");
