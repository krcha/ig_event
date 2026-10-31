import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDisplayEventTime, normalizeEventTime } from "../lib/events/event-time.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";

const calendarSource = ["app/(main)/events-browse-page.tsx", "components/calendar/calendar-agenda.tsx", "components/calendar/calendar-overview.tsx", "components/calendar/event-post-preview.tsx", "components/calendar/events-toolbar.tsx"].map(path => readFileSync(path, "utf8")).join("\n");
const autoApplyFilterFormSource = readFileSync(
  "components/calendar/auto-apply-filter-form.tsx",
  "utf8",
);
const eventKindToggleSource = readFileSync(
  "components/calendar/event-kind-toggle-chips.tsx",
  "utf8",
);
const mobileMonthDayStripSource = readFileSync(
  "components/calendar/mobile-month-day-strip.tsx",
  "utf8",
);
const calendarScrollRestorationSource = readFileSync(
  "components/calendar/calendar-scroll-restoration.tsx",
  "utf8",
);
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

assert.match(calendarSource,/data-calendar-mobile-event-row/);
assert.match(calendarSource,/aria-label="Filteri"/);
assert.match(calendarSource,/aria-expanded=\{filtersOpen\}/);
assert.match(calendarSource,/aria-controls="events-extra-filters"/);
assert.match(calendarSource,/hidden=\{!filtersOpen\}/);
assert.match(calendarSource,/data-calendar-sort-select="true"/);
assert.match(calendarSource,/sortAgendaEvents\(selectedDayAgendaEvents, selectedSortMode\)/);
assert.match(calendarSource,/getNightlifeDefaultDateKey\(new Date\(now\)\)/);
assert.match(calendarSource,/openNowActive \? getOpenNowEventWindow\(now\)/);
assert.match(calendarSource,/dateKeyToLocalNoonDate\(todayKey\)/);
assert.match(calendarSource,/EventMetaRow/);
assert.match(calendarSource,/<CalendarScrollRestoration \/>/);
assert.match(calendarSource,/data-calendar-event-link="true"/);
assert.match(eventDetailSource,/EventCalendarBackLink/);
assert.match(calendarScrollRestorationSource,/restoreCalendarScrollPosition/);
assert.match(calendarScrollRestorationSource,/window.history.scrollRestoration = "manual"/);
assert.match(autoApplyFilterFormSource,/buildCalendarFilterUrl/);
assert.match(autoApplyFilterFormSource,/window.location.href/);
assert.match(autoApplyFilterFormSource,/router.replace/);
assert.match(eventKindToggleSource,/router.replace\(targetUrl, \{ scroll: false \}\)/);
assert.match(eventKindToggleSource,/syncDateStripAndMetricCounts/);
assert.match(eventKindToggleSource,/window.addEventListener\("popstate", onPopState\)/);
assert.doesNotMatch(calendarSource,/name="type"|name="weekend"|Ime mesta/);
assert.doesNotMatch(calendarSource,/min-w-\[56rem\]|month-events-table/);
assert.equal(getNightlifeDefaultDateKey(new Date("2026-07-11T06:59:00+02:00")),"2026-07-10");
assert.equal(getNightlifeDefaultDateKey(new Date("2026-07-11T07:00:00+02:00")),"2026-07-11");

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
  readFileSync("components/calendar/calendar-agenda.tsx", "utf8").includes("formatAgendaMeta") ||
    readFileSync("components/calendar/calendar-agenda.tsx", "utf8").includes("ArrowUpRight"),
  false,
  "Compact mobile rows should not include repeated metadata or a large circular arrow action.",
);

for (const color of ["#A99BFF", "#FF80A1", "#F6C94C", "#7AD6B0"]) {
  assert.ok(eventMetaSource.includes(color), `Event category pills should include ${color}.`);
}
for (const rgba of [
  "rgba(169, 155, 255, 0.14)",
  "rgba(255, 128, 161, 0.14)",
  "rgba(246, 201, 76, 0.14)",
  "rgba(122, 214, 176, 0.14)",
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
  saveEventButtonSource.includes("fill-[#D5F56B]") && saveEventButtonSource.includes("fill-transparent"),
  "Saved bookmarks should render filled accent icons while unsaved bookmarks stay outline-only.",
);
assert.ok(
  saveEventButtonSource.includes("isLibraryLoaded ? savedEventIds.has(eventId)") &&
    saveEventButtonSource.includes("defaultSaved"),
  "Saved bookmark state should stop relying on defaultSaved after the library hydrates.",
);

await import("./qa-calendar-date-strip.mjs");
console.log("QA passed: mobile calendar uses compact event rows and chip-style filters.");
