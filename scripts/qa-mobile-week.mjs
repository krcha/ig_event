import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getMobileDayHeading, getMobileDayLabel, getMobileWeekDateKeys, getMobileWeekFill, getMobileWeekOverviewWindows } from "../lib/events/mobile-week.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";
import { buildCalendarFilterUrl } from "../lib/events/calendar-filter-url.ts";

const today = "2026-10-29";
assert.deepEqual(getMobileWeekDateKeys(today), [
  "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04",
]);
assert.deepEqual(getMobileWeekDateKeys("2026-12-29").slice(-3), ["2027-01-02", "2027-01-03", "2027-01-04"]);
assert.deepEqual(getMobileWeekDateKeys("2028-02-27").slice(0, 4), ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
assert.equal(getMobileDayHeading(today, today), "Gde danas?");
assert.equal(getMobileDayHeading("2026-10-30", today), "Gde sutra?");
for (const [date, name] of [["2026-11-02", "ponedeljak"], ["2026-11-03", "utorak"], ["2026-11-04", "sredu"], ["2026-11-05", "četvrtak"], ["2026-11-06", "petak"], ["2026-10-31", "subotu"], ["2026-11-01", "nedelju"]]) {
  assert.equal(getMobileDayHeading(date, today), `Gde u ${name}?`);
}
assert.deepEqual(getMobileWeekDateKeys(today).map((date) => getMobileDayLabel(date, today)), ["Danas", "Sutra", "Sub", "Ned", "Pon", "Uto", "Sre"]);
assert.equal(getMobileWeekFill(0, 122), 6);
assert.equal(getMobileWeekFill(61, 122), 50);
assert.equal(getMobileWeekFill(122, 122), 100);
assert.equal(getMobileWeekFill(0, 0), 6);
assert.equal(getMobileWeekFill(999, 122), 100);
assert.deepEqual(getMobileWeekOverviewWindows(today, {fromDate:"2026-10-01",beforeDate:"2026-11-01"}), [
  {fromDate:"2026-11-01",beforeDate:"2026-11-05"},
]);
assert.deepEqual(getMobileWeekOverviewWindows(today, {fromDate:"2026-11-01",beforeDate:"2026-12-01"}), [
  {fromDate:today,beforeDate:"2026-11-01"},
]);
assert.deepEqual(getMobileWeekOverviewWindows("2026-10-15", {fromDate:"2026-10-01",beforeDate:"2026-11-01"}), []);
assert.deepEqual(getMobileWeekOverviewWindows(today), [{fromDate:today,beforeDate:"2026-11-05"}]);
assert.deepEqual(getMobileWeekOverviewWindows(today, {fromDate:"2027-01-01",beforeDate:"2027-02-01"}), [{fromDate:today,beforeDate:"2026-11-05"}]);
assert.deepEqual(getMobileWeekOverviewWindows("2026-12-29", {fromDate:"2026-12-01",beforeDate:"2027-01-01"}), [{fromDate:"2027-01-01",beforeDate:"2027-01-05"}]);
// The combined counters must neither double count nor omit a week date.
for (const covered of [undefined, {fromDate:"2026-10-01",beforeDate:"2026-11-01"}, {fromDate:"2026-11-01",beforeDate:"2026-12-01"}, {fromDate:"2026-10-31",beforeDate:"2026-11-02"}]) {
  const ranges = [...(covered ? [covered] : []), ...getMobileWeekOverviewWindows(today, covered)];
  for (const date of getMobileWeekDateKeys(today)) {
    assert.equal(ranges.filter(range => date >= range.fromDate && date < range.beforeDate).length, 1);
  }
}
const searchUrl = new URL(buildCalendarFilterUrl("/", [
  ["month", "2026-10"], ["day", "2026-10-29"], ["q", "jazz"], ["sort", "time"],
], "https://eventzeka.com/?month=2026-10&day=2026-10-29&hide=live,culture,event&open=now"), "https://eventzeka.com");
assert.equal(searchUrl.searchParams.get("hide"), "live,culture,event", "Search must preserve the category selected in the live URL.");
assert.equal(searchUrl.searchParams.get("q"), "jazz");
assert.equal(searchUrl.searchParams.get("open"), "now", "Search must preserve active Open now alongside the selected category.");
// Belgrade DST and the existing 07:00 nightlife rollover remain the source of today.
assert.equal(getNightlifeDefaultDateKey(new Date("2026-10-25T05:59:00Z")), "2026-10-24");
assert.equal(getNightlifeDefaultDateKey(new Date("2026-10-25T06:00:00Z")), "2026-10-25");

const source = readFileSync("app/(main)/events-browse-page.tsx", "utf8");
const agendaSource = readFileSync("components/calendar/calendar-agenda.tsx", "utf8");
const overviewApiSource = readFileSync("app/api/calendar/overview/route.ts", "utf8");
const weekSource = readFileSync("components/calendar/mobile-week-calendar.tsx", "utf8");
const style = readFileSync("components/calendar/mobile-week-calendar.module.css", "utf8");
const homeStyle = readFileSync("components/calendar/mobile-events-home.module.css", "utf8");
assert.match(overviewApiSource, /extraWeekWindows\.map\(window => loadPublicCalendarOverviewWindow/);
assert.doesNotMatch(source, /loadPublicCalendarOverviewWindow/, "Day rendering must not await monthly overview reads.");
assert.match(source, /<MobileMonthDayStrip days=\{mobileMonthDays\} surface="desktop"/);
assert.match(source, /\[\.\.\.selectedDayAgendaEvents\]\.sort\(compareAgendaEventsByTime\)/);
assert.equal((source.match(/<CalendarAgenda\b/g) ?? []).length, 1, "One agenda projection must serve both breakpoints.");
assert.match(agendaSource, /useSyncExternalStore/);
assert.match(agendaSource, /left\.mobileOrder - right\.mobileOrder/);
assert.match(source, /placeholder="Izvođač, mesto ili žanr"/);
assert.match(agendaSource, /singleSelection=\{mobileWeek\}/);
assert.match(agendaSource, /afterAll=\{mobileWeek \? <OpenNowFilter active=\{openNowActive\} appearance="chip" href=\{openNowHref\}/);
assert.match(weekSource, /url\.searchParams\.set\("month", dayKey\.slice\(0, 7\)\)/);
assert.match(weekSource, /disabled=\{dayKey < todayKey\}/);
assert.match(weekSource, /data-calendar-client-navigation="true"/, "Weekly date links must reach their existing client router rather than force a document reload.");
assert.match(style, /height: 68px/);
assert.match(style, /repeat\(7, minmax\(0, 1fr\)\)/);
assert.match(style, /prefers-reduced-motion: reduce/);
assert.doesNotMatch(style, /animation\s*:|@keyframes|data:image\/svg/, "Week tiles must not continuously animate or repeat an SVG wave surface.");
assert.match(homeStyle, /max-width: 767px/);
assert.match(homeStyle, /height: 52px/);
assert.match(homeStyle, /position: sticky; top: 0/);
console.log("QA passed: mobile seven-day water calendar, future month picker, Serbian headings, bounded counts, responsive scope, and time sorting.");
