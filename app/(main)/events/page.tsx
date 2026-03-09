import Link from "next/link";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type EventStatus = "pending" | "approved" | "rejected";

type PublicEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
  eventType: string;
  ticketPrice?: string;
  sourcePostedAt?: string;
  normalizedFieldsJson?: string;
  status: EventStatus;
};

const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;

function parseNormalizedEventDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function getStartOfLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseEventTimeMinutes(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return 0;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return 0;
  }
  return hours * 60 + minutes;
}

function logFilteredOutEvent(event: PublicEvent, reason: "not_approved" | "past_date" | "invalid_normalized_date") {
  console.info(
    JSON.stringify({
      level: "info",
      event: "public_events.filtered_out",
      reason,
      eventId: event._id,
      title: event.title,
      status: event.status,
      eventDate: event.date,
      eventTime: event.time ?? null,
      sourcePostedAt: event.sourcePostedAt ?? null,
    }),
  );
}

function filterUpcomingApprovedEvents(events: PublicEvent[]): PublicEvent[] {
  const startOfToday = getStartOfLocalToday();
  const upcomingEvents: PublicEvent[] = [];
  let filteredNotApproved = 0;
  let filteredInvalidDate = 0;
  let filteredPastDate = 0;
  let approvedEvents = 0;

  for (const event of events) {
    if (event.status !== "approved") {
      filteredNotApproved += 1;
      logFilteredOutEvent(event, "not_approved");
      continue;
    }

    approvedEvents += 1;

    const parsedDate = parseNormalizedEventDate(event.date);
    if (!parsedDate) {
      filteredInvalidDate += 1;
      logFilteredOutEvent(event, "invalid_normalized_date");
      continue;
    }

    if (parsedDate < startOfToday) {
      filteredPastDate += 1;
      logFilteredOutEvent(event, "past_date");
      continue;
    }

    upcomingEvents.push(event);
  }

  upcomingEvents.sort((left, right) => {
    const leftDate = parseNormalizedEventDate(left.date);
    const rightDate = parseNormalizedEventDate(right.date);
    const leftTime = parseEventTimeMinutes(left.time);
    const rightTime = parseEventTimeMinutes(right.time);
    const leftScore = (leftDate ? leftDate.getTime() : Number.MAX_SAFE_INTEGER) + leftTime * 60 * 1000;
    const rightScore = (rightDate ? rightDate.getTime() : Number.MAX_SAFE_INTEGER) + rightTime * 60 * 1000;
    return leftScore - rightScore;
  });

  console.info(
    JSON.stringify({
      level: "info",
      event: "public_events.filter_summary",
      totalFetchedEvents: events.length,
      approvedEvents,
      upcomingEvents: upcomingEvents.length,
      filteredNotApproved,
      filteredInvalidDate,
      filteredPastDate,
      localToday: startOfToday.toISOString(),
    }),
  );

  return upcomingEvents;
}

async function loadApprovedEvents(): Promise<{
  events: PublicEvent[];
  error?: string;
}> {
  noStore();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return { events: [], error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const events = (await convex.query(listByStatusQuery, {
      status: "approved",
      limit: 500,
    })) as PublicEvent[];
    return { events: filterUpcomingApprovedEvents(events) };
  } catch (error) {
    return {
      events: [],
      error: error instanceof Error ? error.message : "Failed to load approved events.",
    };
  }
}

export default async function EventsPage() {
  const { events, error } = await loadApprovedEvents();

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
