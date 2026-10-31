import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListMusic,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  loadPublicCalendarEventsWindow,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { AutoApplyFilterForm } from "@/components/calendar/auto-apply-filter-form";
import { CalendarScrollRestoration } from "@/components/calendar/calendar-scroll-restoration";
import { CalendarAgenda } from "@/components/calendar/calendar-agenda";
import { CalendarOverviewProvider, CalendarStatValue, CalendarVenueSelect } from "@/components/calendar/calendar-overview";
import { projectCalendarAgendaEvents } from "@/lib/events/calendar-agenda-projection";
import type { CalendarEventSummary } from "@/lib/events/calendar-agenda-types";
import { resolveCalendarVenueSelection } from "@/lib/events/calendar-venue-selection";
import { JsonLd } from "@/components/seo/json-ld";
import { MobileMonthDayStrip } from "@/components/calendar/mobile-month-day-strip";
import { MobileWeekCalendar } from "@/components/calendar/mobile-week-calendar";
import { getMobileDayHeading, getMobileDayLabel, getMobileWeekDateKeys } from "@/lib/events/mobile-week";
import mobileStyles from "@/components/calendar/mobile-events-home.module.css";
import { getEventCategoryKind, type EventCategoryKind } from "@/components/events/event-meta";
import { EVENT_PRIMARY_CATEGORIES, normalizeHiddenEventCategories } from "@/lib/taxonomy/event-categories";
import { cn } from "@/lib/utils";
import {
  getEventTimeSortMinutes,
} from "@/lib/events/event-time";
import { addDaysToDateKey, dateKeyToLocalNoonDate, getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
import { getOpenNowEventState, getOpenNowEventWindow, type OpenNowEventState } from "@/lib/venues/venue-open-now";
import { matchesPublicEventNameArtistOrVenue } from "@/lib/events/public-event-search";
import { HOME_FAQ_ITEMS, buildHomePageStructuredData } from "@/lib/seo/site";
import {
  buildPublicEventVenueFilterOptions,
  getPublicEventVenueFilterValue,
  matchesPublicEventVenueFilter,
} from "@/lib/events/public-event-venue-filter";

// Keep the public calendar out of Next.js' persisted route cache. The page data
// comes from Convex and must reflect completed ingestion runs without manual
// cache purges.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type CalendarSearchParams = {
  month?: string | string[];
  day?: string | string[];
  venue?: string | string[];
  category?: string | string[];
  hide?: string | string[];
  sort?: string | string[];
  q?: string | string[];
  open?: string | string[];
};

type CalendarPageProps = {
  searchParams?: Promise<CalendarSearchParams>;
};

const DAY_CATEGORY_CHIPS = [
  { key: "all", label: "All" },
  ...EVENT_PRIMARY_CATEGORIES,
] as const;

type DayCategory = (typeof DAY_CATEGORY_CHIPS)[number]["key"];
type AgendaSortMode = "time" | "type" | "venue";

const DAY_CATEGORY_SORT_ORDER = Object.fromEntries(
  EVENT_PRIMARY_CATEGORIES.map((category, index) => [category.key, index]),
) as Record<Exclude<DayCategory, "all">, number>;

type ConcreteDayCategory = Exclude<DayCategory, "all">;

type DayCategoryCounts = Record<ConcreteDayCategory, number>;

type CalendarDayBucket = {
  categoryCounts: DayCategoryCounts;
  eventCount: number;
};

function normalizeHiddenDayCategories(value: string | undefined): ConcreteDayCategory[] {
  return normalizeHiddenEventCategories(value?.split(",") ?? []);
}

function formatHiddenDayCategories(categories: readonly ConcreteDayCategory[]): string | undefined {
  return categories.length > 0 ? categories.join(",") : undefined;
}

function normalizeAgendaSortMode(value: string | undefined): AgendaSortMode {
  return value === "time" || value === "type" ? value : "venue";
}

function getSingleValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function formatMonthParam(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function parseMonthParam(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  }

  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  }

  return new Date(year, month - 1, 1);
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }

  const value = query.toString();
  return value ? `?${value}` : "";
}

function getMonthDays(monthStart: Date): Date[] {
  const dayCount = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();

  return Array.from({ length: dayCount }, (_, index) => {
    return new Date(monthStart.getFullYear(), monthStart.getMonth(), index + 1);
  });
}

function isWeekendDate(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// These formats are fixed for this page. Reuse ICU formatters instead of
// rebuilding their locale data for every calendar cell and every request.
const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const agendaCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareAlphabetical(left: string, right: string): number {
  return agendaCollator.compare(left.trim(), right.trim());
}

function eventMatchesSearch(event: PublicEvent, query: string | undefined): boolean {
  return matchesPublicEventNameArtistOrVenue(event, query);
}

function getSelectedDay(
  monthStart: Date,
  requestedDay: string | undefined,
  defaultDayKey: string,
): string {
  const monthParam = formatMonthParam(monthStart);
  if (requestedDay?.startsWith(`${monthParam}-`) && parseNormalizedEventDate(requestedDay)) {
    return requestedDay;
  }

  const today = dateKeyToLocalNoonDate(defaultDayKey);
  const todayKey = defaultDayKey;
  if (
    today.getFullYear() === monthStart.getFullYear() &&
    today.getMonth() === monthStart.getMonth()
  ) {
    return todayKey;
  }

  return formatDateKey(monthStart);
}

function eventMatchesFilters(
  event: PublicEvent,
  venue: string | undefined,
  query: string | undefined,
): boolean {
  if (!matchesPublicEventVenueFilter(event, venue)) {
    return false;
  }

  return eventMatchesSearch(event, query);
}

function toCalendarEventSummary(event: PublicEvent): CalendarEventSummary {
  return {
    _id: event._id,
    title: event.title,
    description: event.description,
    date: event.date,
    time: event.time,
    timeStatus: event.timeStatus,
    dayPeriod: event.dayPeriod,
    displayTimeEnd: event.displayTimeEnd,
    displayTimeLabel: event.displayTimeLabel,
    displayTimeSource: event.displayTimeSource,
    displayTimeStart: event.displayTimeStart,
    venue: event.venue,
    venueId: event.venueId,
    venueCategory: event.venueCategory,
    venueHours: event.venueHours,
    artists: event.artists,
    eventType: event.eventType,
    ticketPrice: event.ticketPrice,
    attendance: event.attendance,
    attendanceCount: event.attendanceCount,
    attendeeCount: event.attendeeCount,
    attendees: event.attendees,
    attendeesCount: event.attendeesCount,
    going: event.going,
    goingCount: event.goingCount,
  };
}

function getDayCategory(event: CalendarEventSummary): ConcreteDayCategory {
  return getEventCategoryKind(event);
}

function getAgendaEventSortMinutes(event: CalendarEventSummary): number {
  if (event.timeStatus === "unknown") {
    return Number.POSITIVE_INFINITY;
  }
  return getEventTimeSortMinutes(event.displayTimeStart ?? event.time) ?? Number.POSITIVE_INFINITY;
}

function compareAgendaEventsByTime(left: CalendarEventSummary, right: CalendarEventSummary): number {
  const timeResult = getAgendaEventSortMinutes(left) - getAgendaEventSortMinutes(right);
  if (timeResult !== 0) {
    return timeResult;
  }

  const venueResult = compareAlphabetical(left.venue, right.venue);
  if (venueResult !== 0) {
    return venueResult;
  }

  const titleResult = compareAlphabetical(left.title, right.title);
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function compareAgendaEventsByType(left: CalendarEventSummary, right: CalendarEventSummary): number {
  const categoryResult = DAY_CATEGORY_SORT_ORDER[getDayCategory(left)] - DAY_CATEGORY_SORT_ORDER[getDayCategory(right)];
  if (categoryResult !== 0) {
    return categoryResult;
  }

  return compareAgendaEventsByTime(left, right);
}

function compareAgendaEventsByVenue(left: CalendarEventSummary, right: CalendarEventSummary): number {
  const venueResult = compareAlphabetical(left.venue, right.venue);
  return venueResult !== 0 ? venueResult : compareAgendaEventsByTime(left, right);
}

function compareAgendaEvents(
  left: CalendarEventSummary,
  right: CalendarEventSummary,
  sortMode: AgendaSortMode,
): number {
  if (sortMode === "type") {
    return compareAgendaEventsByType(left, right);
  }
  if (sortMode === "venue") {
    return compareAgendaEventsByVenue(left, right);
  }
  return compareAgendaEventsByTime(left, right);
}

function createEmptyDayCategoryCounts(): DayCategoryCounts {
  return Object.fromEntries(
    EVENT_PRIMARY_CATEGORIES.map((category) => [category.key, 0]),
  ) as DayCategoryCounts;
}

function getCalendarDayBucket(
  buckets: Map<string, CalendarDayBucket>,
  dayKey: string,
): CalendarDayBucket {
  const existingBucket = buckets.get(dayKey);
  if (existingBucket) {
    return existingBucket;
  }

  const bucket: CalendarDayBucket = {
    categoryCounts: createEmptyDayCategoryCounts(),
    eventCount: 0,
  };
  buckets.set(dayKey, bucket);
  return bucket;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getAgendaSortLabel(sortMode: AgendaSortMode): string {
  if (sortMode === "type") {
    return "Type";
  }
  return sortMode === "venue" ? "Venue name" : "Time";
}

function isUpcomingCalendarDay(dayKey: string, defaultDayKey: string): boolean {
  return dayKey >= defaultDayKey;
}

export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const resolvedSearchParams = await searchParams;
  const now = Date.now();
  const openNowActive = getSingleValue(resolvedSearchParams?.open) === "now";
  const todayKey = getNightlifeDefaultDateKey(new Date(now));
  const today = dateKeyToLocalNoonDate(todayKey);
  const requestedMonth = openNowActive ? todayKey.slice(0, 7) : getSingleValue(resolvedSearchParams?.month);
  const monthStart = parseMonthParam(requestedMonth, today);
  const monthParam = formatMonthParam(monthStart);
  const nextMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const monthStartKey = formatDateKey(monthStart);
  const weekDateKeys = getMobileWeekDateKeys(todayKey);
  const weekBeforeDate = addDaysToDateKey(todayKey, 7);
  const selectedDayKey = openNowActive ? todayKey : getSelectedDay(
    monthStart,
    getSingleValue(resolvedSearchParams?.day),
    todayKey,
  );
  const selectedSearchQuery = getSingleValue(resolvedSearchParams?.q)?.trim() || undefined;
  const requestedVenue = getSingleValue(resolvedSearchParams?.venue)?.trim() || undefined;
  // Only the selected day's details cross the backend boundary. Overnight
  // "open now" also needs yesterday's sessions; month chips use counters only.
  const eventWindow = openNowActive ? getOpenNowEventWindow(now) : {
    fromDate: selectedDayKey,
    beforeDate: addDaysToDateKey(selectedDayKey, 1),
  };
  const [loaded, venueSelection] = await Promise.all([
    loadPublicCalendarEventsWindow(eventWindow),
    resolveCalendarVenueSelection(requestedVenue, { fromDate: monthStartKey, beforeDate: formatDateKey(nextMonthStart), q: selectedSearchQuery }),
  ]);
  const error = loaded.error ?? venueSelection.error;
  // Keep cached event data independent of the clock; reevaluate openings per request.
  const openNowStates = new Map<string, OpenNowEventState>();
  const events = openNowActive ? loaded.events.filter((event) => {
    const state = getOpenNowEventState(event, now);
    openNowStates.set(event._id, state);
    return state === "active";
  }) : loaded.events;
  const venues = buildPublicEventVenueFilterOptions(loaded.events);
  const selectedVenue = venueSelection.value;
  const selectedVenueOption = venues.find((venue) => venue.value === selectedVenue);
  const selectedVenueLabel = selectedVenueOption?.label ?? venueSelection.label ?? (
    selectedVenue && /^(?:id|name):/u.test(selectedVenue) ? "Selected venue" : selectedVenue
  );
  const hiddenDayCategories = normalizeHiddenDayCategories(getSingleValue(resolvedSearchParams?.hide));
  const hiddenDayCategorySet = new Set(hiddenDayCategories);
  const selectedSortMode = normalizeAgendaSortMode(getSingleValue(resolvedSearchParams?.sort));
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const monthDayBuckets = new Map<string, CalendarDayBucket>();
  const activeVenueNames = new Set<string>();
  let totalFilteredEventCount = 0;
  let weekendEventCount = 0;

  for (const event of events) {
    if (!openNowActive && !event.date.startsWith(`${monthParam}-`)) {
      continue;
    }

    if (!eventMatchesFilters(event, selectedVenue, selectedSearchQuery)) {
      continue;
    }

    const eventCategory = getDayCategory(event);
    const bucketDate = openNowActive ? selectedDayKey : event.date;
    const eventDate = parseNormalizedEventDate(bucketDate);
    const dayBucket = getCalendarDayBucket(monthDayBuckets, bucketDate);
    dayBucket.categoryCounts[eventCategory] += 1;

    if (hiddenDayCategorySet.has(eventCategory)) {
      continue;
    }

    dayBucket.eventCount += 1;
    totalFilteredEventCount += 1;
    activeVenueNames.add(getPublicEventVenueFilterValue(event));
    if (eventDate && isWeekendDate(eventDate)) {
      weekendEventCount += 1;
    }
  }

  const filteredMonthDayKeys = Array.from(monthDayBuckets.entries())
    .filter(([, bucket]) => bucket.eventCount > 0)
    .map(([dayKey]) => dayKey)
    .sort();
  const selectedDayAgendaEvents: CalendarEventSummary[] = [];
  let selectedDayEventCount = 0;

  for (const event of events) {
    if (!openNowActive && event.date !== selectedDayKey) {
      continue;
    }
    if (!eventMatchesFilters(event, selectedVenue, selectedSearchQuery)) {
      continue;
    }

    const summary = toCalendarEventSummary(event);
    if (!hiddenDayCategorySet.has(getDayCategory(summary))) {
      selectedDayEventCount += 1;
    }
    selectedDayAgendaEvents.push(summary);
  }

  selectedDayAgendaEvents.sort((left, right) => compareAgendaEvents(left, right, selectedSortMode));

  const selectedDate = parseNormalizedEventDate(selectedDayKey) ?? monthStart;
  const previousDay = new Date(selectedDate);
  previousDay.setDate(selectedDate.getDate() - 1);
  const nextDay = new Date(selectedDate);
  nextDay.setDate(selectedDate.getDate() + 1);
  const previousDayKey = formatDateKey(previousDay);
  const nextDayKey = formatDateKey(nextDay);
  const monthDays = getMonthDays(monthStart);
  const monthLabel = monthFormatter.format(monthStart);
  const activeDayCount = filteredMonthDayKeys.filter((dayKey) =>
    isUpcomingCalendarDay(dayKey, todayKey),
  ).length;
  const activeVenueCount = activeVenueNames.size;
  const hiddenCategoriesParam = formatHiddenDayCategories(hiddenDayCategories);
  const hiddenSort = selectedSortMode === "venue" ? undefined : selectedSortMode;

  const baseFilters = {
    q: selectedSearchQuery,
    venue: selectedVenue,
    hide: hiddenCategoriesParam,
    sort: hiddenSort,
    open: openNowActive ? "now" : undefined,
  };
  const dateNavigationFilters = { ...baseFilters, open: undefined };
  const openNowHref = `/${buildQueryString({
    ...baseFilters,
    month: openNowActive ? monthParam : todayKey.slice(0, 7),
    day: openNowActive ? selectedDayKey : todayKey,
    open: openNowActive ? undefined : "now",
  })}`;
  const mobileMonthDays = monthDays.map((day) => {
    const dayKey = formatDateKey(day);
    const dayBucket = monthDayBuckets.get(dayKey);

    return {
      dayKey,
      href: `/${buildQueryString({
        ...dateNavigationFilters,
        month: monthParam,
        day: dayKey,
      })}`,
      weekdayLabel: weekdayFormatter.format(day),
      dayNumber: day.getDate(),
      eventCount: dayBucket?.eventCount ?? 0,
      categoryCounts: dayBucket?.categoryCounts ?? createEmptyDayCategoryCounts(),
      isWeekend: isWeekendDate(day),
      isUpcoming: isUpcomingCalendarDay(dayKey, todayKey),
      isSelected: dayKey === selectedDayKey,
      isToday: dayKey === todayKey,
      isAnchor: dayKey === selectedDayKey,
    };
  });
  const weekDayBuckets = new Map<string, CalendarDayBucket>();
  if (!openNowActive && selectedDayKey >= todayKey && selectedDayKey < weekBeforeDate) {
    // The active date uses the same detail snapshot as its list.
    weekDayBuckets.set(selectedDayKey, monthDayBuckets.get(selectedDayKey) ?? {
      categoryCounts: createEmptyDayCategoryCounts(), eventCount: 0,
    });
  }
  const mobileWeekDays = weekDateKeys.map((dayKey) => ({
    dayKey,
    href: `/${buildQueryString({ ...dateNavigationFilters, month: dayKey.slice(0, 7), day: dayKey })}`,
    label: getMobileDayLabel(dayKey, todayKey),
    eventCount: weekDayBuckets.get(dayKey)?.eventCount ?? 0,
    categoryCounts: weekDayBuckets.get(dayKey)?.categoryCounts ?? createEmptyDayCategoryCounts(),
    isWeekend: isWeekendDate(dateKeyToLocalNoonDate(dayKey)),
  }));
  const activeFilterControls = [
    openNowActive
      ? { key: "open-now", label: "Open now", href: openNowHref }
      : null,
    selectedSearchQuery
      ? {
          key: "search",
          label: `Search: ${selectedSearchQuery}`,
          href: `/${buildQueryString({
            ...baseFilters,
            month: monthParam,
            day: selectedDayKey,
            q: undefined,
          })}`,
        }
      : null,
    selectedVenue
      ? {
          key: "venue",
          label: `Venue: ${selectedVenueLabel}`,
          href: `/${buildQueryString({
            ...baseFilters,
            month: monthParam,
            day: selectedDayKey,
            venue: undefined,
          })}`,
        }
      : null,
    ...hiddenDayCategories.map((hiddenCategoryKey) => ({
      key: `category-${hiddenCategoryKey}`,
      label: `Off: ${DAY_CATEGORY_CHIPS.find((chip) => chip.key === hiddenCategoryKey)?.label ?? hiddenCategoryKey}`,
      href: `/${buildQueryString({
        ...baseFilters,
        month: monthParam,
        day: selectedDayKey,
        hide: formatHiddenDayCategories(hiddenDayCategories.filter((category) => category !== hiddenCategoryKey)),
      })}`,
    })),
    hiddenSort
      ? {
          key: "sort",
          label: `Sort: ${getAgendaSortLabel(selectedSortMode)}`,
          href: `/${buildQueryString({
            ...baseFilters,
            month: monthParam,
            day: selectedDayKey,
            sort: undefined,
          })}`,
        }
      : null,
  ].filter(Boolean) as Array<{ href: string; key: string; label: string }>;
  const hasActiveFilters = activeFilterControls.length > 0;
  const statCards: Array<{ key: "events" | "active-days" | "venues" | "weekend"; label: string; value: number; caption: string }> = [
    {
      key: "events",
      label: "Events",
      value: totalFilteredEventCount,
      caption: openNowActive ? "at places open now" : "listed this month",
    },
    {
      key: "active-days",
      label: "Active days",
      value: activeDayCount,
      caption: openNowActive ? "current Belgrade night" : "upcoming with something on",
    },
    {
      key: "venues",
      label: "Venues",
      value: activeVenueCount,
      caption: openNowActive ? "open now in Belgrade" : "across Belgrade",
    },
    {
      key: "weekend",
      label: "Weekend",
      value: weekendEventCount,
      caption: "Fri to Sun events",
    },
  ];

  function renderActiveFilterControls() {
    if (!hasActiveFilters) {
      return null;
    }

    return (
      <div className="flex flex-wrap gap-1.5" data-calendar-active-filter-chips="true">
        {activeFilterControls.map((control) => (
          <Link
            className="app-chip bg-card/95 text-primary hover:border-primary/35 hover:bg-primary/[0.08]"
            data-calendar-clear-filter={control.key}
            data-calendar-client-navigation="true"
            href={control.href}
            key={control.key}
            prefetch={false}
            scroll={false}
          >
            <span>{control.label}</span>
            <span aria-hidden="true" className="text-primary/70">
              ×
            </span>
            <span className="sr-only">Clear {control.label}</span>
          </Link>
        ))}
      </div>
    );
  }

  function renderFilterFields(
    mode: "desktop" | "mobile-search" | "mobile-sort",
  ) {
    const isDesktop = mode === "desktop";
    const isMobileSearch = mode === "mobile-search";
    const isMobileSort = mode === "mobile-sort";
    const showSearch = !isMobileSort;
    const showFilterFields = !isMobileSearch;

    return (
      <AutoApplyFilterForm
        closeOnApply={isMobileSort}
        className={cn(
          "grid",
          isDesktop
            ? "mt-3 gap-2.5 lg:grid-cols-3 2xl:grid-cols-[minmax(14rem,1.6fr)_minmax(0,1fr)_minmax(0,0.8fr)]"
            : isMobileSearch
              ? "gap-0"
              : "mt-2 gap-2",
        )}
      >
        <input name="month" type="hidden" value={monthParam} />
        <input name="day" type="hidden" value={selectedDayKey} />
        {openNowActive ? <input name="open" type="hidden" value="now" /> : null}
        {hiddenCategoriesParam ? <input name="hide" type="hidden" value={hiddenCategoriesParam} /> : null}
        {!showSearch && selectedSearchQuery ? (
          <input name="q" type="hidden" value={selectedSearchQuery} />
        ) : null}
        {(!showFilterFields || isMobileSort) && selectedVenue ? (
          <input name="venue" type="hidden" value={selectedVenue} />
        ) : null}
        {!showFilterFields && hiddenSort ? <input name="sort" type="hidden" value={hiddenSort} /> : null}

        {showSearch ? (
          <label className="field-label min-w-0">
            <span className={isMobileSearch ? "sr-only" : undefined}>Search</span>
            <span className="relative">
              <Search
                className={cn(
                  "pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2",
                  isMobileSearch ? "text-primary" : "text-muted-foreground",
                )}
              />
              <input
                className={cn(
                  "input-control pl-10",
                  isMobileSearch &&
                    "border-primary/45 bg-primary/[0.14] shadow-[0_16px_42px_-30px_rgba(139,134,251,0.9)] placeholder:text-foreground/70 focus:border-primary/70 focus:bg-primary/[0.18] focus:ring-primary/25",
                  !isDesktop && "h-10 rounded-xl",
                )}
                data-calendar-mobile-search-input={isMobileSearch ? "true" : undefined}
                defaultValue={selectedSearchQuery ?? ""}
                name="q"
                placeholder="Event, venue, artist..."
                type="search"
              />
            </span>
          </label>
        ) : null}

        {showFilterFields ? (
          <>
            {!isMobileSort ? (
              <label className="field-label min-w-0">
                Venue
                <CalendarVenueSelect className={cn("input-control", !isDesktop && "h-10 rounded-xl")} selected={selectedVenue} selectedLabel={selectedVenueLabel ?? "Selected venue"} fallback={venues} />
              </label>
            ) : null}

            <label className="field-label min-w-0">
              Sort
              <select
                className={cn("input-control", !isDesktop && "h-10 rounded-xl")}
                data-calendar-sort-select="true"
                defaultValue={selectedSortMode}
                name="sort"
              >
                <option value="time">Time</option>
                <option value="type">Type</option>
                <option value="venue">Venue name</option>
              </select>
            </label>
          </>
        ) : null}

      </AutoApplyFilterForm>
    );
  }


  return (
    <CalendarOverviewProvider
      options={{ month: monthParam, weekStart: todayKey, q: selectedSearchQuery, venue: selectedVenue }}
      openNow={openNowActive}
      selectedDay={{ date: selectedDayKey, groups: selectedDayAgendaEvents.map(event => ({ date: selectedDayKey, category: getDayCategory(event), venueValue: getPublicEventVenueFilterValue(event), count: 1, legacyVenueMatchCount: 1 })) }}
    >
    <main className={cn("app-page app-page-wide gap-3 sm:gap-4", mobileStyles.home)} data-mobile-week-home="true">
      <JsonLd data={buildHomePageStructuredData(selectedDayAgendaEvents)} />
      <CalendarScrollRestoration />

      <section className={cn(mobileStyles.intro, "md:rounded-[1.15rem] md:border md:border-border/75 md:bg-card/72 md:px-5 md:py-4")}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="section-kicker hidden md:block">Belgrade event calendar</p>
            <h1 className={cn(mobileStyles.heading, "mt-0 whitespace-nowrap text-[clamp(0.75rem,4.7vw,1.25rem)] font-semibold tracking-[-0.045em] text-foreground sm:mt-1.5 sm:whitespace-normal sm:text-4xl")}>
              <span className="md:hidden" lang="sr-Latn-RS">{getMobileDayHeading(selectedDayKey, todayKey)}</span>
              <span className="hidden md:inline">Belgrade events, nightlife & culture</span>
            </h1>
            <p className={cn(mobileStyles.total, "md:hidden")} lang="sr-Latn-RS"><span data-calendar-mobile-day-count="true">{selectedDayEventCount}</span> događaja u gradu</p>
            <p className="mt-2 hidden text-sm leading-6 text-muted-foreground md:block sm:text-base" lang="sr-Latn-RS">
              Šta se dešava u Beogradu danas? Pronađite žurke, koncerte, kvizove i izložbe.
              Izaberite datum i pogledajte gde da izađete večeras ili za vikend.
            </p>
          </div>
        </div>
        <div className="md:hidden" lang="sr-Latn-RS">
          <AutoApplyFilterForm searchDebounceMs={300}>
            <input name="month" type="hidden" value={monthParam} />
            <input name="day" type="hidden" value={selectedDayKey} />
            <input name="sort" type="hidden" value="time" />
            <label className="relative block">
              <span className="sr-only">Izvođač, mesto ili žanr</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-[15px] top-4 h-[18px] w-[18px] text-muted-foreground" />
              <input className={cn("input-control", mobileStyles.search)} data-calendar-mobile-search-input="true" defaultValue={selectedSearchQuery ?? ""} name="q" placeholder="Izvođač, mesto ili žanr" type="search" />
            </label>
          </AutoApplyFilterForm>
          <MobileWeekCalendar days={mobileWeekDays} monthDays={mobileMonthDays.map(({ dayKey, eventCount }) => ({ dayKey, eventCount }))} selectedDayKey={selectedDayKey} todayKey={todayKey} />
        </div>
      </section>

      <header className="relative z-20 hidden rounded-[1.15rem] border border-border/75 bg-card/92 px-2.5 py-2 shadow-[0_18px_52px_-40px_rgba(0,0,0,0.9)] backdrop-blur-sm md:block lg:hidden">
        <div className="flex items-center gap-1.5">
          <div className="inline-flex h-9 min-w-0 flex-1 items-center rounded-full border border-border/75 bg-white/[0.035]">
            <Link prefetch={false}
              data-calendar-client-navigation="true"
              aria-label="Previous day"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...dateNavigationFilters,
                month: formatMonthParam(previousDay),
                day: previousDayKey,
              })}`}
              scroll={false}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Link>
            <span className="min-w-0 flex-1 truncate px-1 text-center text-sm font-semibold text-foreground">
              {monthLabel}
            </span>
            <Link prefetch={false}
              data-calendar-client-navigation="true"
              aria-label="Next day"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...dateNavigationFilters,
                month: formatMonthParam(nextDay),
                day: nextDayKey,
              })}`}
              scroll={false}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <Link prefetch={false}
              data-calendar-client-navigation="true"
            className="inline-flex h-9 flex-none items-center rounded-full border border-primary/25 bg-primary/10 px-3 text-xs font-semibold text-primary"
            href={`/${buildQueryString({
              ...dateNavigationFilters,
              month: formatMonthParam(today),
              day: todayKey,
            })}`}
            scroll={false}
          >
            Today
          </Link>
        </div>

        <MobileMonthDayStrip days={mobileMonthDays} />
      </header>

      <header className="hero-panel relative hidden px-3 py-3 sm:px-5 sm:py-5 lg:block">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_0%,rgba(113,112,255,0.18),transparent_28rem),radial-gradient(circle_at_94%_12%,rgba(56,189,248,0.11),transparent_20rem)]" />
        <div className="relative flex flex-col gap-3 sm:gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.07] px-3 py-1 text-xs font-semibold text-primary">
                <CalendarDays className="h-3.5 w-3.5" />
                Night calendar
              </div>
              <div>
                <h2 className="text-3xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
                  {monthLabel}
                </h2>
                <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground sm:mt-2 sm:text-base sm:leading-6">
                  Browse Belgrade events by date, venue, or type.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
              <div className="inline-flex w-fit items-center gap-1 rounded-full border border-border/80 bg-white/[0.035] p-1 shadow-[0_18px_48px_-38px_rgba(0,0,0,0.8)]">
                <Link prefetch={false}
                  data-calendar-client-navigation="true"
                  aria-label="Previous day"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...dateNavigationFilters,
                    month: formatMonthParam(previousDay),
                    day: previousDayKey,
                  })}`}
                  scroll={false}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Link>
                <Link prefetch={false}
                  data-calendar-client-navigation="true"
                  className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...dateNavigationFilters,
                    month: formatMonthParam(today),
                    day: todayKey,
                  })}`}
                  scroll={false}
                >
                  Today
                </Link>
                <Link prefetch={false}
                  data-calendar-client-navigation="true"
                  aria-label="Next day"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...dateNavigationFilters,
                    month: formatMonthParam(nextDay),
                    day: nextDayKey,
                  })}`}
                  scroll={false}
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
              <Link prefetch={false} data-calendar-client-navigation="true" className="button-secondary hidden min-h-11 gap-2 px-4 py-0 sm:inline-flex" href="/">
                <ListMusic className="h-4 w-4" />
                All events
              </Link>
            </div>
          </div>

          <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden">
            {statCards.map((stat) => (
              <div
                className="metric-card min-w-[7.6rem] snap-start bg-card/92 px-3 py-2 sm:min-w-0 sm:px-3.5 sm:py-3.5"
                data-calendar-stat-card={stat.key}
                key={stat.label}
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:text-[11px] sm:tracking-[0.18em]">
                  {stat.label}
                </p>
                <p
                  className="mt-0.5 text-xl font-semibold tracking-[-0.04em] text-foreground sm:mt-2 sm:text-3xl"
                >
                  <CalendarStatValue statKey={stat.key} fallback={stat.value} />
                </p>
                <p className="mt-1 hidden text-xs text-muted-foreground sm:block">{stat.caption}</p>
              </div>
            ))}
          </div>

          <div
            className="rounded-[1.2rem] border border-border/75 bg-card/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            data-calendar-desktop-date-selector="true"
          >
            <MobileMonthDayStrip days={mobileMonthDays} surface="desktop" />
          </div>

          <section className="hidden rounded-[1.35rem] border border-border/75 bg-white/[0.025] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] lg:block">
            <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                Refine calendar
              </div>
              {hasActiveFilters ? (
                renderActiveFilterControls()
              ) : (
                <p className="text-xs text-muted-foreground">
                  Search events, narrow by venue, and sort the selected day.
                </p>
              )}
            </div>
            {renderFilterFields("desktop")}
          </section>
        </div>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!error ? (
        <>
          <CalendarAgenda
            key={JSON.stringify([selectedDayKey, selectedVenue, selectedSearchQuery, hiddenCategoriesParam, selectedSortMode, openNowActive])}
            events={projectCalendarAgendaEvents(selectedDayAgendaEvents, new Map([...selectedDayAgendaEvents].sort(compareAgendaEventsByTime).map((event, index) => [event._id, index])), openNowStates)}
            hiddenDayCategories={hiddenDayCategories}
            selectedDayEventCount={selectedDayEventCount}
            dayLabel={dayFormatter.format(selectedDate)}
            openNowActive={openNowActive} openNowHref={openNowHref} now={now} authEnabled={authEnabled}
            hiddenSort={hiddenSort} hasActiveFilters={hasActiveFilters}
            clearFiltersHref={`/${buildQueryString({ month: monthParam, day: selectedDayKey })}`}
            advancedSearch={renderFilterFields("mobile-search")} advancedSort={renderFilterFields("mobile-sort")}
          />
        </>
      ) : null}

      <section
        aria-labelledby="belgrade-events-guide"
        className="rounded-[1.2rem] border border-border/75 bg-card/65 px-4 py-5 sm:px-6 sm:py-6"
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
          <div>
            <p className="section-kicker">Local guide</p>
            <h2 id="belgrade-events-guide" className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              What&apos;s on in Belgrade?
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Use Event Zeka to plan a night out or a culture-filled day. Check the selected date,
              open an event for announced times and ticket details, then confirm the latest information
              with the linked venue or original Instagram post.
            </p>
            <p className="mt-3 text-sm leading-6 text-muted-foreground" lang="sr-Latn-RS">
              <strong className="text-foreground">Događaji u Beogradu:</strong> izaberite datum,
              pretražite izvođača ili mesto i proverite detalje događaja pre polaska.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className="button-secondary min-h-10 px-4 py-0" href="/discover">
                Discover tonight
              </Link>
              <Link className="button-secondary min-h-10 px-4 py-0" href="/map">
                Explore venues
              </Link>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Belgrade events FAQ</h2>
            {HOME_FAQ_ITEMS.map((item) => (
              <details className="rounded-[0.95rem] border border-border/75 bg-white/[0.025] px-3.5 py-3" key={item.question}>
                <summary className="cursor-pointer text-sm font-semibold text-foreground">
                  {item.question}
                </summary>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </main>
    </CalendarOverviewProvider>
  );
}
