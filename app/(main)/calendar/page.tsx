import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import {
  loadUpcomingApprovedEvents,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  start.setDate(1 - monthStart.getDay());

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

export default async function CalendarPage({ searchParams }: CalendarPageProps) {
  const { events, error } = await loadUpcomingApprovedEvents();
  const today = new Date();
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-4 rounded-[2rem] border border-border bg-card px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-xs font-medium tracking-[0.18em] text-secondary-foreground uppercase">
              <CalendarDays className="h-3.5 w-3.5" />
              Live calendar
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Calendar</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Browse upcoming approved events by month, then drill into a single day agenda.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link
              className="rounded-full border border-border px-4 py-2 text-foreground transition hover:bg-secondary"
              href="/events"
            >
              List view
            </Link>
            <Link
              className="rounded-full border border-border px-4 py-2 text-foreground transition hover:bg-secondary"
              href={`/calendar${buildQueryString({
                month: formatMonthParam(today),
                day: formatDateKey(today),
              })}`}
            >
              Jump to today
            </Link>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-secondary px-4 py-4">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Events this month
            </p>
            <p className="mt-2 text-2xl font-semibold">{monthEvents.length}</p>
          </div>
          <div className="rounded-2xl bg-secondary px-4 py-4">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Active days
            </p>
            <p className="mt-2 text-2xl font-semibold">{activeDayCount}</p>
          </div>
          <div className="rounded-2xl bg-secondary px-4 py-4">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Venues live
            </p>
            <p className="mt-2 text-2xl font-semibold">{activeVenueCount}</p>
          </div>
        </div>
      </header>

      <section className="rounded-[2rem] border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-4 border-b border-border px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between gap-3">
            <Link
              aria-label="Previous month"
              className="rounded-full border border-border p-2 transition hover:bg-secondary"
              href={`/calendar${buildQueryString({
                ...baseFilters,
                month: formatMonthParam(previousMonth),
              })}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <div>
              <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                Browse month
              </p>
              <h2 className="text-2xl font-semibold">
                {formatDisplayDate(monthStart, { month: "long", year: "numeric" })}
              </h2>
            </div>
            <Link
              aria-label="Next month"
              className="rounded-full border border-border p-2 transition hover:bg-secondary"
              href={`/calendar${buildQueryString({
                ...baseFilters,
                month: formatMonthParam(nextMonth),
              })}`}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <form className="grid gap-3 md:grid-cols-4" method="get">
            <input name="month" type="hidden" value={monthParam} />
            <input name="day" type="hidden" value={selectedDayKey} />

            <label className="flex min-w-[11rem] flex-col gap-1 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Venue
              <select
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm font-normal tracking-normal text-foreground"
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

            <label className="flex min-w-[11rem] flex-col gap-1 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Type
              <select
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm font-normal tracking-normal text-foreground"
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

            <label className="flex min-w-[11rem] flex-col gap-1 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Focus
              <select
                className="rounded-xl border border-border bg-background px-3 py-2 text-sm font-normal tracking-normal text-foreground"
                defaultValue={weekendOnly ? "1" : ""}
                name="weekend"
              >
                <option value="">All days</option>
                <option value="1">Weekend only</option>
              </select>
            </label>

            <div className="flex items-end gap-2">
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90"
                type="submit"
              >
                <Filter className="h-4 w-4" />
                Apply
              </button>
              <Link
                className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm transition hover:bg-secondary"
                href={`/calendar${buildQueryString({
                  month: monthParam,
                  day: selectedDayKey,
                })}`}
              >
                Reset
              </Link>
            </div>
          </form>
        </div>

        {(selectedVenue || selectedType || weekendOnly) && !error ? (
          <div className="flex flex-wrap gap-2 border-b border-border px-6 py-4 text-sm">
            {selectedVenue ? (
              <span className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                Venue: {selectedVenue}
              </span>
            ) : null}
            {selectedType ? (
              <span className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                Type: {selectedType}
              </span>
            ) : null}
            {weekendOnly ? (
              <span className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                Weekend only
              </span>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="px-6 py-5 text-sm text-destructive">{error}</p> : null}

        {!error ? (
          <>
            <div className="overflow-x-auto">
              <div className="min-w-[52rem]">
                <div className="grid grid-cols-7 border-b border-border">
                  {WEEKDAY_LABELS.map((weekday) => (
                    <div
                      className="border-r border-border px-3 py-3 text-center text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase last:border-r-0"
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
                    const isToday = dayKey === formatDateKey(today);

                    return (
                      <Link
                        className={cn(
                          "min-h-32 border-r border-b border-border p-3 transition hover:bg-secondary/60",
                          (index + 1) % 7 === 0 && "border-r-0",
                          !inMonth && "bg-muted/30 text-muted-foreground",
                          isSelected && "bg-secondary",
                        )}
                        href={`/calendar${buildQueryString({
                          ...baseFilters,
                          month: formatMonthParam(day),
                          day: dayKey,
                        })}`}
                        key={dayKey}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium",
                              isToday && "bg-foreground text-background",
                            )}
                          >
                            {day.getDate()}
                          </span>
                          {dayEvents.length > 0 ? (
                            <span className="rounded-full bg-background/90 px-2 py-1 text-[11px] font-medium text-foreground">
                              {dayEvents.length} event{dayEvents.length === 1 ? "" : "s"}
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-3 space-y-2">
                          {dayEvents.slice(0, 2).map((event) => (
                            <div
                              className="rounded-xl bg-background/90 px-2.5 py-2 text-left text-[11px] leading-tight text-foreground shadow-sm"
                              key={event._id}
                            >
                              <p className="truncate font-medium">
                                {event.time ?? "TBA"} · {event.title}
                              </p>
                              <p className="mt-1 truncate text-muted-foreground">{event.venue}</p>
                            </div>
                          ))}
                          {dayEvents.length > 2 ? (
                            <p className="text-[11px] font-medium text-muted-foreground">
                              +{dayEvents.length - 2} more
                            </p>
                          ) : null}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section className="rounded-[2rem] border border-border bg-card px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Selected day
            </p>
            <h2 className="text-2xl font-semibold">
              {formatDisplayDate(selectedDate, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {selectedDayEvents.length} event{selectedDayEvents.length === 1 ? "" : "s"} scheduled
            {weekendEventCount > 0 && weekendOnly ? ` · ${weekendEventCount} weekend events this month` : ""}
          </p>
        </div>

        <div className="mt-5 space-y-4">
          {selectedDayEvents.map((event) => (
            <article
              className="rounded-2xl border border-border bg-background px-5 py-5 shadow-sm"
              key={event._id}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                    <span className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                      {event.time ?? "Time TBA"}
                    </span>
                    <span>{event.eventType}</span>
                    {event.ticketPrice ? <span>{event.ticketPrice}</span> : null}
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold">{event.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{event.venue}</p>
                  </div>
                  {event.artists.length > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Artists: {event.artists.join(", ")}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    className="rounded-full border border-border px-4 py-2 text-sm transition hover:bg-secondary"
                    href={`/events/${event._id}`}
                  >
                    Open details
                  </Link>
                </div>
              </div>
            </article>
          ))}

          {selectedDayEvents.length === 0 && !error ? (
            <div className="rounded-2xl border border-dashed border-border bg-secondary/40 px-5 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No events match the current filters for{" "}
                {formatDisplayDate(selectedDate, { month: "long", day: "numeric" })}.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Try another day, remove a filter, or switch back to the full list.
              </p>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
