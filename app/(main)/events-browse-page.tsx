import Link from "next/link";
import Image from "next/image";
import skyline from "@/public/images/belgrade-skyline.png";
import {
  loadPublicCalendarEventsWindow,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { EventsToolbar } from "@/components/calendar/events-toolbar";
import { normalizeAgendaSortMode, sortAgendaEvents } from "@/lib/events/agenda-sort";
import { CalendarScrollRestoration } from "@/components/calendar/calendar-scroll-restoration";
import { CalendarAgenda } from "@/components/calendar/calendar-agenda";
import { CalendarOverviewProvider } from "@/components/calendar/calendar-overview";
import { projectCalendarAgendaEvents } from "@/lib/events/calendar-agenda-projection";
import type { CalendarEventSummary } from "@/lib/events/calendar-agenda-types";
import { resolveCalendarVenueSelection } from "@/lib/events/calendar-venue-selection";
import { JsonLd } from "@/components/seo/json-ld";
import { MobileWeekCalendar } from "@/components/calendar/mobile-week-calendar";
import { getMobileDayHeading, getMobileDayLabel, getMobileWeekDateKeys } from "@/lib/events/mobile-week";
import mobileStyles from "@/components/calendar/mobile-events-home.module.css";
import { getEventCategoryKind, type EventCategoryKind } from "@/components/events/event-meta";
import { EVENT_PRIMARY_CATEGORIES, normalizeHiddenEventCategories } from "@/lib/taxonomy/event-categories";
import { cn } from "@/lib/utils";
import { addDaysToDateKey, dateKeyToLocalNoonDate, getNightlifeDefaultDateKey } from "@/lib/events/nightlife-date";
import { getOpenNowEventState, getOpenNowEventWindow, type OpenNowEventState } from "@/lib/venues/venue-open-now";
import { matchesPublicEventNameArtistOrVenue } from "@/lib/events/public-event-search";
import { HOME_FAQ_ITEMS, buildHomePageStructuredData } from "@/lib/seo/site";
import {
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

type ConcreteDayCategory = EventCategoryKind;

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
const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

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
  const hiddenDayCategories = normalizeHiddenDayCategories(getSingleValue(resolvedSearchParams?.hide));
  const hiddenDayCategorySet = new Set(hiddenDayCategories);
  const selectedSortMode = normalizeAgendaSortMode(getSingleValue(resolvedSearchParams?.sort));
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const monthDayBuckets = new Map<string, CalendarDayBucket>();

  for (const event of events) {
    if (!openNowActive && !event.date.startsWith(`${monthParam}-`)) {
      continue;
    }

    if (!eventMatchesFilters(event, venueSelection.value, selectedSearchQuery)) {
      continue;
    }

    const eventCategory = getDayCategory(event);
    const bucketDate = openNowActive ? selectedDayKey : event.date;
    const dayBucket = getCalendarDayBucket(monthDayBuckets, bucketDate);
    dayBucket.categoryCounts[eventCategory] += 1;

    if (hiddenDayCategorySet.has(eventCategory)) {
      continue;
    }

    dayBucket.eventCount += 1;
  }

  const selectedDayAgendaEvents: CalendarEventSummary[] = [];
  let selectedDayEventCount = 0;

  for (const event of events) {
    if (!openNowActive && event.date !== selectedDayKey) {
      continue;
    }
    if (!eventMatchesFilters(event, venueSelection.value, selectedSearchQuery)) {
      continue;
    }

    const summary = toCalendarEventSummary(event);
    if (!hiddenDayCategorySet.has(getDayCategory(summary))) {
      selectedDayEventCount += 1;
    }
    selectedDayAgendaEvents.push(summary);
  }

  const sortedDayAgendaEvents = sortAgendaEvents(selectedDayAgendaEvents, selectedSortMode);

  const selectedDate = parseNormalizedEventDate(selectedDayKey) ?? monthStart;
  const monthDays = getMonthDays(monthStart);
  const hiddenCategoriesParam = formatHiddenDayCategories(hiddenDayCategories);
  const hiddenSort = selectedSortMode === "time" ? undefined : selectedSortMode;

  const baseFilters = {
    q: selectedSearchQuery,
    venue: venueSelection.value,
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
      isUpcoming: dayKey >= todayKey,
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
  const hasActiveFilters = Boolean(selectedSearchQuery || venueSelection.value || hiddenCategoriesParam || hiddenSort || openNowActive);
  const dateLabel = new Intl.DateTimeFormat("sr-Latn", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Belgrade" }).format(selectedDate);

  return (
    <CalendarOverviewProvider
      options={{ month: monthParam, weekStart: todayKey, q: selectedSearchQuery, venue: venueSelection.value }}
      openNow={openNowActive}
      selectedDay={{ date: selectedDayKey, groups: selectedDayAgendaEvents.map(event => ({ date: selectedDayKey, category: getDayCategory(event), venueValue: getPublicEventVenueFilterValue(event), count: 1, legacyVenueMatchCount: 1 })) }}
    >
    <main className={cn("app-page", mobileStyles.home)} data-mobile-week-home="true">
      <JsonLd data={buildHomePageStructuredData(selectedDayAgendaEvents)} />
      <CalendarScrollRestoration />
      <section className={mobileStyles.intro} aria-labelledby="events-heading">
        <Image className={mobileStyles.panorama} src={skyline} alt="" fill priority sizes="(max-width: 767px) 100vw, 1240px" />
        <div><h1 className={mobileStyles.heading} id="events-heading" lang="sr-Latn-RS">{getMobileDayHeading(selectedDayKey, todayKey)}</h1>
          <p className={mobileStyles.total} lang="sr-Latn-RS"><span data-calendar-mobile-day-count="true">{selectedDayEventCount}</span> {selectedDayEventCount === 1 ? "događaj" : "događaja"} u gradu</p>
        </div>
        <p className={mobileStyles.selectedDate}>{dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1)}</p>
      </section>
      <MobileWeekCalendar days={mobileWeekDays} monthDays={mobileMonthDays.map(({ dayKey, eventCount }) => ({ dayKey, eventCount }))} selectedDayKey={selectedDayKey} todayKey={todayKey} />
      <EventsToolbar query={selectedSearchQuery} sortMode={selectedSortMode} openNowActive={openNowActive} openNowHref={openNowHref} now={now} />
      {venueSelection.value ? <p className="mb-2 text-xs text-muted-foreground">Izabrano mesto: {venueSelection.label ?? venueSelection.value} · <Link href={`/${buildQueryString({ ...baseFilters, month: monthParam, day: selectedDayKey, venue: undefined })}`} prefetch={false} scroll={false} data-calendar-client-navigation="true" className="text-primary underline underline-offset-4">Poništi</Link></p> : null}
      {error ? <p className="py-4 text-sm text-destructive" role="alert">{error}</p> : <CalendarAgenda
        key={JSON.stringify([selectedDayKey, venueSelection.value, selectedSearchQuery, hiddenCategoriesParam, selectedSortMode, openNowActive])}
        events={projectCalendarAgendaEvents(sortedDayAgendaEvents, new Map(sortedDayAgendaEvents.map((event, index) => [event._id, index])), openNowStates)}
        hiddenDayCategories={hiddenDayCategories} selectedDayEventCount={selectedDayEventCount}
        dayLabel={dayFormatter.format(selectedDate)} openNowActive={openNowActive} openNowHref={openNowHref}
        now={now} authEnabled={authEnabled} sortMode={selectedSortMode} hasActiveFilters={hasActiveFilters}
        clearFiltersHref={`/${buildQueryString({ month: monthParam, day: selectedDayKey })}`} />}

      <section
        aria-labelledby="belgrade-events-guide"
        className={mobileStyles.guide}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
          <div>
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
