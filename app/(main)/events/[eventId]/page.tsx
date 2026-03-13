import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, CalendarDays, Clock3, ExternalLink, MapPin, Ticket } from "lucide-react";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

type EventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  ticketPrice?: string;
  eventType: string;
  status: "pending" | "approved" | "rejected";
};

type EventDetailPageProps = {
  params: { eventId: string };
};

const getEventQuery = "events:getEvent" as unknown as FunctionReference<"query">;

async function loadEvent(eventId: string): Promise<{
  event: EventRecord | null;
  error?: string;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return { event: null, error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const event = (await convex.query(getEventQuery, { id: eventId })) as EventRecord | null;
    return { event };
  } catch (error) {
    return {
      event: null,
      error: error instanceof Error ? error.message : "Failed to load event details.",
    };
  }
}

function formatEventDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { event, error } = await loadEvent(params.eventId);

  return (
    <main className="app-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link className="button-secondary w-full gap-2 sm:w-auto" href="/events">
          <ArrowLeft className="h-4 w-4" />
          Back to events
        </Link>
        <span className="app-chip">Event ID {params.eventId}</span>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {event ? (
        <article className="hero-panel">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.05fr)_320px]">
            <div className="order-1 border-b border-border/70 bg-secondary/55 p-4 sm:p-6 lg:order-2 lg:border-l lg:border-b-0">
              {event.imageUrl ? (
                <div className="glass-panel overflow-hidden p-2">
                  <div className="relative aspect-[4/5] min-h-72 w-full overflow-hidden rounded-[1.25rem]">
                    <Image
                      alt={event.title}
                      className="object-cover"
                      fill
                      sizes="(max-width: 1024px) 100vw, 320px"
                      src={event.imageUrl}
                    />
                  </div>
                </div>
              ) : (
                <div className="glass-panel flex min-h-72 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  No poster image is available for this event.
                </div>
              )}
            </div>

            <div className="order-2 space-y-5 px-5 py-6 sm:px-8 sm:py-8 lg:order-1 lg:space-y-6">
              <div className="flex flex-wrap gap-2">
                <span className="app-chip">{event.status}</span>
                <span className="app-chip">{event.eventType}</span>
                {event.ticketPrice ? (
                  <span className="app-chip">
                    <Ticket className="h-3.5 w-3.5" />
                    {event.ticketPrice}
                  </span>
                ) : null}
              </div>

              <div className="space-y-3">
                <p className="section-kicker">Event detail</p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  {event.title}
                </h1>
                {event.description ? (
                  <p className="max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
                    {event.description}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="metric-card">
                  <p className="section-kicker">Date</p>
                  <p className="mt-3 inline-flex items-center gap-2 text-base font-semibold">
                    <CalendarDays className="h-4 w-4 text-primary" />
                    {formatEventDate(event.date)}
                  </p>
                </div>
                <div className="metric-card">
                  <p className="section-kicker">Time</p>
                  <p className="mt-3 inline-flex items-center gap-2 text-base font-semibold">
                    <Clock3 className="h-4 w-4 text-primary" />
                    {event.time ?? "Time TBA"}
                  </p>
                </div>
                <div className="metric-card">
                  <p className="section-kicker">Venue</p>
                  <p className="mt-3 inline-flex items-center gap-2 text-base font-semibold">
                    <MapPin className="h-4 w-4 text-primary" />
                    {event.venue}
                  </p>
                </div>
              </div>

              {event.artists.length > 0 ? (
                <div className="glass-panel px-5 py-5">
                  <p className="section-kicker">Artists</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {event.artists.map((artist) => (
                      <span className="app-chip" key={artist}>
                        {artist}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {event.instagramPostUrl ? (
                  <a
                    className="button-primary w-full gap-2 sm:w-auto"
                    href={event.instagramPostUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open Instagram post
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : null}
                <Link className="button-secondary w-full sm:w-auto" href="/calendar">
                  Open calendar
                </Link>
              </div>
            </div>
          </div>
        </article>
      ) : (
        <div className="glass-panel px-6 py-10 text-center text-sm text-muted-foreground">
          Event not found.
        </div>
      )}
    </main>
  );
}
