import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Filter,
  ListMusic,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import {
  loadUpcomingApprovedEvents,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { MobileMonthDayStrip } from "@/components/calendar/mobile-month-day-strip";
import {
  EVENT_CATEGORY_TONES,
  EventMetaRow,
  getEventCategoryKind,
} from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { cn } from "@/lib/utils";
import { getDisplayEventTime, normalizeEventTime } from "@/lib/events/event-time";
import { matchesPublicEventNameArtistOrVenue } from "@/lib/events/public-event-search";

export const revalidate = 60;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarSearchParams = {
  month?: string | string[];
  day?: string | string[];
  venue?: string | string[];
  type?: string | string[];
  category?: string | string[];
  weekend?: string | string[];
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
const CALENDAR_DAY_PREVIEW_LIMIT = 3;
const DEFAULT_SELECTED_DAY_AGENDA_LIMIT = 24;

type DayCategory = (typeof DAY_CATEGORY_CHIPS)[number]["key"];

type CalendarDayBucket = {
  eventCount: number;
  previewEvents: CalendarEventSummary[];
};

function normalizeDayCategory(value: string | undefined): DayCategory {
  return DAY_CATEGORY_CHIPS.some((chip) => chip.key === value) ? (value as DayCategory) : "all";
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

function getCalendarDays(monthStart: Date): Date[] {
  const start = new Date(monthStart);
  const mondayFirstDayIndex = (monthStart.getDay() + 6) % 7;
  start.setDate(1 - mondayFirstDayIndex);

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
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

function eventMatchesSearch(event: PublicEvent, query: string | undefined): boolean {
  return matchesPublicEventNameArtistOrVenue(event, query);
}

function getSelectedDay(
  monthStart: Date,
  requestedDay: string | undefined,
  filteredMonthDayKeys: string[],
): string {
  const monthParam = formatMonthParam(monthStart);
  if (requestedDay?.startsWith(`${monthParam}-`) && parseNormalizedEventDate(requestedDay)) {
    return requestedDay;
  }

  const today = new Date();
  const todayKey = formatDateKey(today);
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
  eventType: string | undefined,
  weekendOnly: boolean,
  query: string | undefined,
): boolean {
  if (venue && event.venue !== venue) {
    return false;
  }

  if (eventType && event.eventType !== eventType) {
    return false;
  }

  if (!eventMatchesSearch(event, query)) {
    return false;
  }

  if (!weekendOnly) {
    return true;
  }

  const eventDate = parseNormalizedEventDate(event.date);
  return eventDate ? isWeekendDate(eventDate) : false;
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

function getEventTone(event: CalendarEventSummary): EventTone {
  return EVENT_TONES[getEventCategoryKind(event)];
}

function getDayCategory(event: CalendarEventSummary): Exclude<DayCategory, "all"> {
  const toneName = getEventTone(event).name.toLowerCase();

  if (toneName === "club" || toneName === "live" || toneName === "culture") {
    return toneName;
  }

  return "event";
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
    previewEvents: [],
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

function getActiveFilterLabels(
  query: string | undefined,
  venue: string | undefined,
  eventType: string | undefined,
  weekendOnly: boolean,
): string[] {
  return [
    query ? `Search: ${query}` : null,
    venue ? `Venue: ${venue}` : null,
    eventType ? `Type: ${eventType}` : null,
    weekendOnly ? "Weekend only" : null,
  ].filter(Boolean) as string[];
}

export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const today = new Date();
  const todayKey = formatDateKey(today);
  const requestedMonth = getSingleValue(searchParams?.month);
  const monthStart = parseMonthParam(requestedMonth, today);
  const monthParam = formatMonthParam(monthStart);
  const nextMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const monthStartKey = formatDateKey(monthStart);
  const fromDate = monthStartKey;
  const beforeDate = formatDateKey(nextMonthStart);
  const { events, error } = await loadUpcomingApprovedEvents({ beforeDate, fromDate });
  const selectedVenue = getSingleValue(searchParams?.venue);
  const selectedType = getSingleValue(searchParams?.type);
  const selectedCategory = normalizeDayCategory(getSingleValue(searchParams?.category));
  const selectedSearchQuery = getSingleValue(searchParams?.q)?.trim() || undefined;
  const weekendOnly = getSingleValue(searchParams?.weekend) === "1";
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const venueNames = new Set<string>();
  const eventTypeNames = new Set<string>();
  const monthDayBuckets = new Map<string, CalendarDayBucket>();
  const activeVenueNames = new Set<string>();
  let totalFilteredEventCount = 0;
  let weekendEventCount = 0;

  for (const event of events) {
    venueNames.add(event.venue);
    eventTypeNames.add(event.eventType);

    if (!event.date.startsWith(`${monthParam}-`)) {
      continue;
    }

    if (
      !eventMatchesFilters(
        event,
        selectedVenue,
        selectedType,
        weekendOnly,
        selectedSearchQuery,
      )
    ) {
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
    if (dayBucket.previewEvents.length < CALENDAR_DAY_PREVIEW_LIMIT) {
      dayBucket.previewEvents.push(toCalendarEventSummary(event));
    }
  }

  const venues = Array.from(venueNames).sort((left, right) => left.localeCompare(right));
  const eventTypes = Array.from(eventTypeNames).sort((left, right) => left.localeCompare(right));
  const filteredMonthDayKeys = Array.from(monthDayBuckets.keys()).sort();
  const selectedDayKey = getSelectedDay(
    monthStart,
    getSingleValue(searchParams?.day),
    filteredMonthDayKeys,
  );
  const selectedDayAgendaEvents: CalendarEventSummary[] = [];
  let selectedDayEventCount = 0;

  for (const event of events) {
    if (event.date !== selectedDayKey) {
      continue;
    }
    if (
      !eventMatchesFilters(
        event,
        selectedVenue,
        selectedType,
        weekendOnly,
        selectedSearchQuery,
      )
    ) {
      continue;
    }

    const summary = toCalendarEventSummary(event);
    if (selectedCategory !== "all" && getDayCategory(summary) !== selectedCategory) {
      continue;
    }

    selectedDayEventCount += 1;
    if (selectedDayAgendaEvents.length < DEFAULT_SELECTED_DAY_AGENDA_LIMIT) {
      selectedDayAgendaEvents.push(summary);
    }
  }

  const selectedDate = parseNormalizedEventDate(selectedDayKey) ?? monthStart;
  const calendarDays = getCalendarDays(monthStart);
  const monthDays = getMonthDays(monthStart);
  const previousMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
  const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const monthLabel = formatDisplayDate(monthStart, { month: "long", year: "numeric" });
  const activeDayCount = filteredMonthDayKeys.length;
  const activeVenueCount = activeVenueNames.size;
  const hiddenCategory = selectedCategory === "all" ? undefined : selectedCategory;

  const baseFilters = {
    q: selectedSearchQuery,
    venue: selectedVenue,
    type: selectedType,
    category: hiddenCategory,
    weekend: weekendOnly ? "1" : undefined,
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
  const activeFilterLabels = getActiveFilterLabels(
    selectedSearchQuery,
    selectedVenue,
    selectedType,
    weekendOnly,
  );
  const hasActiveFilters = activeFilterLabels.length > 0;
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

  function renderFilterFields(
    mode: "mobile" | "desktop" | "mobile-search" | "mobile-filter",
  ) {
    const isDesktop = mode === "desktop";
    const isMobileSearch = mode === "mobile-search";
    const isMobileFilter = mode === "mobile-filter";
    const showSearch = !isMobileFilter;
    const showFilterFields = !isMobileSearch;
    const resetHref = `/${buildQueryString({
      month: monthParam,
      day: selectedDayKey,
      category: hiddenCategory,
      q: isMobileFilter ? selectedSearchQuery : undefined,
      venue: isMobileSearch ? selectedVenue : undefined,
      type: isMobileSearch ? selectedType : undefined,
      weekend: isMobileSearch && weekendOnly ? "1" : undefined,
    })}`;

    return (
      <form
        className={cn(
          "grid",
          isDesktop
            ? "mt-3 gap-2.5 lg:grid-cols-2 2xl:grid-cols-[minmax(14rem,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]"
            : "mt-2 gap-2",
        )}
        method="get"
      >
        <input name="month" type="hidden" value={monthParam} />
        {hiddenCategory ? <input name="category" type="hidden" value={hiddenCategory} /> : null}
        {!showSearch && selectedSearchQuery ? (
          <input name="q" type="hidden" value={selectedSearchQuery} />
        ) : null}
        {!showFilterFields && selectedVenue ? (
          <input name="venue" type="hidden" value={selectedVenue} />
        ) : null}
        {!showFilterFields && selectedType ? (
          <input name="type" type="hidden" value={selectedType} />
        ) : null}
        {!showFilterFields && weekendOnly ? <input name="weekend" type="hidden" value="1" /> : null}

        {showSearch ? (
          <label className="field-label min-w-0">
            Search
            <span className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={cn("input-control pl-10", !isDesktop && "h-10 rounded-xl")}
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
              Type
              <select
                className={cn("input-control", !isDesktop && "h-10 rounded-xl")}
                defaultValue={selectedType ?? ""}
                name="type"
              >
                <option value="">All types</option>
                {eventTypes.map((eventType) => (
                  <option key={eventType} value={eventType}>
                    {eventType}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label min-w-0">
              Focus
              <select
                className={cn("input-control", !isDesktop && "h-10 rounded-xl")}
                defaultValue={weekendOnly ? "1" : ""}
                name="weekend"
              >
                <option value="">All days</option>
                <option value="1">Weekend only</option>
              </select>
            </label>
          </>
        ) : null}

        <div className={cn("grid grid-cols-2 gap-2", isDesktop && "sm:flex sm:items-end")}>
          <button
            className={cn(
              "button-primary gap-2 py-0",
              isDesktop ? "min-h-12 px-4" : "min-h-10 px-3 text-sm",
            )}
            type="submit"
          >
            {isMobileSearch ? <Search className="h-4 w-4" /> : <Filter className="h-4 w-4" />}
            {isMobileSearch ? "Search" : "Apply"}
          </button>
          <Link prefetch={false}
            className={cn(
              "button-secondary py-0",
              isDesktop ? "min-h-12 px-4" : "min-h-10 px-3 text-sm",
            )}
            href={resetHref}
            scroll={false}
          >
            Reset
          </Link>
        </div>
      </form>
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
    const hasAgendaOverflow = selectedDayEventCount > agendaEvents.length;

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
            <div className={panelClass}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Search events
              </p>
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
              {renderFilterFields("mobile-filter")}
            </div>
          </details>
        </div>
      );
    }

    function renderCategoryChips({ withActions = false }: { withActions?: boolean } = {}) {
      return (
        <div
          className="mt-1.5 flex items-center gap-1.5"
          data-calendar-mobile-filter-chips="true"
        >
          <nav
            aria-label="Selected day categories"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {DAY_CATEGORY_CHIPS.map((chip) => {
              const isActive = selectedCategory === chip.key;
              const tone = chip.key === "all" ? null : EVENT_CATEGORY_TONES[chip.key];

              return (
                <Link prefetch={false}
                  className={cn(
                    "inline-flex min-h-8 flex-none items-center rounded-full px-2.5 text-[11px] font-semibold transition hover:opacity-90",
                    tone
                      ? isActive && "shadow-[0_16px_34px_-28px_rgba(0,0,0,0.85)]"
                      : isActive
                        ? "bg-primary/15 text-primary shadow-[0_16px_34px_-28px_rgba(113,112,255,0.9)]"
                        : "bg-white/[0.045] text-muted-foreground hover:text-foreground",
                  )}
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: monthParam,
                    day: selectedDayKey,
                    category: chip.key === "all" ? undefined : chip.key,
                  })}`}
                  key={chip.key}
                  scroll={false}
                  style={tone ? { backgroundColor: tone.backgroundColor, color: tone.color } : undefined}
                >
                  {chip.label}
                </Link>
              );
            })}
          </nav>
          {withActions ? renderMobileAdvancedControls() : null}
        </div>
      );
    }

    function renderAgendaCards(isMobile = false) {
      return (
        <>
          {agendaEvents.map((event) => {
            const tone = getEventTone(event);
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
                  data-calendar-mobile-event-row="true"
                  data-event-time={event.displayTimeLabel ?? event.time}
                  data-event-title={event.title}
                  data-event-tone={tone.name}
                  data-event-venue={event.venue}
                  key={event._id}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {eventTime.startLabel ? (
                      <Link
                        aria-label={getEventAriaLabel(event, tone)}
                        className="box-border flex h-9 w-16 flex-none flex-col items-center justify-center overflow-hidden rounded-[0.72rem] border border-border/65 bg-background/45 px-1 text-center hover:border-primary/35"
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

          {agendaEvents.length === 0 ? (
            <div className="rounded-[1.2rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
              <p className="text-sm font-semibold text-foreground">
                No events match this date and filter set.
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Pick another date, change filters, or clear the current search.
              </p>
              {hasActiveFilters || selectedCategory !== "all" ? (
                <Link prefetch={false}
                  className="button-secondary mt-4 min-h-10 px-4 py-0"
                  href={`/${buildQueryString({ month: monthParam, day: selectedDayKey })}`}
                  scroll={false}
                >
                  Clear filters
                </Link>
              ) : null}
            </div>
          ) : null}

          {hasAgendaOverflow ? (
            <div className="rounded-[1rem] border border-primary/20 bg-primary/[0.07] px-3 py-3 text-sm text-muted-foreground">
              <p>
                Showing {agendaEvents.length} of {selectedDayEventCount} matching events for this day.
              </p>
            </div>
          ) : null}
        </>
      );
    }

    if (mobile) {
      return (
        <section className="space-y-1.5">
          <div className="sticky top-[4.25rem] z-20 rounded-[1rem] border border-border/75 bg-background/92 px-2.5 py-1.5 shadow-[0_18px_46px_-34px_rgba(0,0,0,0.9)] backdrop-blur">
            <h2 className="min-w-0 truncate text-xs font-semibold tracking-tight text-foreground">
              {formatDisplayDate(selectedDate, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}{" "}
              <span className="text-muted-foreground">·</span>{" "}
              {pluralize(selectedDayEventCount, "event")}
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
                {hasAgendaOverflow
                  ? `Showing ${agendaEvents.length} of ${selectedDayEventCount} events.`
                  : `${pluralize(selectedDayEventCount, "event")} ready to browse.`}
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
      <header className="relative z-20 rounded-[1.15rem] border border-border/75 bg-card/92 px-2.5 py-2 shadow-[0_18px_52px_-40px_rgba(0,0,0,0.9)] backdrop-blur-sm lg:hidden">
        <div className="flex items-center gap-1.5">
          <div className="inline-flex h-9 min-w-0 flex-1 items-center rounded-full border border-border/75 bg-white/[0.035]">
            <Link prefetch={false}
              aria-label="Previous month"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...baseFilters,
                month: formatMonthParam(previousMonth),
              })}`}
              scroll={false}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Link>
            <span className="min-w-0 flex-1 truncate px-1 text-center text-sm font-semibold text-foreground">
              {monthLabel}
            </span>
            <Link prefetch={false}
              aria-label="Next month"
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              href={`/${buildQueryString({
                ...baseFilters,
                month: formatMonthParam(nextMonth),
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
                  aria-label="Previous month"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: formatMonthParam(previousMonth),
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
                  aria-label="Next month"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted"
                  href={`/${buildQueryString({
                    ...baseFilters,
                    month: formatMonthParam(nextMonth),
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

          <section className="hidden rounded-[1.35rem] border border-border/75 bg-white/[0.025] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] lg:block">
            <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                Refine calendar
              </div>
              {hasActiveFilters ? (
                <div className="flex flex-wrap gap-2">
                  {activeFilterLabels.map((label) => (
                    <span className="app-chip bg-card/95 text-primary" key={label}>
                      {label}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Search events, narrow by venue or type, and focus on weekends.
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
          <section className="lg:hidden">{renderSelectedDayAgenda({ mobile: true })}</section>

          <section className="hidden gap-4 lg:grid 2xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="overflow-hidden rounded-[1.5rem] border border-border/80 bg-card/95 shadow-[0_30px_85px_-58px_rgba(0,0,0,0.82)]">
              <div className="flex items-center justify-between gap-3 border-b border-border/80 bg-muted/[0.32] px-4 py-3">
                <div>
                  <p className="section-kicker">Month grid</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight">{monthLabel}</h2>
                </div>
                <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                  <span className="inline-flex items-center gap-1.5">
                    <Star className="h-3.5 w-3.5 text-primary" />
                    selected day
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5 text-primary" />
                    times first
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[56rem] bg-card">
                  <div className="grid grid-cols-7 border-b border-border/80 bg-muted/[0.42]">
                    {WEEKDAY_LABELS.map((weekday, index) => (
                      <div
                        className={cn(
                          "px-3 py-3 text-center text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground",
                          index >= 5 && "bg-white/[0.025] text-sky-200",
                        )}
                        key={weekday}
                      >
                        {weekday}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7">
                    {calendarDays.map((day, index) => {
                      const dayKey = formatDateKey(day);
                      const inMonth = day.getMonth() === monthStart.getMonth();
                      const dayBucket = inMonth ? monthDayBuckets.get(dayKey) : undefined;
                      const dayEventCount = dayBucket?.eventCount ?? 0;
                      const visibleEvents = dayBucket?.previewEvents ?? [];
                      const isSelected = dayKey === selectedDayKey;
                      const isToday = dayKey === todayKey;
                      const isWeekendColumn = index % 7 >= 5;

                      return (
                        <Link prefetch={false}
                          className={cn(
                            "group relative min-h-[9.75rem] border-r border-b border-border/75 bg-card px-2.5 pb-2.5 pt-2.5 transition hover:z-10 hover:bg-primary/[0.035]",
                            (index + 1) % 7 === 0 && "border-r-0",
                            !inMonth && "bg-muted/[0.18] text-muted-foreground",
                            isWeekendColumn && inMonth && "bg-white/[0.018]",
                            isSelected &&
                              "z-10 bg-primary/[0.085] shadow-[inset_0_0_0_2px_rgba(113,112,255,0.42)]",
                          )}
                          href={`/${buildQueryString({
                            ...baseFilters,
                            month: formatMonthParam(day),
                            day: dayKey,
                          })}`}
                          key={dayKey}
                          scroll={false}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span
                              className={cn(
                                "inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm font-semibold tabular-nums",
                                isToday
                                  ? "bg-primary text-primary-foreground shadow-[0_14px_26px_-16px_rgba(113,112,255,0.95)]"
                                  : isSelected
                                    ? "bg-primary/10 text-primary"
                                    : inMonth
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                              )}
                            >
                              {day.getDate()}
                            </span>

                            {dayEventCount > 0 ? (
                              <span className="rounded-full bg-background/80 px-2 py-1 text-[10px] font-semibold text-muted-foreground ring-1 ring-border/70">
                                {dayEventCount}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-2.5 space-y-1.5">
                            {visibleEvents.map((event) => {
                              const tone = getEventTone(event);
                              const eventTime =
                                event.displayTimeSource === "unknown"
                                  ? undefined
                                  : getResolvedDisplayTime(event);

                              return (
                                <div
                                  className={cn(
                                    "flex items-center gap-1.5 rounded-[0.75rem] border px-2 py-1.5 text-[11px] font-semibold shadow-[0_12px_28px_-26px_rgba(0,0,0,0.8)]",
                                    tone.chip,
                                  )}
                                  key={event._id}
                                >
                                  <span className={cn("h-1.5 w-1.5 flex-none rounded-full", tone.dot)} />
                                  {eventTime ? (
                                    <span className="min-w-[2.35rem] flex-none text-[10px] font-semibold tabular-nums text-muted-foreground">
                                      {eventTime}
                                    </span>
                                  ) : null}
                                  <span className="truncate">{event.title}</span>
                                </div>
                              );
                            })}
                            {dayEventCount > visibleEvents.length ? (
                              <p className="px-1 pt-0.5 text-[10px] font-semibold text-primary">
                                View {dayEventCount - visibleEvents.length} more
                              </p>
                            ) : null}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="hidden 2xl:block">{renderSelectedDayAgenda()}</div>
          </section>

          <div className="hidden lg:block 2xl:hidden">{renderSelectedDayAgenda({ compact: true })}</div>

        </>
      ) : null}
    </main>
  );
}
