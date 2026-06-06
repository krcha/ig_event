import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  Clock3,
  MapPin,
  Search,
  Ticket,
} from "lucide-react";
import {
  loadUpcomingApprovedEventsPage,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { getDisplayEventTime } from "@/lib/events/event-time";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
const EVENTS_PAGE_SIZE = 12;

type EventsSearchParams = {
  page?: string | string[];
  q?: string | string[];
};

type EventsPageProps = {
  searchParams?: EventsSearchParams;
};

type DatePill = {
  weekday: string;
  month: string;
  day: string;
  full: string;
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

function formatDatePill(value: string): DatePill {
  const parsed = parseNormalizedEventDate(value);
  if (!parsed) {
    return {
      weekday: "Date",
      month: value,
      day: "",
      full: value,
    };
  }

  return {
    weekday: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(parsed),
    month: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsed),
    day: new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(parsed),
    full: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(parsed),
  };
}

function formatEventDate(value: string): string {
  return formatDatePill(value).full;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function groupEventsByDate(events: PublicEvent[]): { date: string; events: PublicEvent[] }[] {
  const groups = new Map<string, PublicEvent[]>();

  for (const event of events) {
    const dateEvents = groups.get(event.date) ?? [];
    dateEvents.push(event);
    groups.set(event.date, dateEvents);
  }

  return Array.from(groups.entries()).map(([date, dateEvents]) => ({ date, events: dateEvents }));
}

function PaginationControls({
  compact = false,
  hasNextPage,
  hasPreviousPage,
  page,
  paginationBaseParams,
}: {
  compact?: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  page: number;
  paginationBaseParams: Record<string, string>;
}) {
  if (!hasPreviousPage && !hasNextPage) {
    return null;
  }

  return (
    <div className={compact ? "grid grid-cols-2 gap-2" : "flex flex-wrap items-center gap-2"}>
      {hasPreviousPage ? (
        <Link
          className="button-secondary h-10 min-h-10 gap-1.5 px-3 py-0"
          href={`/events${buildQueryString({
            ...paginationBaseParams,
            page: String(page - 1),
          })}`}
        >
          <ArrowLeft className="h-4 w-4" />
          Previous
        </Link>
      ) : null}
      {hasNextPage ? (
        <Link
          className="button-primary h-10 min-h-10 gap-1.5 px-3 py-0"
          href={`/events${buildQueryString({
            ...paginationBaseParams,
            page: String(page + 1),
          })}`}
        >
          Next 12
          <ArrowRight className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  );
}

function EventCard({ event }: { event: PublicEvent }) {
  const date = formatDatePill(event.date);
  const eventTime = getDisplayEventTime(event.time);
  const artistPreview = event.artists.slice(0, 4).join(", ");
  const hiddenArtistCount = Math.max(0, event.artists.length - 4);
  const hasMoreInfo = Boolean(event.description || artistPreview);

  return (
    <article className="group rounded-[1.05rem] border border-border/75 bg-card/95 p-3 shadow-[0_16px_42px_-34px_rgba(0,0,0,0.85)] transition hover:-translate-y-0.5 hover:border-primary/25 hover:bg-white/[0.035] sm:p-3.5">
      <div className="flex items-start gap-3">
        <Link
          aria-label={`Open ${event.title}`}
          className="w-14 flex-none rounded-[0.9rem] border border-primary/15 bg-primary/[0.07] px-2 py-2 text-center text-primary hover:bg-primary/[0.1]"
          href={`/events/${event._id}`}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">{date.weekday}</p>
          <p className="mt-1 text-2xl font-semibold leading-none">{date.day}</p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em]">{date.month}</p>
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <Link
                className="flex min-h-10 items-start gap-1.5 text-[15px] font-semibold leading-5 tracking-tight text-foreground group-hover:text-primary sm:text-base"
                href={`/events/${event._id}`}
              >
                <span className="line-clamp-2">{event.title}</span>
              </Link>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {eventTime ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3.5 w-3.5 text-primary/80" />
                    {eventTime}
                  </span>
                ) : null}
                <span className="inline-flex min-w-0 items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 flex-none text-primary/80" />
                  <span className="truncate">{event.venue}</span>
                </span>
              </div>
            </div>
            <Link
              aria-label={`View details for ${event.title}`}
              className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full border border-border/80 bg-white/[0.035] text-foreground hover:border-primary/35 hover:bg-white/[0.06]"
              href={`/events/${event._id}`}
            >
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="app-chip bg-background/95">{event.eventType}</span>
            {event.ticketPrice ? (
              <span className="app-chip bg-background/95">
                <Ticket className="h-3.5 w-3.5" />
                {event.ticketPrice}
              </span>
            ) : null}
          </div>

          {hasMoreInfo ? (
            <details className="group/details mt-2">
              <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-full border border-border/75 bg-white/[0.025] px-3 text-xs font-semibold text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                More
                <ChevronDown className="h-3.5 w-3.5 transition group-open/details:rotate-180" />
              </summary>
              <div className="mt-2 rounded-[0.85rem] border border-border/70 bg-white/[0.025] px-3 py-2 text-xs leading-5 text-muted-foreground">
                {event.description ? <p className="line-clamp-3">{event.description}</p> : null}
                {artistPreview ? (
                  <p className={event.description ? "mt-1.5" : ""}>
                    {artistPreview}
                    {hiddenArtistCount > 0 ? ` +${hiddenArtistCount} more` : ""}
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const page = parsePageParam(getSingleValue(searchParams?.page));
  const searchQuery = getSingleValue(searchParams?.q)?.trim() ?? "";
  const pageResult = await loadUpcomingApprovedEventsPage({
    page,
    pageSize: EVENTS_PAGE_SIZE,
    searchQuery,
  });
  const { events, error, hasNextPage, hasPreviousPage } = pageResult;
  const venueCount = new Set(events.map((event) => event.venue)).size;
  const typeCount = new Set(events.map((event) => event.eventType)).size;
  const nextEvent = page === 1 && searchQuery.length === 0 ? (events[0] ?? null) : null;
  const nextEventMeta = nextEvent
    ? [formatEventDate(nextEvent.date), getDisplayEventTime(nextEvent.time), nextEvent.venue]
        .filter(Boolean)
        .join(" / ")
    : undefined;
  const rangeStart = events.length > 0 ? (page - 1) * EVENTS_PAGE_SIZE + 1 : 0;
  const rangeEnd = events.length > 0 ? rangeStart + events.length - 1 : 0;
  const paginationBaseParams = {
    ...(searchQuery ? { q: searchQuery } : {}),
  };
  const eventGroups = groupEventsByDate(events);

  return (
    <main className="app-page gap-3 sm:gap-4">
      <header className="hero-panel px-3 py-3 sm:px-5 sm:py-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.4fr)] lg:items-stretch">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="section-kicker">Event feed</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
                  Find your next night
                </h1>
              </div>
              <Link className="button-secondary min-h-10 flex-none gap-2 px-3 py-0" href="/calendar">
                <CalendarDays className="h-4 w-4" />
                <span className="hidden sm:inline">Calendar</span>
              </Link>
            </div>

            <form action="/events" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]" method="get">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="input-control rounded-full pl-11"
                  defaultValue={searchQuery}
                  id="events-search"
                  name="q"
                  placeholder="Search event, venue, artist..."
                  type="search"
                />
              </div>
              <button className="button-primary min-h-12 px-4 py-0" type="submit">
                Search
              </button>
              {searchQuery ? (
                <Link className="button-secondary min-h-12 px-4 py-0" href="/events">
                  Clear
                </Link>
              ) : null}
            </form>

            <div className="flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="app-chip shrink-0 bg-card/95">{pluralize(events.length, "event")}</span>
              <span className="app-chip shrink-0 bg-card/95">{pluralize(venueCount, "venue")}</span>
              <span className="app-chip shrink-0 bg-card/95">{pluralize(typeCount, "type")}</span>
              <span className="app-chip shrink-0 bg-card/95">Page {page}</span>
            </div>
          </div>

          {nextEvent ? (
            <Link
              className="rounded-[1.1rem] border border-primary/15 bg-primary/[0.07] p-3 text-foreground hover:border-primary/30 hover:bg-primary/[0.1]"
              href={`/events/${nextEvent._id}`}
            >
              <p className="section-kicker text-primary">Next up</p>
              <p className="mt-2 line-clamp-2 text-base font-semibold leading-5 tracking-tight">
                {nextEvent.title}
              </p>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {nextEventMeta}
              </p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                Open
                <ArrowRight className="h-4 w-4" />
              </span>
            </Link>
          ) : (
            <div className="rounded-[1.1rem] border border-dashed border-border/80 bg-white/[0.025] p-3">
              <p className="section-kicker">Tip</p>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                Search when you remember a name. Use calendar when you know the date.
              </p>
            </div>
          )}
        </div>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section className="glass-panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border/75 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <p className="section-kicker">Browse</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              {searchQuery ? `Results for "${searchQuery}"` : "Upcoming"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {events.length > 0
                ? `${rangeStart}-${rangeEnd} / page ${page}`
                : searchQuery
                  ? "No matching approved events."
                  : "No approved upcoming events yet."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <PaginationControls
              hasNextPage={hasNextPage}
              hasPreviousPage={hasPreviousPage}
              page={page}
              paginationBaseParams={paginationBaseParams}
            />
          </div>
        </div>

        {events.length > 0 ? (
          <div className="space-y-3 px-3 py-3 sm:px-5 sm:py-5">
            {eventGroups.map((group) => (
              <section className="space-y-2.5" key={group.date}>
                <div className="sticky top-[4.2rem] z-10 flex items-center justify-between gap-3 rounded-[1rem] border border-border/75 bg-background/95 px-3 py-2 backdrop-blur md:static md:bg-transparent md:px-1 md:py-0">
                  <div className="min-w-0">
                    <p className="section-kicker">{formatDatePill(group.date).weekday}</p>
                    <h3 className="mt-0.5 truncate text-base font-semibold tracking-tight sm:text-lg">
                      {formatEventDate(group.date)}
                    </h3>
                  </div>
                  <span className="app-chip shrink-0 bg-card/95">{pluralize(group.events.length, "event")}</span>
                </div>
                <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
                  {group.events.map((event) => (
                    <EventCard event={event} key={event._id} />
                  ))}
                </div>
              </section>
            ))}

            <div className="pt-1">
              <PaginationControls
                compact
                hasNextPage={hasNextPage}
                hasPreviousPage={hasPreviousPage}
                page={page}
                paginationBaseParams={paginationBaseParams}
              />
            </div>
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <p className="text-base font-semibold tracking-tight text-foreground">
              {searchQuery ? "Nothing matched your search." : "No events are published right now."}
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {searchQuery
                ? "Try a venue, artist, event type, or clear the search."
                : "Approved events will appear here once moderation publishes them."}
            </p>
            <div className="mt-5 grid gap-2 sm:flex sm:justify-center">
              {searchQuery ? (
                <Link className="button-primary" href="/events">
                  Clear search
                </Link>
              ) : null}
              <Link className="button-secondary gap-2" href="/calendar">
                <CalendarDays className="h-4 w-4" />
                Open calendar
              </Link>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
