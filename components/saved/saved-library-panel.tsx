"use client";

import { SignInButton, SignUpButton, useUser } from "@clerk/nextjs";
import { Bookmark, CalendarDays, ChevronRight, Heart, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EventMetaRow } from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import {
  getDisplayEventTime,
  getEventTimeSortMinutes,
  normalizeEventTime,
  type EventDayPeriod,
} from "@/lib/events/event-time";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import { cn } from "@/lib/utils";

export type SavedLibraryEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  dayPeriod?: EventDayPeriod;
  displayTimeEnd?: string;
  displayTimeLabel?: string;
  displayTimeSource?: string;
  displayTimeStart?: string;
  venue: string;
  venueId?: string;
  eventType: string;
  ticketPrice?: string;
  attendance?: number | string;
  attendanceCount?: number | string;
  attendeeCount?: number | string;
  attendees?: number | string;
  attendeesCount?: number | string;
  going?: number | string;
  goingCount?: number | string;
  status?: string;
};

export type SavedLibraryVenue = {
  _id: string;
  name: string;
  category?: string;
};

type SavedLibraryPanelProps = {
  initialError?: string;
  initialFavoriteVenueIds: string[];
  initialFavoriteVenues: SavedLibraryVenue[];
  initialSavedEventIds: string[];
  initialSavedEvents: SavedLibraryEvent[];
  upcomingEvents: SavedLibraryEvent[];
};

type SavedSegment = "events" | "places";

type GroupedSavedEvents = {
  accent: boolean;
  key: string;
  label: string;
  events: SavedLibraryEvent[];
};

type FavoriteVenueWithNextEvent = {
  nextEvent: SavedLibraryEvent | null;
  venue: SavedLibraryVenue;
};

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function parseLocalDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function getDayDelta(dateValue: string, today = new Date()): number | null {
  const date = parseLocalDate(dateValue);
  if (!date) {
    return null;
  }

  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((date.getTime() - todayStart.getTime()) / 86_400_000);
}

function getRelativeDateLabel(dateValue: string): string {
  const dayDelta = getDayDelta(dateValue);
  if (dayDelta === 0) {
    return "Tonight";
  }
  if (dayDelta === 1) {
    return "Tomorrow";
  }
  if (dayDelta !== null && dayDelta > 1) {
    return `In ${dayDelta} days`;
  }

  return dateValue;
}

function parseEventTimeMinutes(value: string | null | undefined): number {
  return getEventTimeSortMinutes(value) ?? Number.POSITIVE_INFINITY;
}

function compareChronological(left: SavedLibraryEvent, right: SavedLibraryEvent): number {
  const dateResult = left.date.localeCompare(right.date);
  if (dateResult !== 0) {
    return dateResult;
  }

  const timeResult = parseEventTimeMinutes(left.time) - parseEventTimeMinutes(right.time);
  if (timeResult !== 0) {
    return timeResult;
  }

  const titleResult = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  if (titleResult !== 0) {
    return titleResult;
  }

  return left._id.localeCompare(right._id);
}

function normalizeEvents(events: readonly unknown[]): SavedLibraryEvent[] {
  return events.filter((event): event is SavedLibraryEvent => {
    const candidate = event as Partial<SavedLibraryEvent>;
    return (
      typeof candidate._id === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.date === "string" &&
      typeof candidate.venue === "string" &&
      typeof candidate.eventType === "string"
    );
  });
}

function normalizeVenues(venues: readonly unknown[]): SavedLibraryVenue[] {
  return venues.filter((venue): venue is SavedLibraryVenue => {
    const candidate = venue as Partial<SavedLibraryVenue>;
    return typeof candidate._id === "string" && typeof candidate.name === "string";
  });
}

function getUpcomingSavedEvents(
  events: readonly SavedLibraryEvent[],
  activeIds: ReadonlySet<string>,
): SavedLibraryEvent[] {
  const todayKey = formatLocalDateKey(new Date());

  return events
    .filter((event) => activeIds.has(event._id))
    .filter((event) => event.date >= todayKey)
    .filter((event) => !event.status || event.status === "approved")
    .sort(compareChronological);
}

function groupSavedEvents(events: readonly SavedLibraryEvent[]): GroupedSavedEvents[] {
  const groups = new Map<string, GroupedSavedEvents>();

  for (const event of events) {
    const label = getRelativeDateLabel(event.date);
    const group = groups.get(event.date) ?? {
      accent: label === "Tonight",
      events: [],
      key: event.date,
      label,
    };
    group.events.push(event);
    groups.set(event.date, group);
  }

  return Array.from(groups.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function getVenueLookupKey(value: string): string {
  return toSearchableText(value);
}

function getNextEventForVenue(
  venue: SavedLibraryVenue,
  upcomingEvents: readonly SavedLibraryEvent[],
): SavedLibraryEvent | null {
  const venueNameKey = getVenueLookupKey(venue.name);
  return (
    [...upcomingEvents]
      .sort(compareChronological)
      .find((event) => {
        if (event.venueId && event.venueId === venue._id) {
          return true;
        }
        return getVenueLookupKey(event.venue) === venueNameKey;
      }) ?? null
  );
}

function getNextEventMeta(event: SavedLibraryEvent | null): string {
  if (!event) {
    return "No upcoming events yet";
  }

  const time = getResolvedDisplayTime(event);
  return [getRelativeDateLabel(event.date), time].filter(Boolean).join(" · ");
}

function getResolvedDisplayTime(event: SavedLibraryEvent): string | undefined {
  return event.displayTimeLabel ?? getDisplayEventTime(event.time);
}

function getResolvedTimeParts(event: SavedLibraryEvent) {
  if (event.displayTimeStart) {
    return {
      allDay: false,
      endLabel: event.displayTimeEnd,
      startLabel: event.displayTimeStart,
    };
  }

  return normalizeEventTime(event.time);
}

function getSupplementalDisplayTime(event: SavedLibraryEvent): string | undefined {
  if (!event.displayTimeLabel || event.displayTimeStart) {
    return undefined;
  }

  return event.displayTimeLabel;
}

function mergeDisplayTimeFields(
  event: SavedLibraryEvent,
  reference: SavedLibraryEvent | undefined,
): SavedLibraryEvent {
  if (!reference?.displayTimeLabel) {
    return event;
  }

  return {
    ...event,
    dayPeriod: reference.dayPeriod,
    displayTimeEnd: reference.displayTimeEnd,
    displayTimeLabel: reference.displayTimeLabel,
    displayTimeSource: reference.displayTimeSource,
    displayTimeStart: reference.displayTimeStart,
  };
}

function EmptyState({
  body,
  cta,
  href,
  title,
}: {
  body: string;
  cta: string;
  href: string;
  title: string;
}) {
  return (
    <section className="rounded-[1.2rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/[0.1] text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{body}</p>
      <Link className="button-primary mt-5 min-h-10 px-4 py-0" href={href}>
        {cta}
      </Link>
    </section>
  );
}

function SignInPromptCard() {
  return (
    <section className="hero-panel px-4 py-5 sm:px-6 sm:py-7">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.36fr)] lg:items-center">
        <div className="space-y-3">
          <span className="app-chip border-primary/25 bg-primary/[0.1] text-primary">
            <Bookmark className="h-3.5 w-3.5" />
            Saved
          </span>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
              Sign in to keep your plans.
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Browsing stays open. Saved events and favourite places appear here once you use a
              real Clerk account.
            </p>
          </div>
        </div>
        <div className="rounded-[1.25rem] border border-border/75 bg-white/[0.03] p-3 sm:p-4">
          <div className="grid gap-2">
            <SignInButton mode="modal">
              <button className="button-primary min-h-11 w-full px-4 py-0" type="button">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="button-secondary min-h-11 w-full px-4 py-0" type="button">
                Sign up
              </button>
            </SignUpButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function LoadingCard() {
  return (
    <section className="hero-panel px-4 py-8 text-center sm:px-6">
      <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
      <p className="mt-3 text-sm font-medium text-muted-foreground">Loading saved items...</p>
    </section>
  );
}

function EventRow({ event }: { event: SavedLibraryEvent }) {
  const eventTime = getResolvedTimeParts(event);
  const supplementalDisplayTime = getSupplementalDisplayTime(event);

  return (
    <article className="group box-border flex items-center gap-3 overflow-hidden rounded-[18px] border border-white/[0.07] bg-[#13151D] p-[13px] transition hover:border-primary/25 hover:bg-[#171923]">
      <Link
        aria-label={`Open ${event.title}`}
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"
        href={`/events/${event._id}`}
      >
        <div className="box-border flex w-14 flex-none flex-col items-center justify-center overflow-hidden text-center font-mono text-[15px] font-semibold leading-[17px] text-primary tabular-nums">
          {eventTime.startLabel ? (
            <>
              <span className="block max-w-full truncate">{eventTime.startLabel}</span>
              {eventTime.endLabel ? (
                <span className="mt-0.5 block max-w-full truncate text-primary/78">
                  {eventTime.endLabel}
                </span>
              ) : null}
            </>
          ) : (
            <span className="block max-w-full truncate text-primary/72">—</span>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="truncate whitespace-nowrap text-[15px] font-semibold leading-5 tracking-tight text-foreground group-hover:text-primary">
            {event.title}
          </p>
          <p className="mt-0.5 truncate text-[13px] leading-[18px] text-[#8A8E9E]">
            {event.venue}
          </p>
          {supplementalDisplayTime ? (
            <p className="truncate text-[13px] leading-[18px] text-[#8A8E9E]">
              {supplementalDisplayTime}
            </p>
          ) : null}
          <EventMetaRow className="mt-1 flex-nowrap" event={event} />
        </div>
      </Link>
      <div className="flex flex-none items-center justify-end">
        <SaveEventButton
          className="flex-none"
          defaultSaved
          eventId={event._id}
          eventTitle={event.title}
          variant="icon"
        />
      </div>
    </article>
  );
}

function PlaceRow({ item }: { item: FavoriteVenueWithNextEvent }) {
  const { nextEvent, venue } = item;
  const nextEventTime = nextEvent ? getResolvedTimeParts(nextEvent) : null;

  return (
    <article className="box-border min-h-[4.75rem] overflow-hidden rounded-[1rem] border border-border/75 bg-card/88 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        <div className="box-border flex h-12 w-16 flex-none flex-col items-center justify-center overflow-hidden rounded-[0.8rem] border border-primary/15 bg-primary/[0.07] px-1.5 text-center text-primary">
          {nextEventTime?.startLabel ? (
            <>
              <span className="block max-w-full truncate text-sm font-semibold leading-4 tabular-nums">
                {nextEventTime.startLabel}
              </span>
              {nextEventTime.endLabel ? (
                <span className="mt-0.5 block max-w-full truncate text-xs font-semibold leading-4 tabular-nums text-primary/78">
                  {nextEventTime.endLabel}
                </span>
              ) : null}
            </>
          ) : (
            <span className="block max-w-full truncate text-xs font-semibold uppercase tracking-[0.12em] text-primary/72">
              —
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <Link
            className="block truncate whitespace-nowrap text-sm font-semibold tracking-tight text-foreground hover:text-primary"
            href={nextEvent ? `/events/${nextEvent._id}` : "/events"}
          >
            {venue.name}
          </Link>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
            <span className="flex-none font-semibold text-primary/95">{getNextEventMeta(nextEvent)}</span>
            {nextEvent ? (
              <>
                <span className="flex-none text-border">/</span>
                <span className="min-w-0 truncate">{nextEvent.title}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex w-[8.75rem] flex-none items-center justify-end gap-1.5 overflow-hidden">
          <span className="inline-flex min-w-0 max-w-[3.75rem] flex-none items-center rounded-full bg-white/[0.045] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <span className="truncate">{venue.category ?? "Place"}</span>
          </span>
          <FavoriteVenueButton
            className="flex-none"
            defaultFavorite
            venueId={venue._id}
            venueName={venue.name}
            variant="icon"
          />
          <Link
            aria-label={nextEvent ? `View next event at ${venue.name}` : `Browse events for ${venue.name}`}
            className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-border/75 bg-white/[0.035] text-muted-foreground hover:border-primary/35 hover:bg-white/[0.06] hover:text-primary"
            href={nextEvent ? `/events/${nextEvent._id}` : "/events"}
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </article>
  );
}

export function SavedLibraryPanel({
  initialError,
  initialFavoriteVenueIds,
  initialFavoriteVenues,
  initialSavedEventIds,
  initialSavedEvents,
  upcomingEvents,
}: SavedLibraryPanelProps) {
  const { isLoaded, isSignedIn } = useUser();
  const {
    error: libraryError,
    favoriteVenueIds,
    favoriteVenues,
    isLibraryLoaded,
    savedEventIds,
    savedEvents,
  } = useUserLibrary();
  const [activeSegment, setActiveSegment] = useState<SavedSegment>("events");
  const initialSavedIds = useMemo(() => new Set(initialSavedEventIds), [initialSavedEventIds]);
  const initialFavoriteIds = useMemo(
    () => new Set(initialFavoriteVenueIds),
    [initialFavoriteVenueIds],
  );
  const activeSavedIds = isLibraryLoaded ? savedEventIds : initialSavedIds;
  const activeFavoriteIds = isLibraryLoaded ? favoriteVenueIds : initialFavoriteIds;
  const baseSavedEvents = useMemo(
    () => (isLibraryLoaded ? normalizeEvents(savedEvents) : normalizeEvents(initialSavedEvents)),
    [initialSavedEvents, isLibraryLoaded, savedEvents],
  );
  const upcomingEventsById = useMemo(
    () => new Map(upcomingEvents.map((event) => [event._id, event])),
    [upcomingEvents],
  );
  const hydratedSavedEvents = useMemo(
    () =>
      baseSavedEvents.map((event) =>
        mergeDisplayTimeFields(event, upcomingEventsById.get(event._id)),
      ),
    [baseSavedEvents, upcomingEventsById],
  );
  const hydratedFavoriteVenues = isLibraryLoaded
    ? normalizeVenues(favoriteVenues)
    : normalizeVenues(initialFavoriteVenues);

  const upcomingSavedEvents = useMemo(
    () => getUpcomingSavedEvents(hydratedSavedEvents, activeSavedIds),
    [activeSavedIds, hydratedSavedEvents],
  );
  const savedEventGroups = useMemo(() => groupSavedEvents(upcomingSavedEvents), [upcomingSavedEvents]);
  const favoriteVenueItems = useMemo<FavoriteVenueWithNextEvent[]>(() => {
    return hydratedFavoriteVenues
      .filter((venue) => activeFavoriteIds.has(venue._id))
      .map((venue) => ({
        nextEvent: getNextEventForVenue(venue, upcomingEvents),
        venue,
      }))
      .sort((left, right) => {
        if (left.nextEvent && right.nextEvent) {
          return compareChronological(left.nextEvent, right.nextEvent);
        }
        if (left.nextEvent) {
          return -1;
        }
        if (right.nextEvent) {
          return 1;
        }
        return left.venue.name.localeCompare(right.venue.name, undefined, { sensitivity: "base" });
      });
  }, [activeFavoriteIds, hydratedFavoriteVenues, upcomingEvents]);
  const error = libraryError ?? initialError;

  if (!isLoaded) {
    return <LoadingCard />;
  }

  if (!isSignedIn) {
    return <SignInPromptCard />;
  }

  return (
    <section className="space-y-3 sm:space-y-4">
      <header className="hero-panel px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="app-chip border-primary/25 bg-primary/[0.1] text-primary">
              <Bookmark className="h-3.5 w-3.5" />
              Saved
            </span>
            <h1 className="mt-3 text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
              Your kept events and places
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Compact list of the events you bookmarked and venues you followed.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center sm:min-w-56">
            <div className="rounded-[1rem] border border-border/75 bg-white/[0.03] px-3 py-2">
              <p className="section-kicker">Events</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{upcomingSavedEvents.length}</p>
            </div>
            <div className="rounded-[1rem] border border-border/75 bg-white/[0.03] px-3 py-2">
              <p className="section-kicker">Places</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{favoriteVenueItems.length}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="rounded-[1.25rem] border border-border/75 bg-card/90 p-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ["events", "Events", upcomingSavedEvents.length, Bookmark],
            ["places", "Places", favoriteVenueItems.length, Heart],
          ] as const).map(([key, label, count, Icon]) => {
            const active = activeSegment === key;
            return (
              <button
                className={cn(
                  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[1rem] px-3 text-sm font-semibold transition",
                  active
                    ? "bg-primary text-primary-foreground shadow-[0_18px_38px_-26px_rgba(139,134,251,0.82)]"
                    : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground",
                )}
                key={key}
                onClick={() => setActiveSegment(key)}
                type="button"
              >
                <Icon className={cn("h-4 w-4", active && "fill-current")} />
                {label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                    active ? "bg-primary-foreground/16" : "bg-white/[0.06] text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <p className="rounded-[1rem] border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {activeSegment === "events" ? (
        <div className="space-y-3">
          {savedEventGroups.length > 0 ? (
            savedEventGroups.map((group) => (
              <section
                className={cn(
                  "rounded-[1.2rem] border bg-white/[0.025] p-2.5",
                  group.accent ? "border-primary/35 bg-primary/[0.08]" : "border-border/75",
                )}
                key={group.key}
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <h2
                    className={cn(
                      "inline-flex items-center gap-2 text-sm font-semibold tracking-tight",
                      group.accent ? "text-primary" : "text-foreground",
                    )}
                  >
                    <CalendarDays className="h-4 w-4" />
                    {group.label}
                  </h2>
                  <span className="app-chip bg-card/80">{group.events.length}</span>
                </div>
                <div className="space-y-2">
                  {group.events.map((event) => (
                    <EventRow event={event} key={event._id} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <EmptyState
              body="Tap the bookmark on any event to keep it here. Past events automatically fall away from this list."
              cta="Browse events"
              href="/"
              title="No saved events yet."
            />
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {favoriteVenueItems.length > 0 ? (
            favoriteVenueItems.map((item) => <PlaceRow item={item} key={item.venue._id} />)
          ) : (
            <EmptyState
              body="Tap the heart beside any venue to keep it here and see its next upcoming event."
              cta="Find places"
              href="/"
              title="No favourite places yet."
            />
          )}
        </div>
      )}
    </section>
  );
}
