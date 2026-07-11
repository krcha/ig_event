import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
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
import { EventKindToggleChips } from "@/components/calendar/event-kind-toggle-chips";
import { MobileMonthDayStrip } from "@/components/calendar/mobile-month-day-strip";
import { EventMetaRow, getEventCategoryKind } from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { cn } from "@/lib/utils";
import { getDisplayEventTime, getEventTimeSortMinutes, normalizeEventTime } from "@/lib/events/event-time";
import { dateKeyToLocalNoonDate, getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
import { matchesPublicEventNameArtistOrVenue } from "@/lib/events/public-event-search";

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
};

type CalendarPageProps = {
  searchParams?: CalendarSearchParams;
};

type EventTone = {
  name: string;
  chip: string;
  dot: string;
  rail: string;
  badge: string;
  panel: string;
};

type CalendarEventSummary = Pick<
  PublicEvent,
  | "_id"
  | "title"
  | "date"
  | "time"
  | "dayPeriod"
  | "displayTimeEnd"
  | "displayTimeLabel"
  | "displayTimeSource"
  | "displayTimeStart"
  | "venue"
  | "venueId"
  | "artists"
  | "eventType"
  | "ticketPrice"
  | "attendance"
  | "attendanceCount"
  | "attendeeCount"
  | "attendees"
  | "attendeesCount"
  | "going"
  | "goingCount"
>;

const EVENT_TONES: Record<"club" | "live" | "culture" | "event", EventTone> = {
  club: {
    name: "Club",
    chip: "bg-[#8B86FB]/[0.14] text-[#8B86FB] hover:bg-[#8B86FB]/[0.18]",
    dot: "bg-[#8B86FB]",
    rail: "bg-[#8B86FB]",
    badge: "bg-[#8B86FB]/[0.14] text-[#8B86FB]",
    panel: "from-[#8B86FB]/[0.10] via-card to-card",
  },
  live: {
    name: "Live",
    chip: "bg-[#FB7185]/[0.14] text-[#FB7185] hover:bg-[#FB7185]/[0.18]",
    dot: "bg-[#FB7185]",
    rail: "bg-[#FB7185]",
    badge: "bg-[#FB7185]/[0.14] text-[#FB7185]",
    panel: "from-[#FB7185]/[0.10] via-card to-card",
  },
  culture: {
    name: "Culture",
    chip: "bg-[#FBBF24]/[0.14] text-[#FBBF24] hover:bg-[#FBBF24]/[0.18]",
    dot: "bg-[#FBBF24]",
    rail: "bg-[#FBBF24]",
    badge: "bg-[#FBBF24]/[0.14] text-[#FBBF24]",
    panel: "from-[#FBBF24]/[0.10] via-card to-card",
  },
  event: {
    name: "Event",
    chip: "bg-[#34D399]/[0.14] text-[#34D399] hover:bg-[#34D399]/[0.18]",
    dot: "bg-[#34D399]",
    rail: "bg-[#34D399]",
    badge: "bg-[#34D399]/[0.14] text-[#34D399]",
    panel: "from-[#34D399]/[0.10] via-card to-card",
  },
};

const DAY_CATEGORY_CHIPS = [
  { key: "all", label: "All" },
  { key: "club", label: "Club" },
  { key: "live", label: "Live" },
  { key: "culture", label: "Culture" },
  { key: "event", label: "Event" },
] as const;

type DayCategory = (typeof DAY_CATEGORY_CHIPS)[number]["key"];
type AgendaSortMode = "time" | "type";

const DAY_CATEGORY_SORT_ORDER: Record<Exclude<DayCategory, "all">, number> = {
  club: 0,
  live: 1,
  culture: 2,
  event: 3,
};

type CalendarDayBucket = {
  eventCount: number;
};

function isConcreteDayCategory(value: string | undefined): value is Exclude<DayCategory, "all"> {
  return value !== "all" && DAY_CATEGORY_CHIPS.some((chip) => chip.key === value);
}

function normalizeHiddenDayCategories(value: string | undefined): Array<Exclude<DayCategory, "all">> {
  const requested = new Set(
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(isConcreteDayCategory),
  );

  return DAY_CATEGORY_CHIPS.map((chip) => chip.key).filter(isConcreteDayCategory).filter((key) =>
    requested.has(key),
  );
}

function formatHiddenDayCategories(categories: readonly Exclude<DayCategory, "all">[]): string | undefined {
  return categories.length > 0 ? categories.join(",") : undefined;
}

function normalizeAgendaSortMode(value: string | undefined): AgendaSortMode {
  return value === "type" ? "type" : "time";
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

function getEventAriaLabel(event: CalendarEventSummary, tone: EventTone): string {
  return ["Open " + event.title, event.displayTimeLabel ?? getDisplayEventTime(event.time), event.venue, tone.name]
    .filter(Boolean)
    .join(", ");
}

function getVenueHref(event: Pick<CalendarEventSummary, "venueId">): string | null {
  return event.venueId ? `/venues/${event.venueId}` : null;
}

function VenueNameLink({
  className,
  event,
}: {
  className?: string;
  event: Pick<CalendarEventSummary, "venue" | "venueId">;
}) {
  const href = getVenueHref(event);
  if (!href) {
    return <span className={className}>{event.venue}</span>;
  }

  return (
    <Link
      className={cn(className, "hover:text-primary focus-visible:text-primary focus-visible:outline-none")}
      href={href}
      prefetch={false}
    >
      {event.venue}
    </Link>
  );
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

function formatDisplayDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

function compareAlphabetical(left: string, right: string): number {
  return left.trim().localeCompare(right.trim(), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function eventMatchesSearch(event: PublicEvent, query: string | undefined): boolean {
  return matchesPublicEventNameArtistOrVenue(event, query);
}

function getSelectedDay(
  monthStart: Date,
  requestedDay: string | undefined,
  filteredMonthDayKeys: string[],
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
    today.getMonth() === monthStart.getMonth() &&
    filteredMonthDayKeys.includes(todayKey)
  ) {
    return todayKey;
  }

  if (filteredMonthDayKeys.length > 0) {
    return filteredMonthDayKeys[0];
  }

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
  if (venue && event.venue !== venue) {
    return false;
  }

  return eventMatchesSearch(event, query);
}

function toCalendarEventSummary(event: PublicEvent): CalendarEventSummary {
  return {
    _id: event._id,
    title: event.title,
    date: event.date,
    time: event.time,
    dayPeriod: event.dayPeriod,
    displayTimeEnd: event.displayTimeEnd,
    displayTimeLabel: event.displayTimeLabel,
    displayTimeSource: event.displayTimeSource,
    displayTimeStart: event.displayTimeStart,
    venue: event.venue,
    venueId: event.venueId,
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

function getEventTone(event: Pick<CalendarEventSummary, "artists" | "eventType" | "title">): EventTone {
  return EVENT_TONES[getEventCategoryKind(event)];
}

function getDayCategory(event: Pick<CalendarEventSummary, "artists" | "eventType" | "title">): Exclude<DayCategory, "all"> {
  const toneName = getEventTone(event).name.toLowerCase();

  if (toneName === "club" || toneName === "live" || toneName === "culture") {
    return toneName;
  }

  return "event";
}

function getAgendaEventSortMinutes(event: CalendarEventSummary): number {
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

function compareAgendaEvents(
  left: CalendarEventSummary,
  right: CalendarEventSummary,
  sortMode: AgendaSortMode,
): number {
  return sortMode === "type"
    ? compareAgendaEventsByType(left, right)
    : compareAgendaEventsByTime(left, right);
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
    eventCount: 0,
  };
  buckets.set(dayKey, bucket);
  return bucket;
}

function formatArtistMeta(event: CalendarEventSummary): string | undefined {
  return event.artists.length > 0 ? event.artists.slice(0, 3).join(", ") : undefined;
}

function getResolvedDisplayTime(event: CalendarEventSummary): string | undefined {
  return event.displayTimeLabel ?? getDisplayEventTime(event.time);
}

function getResolvedTimeParts(event: CalendarEventSummary) {
  if (event.displayTimeStart) {
    return {
      allDay: false,
      endLabel: event.displayTimeEnd,
      startLabel: event.displayTimeStart,
    };
  }

  return normalizeEventTime(event.time);
}

function getSupplementalDisplayTime(event: CalendarEventSummary): string | undefined {
  if (!event.displayTimeLabel || event.displayTimeStart) {
    return undefined;
  }

  return event.displayTimeLabel;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getAgendaSortLabel(sortMode: AgendaSortMode): string {
  return sortMode === "type" ? "Type" : "Time";
}

export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const todayKey = getNightlifeDefaultDateKey();
  const today = dateKeyToLocalNoonDate(todayKey);
  const requestedMonth = getSingleValue(searchParams?.month);
  const monthStart = parseMonthParam(requestedMonth, today);
  const monthParam = formatMonthParam(monthStart);
  const nextMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const monthStartKey = formatDateKey(monthStart);
  const fromDate = monthStartKey;
  const beforeDate = formatDateKey(nextMonthStart);
  const { events, error } = await loadPublicCalendarEventsWindow({ beforeDate, fromDate });
  const selectedVenue = getSingleValue(searchParams?.venue);
  const hiddenDayCategories = normalizeHiddenDayCategories(getSingleValue(searchParams?.hide));
  const hiddenDayCategorySet = new Set(hiddenDayCategories);
  const selectedSortMode = normalizeAgendaSortMode(getSingleValue(searchParams?.sort));
  const selectedSearchQuery = getSingleValue(searchParams?.q)?.trim() || undefined;
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const venueNames = new Set<string>();
  const monthDayBuckets = new Map<string, CalendarDayBucket>();
  const activeVenueNames = new Set<string>();
  let totalFilteredEventCount = 0;
  let weekendEventCount = 0;

  for (const event of events) {
    venueNames.add(event.venue);

    if (!event.date.startsWith(`${monthParam}-`)) {
      continue;
    }

    if (!eventMatchesFilters(event, selectedVenue, selectedSearchQuery)) {
      continue;
    }

    if (hiddenDayCategorySet.has(getDayCategory(event))) {
      continue;
    }

    const eventDate = parseNormalizedEventDate(event.date);
    const dayBucket = getCalendarDayBucket(monthDayBuckets, event.date);
    dayBucket.eventCount += 1;
    totalFilteredEventCount += 1;
    activeVenueNames.add(event.venue);
    if (eventDate && isWeekendDate(eventDate)) {
      weekendEventCount += 1;
    }
  }

  const venues = Array.from(venueNames).sort((left, right) => left.localeCompare(right));
  const filteredMonthDayKeys = Array.from(monthDayBuckets.keys()).sort();
  const selectedDayKey = getSelectedDay(
    monthStart,
    getSingleValue(searchParams?.day),
    filteredMonthDayKeys,
    todayKey,
  );
  const selectedDayAgendaEvents: CalendarEventSummary[] = [];
  let selectedDayEventCount = 0;

  for (const event of events) {
    if (event.date !== selectedDayKey) {
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
  const monthLabel = formatDisplayDate(monthStart, { month: "long", year: "numeric" });
  const activeDayCount = filteredMonthDayKeys.length;
  const activeVenueCount = activeVenueNames.size;
  const hiddenCategoriesParam = formatHiddenDayCategories(hiddenDayCategories);
  const hiddenSort = selectedSortMode === "time" ? undefined : selectedSortMode;

  const baseFilters = {
    q: selectedSearchQuery,
    venue: selectedVenue,
    hide: hiddenCategoriesParam,
    sort: hiddenSort,
  };
  const mobileMonthDays = monthDays.map((day) => {
    const dayKey = formatDateKey(day);
    const dayBucket = monthDayBuckets.get(dayKey);

    return {
      dayKey,
      href: `/${buildQueryString({
        ...baseFilters,
        month: monthParam,
        day: dayKey,
      })}`,
      weekdayLabel: formatDisplayDate(day, { weekday: "short" }),
      dayNumber: day.getDate(),
      eventCount: dayBucket?.eventCount ?? 0,
      isSelected: dayKey === selectedDayKey,
      isToday: dayKey === todayKey,
      isAnchor: dayKey === selectedDayKey,
    };
  });
  const activeFilterControls = [
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
          label: `Venue: ${selectedVenue}`,
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
  const activeFilterLabels = activeFilterControls.map((control) => control.label);
  const hasActiveFilters = activeFilterControls.length > 0;
  const statCards = [
    {
      label: "Events",
      value: totalFilteredEventCount,
      caption: "approved this month",
    },
    {
      label: "Active days",
      value: activeDayCount,
      caption: "with something on",
    },
    {
      label: "Venues",
      value: activeVenueCount,
      caption: "across Belgrade",
    },
    {
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
    mode: "mobile" | "desktop" | "mobile-search" | "mobile-filter",
  ) {
    const isDesktop = mode === "desktop";
    const isMobileSearch = mode === "mobile-search";
    const isMobileFilter = mode === "mobile-filter";
    const showSearch = !isMobileFilter;
    const showFilterFields = !isMobileSearch;

    return (
      <AutoApplyFilterForm
        closeOnApply={isMobileFilter}
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
        {hiddenCategoriesParam ? <input name="hide" type="hidden" value={hiddenCategoriesParam} /> : null}
        {!showSearch && selectedSearchQuery ? (
          <input name="q" type="hidden" value={selectedSearchQuery} />
        ) : null}
        {!showFilterFields && selectedVenue ? (
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
            <label className="field-label min-w-0">
              Venue
              <select
                className={cn("input-control", !isDesktop && "h-10 rounded-xl")}
                defaultValue={selectedVenue ?? ""}
                name="venue"
              >
                <option value="">All venues</option>
                {venues.map((venue) => (
                  <option key={venue} value={venue}>
                    {venue}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label min-w-0">
              Sort
              <select
                className={cn("input-control", !isDesktop && "h-10 rounded-xl")}
                data-calendar-sort-select="true"
                defaultValue={hiddenSort ?? ""}
                name="sort"
              >
                <option value="">Time</option>
                <option value="type">Type</option>
              </select>
            </label>
          </>
        ) : null}

      </AutoApplyFilterForm>
    );
  }

  function renderSelectedDayAgenda({
    compact = false,
    mobile = false,
  }: {
    compact?: boolean;
    mobile?: boolean;
  } = {}) {
    const agendaEvents = selectedDayAgendaEvents;
    const initialVisibleAgendaEventCount = agendaEvents.filter(
      (event) => !hiddenDayCategorySet.has(getDayCategory(event)),
    ).length;

    function renderMobileAdvancedControls() {
      const iconButtonClass =
        "relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/75 bg-white/[0.045] text-foreground shadow-[0_14px_34px_-28px_rgba(0,0,0,0.85)] hover:border-primary/35 hover:bg-primary/10 hover:text-primary";
      const panelClass =
        "absolute right-0 top-full z-40 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-[1rem] border border-border/80 bg-card/98 p-2.5 shadow-[0_24px_70px_-42px_rgba(0,0,0,0.95)] backdrop-blur";

      return (
        <div className="flex flex-none items-center gap-1">
          <details className="group relative">
            <summary
              aria-label="Search calendar events"
              className={`${iconButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
              data-calendar-mobile-search-button="true"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="sr-only">Search</span>
            </summary>
            <div className={panelClass} data-calendar-mobile-search-panel="true">
              {renderFilterFields("mobile-search")}
            </div>
          </details>

          <details className="group relative">
            <summary
              aria-label="Filter calendar events"
              className={`${iconButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
              data-calendar-mobile-filter-button="true"
            >
              <Filter className="h-3.5 w-3.5" />
              <span className="sr-only">Filters</span>
              {hasActiveFilters ? (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
              ) : null}
            </summary>
            <div className={panelClass}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Filters
                </p>
                {hasActiveFilters ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    {activeFilterLabels.length} active
                  </span>
                ) : null}
              </div>
              {renderActiveFilterControls()}
              {renderFilterFields("mobile-filter")}
            </div>
          </details>
        </div>
      );
    }

    function renderCategoryChips({ withActions = false }: { withActions?: boolean } = {}) {
      return (
        <EventKindToggleChips initialHiddenCategories={hiddenDayCategories}>
          {withActions ? renderMobileAdvancedControls() : null}
        </EventKindToggleChips>
      );
    }

    function renderAgendaCards(isMobile = false) {
      return (
        <>
          {agendaEvents.map((event) => {
            const tone = getEventTone(event);
            const eventCategory = getDayCategory(event);
            const isHiddenByKind = hiddenDayCategorySet.has(eventCategory);
            const eventTime = getResolvedTimeParts(event);
            const displayEventTime = getResolvedDisplayTime(event);
            const supplementalDisplayTime = getSupplementalDisplayTime(event);
            const artistMeta = formatArtistMeta(event);

            if (isMobile) {
              return (
                <article
                  className={cn(
                    "group flex items-center gap-2 rounded-[0.9rem] border border-border/75 bg-gradient-to-r px-2.5 py-2 shadow-[0_14px_38px_-32px_rgba(0,0,0,0.86)] transition hover:border-primary/35 hover:bg-primary/[0.04]",
                    tone.panel,
                  )}
                  data-calendar-event-kind={eventCategory}
                  data-calendar-hidden-by-kind={isHiddenByKind ? "true" : "false"}
                  data-calendar-mobile-event-row="true"
                  data-event-time={event.displayTimeLabel ?? event.time}
                  data-event-title={event.title}
                  data-event-tone={tone.name}
                  data-event-venue={event.venue}
                  hidden={isHiddenByKind}
                  key={event._id}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {eventTime.startLabel ? (
                      <Link
                        aria-label={getEventAriaLabel(event, tone)}
                        className="box-border flex h-9 w-16 flex-none flex-col items-center justify-center overflow-hidden rounded-[0.72rem] border border-border/65 bg-background/45 px-1 text-center hover:border-primary/35"
                        data-calendar-event-link="true"
                        href={`/events/${event._id}`}
                        prefetch={false}
                      >
                        <span className="block max-w-full truncate text-xs font-semibold leading-4 tabular-nums text-foreground">
                          {eventTime.startLabel}
                        </span>
                        {eventTime.endLabel ? (
                          <span className="block max-w-full truncate text-[10px] font-semibold leading-3 tabular-nums text-muted-foreground">
                            {eventTime.endLabel}
                          </span>
                        ) : null}
                      </Link>
                    ) : (
                      <Link
                        aria-label={getEventAriaLabel(event, tone)}
                        className="box-border flex h-9 w-16 flex-none items-center justify-center overflow-hidden rounded-[0.72rem] border border-border/65 bg-background/45 px-1 text-center hover:border-primary/35"
                        data-calendar-event-link="true"
                        href={`/events/${event._id}`}
                        prefetch={false}
                      >
                        <span className="block max-w-full truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          —
                        </span>
                      </Link>
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        aria-label={getEventAriaLabel(event, tone)}
                        className="block min-w-0 hover:text-primary"
                        data-calendar-event-link="true"
                        href={`/events/${event._id}`}
                        prefetch={false}
                      >
                        <h4 className="truncate text-[13px] font-semibold leading-4 tracking-tight text-foreground">
                          {event.title}
                        </h4>
                      </Link>
                      <VenueNameLink
                        className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-muted-foreground"
                        event={event}
                      />
                      {supplementalDisplayTime ? (
                        <p className="truncate text-[11px] font-medium leading-4 text-muted-foreground/85">
                          {supplementalDisplayTime}
                        </p>
                      ) : null}
                      <EventMetaRow className="mt-1 flex-nowrap" event={event} />
                    </div>
                  </div>
                  {authEnabled ? (
                    <SaveEventButton eventId={event._id} eventTitle={event.title} variant="icon" />
                  ) : null}
                </article>
              );
            }

            return (
              <article
                className={cn(
                  "relative overflow-hidden rounded-[1rem] border border-border/80 bg-gradient-to-br px-3 py-3 transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_22px_54px_-42px_rgba(0,0,0,0.8)]",
                  tone.panel,
                )}
                data-calendar-desktop-event-row="true"
                data-calendar-event-kind={eventCategory}
                data-calendar-hidden-by-kind={isHiddenByKind ? "true" : "false"}
                hidden={isHiddenByKind}
                key={event._id}
              >
                <div className={cn("absolute inset-y-4 left-0 w-1 rounded-r-full", tone.rail)} />
                <div className="flex items-start gap-2.5 pl-1.5">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <div className="w-14 flex-none text-right">
                      {displayEventTime ? (
                        <Link
                          aria-label={getEventAriaLabel(event, tone)}
                          className="block truncate text-sm font-semibold tabular-nums text-foreground hover:text-primary"
                          data-calendar-event-link="true"
                          href={`/events/${event._id}`}
                          prefetch={false}
                        >
                          {displayEventTime}
                        </Link>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        aria-label={getEventAriaLabel(event, tone)}
                        className="block min-w-0 hover:text-primary"
                        data-calendar-event-link="true"
                        href={`/events/${event._id}`}
                        prefetch={false}
                      >
                        <h4 className="text-sm font-semibold leading-5 tracking-tight text-foreground sm:text-[15px]">
                          {event.title}
                        </h4>
                      </Link>
                      <VenueNameLink
                        className="mt-1 block truncate text-xs leading-5 text-muted-foreground"
                        event={event}
                      />
                      <EventMetaRow className="mt-1.5" event={event} />
                      {artistMeta ? (
                        <p className="mt-1 truncate text-xs leading-5 text-muted-foreground/85">
                          {artistMeta}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {authEnabled ? (
                    <div className="flex flex-none items-center">
                      <SaveEventButton eventId={event._id} eventTitle={event.title} variant="icon" />
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}

          <div
            className="rounded-[1.2rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center"
            data-calendar-empty-state="true"
            hidden={initialVisibleAgendaEventCount > 0}
          >
            <p className="text-sm font-semibold text-foreground">
              No events match this date and filter set.
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Pick another date, change filters, or clear the current search.
            </p>
            {hasActiveFilters ? (
              <Link prefetch={false}
                className="button-secondary mt-4 min-h-10 px-4 py-0"
                href={`/${buildQueryString({ month: monthParam, day: selectedDayKey })}`}
                scroll={false}
              >
                Clear filters
              </Link>
            ) : null}
          </div>
        </>
      );
    }

    if (mobile) {
      return (
        <section
          className="space-y-1.5"
          data-calendar-agenda-scope="mobile"
          data-calendar-scroll-region="selected-day-agenda"
        >
          <div className="sticky top-[4.25rem] z-20 rounded-[1rem] border border-border/75 bg-background/92 px-2.5 py-1.5 shadow-[0_18px_46px_-34px_rgba(0,0,0,0.9)] backdrop-blur">
            <h2 className="min-w-0 truncate text-xs font-semibold tracking-tight text-foreground">
              {formatDisplayDate(selectedDate, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}{" "}
              <span className="text-muted-foreground">·</span>{" "}
              <span data-calendar-visible-event-count="true">
                {pluralize(selectedDayEventCount, "event")}
              </span>
            </h2>
            {renderCategoryChips({ withActions: true })}
          </div>

          <div className="space-y-1.5">{renderAgendaCards(true)}</div>
        </section>
      );
    }

    return (
      <section
        className={cn(
          "overflow-hidden rounded-[1.2rem] border border-border/80 bg-card/95 shadow-[0_32px_90px_-58px_rgba(0,0,0,0.82)]",
          !compact && "xl:sticky xl:top-28 xl:max-h-[calc(100svh-8rem)] xl:overflow-auto",
        )}
        data-calendar-agenda-scope="desktop"
        data-calendar-scroll-region="selected-day-agenda"
      >
        <div className="relative overflow-hidden border-b border-border/75 bg-gradient-to-br from-primary/[0.14] via-card to-card px-3 py-3 sm:px-4 sm:py-4">
          <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-primary/[0.08] blur-2xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <p className="section-kicker">Selected day</p>
              <h3 className="mt-1 text-lg font-semibold tracking-tight sm:text-2xl">
                {formatDisplayDate(selectedDate, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                <span data-calendar-visible-event-count="true">
                  {pluralize(selectedDayEventCount, "event")}
                </span>{" "}
                ready to browse.
              </p>
            </div>
            <div className="rounded-[1.05rem] bg-primary px-3 py-2 text-center text-primary-foreground shadow-[0_20px_42px_-26px_rgba(113,112,255,0.85)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em]">
                {formatDisplayDate(selectedDate, { month: "short" })}
              </p>
              <p className="text-2xl font-semibold leading-none">{selectedDate.getDate()}</p>
            </div>
          </div>
        </div>

        <div className="space-y-2.5 px-2.5 py-2.5 sm:space-y-3 sm:px-4 sm:py-4">
          {renderAgendaCards()}
        </div>
      </section>
    );
  }

  return (
    <main className="app-page app-page-wide gap-3 sm:gap-4">
      <CalendarScrollRestoration />
      <header className="relative z-20 rounded-[1.15rem] border border-border/75 bg-card/92 px-2.5 py-2 shadow-[0_18px_52px_-40px_rgba(0,0,0,0.9)] backdrop-blur-sm lg:hidden">
        <div className="flex items-center gap-1.5">
          <div className="inline-flex h-9 min-w-0 flex-1 items-center rounded-full border border-border/75 bg-white/[0.035]">
            <Link prefetch={false}
              aria-label="Previous day"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...baseFilters,
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
              aria-label="Next day"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...baseFilters,
                month: formatMonthParam(nextDay),
                day: nextDayKey,
              })}`}
              scroll={false}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <Link prefetch={false}
            className="inline-flex h-9 flex-none items-center rounded-full border border-primary/25 bg-primary/10 px-3 text-xs font-semibold text-primary"
            href={`/${buildQueryString({
              ...baseFilters,
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
                <h1 className="text-3xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
                  {monthLabel}
                </h1>
                <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground sm:mt-2 sm:text-base sm:leading-6">
                  Swipe dates, open a day agenda, and filter only when needed.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
              <div className="inline-flex w-fit items-center gap-1 rounded-full border border-border/80 bg-white/[0.035] p-1 shadow-[0_18px_48px_-38px_rgba(0,0,0,0.8)]">
                <Link prefetch={false}
                  aria-label="Previous day"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: formatMonthParam(previousDay),
                    day: previousDayKey,
                  })}`}
                  scroll={false}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Link>
                <Link prefetch={false}
                  className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: formatMonthParam(today),
                    day: todayKey,
                  })}`}
                  scroll={false}
                >
                  Today
                </Link>
                <Link prefetch={false}
                  aria-label="Next day"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: formatMonthParam(nextDay),
                    day: nextDayKey,
                  })}`}
                  scroll={false}
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
              <Link prefetch={false} className="button-secondary hidden min-h-11 gap-2 px-4 py-0 sm:inline-flex" href="/">
                <ListMusic className="h-4 w-4" />
                All events
              </Link>
            </div>
          </div>

          <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden">
            {statCards.map((stat) => (
              <div className="metric-card min-w-[7.6rem] snap-start bg-card/92 px-3 py-2 sm:min-w-0 sm:px-3.5 sm:py-3.5" key={stat.label}>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:text-[11px] sm:tracking-[0.18em]">
                  {stat.label}
                </p>
                <p className="mt-0.5 text-xl font-semibold tracking-[-0.04em] text-foreground sm:mt-2 sm:text-3xl">
                  {stat.value}
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
          <section>{renderSelectedDayAgenda({ mobile: true })}</section>

        </>
      ) : null}
    </main>
  );
}
