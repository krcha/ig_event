import Link from "next/link";
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

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { event, error } = await loadEvent(params.eventId);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Event Details</h1>
        <p className="text-sm text-muted-foreground">
          Event ID: <span className="font-medium">{params.eventId}</span>
        </p>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {event ? (
        <article className="space-y-3 rounded-xl border border-border bg-card p-6 text-sm">
          <h2 className="text-xl font-semibold">{event.title}</h2>
          <p className="text-muted-foreground">
            {event.date}
            {event.time ? ` at ${event.time}` : ""}
            {" · "}
            {event.venue}
          </p>
          <p className="text-muted-foreground">Status: {event.status}</p>
          <p className="text-muted-foreground">
            Type: {event.eventType}
            {event.ticketPrice ? ` · ${event.ticketPrice}` : ""}
          </p>
          {event.artists.length > 0 ? (
            <p className="text-muted-foreground">Artists: {event.artists.join(", ")}</p>
          ) : null}
          {event.description ? <p>{event.description}</p> : null}
          {event.instagramPostUrl ? (
            <a
              className="inline-block text-primary underline"
              href={event.instagramPostUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open Instagram post
            </a>
          ) : null}
        </article>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Event not found.
        </div>
      )}

      <Link className="text-sm text-primary underline" href="/events">
        Back to events
      </Link>
    </main>
  );
}
