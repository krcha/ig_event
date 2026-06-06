import Link from "next/link";
import { ArrowRight, CalendarDays, Clock3, MapPin, Search } from "lucide-react";
import {
  loadUpcomingApprovedEventsPage,
  parseNormalizedEventDate,
  type PublicEvent,
} from "@/lib/events/public-events";
import { getDisplayEventTime } from "@/lib/events/event-time";

const HOME_ACTIONS = [
  {
    href: "/events",
    label: "Events",
    shortLabel: "Search",
    description: "Find nights by artist, venue, style, or date.",
    icon: Search,
  },
  {
    href: "/calendar",
    label: "Calendar",
    shortLabel: "Dates",
    description: "Swipe days and jump into a focused agenda.",
    icon: CalendarDays,
  },
] as const;

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

function EventPreview({ event, compact = false }: { event: PublicEvent; compact?: boolean }) {
  const eventTime = getDisplayEventTime(event.time);

  return (
    <Link
      className="group block rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-2.5 hover:border-primary/30 hover:bg-white/[0.045]"
      href={`/events/${event._id}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 flex-none flex-col items-center justify-center rounded-[0.9rem] border border-primary/15 bg-primary/[0.08] text-primary">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
            {formatEventDate(event.date).split(" ")[0]}
          </span>
          <span className="text-base font-semibold leading-none">
            {formatEventDate(event.date).split(" ").at(-1)}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-sm font-semibold tracking-tight text-foreground group-hover:text-primary">
            {event.title}
          </p>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {eventTime ? (
              <>
                <Clock3 className="h-3.5 w-3.5 flex-none text-primary/80" />
                <span className="flex-none">{eventTime}</span>
                <span className="text-border">/</span>
              </>
            ) : null}
            <MapPin className="h-3.5 w-3.5 flex-none text-primary/80" />
            <span className="truncate">{event.venue}</span>
          </div>
          {!compact && event.eventType ? (
            <span className="mt-1.5 inline-flex rounded-full bg-white/[0.045] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {event.eventType}
            </span>
          ) : null}
        </div>
        <ArrowRight className="h-4 w-4 flex-none text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
    </Link>
  );
}

export default async function HomePage() {
  const upcoming = await loadUpcomingApprovedEventsPage({ page: 1, pageSize: 5 });
  const nextEvents = upcoming.events.slice(0, 5);
  const nextEvent = nextEvents[0];
  const previewEvents = nextEvents.slice(0, 2);
  const extraEvents = nextEvents.slice(2);

  return (
    <main className="app-page justify-start gap-3 sm:gap-4">
      <section className="hero-panel px-3 py-3 sm:px-5 sm:py-5 lg:px-7 lg:py-7">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-stretch">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="app-chip border-primary/20 bg-primary/[0.08] text-primary">
                Belgrade nights
              </span>
              {nextEvent ? (
                <span className="app-chip bg-card/95">Next {formatEventDate(nextEvent.date)}</span>
              ) : null}
            </div>

            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-[-0.055em] sm:text-5xl lg:text-6xl">
                Pick tonight fast.
              </h1>
              <p className="max-w-2xl text-sm leading-5 text-muted-foreground sm:text-base sm:leading-6">
                Compact cards, quick search, and a calendar built for one-handed planning.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <Link className="button-primary min-h-12 gap-2 px-4 py-0" href="/events">
                Browse
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link className="button-secondary min-h-12 gap-2 px-4 py-0" href="/calendar">
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
            </div>

            <nav aria-label="Quick paths" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {HOME_ACTIONS.map((action) => {
                const Icon = action.icon;

                return (
                  <Link
                    className="group rounded-[1rem] border border-border/75 bg-white/[0.025] p-3 hover:border-primary/30 hover:bg-white/[0.045]"
                    href={action.href}
                    key={action.href}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
                        <Icon className="h-4 w-4" />
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                    </span>
                    <span className="mt-2 block text-sm font-semibold tracking-tight text-foreground">
                      {action.shortLabel}
                    </span>
                    <span className="mt-0.5 hidden text-xs leading-5 text-muted-foreground sm:block">
                      {action.description}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <aside className="glass-panel overflow-hidden px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="section-kicker">Upcoming</p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight">Next nights</h2>
              </div>
              <Link className="app-chip min-h-10 px-3 hover:border-primary/30 hover:text-foreground" href="/events">
                View all
              </Link>
            </div>

            <div className="mt-3 space-y-2">
              {previewEvents.map((event) => (
                <EventPreview compact event={event} key={event._id} />
              ))}

              {extraEvents.length > 0 ? (
                <details className="group rounded-[1rem] border border-border/75 bg-white/[0.02] px-3 py-2.5">
                  <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                    <span>{extraEvents.length} more soon</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                  </summary>
                  <div className="mt-2 space-y-2">
                    {extraEvents.map((event) => (
                      <EventPreview compact event={event} key={event._id} />
                    ))}
                  </div>
                </details>
              ) : null}

              {nextEvents.length === 0 ? (
                <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-7 text-center">
                  <p className="text-sm font-semibold text-foreground">No approved events yet.</p>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    Published events will appear here automatically.
                  </p>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
