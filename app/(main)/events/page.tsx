import Link from "next/link";
import { ArrowRight, CalendarDays } from "lucide-react";
import { ApprovedEventsDedupeButton } from "@/components/events/approved-events-dedupe-button";
import {
  loadUpcomingApprovedEvents,
  parseNormalizedEventDate,
} from "@/lib/events/public-events";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

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

export default async function EventsPage() {
  const { events, error } = await loadUpcomingApprovedEvents();
  const venueCount = new Set(events.map((event) => event.venue)).size;
  const typeCount = new Set(events.map((event) => event.eventType)).size;
  const nextEvent = events[0] ?? null;

  return (
    <main className="app-page">
      <header className="hero-panel px-6 py-7 sm:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-3">
            <p className="section-kicker">Approved event feed</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Upcoming events</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              A simple event table so date, venue, type, and price are easy to scan at a glance.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className="button-secondary gap-2" href="/calendar">
              <CalendarDays className="h-4 w-4" />
              Switch to calendar
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="metric-card">
            <p className="section-kicker">Upcoming</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{events.length}</p>
            <p className="mt-2 text-sm text-muted-foreground">Approved events currently in the list.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Venues</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{venueCount}</p>
            <p className="mt-2 text-sm text-muted-foreground">Distinct venues in the feed.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Types</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{typeCount}</p>
            <p className="mt-2 text-sm text-muted-foreground">Event types across the current slate.</p>
          </div>
        </div>

        {nextEvent ? (
          <div className="glass-panel mt-6 flex flex-col gap-4 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
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
            <Link className="button-primary gap-2" href={`/events/${nextEvent._id}`}>
              Open next event
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : null}
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {events.length > 0 ? (
        <section className="glass-panel overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border/70 px-6 py-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="section-kicker">Event table</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight">All upcoming events</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                One row per event with the most important details first.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              <span className="app-chip">{events.length} listed</span>
              <ApprovedEventsDedupeButton disabled={events.length < 2} />
            </div>
          </div>

          <div className="hidden md:block overflow-x-auto">
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

          <div className="md:hidden">
            {events.map((event) => (
              <article className="border-b border-border/65 px-5 py-4 last:border-b-0" key={event._id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{formatEventDate(event.date)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatEventTime(event.time)}</p>
                  </div>
                  <span className="app-chip">{event.eventType}</span>
                </div>

                <Link
                  className="mt-3 block text-base font-semibold tracking-tight text-foreground hover:text-primary"
                  href={`/events/${event._id}`}
                >
                  {event.title}
                </Link>

                <p className="mt-2 text-sm text-muted-foreground">
                  {event.venue}
                  {event.ticketPrice ? ` · ${event.ticketPrice}` : ""}
                </p>

                {event.artists.length > 0 ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {event.artists.join(", ")}
                  </p>
                ) : null}

                <Link
                  className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                  href={`/events/${event._id}`}
                >
                  Open details
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {events.length === 0 && !error ? (
        <div className="glass-panel px-6 py-10 text-center text-sm text-muted-foreground">
          No upcoming approved events right now.
        </div>
      ) : null}
    </main>
  );
}
