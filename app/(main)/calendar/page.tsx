import Link from "next/link";
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import {
  loadUpcomingApprovedEvents,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { MonthEventsTable } from "@/components/calendar/month-events-table";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarSearchParams = {
  month?: string | string[];
  day?: string | string[];
  venue?: string | string[];
  type?: string | string[];
  weekend?: string | string[];
};

type CalendarPageProps = {
  searchParams?: CalendarSearchParams;
};

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

function isWeekendDate(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function formatDisplayDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", options).format(date);
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

function filterEvents(
  events: PublicEvent[],
  venue: string | undefined,
  eventType: string | undefined,
  weekendOnly: boolean,
): PublicEvent[] {
  return events.filter((event) => {
    if (venue && event.venue !== venue) {
      return false;
    }

    if (eventType && event.eventType !== eventType) {
      return false;
    }

    if (!weekendOnly) {
      return true;
    }

    const eventDate = parseNormalizedEventDate(event.date);
    return eventDate ? isWeekendDate(eventDate) : false;
  });
}

function formatAgendaMeta(event: PublicEvent): string {
  const parts = [event.venue, event.eventType, event.ticketPrice ?? null];

  if (event.artists.length > 0) {
    parts.push(event.artists.join(", "));
  }

  return parts.filter(Boolean).join(" · ");
}

export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const { events, error } = await loadUpcomingApprovedEvents();
  const today = new Date();
  const todayKey = formatDateKey(today);
  const requestedMonth = getSingleValue(searchParams?.month);
  const selectedVenue = getSingleValue(searchParams?.venue);
  const selectedType = getSingleValue(searchParams?.type);
  const weekendOnly = getSingleValue(searchParams?.weekend) === "1";
  const monthStart = parseMonthParam(requestedMonth, today);
  const monthParam = formatMonthParam(monthStart);

  const venues = Array.from(new Set(events.map((event) => event.venue))).sort((left, right) =>
    left.localeCompare(right),
  );
  const eventTypes = Array.from(new Set(events.map((event) => event.eventType))).sort(
    (left, right) => left.localeCompare(right),
  );

  const filteredEvents = filterEvents(events, selectedVenue, selectedType, weekendOnly);
  const monthEvents = filteredEvents.filter((event) => event.date.startsWith(`${monthParam}-`));
  const monthEventsByDay = new Map<string, PublicEvent[]>();

  for (const event of monthEvents) {
    const dayEvents = monthEventsByDay.get(event.date) ?? [];
    dayEvents.push(event);
    monthEventsByDay.set(event.date, dayEvents);
  }

  const filteredMonthDayKeys = Array.from(monthEventsByDay.keys()).sort();
  const selectedDayKey = getSelectedDay(
    monthStart,
    getSingleValue(searchParams?.day),
    filteredMonthDayKeys,
  );
  const selectedDayEvents = monthEventsByDay.get(selectedDayKey) ?? [];
  const selectedDate = parseNormalizedEventDate(selectedDayKey) ?? monthStart;
  const calendarDays = getCalendarDays(monthStart);
  const previousMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
  const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const monthLabel = formatDisplayDate(monthStart, { month: "long", year: "numeric" });
  const activeDayCount = filteredMonthDayKeys.length;
  const activeVenueCount = new Set(monthEvents.map((event) => event.venue)).size;
  const weekendEventCount = monthEvents.filter((event) => {
    const eventDate = parseNormalizedEventDate(event.date);
    return eventDate ? isWeekendDate(eventDate) : false;
  }).length;

  const baseFilters = {
    venue: selectedVenue,
    type: selectedType,
    weekend: weekendOnly ? "1" : undefined,
  };

  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-3 px-3 py-4 sm:px-5 sm:py-5 lg:px-6">
      <header className="glass-panel overflow-hidden px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-[1rem] bg-primary/[0.1] text-primary shadow-[0_18px_30px_-22px_rgba(59,130,246,0.8)]">
              <CalendarDays className="h-4 w-4" />
            </div>
            <div className="space-y-0.5">
              <p className="section-kicker">Calendar</p>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Month view</h1>
              <p className="text-sm text-muted-foreground">
                {monthEvents.length} events across {activeDayCount} active days this month.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="app-chip">
              {weekendEventCount} weekend event{weekendEventCount === 1 ? "" : "s"}
            </span>
            <Link className="button-secondary h-9 px-4 py-0 text-sm" href="/events">
              Events
            </Link>
          </div>
        </div>
      </header>

      <section className="overflow-hidden rounded-[2rem] border border-border/80 bg-card/95 shadow-[0_34px_90px_-58px_rgba(15,23,42,0.42)]">
        <div className="border-b border-border/80 bg-background/88 px-4 py-3.5 sm:px-5 sm:py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="inline-flex w-fit items-center gap-1 rounded-full border border-border/80 bg-card/88 p-1 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.3)]">
                  <Link
                    aria-label="Previous month"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground hover:bg-muted"
                    href={`/calendar${buildQueryString({
                      ...baseFilters,
                      month: formatMonthParam(previousMonth),
                    })}`}
                    scroll={false}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Link>
                  <Link
                    className="inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-semibold text-foreground hover:bg-muted"
                    href={`/calendar${buildQueryString({
                      month: formatMonthParam(today),
                      day: todayKey,
                    })}`}
                    scroll={false}
                  >
                    Today
                  </Link>
                  <Link
                    aria-label="Next month"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground hover:bg-muted"
                    href={`/calendar${buildQueryString({
                      ...baseFilters,
                      month: formatMonthParam(nextMonth),
                    })}`}
                    scroll={false}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </div>

                <div className="space-y-0.5">
                  <p className="section-kicker">Browse month</p>
                  <h2 className="text-[1.75rem] font-semibold tracking-tight sm:text-[2rem]">
                    {monthLabel}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {monthEvents.length} events · {activeDayCount} active days · {activeVenueCount} venues
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="app-chip">{selectedDayEvents.length} on selected day</span>
                <Link className="button-secondary h-9 px-4 py-0 text-sm" href="/events">
                  List view
                </Link>
              </div>
            </div>

            <form className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" method="get">
              <input name="month" type="hidden" value={monthParam} />
              <input name="day" type="hidden" value={selectedDayKey} />

              <label className="flex min-w-[10rem] flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Venue
                <select
                  className="h-10 rounded-2xl border border-border/80 bg-background px-3 text-sm font-medium tracking-normal text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
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

              <label className="flex min-w-[10rem] flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Type
                <select
                  className="h-10 rounded-2xl border border-border/80 bg-background px-3 text-sm font-medium tracking-normal text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
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

              <label className="flex min-w-[10rem] flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Focus
                <select
                  className="h-10 rounded-2xl border border-border/80 bg-background px-3 text-sm font-medium tracking-normal text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
                  defaultValue={weekendOnly ? "1" : ""}
                  name="weekend"
                >
                  <option value="">All days</option>
                  <option value="1">Weekend only</option>
                </select>
              </label>

              <div className="flex items-end gap-2">
                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-[0_24px_40px_-28px_rgba(59,130,246,0.92)] hover:opacity-95"
                  type="submit"
                >
                  <Filter className="h-4 w-4" />
                  Apply
                </button>
                <Link
                  className="inline-flex h-10 items-center justify-center rounded-2xl border border-border/80 bg-background px-4 text-sm font-semibold text-foreground hover:border-primary/30 hover:bg-card"
                  href={`/calendar${buildQueryString({
                    month: monthParam,
                    day: selectedDayKey,
                  })}`}
                  scroll={false}
                >
                  Reset
                </Link>
              </div>
            </form>

            {(selectedVenue || selectedType || weekendOnly) && !error ? (
              <div className="flex flex-wrap gap-2 text-sm">
                {selectedVenue ? <span className="app-chip">Venue: {selectedVenue}</span> : null}
                {selectedType ? <span className="app-chip">Type: {selectedType}</span> : null}
                {weekendOnly ? <span className="app-chip">Weekend only</span> : null}
              </div>
            ) : null}
          </div>
        </div>

        {error ? <p className="px-5 py-5 text-sm text-destructive">{error}</p> : null}

        {!error ? (
          <>
            <div className="grid xl:grid-cols-[minmax(0,1fr)_19rem]">
              <div className="min-w-0 border-b border-border/80 xl:border-b-0 xl:border-r">
                <div className="overflow-x-auto">
                  <div className="min-w-[66rem] bg-card">
                    <div className="grid grid-cols-7 border-b border-border/80 bg-muted/[0.42]">
                      {WEEKDAY_LABELS.map((weekday) => (
                        <div
                          className="px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
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
                        const dayEvents = inMonth ? monthEventsByDay.get(dayKey) ?? [] : [];
                        const isSelected = dayKey === selectedDayKey;
                        const isToday = dayKey === todayKey;
                        const isWeekendColumn = index % 7 >= 5;

                        return (
                          <Link
                            className={cn(
                              "group relative min-h-[6.75rem] border-r border-b border-border/75 bg-card px-2.5 pb-2.5 pt-2 transition hover:z-10 hover:bg-primary/[0.035] sm:min-h-[7.5rem]",
                              (index + 1) % 7 === 0 && "border-r-0",
                              !inMonth && "bg-muted/[0.2] text-muted-foreground",
                              isWeekendColumn && inMonth && "bg-sky-50/40",
                              isSelected &&
                                "z-10 bg-primary/[0.055] shadow-[inset_0_0_0_1.5px_rgba(59,130,246,0.32)]",
                            )}
                            href={`/calendar${buildQueryString({
                              ...baseFilters,
                              month: formatMonthParam(day),
                              day: dayKey,
                            })}`}
                            key={dayKey}
                            scroll={false}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <span
                                  className={cn(
                                    "inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm font-medium",
                                    isToday
                                      ? "bg-primary text-primary-foreground shadow-[0_14px_26px_-16px_rgba(59,130,246,0.95)]"
                                      : isSelected
                                        ? "bg-primary/10 text-primary"
                                        : inMonth
                                          ? "text-foreground"
                                          : "text-muted-foreground",
                                  )}
                                >
                                  {day.getDate()}
                                </span>
                              </div>

                              {dayEvents.length > 0 ? (
                                <span className="pt-1.5 text-[10px] font-medium text-muted-foreground">
                                  {dayEvents.length}
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-2 space-y-1">
                              {dayEvents.slice(0, 3).map((event) => (
                                <div
                                  className="flex items-center gap-1.5 rounded-md bg-primary/[0.09] px-2 py-1 text-[10px] font-medium text-foreground"
                                  key={event._id}
                                >
                                  <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary/75" />
                                  <span className="truncate">
                                    {event.time ? `${event.time} ` : ""}
                                    {event.title}
                                  </span>
                                </div>
                              ))}
                              {dayEvents.length > 3 ? (
                                <p className="px-1 text-[10px] font-medium text-muted-foreground">
                                  +{dayEvents.length - 3} more
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
              <aside className="bg-muted/[0.18] px-3 py-3 sm:px-4 sm:py-4 xl:min-h-full">
                <div className="xl:sticky xl:top-24">
                  <div className="rounded-[1.6rem] border border-border/80 bg-card/96 p-4 shadow-[0_28px_70px_-48px_rgba(15,23,42,0.34)]">
                    <div className="border-b border-border/80 pb-3">
                      <p className="section-kicker">Selected day</p>
                      <div className="mt-2.5 flex items-start justify-between gap-3">
                        <div className="space-y-0.5">
                          <h3 className="text-xl font-semibold tracking-tight">
                            {formatDisplayDate(selectedDate, {
                              weekday: "long",
                              month: "long",
                              day: "numeric",
                            })}
                          </h3>
                        </div>
                        <div className="rounded-[1rem] bg-primary/[0.08] px-2.5 py-2 text-center text-primary">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.22em]">
                            {formatDisplayDate(selectedDate, { month: "short" })}
                          </p>
                          <p className="text-2xl font-semibold leading-none">
                            {selectedDate.getDate()}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {selectedDayEvents.length} event{selectedDayEvents.length === 1 ? "" : "s"}
                        {weekendEventCount > 0 && weekendOnly
                          ? ` · ${weekendEventCount} weekend matches this month`
                          : ""}
                      </p>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {selectedDayEvents.map((event) => (
                        <article
                          className="relative overflow-hidden rounded-[1.2rem] border border-border/80 bg-background/90 px-3.5 py-3 shadow-[0_20px_34px_-30px_rgba(15,23,42,0.28)]"
                          key={event._id}
                        >
                          <div className="absolute inset-y-3 left-0 w-1 rounded-full bg-primary/75" />
                          <div className="flex items-start gap-2.5 pl-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="rounded-full bg-primary/[0.09] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                                  {event.time ?? "Time TBA"}
                                </span>
                                <h4 className="truncate text-sm font-semibold tracking-tight">
                                  {event.title}
                                </h4>
                              </div>
                              <p className="mt-1 truncate text-xs text-muted-foreground">
                                {formatAgendaMeta(event)}
                              </p>
                            </div>
                            <Link
                              aria-label={`Open ${event.title}`}
                              className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:border-primary/30 hover:bg-background"
                              href={`/events/${event._id}`}
                            >
                              <ArrowUpRight className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                        </article>
                      ))}

                      {selectedDayEvents.length === 0 ? (
                        <div className="rounded-[1.2rem] border border-dashed border-border/80 bg-background/82 px-4 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            No events match the current filters for{" "}
                            {formatDisplayDate(selectedDate, { month: "long", day: "numeric" })}.
                          </p>
                          <p className="mt-1.5 text-sm text-muted-foreground">
                            Try another day or reset the filters.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </aside>
            </div>

            <MonthEventsTable events={monthEvents} monthLabel={monthLabel} />
          </>
        ) : null}
      </section>
    </main>
  );
}
