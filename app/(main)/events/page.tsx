import Link from "next/link";
import { loadUpcomingApprovedEvents } from "@/lib/events/public-events";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function EventsPage() {
  const { events, error } = await loadUpcomingApprovedEvents();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Events</h1>
        <p className="text-sm text-muted-foreground">
          Showing upcoming approved events from the moderation pipeline.
        </p>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="space-y-3">
        {events.map((event) => (
          <article
            className="rounded-xl border border-border bg-card p-5 text-sm"
            key={event._id}
          >
            <h2 className="text-lg font-semibold">{event.title}</h2>
            <p className="mt-1 text-muted-foreground">
              {event.date}
              {event.time ? ` at ${event.time}` : ""}
              {" · "}
              {event.venue}
            </p>
            <p className="mt-1 text-muted-foreground">
              {event.eventType}
              {event.ticketPrice ? ` · ${event.ticketPrice}` : ""}
            </p>
            {event.artists.length > 0 ? (
              <p className="mt-2 text-muted-foreground">
                Artists: {event.artists.join(", ")}
              </p>
            ) : null}
            <Link className="mt-3 inline-block text-primary underline" href={`/events/${event._id}`}>
              Open details
            </Link>
          </article>
        ))}
      </div>

      {events.length === 0 && !error ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          No upcoming approved events right now.
        </div>
      ) : null}

      <Link className="text-sm text-primary underline" href="/calendar">
        Switch to calendar view
      </Link>
    </main>
  );
}
