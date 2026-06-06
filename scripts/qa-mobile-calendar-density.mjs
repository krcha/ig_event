import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDisplayEventTime } from "../lib/events/event-time.ts";

const calendarSource = readFileSync("app/(main)/calendar/page.tsx", "utf8");
const publicEventUiSources = [
  ["calendar page", calendarSource],
  ["events page", readFileSync("app/(main)/events/page.tsx", "utf8")],
  ["event detail page", readFileSync("app/(main)/events/[eventId]/page.tsx", "utf8")],
  ["home page", readFileSync("app/page.tsx", "utf8")],
  ["month events table", readFileSync("components/calendar/month-events-table.tsx", "utf8")],
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

console.log("QA passed: mobile calendar uses compact event rows and chip-style filters.");
