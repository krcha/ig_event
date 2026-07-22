import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CALENDAR_TIME_BANDS,
  getCalendarTimeBandKey,
  groupCalendarEventsByTimeBand,
} from "../lib/events/calendar-time-bands.ts";

const expectedBandKeys = [
  "after-midnight",
  "daytime",
  "evening",
  "night",
  "time-not-announced",
];

assert.deepEqual(
  CALENDAR_TIME_BANDS.map((band) => band.key),
  expectedBandKeys,
  "Calendar time bands must stay in deterministic chronological order with unknown times last.",
);
assert.equal(
  CALENDAR_TIME_BANDS.at(-1)?.label,
  "Time not announced",
  "Unknown-time events need an explicit, user-facing group label.",
);

const boundaryFixtures = [
  {
    id: "midnight",
    displayTimeStart: "00:00",
    timeStatus: "confirmed",
    expected: "after-midnight",
  },
  {
    id: "before-six",
    time: "05:59",
    timeStatus: "inferred",
    expected: "after-midnight",
  },
  { id: "six", time: "06:00", timeStatus: "confirmed", expected: "daytime" },
  {
    id: "before-six-pm",
    time: "17:59",
    timeStatus: "inferred",
    expected: "daytime",
  },
  { id: "six-pm", time: "18:00", timeStatus: "confirmed", expected: "evening" },
  {
    id: "before-ten",
    time: "21:59",
    timeStatus: "inferred",
    expected: "evening",
  },
  { id: "ten", time: "22:00", timeStatus: "confirmed", expected: "night" },
  {
    id: "end-of-day",
    time: "23:59",
    timeStatus: "inferred",
    expected: "night",
  },
  {
    id: "unknown-status-wins",
    time: "22:30",
    timeStatus: "unknown",
    expected: "time-not-announced",
  },
  {
    id: "blank",
    time: "",
    timeStatus: "confirmed",
    expected: "time-not-announced",
  },
  { id: "missing", timeStatus: "inferred", expected: "time-not-announced" },
];

for (const fixture of boundaryFixtures) {
  assert.equal(
    getCalendarTimeBandKey(fixture),
    fixture.expected,
    `${fixture.id} should map to ${fixture.expected}.`,
  );
}

assert.equal(
  getCalendarTimeBandKey({
    displayTimeStart: "18:30",
    time: "02:00",
    timeStatus: "confirmed",
  }),
  "evening",
  "Normalized displayTimeStart must take precedence over stale/raw time text.",
);

const orderedFixtures = [
  { id: "night-b", time: "23:00", timeStatus: "confirmed" },
  { id: "unknown-a", timeStatus: "unknown" },
  { id: "day-a", time: "09:00", timeStatus: "inferred" },
  { id: "night-a", time: "22:00", timeStatus: "confirmed" },
  { id: "after-a", time: "01:00", timeStatus: "inferred" },
  { id: "evening-a", time: "20:00", timeStatus: "confirmed" },
];
const orderedGroups = groupCalendarEventsByTimeBand(orderedFixtures);
assert.deepEqual(
  orderedGroups.map((group) => group.key),
  expectedBandKeys,
  "Non-empty groups must render in deterministic band order regardless of input order.",
);
assert.deepEqual(
  orderedGroups
    .find((group) => group.key === "night")
    ?.events.map((event) => event.id),
  ["night-b", "night-a"],
  "Grouping must preserve the selected agenda sort within each band.",
);

const denseFixture = Array.from({ length: 83 }, (_, index) => {
  const mode = index % 5;
  if (mode === 0) {
    return {
      id: `dense-${index}`,
      time: `0${index % 6}:15`,
      timeStatus: "confirmed",
    };
  }
  if (mode === 1) {
    return {
      id: `dense-${index}`,
      time: `${String(6 + (index % 12)).padStart(2, "0")}:30`,
      timeStatus: "inferred",
    };
  }
  if (mode === 2) {
    return {
      id: `dense-${index}`,
      time: `${18 + (index % 4)}:45`,
      timeStatus: "confirmed",
    };
  }
  if (mode === 3) {
    return {
      id: `dense-${index}`,
      time: `${22 + (index % 2)}:00`,
      timeStatus: "inferred",
    };
  }
  return { id: `dense-${index}`, timeStatus: "unknown" };
});
const denseGroups = groupCalendarEventsByTimeBand(denseFixture);
const denseIds = denseGroups.flatMap((group) =>
  group.events.map((event) => event.id),
);
assert.equal(
  denseIds.length,
  denseFixture.length,
  "Every dense-day event must remain visible in one group.",
);
assert.equal(
  new Set(denseIds).size,
  denseFixture.length,
  "Dense-day grouping must never duplicate event cards.",
);
assert.deepEqual(
  [...denseIds].sort(),
  denseFixture.map((event) => event.id).sort(),
  "Dense-day grouping must never omit a matching event.",
);
for (const group of denseGroups) {
  for (const event of group.events) {
    assert.equal(
      getCalendarTimeBandKey(event),
      group.key,
      `Event ${event.id} must appear only in its computed time band.`,
    );
  }
}

const calendarSource = readFileSync(
  "app/(main)/events-browse-page.tsx",
  "utf8",
);
const kindToggleSource = readFileSync(
  "components/calendar/event-kind-toggle-chips.tsx",
  "utf8",
);
const groupingStart = calendarSource.indexOf("function renderAgendaCards");
const groupingEnd = calendarSource.indexOf("if (mobile)", groupingStart);
const groupingSource = calendarSource.slice(groupingStart, groupingEnd);

assert.ok(
  calendarSource.includes("groupCalendarEventsByTimeBand(agendaEvents)") &&
    calendarSource.includes("agendaTimeBandGroups.map"),
  "The selected-day agenda must render through the deterministic time-band helper.",
);
assert.ok(
  calendarSource.includes('| "timeStatus"') &&
    calendarSource.includes("timeStatus: event.timeStatus") &&
    calendarSource.includes('event.timeStatus === "unknown"'),
  "The agenda summary and time sort must preserve explicit unknown-time provenance even when stale time text exists.",
);
assert.ok(
  groupingSource.includes("aria-labelledby=") &&
    groupingSource.includes("data-calendar-time-band={timeBand.key}") &&
    groupingSource.includes("data-calendar-time-band-visible-count"),
  "Every time band must have an accessible heading and an explicit visible-count target.",
);
assert.ok(
  groupingSource.includes("min-w-0") &&
    groupingSource.includes("truncate") &&
    !groupingSource.includes("min-w-["),
  "Time-band headings must shrink safely without introducing a fixed minimum width at 320px.",
);
assert.equal(
  groupingSource.includes("<details") || groupingSource.includes("line-clamp"),
  false,
  "Time-band groups must not collapse or truncate matching events by default.",
);
assert.ok(
  calendarSource.includes("data-calendar-event-id={event._id}") &&
    calendarSource.includes(
      "data-calendar-time-band-event-count={timeBand.events.length}",
    ),
  "Rendered rows and groups need deterministic identity/count markers for visible-card verification.",
);
assert.ok(
  kindToggleSource.includes(
    'querySelectorAll<HTMLElement>("[data-calendar-time-band]")',
  ) &&
    kindToggleSource.includes("timeBand.hidden = visibleTimeBandCount === 0") &&
    kindToggleSource.includes(
      "target.textContent = pluralize(visibleTimeBandCount)",
    ),
  "Auto-applying category filters must update each group count and hide only empty groups.",
);
assert.ok(
  kindToggleSource.includes("router.replace(targetUrl, { scroll: false })") &&
    kindToggleSource.includes(
      'window.addEventListener("popstate", onPopState)',
    ),
  "Grouping must preserve URL-authoritative auto-apply and Back/forward synchronization.",
);
assert.equal(
  calendarSource.includes(">Apply<") || calendarSource.includes(">Reset<"),
  false,
);
assert.equal(
  calendarSource.includes('name="type"') || calendarSource.includes("Focus"),
  false,
);

console.log(
  "Calendar time-band QA passed: 83 dense events remain unique/visible, boundaries and unknown times are deterministic, and filter counts stay synchronized.",
);
