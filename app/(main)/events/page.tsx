import Link from "next/link";
import { ArrowRight, CalendarDays, Clock3, MapPin } from "lucide-react";
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
              A cleaner list view for approved events, optimized for quick scanning by date, venue,
              and category.
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
            <p className="section-kicker">Queued</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{events.length}</p>
            <p className="mt-2 text-sm text-muted-foreground">Approved upcoming events live now.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Coverage</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{venueCount}</p>
            <p className="mt-2 text-sm text-muted-foreground">Distinct venues in the feed.</p>
          </div>
          <div className="metric-card">
            <p className="section-kicker">Mix</p>
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

      <div className="grid gap-4 xl:grid-cols-2">
        {events.map((event) => (
          <article
            className="glass-panel px-6 py-6 text-sm"
            key={event._id}
          >
            <div className="flex h-full flex-col justify-between gap-5">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className="app-chip">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {formatEventDate(event.date)}
                  </span>
                  <span className="app-chip">
                    <Clock3 className="h-3.5 w-3.5" />
                    {event.time ?? "Time TBA"}
                  </span>
                  <span className="app-chip">
                    <MapPin className="h-3.5 w-3.5" />
                    {event.venue}
                  </span>
                </div>

                <div>
                  <h2 className="text-xl font-semibold tracking-tight">{event.title}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {event.eventType}
                    {event.ticketPrice ? ` · ${event.ticketPrice}` : ""}
                  </p>
                </div>

                {event.artists.length > 0 ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    Artists: {event.artists.join(", ")}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="section-kicker">Approved listing</span>
                <Link className="button-secondary gap-2" href={`/events/${event._id}`}>
                  Open details
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>

      {events.length === 0 && !error ? (
        <div className="glass-panel px-6 py-10 text-center text-sm text-muted-foreground">
          No upcoming approved events right now.
        </div>
      ) : null}
    </main>
  );
}
