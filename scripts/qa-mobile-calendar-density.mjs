import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDisplayEventTime, normalizeEventTime } from "../lib/events/event-time.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";

const calendarSource = readFileSync("app/(main)/events-browse-page.tsx", "utf8");
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

assert.ok(
  calendarSource.includes("data-calendar-mobile-event-row"),
  "Mobile calendar events should render as compact tappable rows with an explicit QA marker.",
);
assert.ok(
  eventKindToggleSource.includes("data-calendar-mobile-filter-chips"),
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
assert.ok(
  calendarSource.includes('data-calendar-sort-select="true"') &&
    calendarSource.includes('name="sort"') &&
    calendarSource.includes('<option value="type">Type</option>'),
  "Calendar filters should allow sorting the selected day by time or event type.",
);
assert.ok(
  calendarSource.includes("getNightlifeDefaultDateKey()") &&
    calendarSource.includes("dateKeyToLocalNoonDate(todayKey)") &&
    calendarSource.includes("defaultDayKey"),
  "Default calendar day should use the nightlife business date, not raw wall-clock today.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-07-11T06:59:00+02:00")),
  "2026-07-10",
  "Calendar home should keep showing the previous night before 07:00 Belgrade time.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-07-11T07:00:00+02:00")),
  "2026-07-11",
  "Calendar home should roll to the calendar date at 07:00 Belgrade time.",
);
assert.ok(
  !calendarSource.includes('name="type"') &&
    !calendarSource.includes('name="weekend"') &&
    !calendarSource.includes("All types") &&
    !calendarSource.includes("Weekend only") &&
    !calendarSource.includes("Focus"),
  "Calendar filter popover should only expose venue/sort/search controls; event Type and Focus filters are removed.",
);
assert.ok(
  calendarSource.includes("compareAgendaEventsByTime") &&
    calendarSource.includes("compareAgendaEventsByType") &&
    calendarSource.includes("selectedDayAgendaEvents.sort"),
  "Selected-day agenda events should be explicitly sorted by the chosen mode.",
);
assert.ok(
  calendarSource.includes('data-calendar-clear-filter={control.key}') &&
    calendarSource.includes('data-calendar-active-filter-chips="true"') &&
    calendarSource.includes('data-calendar-stat-card={stat.key}') &&
    calendarSource.includes('data-calendar-stat-value={stat.key}') &&
    calendarSource.includes('caption: "upcoming with something on"'),
  "Active filters should render removable chips and stat cards should expose updateable count markers; active-day copy should make the upcoming scope explicit.",
);
assert.ok(
  eventKindToggleSource.includes('data-calendar-kind-toggle={chip.key}') &&
    eventKindToggleSource.includes("router.replace(targetUrl, { scroll: false })") &&
    eventKindToggleSource.includes("syncDateStripAndMetricCounts") &&
    mobileMonthDayStripSource.includes("router.push(nextUrl, { scroll: false })") &&
    mobileMonthDayStripSource.includes('currentUrl.searchParams.get("hide")') &&
    mobileMonthDayStripSource.includes('data-calendar-date-kind-counts={JSON.stringify(day.categoryCounts)}') &&
    mobileMonthDayStripSource.includes('data-calendar-date-upcoming={day.isUpcoming ? "true" : undefined}') &&
    mobileMonthDayStripSource.includes('data-calendar-date-visible-event-count="true"') &&
    calendarSource.includes('data-calendar-event-kind={eventCategory}') &&
    calendarSource.includes("isUpcomingCalendarDay(dayKey, todayKey)") &&
    eventKindToggleSource.includes('dateLink.dataset.calendarDateUpcoming === "true"') &&
    calendarSource.includes('hidden={isHiddenByKind}'),
  "Tapping an event-kind chip should update URL, visible rows, selected counts, date-strip counts, upcoming active-day stats, and server state without a full document refresh.",
);
assert.ok(
  calendarSource.includes('data-calendar-mobile-search-panel="true"') &&
    calendarSource.includes('data-calendar-mobile-search-input={isMobileSearch ? "true" : undefined}'),
  "Mobile calendar search popover should expose only the compact search input.",
);
assert.ok(
  calendarSource.includes("border-primary/45 bg-primary/[0.14]") &&
    calendarSource.includes("focus:bg-primary/[0.18]") &&
    calendarSource.includes("isMobileSearch ? \"text-primary\""),
  "Mobile calendar search box should use the app's purple primary accent.",
);
assert.ok(
  calendarSource.includes("<AutoApplyFilterForm") &&
    calendarSource.includes("closeOnApply={isMobileFilter}") &&
    autoApplyFilterFormSource.includes('data-calendar-auto-apply-filter-form="true"') &&
    autoApplyFilterFormSource.includes("router.replace") &&
    autoApplyFilterFormSource.includes('searchParams.get("hide")') &&
    autoApplyFilterFormSource.includes('params.delete("category")') &&
    autoApplyFilterFormSource.includes("target instanceof HTMLSelectElement") &&
    autoApplyFilterFormSource.includes('closest("details")') &&
    autoApplyFilterFormSource.includes('removeAttribute("open")') &&
    !calendarSource.includes('{isMobileSearch ? "Search" : "Apply"}') &&
    !calendarSource.includes(">Apply<") &&
    !calendarSource.includes(">Reset<"),
  "Calendar filter selects should auto-apply without visible Apply/Reset buttons.",
);
assert.ok(
  calendarSource.includes('<span className={isMobileSearch ? "sr-only" : undefined}>Search</span>'),
  "Mobile calendar search popover should hide the repeated visible Search label while keeping an accessible label.",
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
assert.ok(
  mobileMonthDayStripSource.includes('data-calendar-mobile-date-strip={surface === "mobile" ? "true" : undefined}') &&
    mobileMonthDayStripSource.includes('data-calendar-desktop-date-strip={surface === "desktop" ? "true" : undefined}') &&
    mobileMonthDayStripSource.includes("surface?: \"mobile\" | \"desktop\"") &&
    mobileMonthDayStripSource.includes('data-calendar-date-event-count={day.eventCount}') &&
    mobileMonthDayStripSource.includes('data-calendar-date-selected={day.isSelected ? "true" : undefined}') &&
    calendarSource.includes('data-calendar-desktop-date-selector="true"') &&
    calendarSource.includes('<MobileMonthDayStrip days={mobileMonthDays} surface="desktop" />'),
  "Calendar date slider should be available on both mobile and desktop with stable QA/count markers.",
);
assert.ok(
  calendarSource.includes('aria-label="Previous day"') &&
    calendarSource.includes('aria-label="Next day"') &&
    calendarSource.includes("const previousDayKey = formatDateKey(previousDay)") &&
    calendarSource.includes("const nextDayKey = formatDateKey(nextDay)") &&
    calendarSource.includes("month: formatMonthParam(previousDay)") &&
    calendarSource.includes("day: previousDayKey") &&
    calendarSource.includes("month: formatMonthParam(nextDay)") &&
    calendarSource.includes("day: nextDayKey") &&
    !calendarSource.includes('aria-label="Previous month"') &&
    !calendarSource.includes('aria-label="Next month"'),
  "Top calendar arrows should move one selected day backward/forward, not jump whole months.",
);
assert.ok(
  !calendarSource.includes("Month grid") &&
    !calendarSource.includes("getCalendarDays") &&
    !calendarSource.includes("WEEKDAY_LABELS") &&
    !calendarSource.includes("calendarDays.map") &&
    !calendarSource.includes("min-w-[56rem]") &&
    !calendarSource.includes("grid grid-cols-7"),
  "The old full bottom month calendar grid should be removed across desktop and other breakpoints.",
);
assert.ok(
  mobileMonthDayStripSource.includes("inline: \"center\"") &&
    mobileMonthDayStripSource.includes("scrollIntoView") &&
    mobileMonthDayStripSource.includes("scrollAnchorIntoView"),
  "Selecting a mobile calendar date should gently center the tapped/selected day.",
);
assert.ok(
  mobileMonthDayStripSource.includes('behavior: shouldReduceMotion() ? "auto" : "smooth"') &&
    mobileMonthDayStripSource.includes('"(prefers-reduced-motion: reduce)"'),
  "Mobile calendar date slider should use smooth motion while respecting reduced-motion users.",
);
assert.ok(
  mobileMonthDayStripSource.includes("snap-center") &&
    mobileMonthDayStripSource.includes("overscroll-x-contain") &&
    mobileMonthDayStripSource.includes("scroll-smooth"),
  "Mobile calendar date slider should use centered scroll snapping with contained momentum.",
);
assert.ok(
  calendarSource.includes("<CalendarScrollRestoration />") &&
    calendarSource.includes('data-calendar-event-link="true"') &&
    calendarSource.includes('data-calendar-scroll-region="selected-day-agenda"') &&
    eventDetailSource.includes("EventCalendarBackLink") &&
    eventDetailSource.includes("const calendarHref = event ? buildCalendarHref(event) : \"/\""),
  "Opening an event from the calendar should preserve enough return context for exact scroll restoration.",
);
assert.ok(
  calendarScrollRestorationSource.includes("CALENDAR_RESTORE_REQUEST_STORAGE_KEY") &&
    calendarScrollRestorationSource.includes("saveCalendarScrollPosition") &&
    calendarScrollRestorationSource.includes("restoreCalendarScrollPosition") &&
    calendarScrollRestorationSource.includes("window.scrollTo") &&
    calendarScrollRestorationSource.includes("window.history.scrollRestoration = \"manual\"") &&
    calendarScrollRestorationSource.includes("data-calendar-event-link") &&
    calendarScrollRestorationSource.includes("data-calendar-scroll-region"),
  "Calendar scroll restoration should save scroll before event navigation and restore it on return/back.",
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
