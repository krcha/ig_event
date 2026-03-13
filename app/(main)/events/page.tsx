import Link from "next/link";
import { ArrowRight, CalendarDays } from "lucide-react";
import { ApprovedEventsDedupeButton } from "@/components/events/approved-events-dedupe-button";
import { isViewerAdmin } from "@/lib/auth/admin";
import {
  loadUpcomingApprovedEventsPage,
  parseNormalizedEventDate,
} from "@/lib/events/public-events";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
const EVENTS_PAGE_SIZE = 24;

type EventsSearchParams = {
  page?: string | string[];
  q?: string | string[];
};

type EventsPageProps = {
  searchParams?: EventsSearchParams;
};

function getSingleValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function parsePageParam(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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

function formatEventDate(value: string): string {
  const parsed = parseNormalizedEventDate(value);
  if (!parsed) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function formatEventTime(value: string | undefined): string {
  return value ?? "Time TBA";
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const page = parsePageParam(getSingleValue(searchParams?.page));
  const searchQuery = getSingleValue(searchParams?.q)?.trim() ?? "";
  const [showAdminActions, pageResult] = await Promise.all([
    isViewerAdmin(),
    loadUpcomingApprovedEventsPage({
      page,
      pageSize: EVENTS_PAGE_SIZE,
      searchQuery,
    }),
  ]);
  const { events, error, hasNextPage, hasPreviousPage } = pageResult;
  const venueCount = new Set(events.map((event) => event.venue)).size;
  const typeCount = new Set(events.map((event) => event.eventType)).size;
  const nextEvent = page === 1 && searchQuery.length === 0 ? (events[0] ?? null) : null;
  const rangeStart = events.length > 0 ? (page - 1) * EVENTS_PAGE_SIZE + 1 : 0;
  const rangeEnd = events.length > 0 ? rangeStart + events.length - 1 : 0;
  const paginationBaseParams = {
    ...(searchQuery ? { q: searchQuery } : {}),
  };

  return (
    <main className="app-page">
      <header className="hero-panel relative px-5 py-6 sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.14),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(20,184,166,0.12),_transparent_26%)]" />
        <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-3">
            <p className="section-kicker">Approved event feed</p>
            <h1 className="text-[2.1rem] font-semibold tracking-tight sm:text-4xl">
              Upcoming events
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
              Search, filter, and scan the approved event feed in a layout that starts with mobile
              cards before it expands into a larger-screen table.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link className="button-secondary w-full gap-2 sm:w-auto" href="/calendar">
              <CalendarDays className="h-4 w-4" />
              Switch to calendar
            </Link>
          </div>
        </div>

        <div className="relative mt-6 grid gap-3 sm:grid-cols-3">
          <div className="metric-card">
            <p className="section-kicker">Shown</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{events.length}</p>
            <p className="mt-2 text-sm text-muted-foreground">Matching events on this page.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Venues</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{venueCount}</p>
            <p className="mt-2 text-sm text-muted-foreground">Distinct venues on this page.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Types</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{typeCount}</p>
            <p className="mt-2 text-sm text-muted-foreground">Event types in the current view.</p>
          </div>
        </div>

        {nextEvent ? (
          <div className="glass-panel mt-6 flex flex-col gap-4 px-4 py-4 sm:px-5 sm:py-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="section-kicker">Next up</p>
              <p className="mt-2 text-xl font-semibold tracking-tight">{nextEvent.title}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatEventDate(nextEvent.date)}
                {nextEvent.time ? ` at ${nextEvent.time}` : ""}
                {" · "}
                {nextEvent.venue}
              </p>
            </div>
            <Link className="button-primary w-full gap-2 sm:w-auto" href={`/events/${nextEvent._id}`}>
              Open next event
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : null}
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section className="glass-panel overflow-hidden">
        <div className="border-b border-border/70 px-4 py-4 sm:px-6 sm:py-5">
          <form
            action="/events"
            className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"
            method="get"
          >
            <div className="w-full max-w-xl space-y-2">
              <label className="section-kicker" htmlFor="events-search">
                Search
              </label>
              <input
                className="w-full rounded-[1.35rem] border border-border/80 bg-background/85 px-4 py-3.5 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/20"
                defaultValue={searchQuery}
                id="events-search"
                name="q"
                placeholder="Search title, venue, artist, type, or ticket notes"
                type="search"
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button className="button-primary w-full sm:w-auto" type="submit">
                Search events
              </button>
              {searchQuery ? (
                <Link className="button-secondary w-full sm:w-auto" href="/events">
                  Clear search
                </Link>
              ) : null}
            </div>
          </form>
        </div>

        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:px-6 sm:py-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="section-kicker">Event feed</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">All upcoming events</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {searchQuery
                ? `Search results for "${searchQuery}" on page ${page}.`
                : events.length > 0
                  ? `Showing events ${rangeStart}-${rangeEnd} on page ${page}.`
                  : `Page ${page} of the approved event feed.`}
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <span className="app-chip">
              {searchQuery ? "Filtered view" : `Page ${page}`}
            </span>
            {showAdminActions ? (
              <ApprovedEventsDedupeButton disabled={events.length < 2} />
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:px-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {searchQuery
              ? `${events.length} result${events.length === 1 ? "" : "s"} on this page.`
              : `${events.length} event${events.length === 1 ? "" : "s"} on this page.`}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {hasPreviousPage ? (
              <Link
                className="button-secondary h-11 px-4 py-0"
                href={`/events${buildQueryString({
                  ...paginationBaseParams,
                  page: String(page - 1),
                })}`}
              >
                Previous
              </Link>
            ) : (
              <span className="button-secondary h-11 px-4 py-0 opacity-50">Previous</span>
            )}
            {hasNextPage ? (
              <Link
                className="button-secondary h-11 px-4 py-0"
                href={`/events${buildQueryString({
                  ...paginationBaseParams,
                  page: String(page + 1),
                })}`}
              >
                Next
              </Link>
            ) : (
              <span className="button-secondary h-11 px-4 py-0 opacity-50">Next</span>
            )}
          </div>
        </div>

        {events.length > 0 ? (
          <>
            <div className="hidden overflow-x-auto xl:block">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-muted/[0.4]">
                  <tr className="border-b border-border/70 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Date
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Event
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Venue
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Type
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Price
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr
                      className="border-b border-border/65 align-top transition hover:bg-primary/[0.03] last:border-b-0"
                      key={event._id}
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <p className="font-medium text-foreground">{formatEventDate(event.date)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatEventTime(event.time)}</p>
                      </td>
                      <td className="min-w-[20rem] px-6 py-4">
                        <Link
                          className="text-base font-semibold tracking-tight text-foreground hover:text-primary"
                          href={`/events/${event._id}`}
                        >
                          {event.title}
                        </Link>
                        {event.artists.length > 0 ? (
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {event.artists.join(", ")}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{event.venue}</td>
                      <td className="px-6 py-4">
                        <span className="app-chip">{event.eventType}</span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-muted-foreground">
                        {event.ticketPrice ?? "TBA"}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Link
                          className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                          href={`/events/${event._id}`}
                        >
                          Open
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 px-4 py-4 sm:px-6 sm:py-5 xl:hidden">
              {events.map((event) => (
                <article
                  className="rounded-[1.35rem] border border-border/75 bg-card/88 px-4 py-4 shadow-[0_18px_36px_-30px_rgba(15,23,42,0.18)]"
                  key={event._id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-foreground">{formatEventDate(event.date)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatEventTime(event.time)}
                      </p>
                    </div>
                    <span className="app-chip">{event.eventType}</span>
                  </div>

                  <Link
                    className="mt-4 block text-lg font-semibold tracking-tight text-foreground hover:text-primary"
                    href={`/events/${event._id}`}
                  >
                    {event.title}
                  </Link>

                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{event.venue}</p>

                  {event.artists.length > 0 ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {event.artists.join(", ")}
                    </p>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {event.ticketPrice ? <span className="app-chip">{event.ticketPrice}</span> : null}
                    <Link
                      className="button-secondary h-11 gap-2 px-4 py-0 text-sm"
                      href={`/events/${event._id}`}
                    >
                      Open details
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>

      {events.length === 0 && !error ? (
        <div className="glass-panel px-6 py-10 text-center text-sm text-muted-foreground">
          {searchQuery
            ? `No upcoming approved events matched "${searchQuery}".`
            : page > 1
              ? "There are no events on this page."
              : "No upcoming approved events right now."}
        </div>
      ) : null}
    </main>
  );
}
