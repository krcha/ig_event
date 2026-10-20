"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, Navigation, Warehouse } from "lucide-react";
import { EventLocationMap } from "@/components/maps/event-location-map";
import { EventSessionLabel } from "@/components/events/event-session-label";
import { EventMetaRow } from "@/components/events/event-meta";
import { OpenNowFilter } from "@/components/calendar/open-now-filter";
import { OpenNowStatus } from "@/components/events/open-now-status";
import { getOpenNowEventState, type OpenNowEventState } from "@/lib/venues/venue-open-now";
import { getEventSessionLabel } from "@/lib/events/event-session";
import { buildEventMapData, buildEventMapHref, filterEventMapEvents, getEventMapOpenNowDateKey, MAP_MAX_DATE, MAP_MIN_DATE } from "@/lib/events/event-map";
import { resolveEventTimePresentation } from "@/lib/events/event-time-presentation";
import { addDaysToDateKey } from "@/lib/events/nightlife-date";
import type { PublicEvent } from "@/lib/events/public-events";
import { cn } from "@/lib/utils";
import "./event-calendar-map.css";

type EventCalendarMapProps = {
  selectedDate: string;
  todayDate: string;
  days: readonly { date: string; eventCount: number }[];
  events: PublicEvent[];
  initialNow: number;
  openNowActive: boolean;
};

const MAP_KEYBOARD_DATE_KEY = "eventzeka-map-keyboard-date";

function preserveDayFocus(event: KeyboardEvent<HTMLAnchorElement>, date: string) {
  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    // The app uses document navigation for same-page query changes.
    try {
      window.sessionStorage.setItem(MAP_KEYBOARD_DATE_KEY, date);
    } catch {
      // Browsing dates still works when browser storage is disabled.
    }
  }
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function MapEventRow({ event, openNowState }: { event: PublicEvent; openNowState?: OpenNowEventState }) {
  const time = resolveEventTimePresentation(event);
  return (
    <Link aria-label={`${event.title} at ${event.venue}, ${getEventSessionLabel(event) || time.label}`} className="group flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-white/[0.045] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-event-map-event-id={event._id} href={`/events/${event._id}`} prefetch={false}>
      <Clock3 aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-primary" />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs text-muted-foreground", time.kind === "venue_hours" ? "font-normal" : "font-medium")}>{time.label}</p>
        <h3 className="mt-1 text-sm font-semibold leading-5 text-foreground group-hover:text-primary">{event.title}</h3>
        <EventSessionLabel event={event} />
        <EventMetaRow className="mt-1" event={event} />
        <OpenNowStatus eventId={event._id} state={openNowState} />
      </div>
      <ArrowRight aria-hidden="true" className="mt-1 h-4 w-4 flex-none text-muted-foreground group-hover:text-primary" />
    </Link>
  );
}

export function EventCalendarMap({ initialNow, openNowActive, selectedDate, todayDate, days, events }: EventCalendarMapProps) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const update = () => {
      const currentNow = Date.now();
      setNow(currentNow);
      timeout = setTimeout(update, 60_000 - currentNow % 60_000 + 25);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timeout);
        update();
      }
    };
    update();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [initialNow]);
  const filterNow = openNowActive ? now : initialNow;
  const eligibleEventIds = useMemo(() => JSON.stringify(
    filterEventMapEvents(events, { selectedDate, openNow: openNowActive, now: filterNow }).map((event) => event._id),
  ), [events, filterNow, openNowActive, selectedDate]);
  // Keep the map and open popups intact while the clock advances without any
  // event entering or leaving the current result set.
  const visibleEvents = useMemo(() => {
    const ids = new Set<string>(JSON.parse(eligibleEventIds));
    return events.filter((event) => ids.has(event._id));
  }, [eligibleEventIds, events]);
  const { locations, unmappedEvents } = useMemo(() => buildEventMapData(visibleEvents), [visibleEvents]);
  const openNowStates = useMemo(() => openNowActive
    ? new Map(visibleEvents.map((event) => [event._id, getOpenNowEventState(event, filterNow)]))
    : new Map<string, OpenNowEventState>(), [filterNow, openNowActive, visibleEvents]);
  const openNowHref = buildEventMapHref(getEventMapOpenNowDateKey(now), { openNow: !openNowActive });
  const [selection, setSelection] = useState<{ date: string; id: string } | null>(null);
  const selectedLocationId = selection?.date === selectedDate ? selection.id : null;
  const locationCards = useRef(new Map<string, HTMLElement>());
  const selectedDayRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(MAP_KEYBOARD_DATE_KEY) === selectedDate) {
        window.sessionStorage.removeItem(MAP_KEYBOARD_DATE_KEY);
        selectedDayRef.current?.focus({ preventScroll: true });
      }
    } catch {
      // Browsing dates still works when browser storage is disabled.
    }
  }, [selectedDate]);
  const selectFromMap = useCallback((id: string) => {
    setSelection({ date: selectedDate, id });
    locationCards.current.get(id)?.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [selectedDate]);
  const fullDateLabel = formatDate(selectedDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const mappedEventCount = visibleEvents.length - unmappedEvents.length;

  return (
    <main className="app-page event-calendar-page gap-4" data-event-map-open-now-active={openNowActive ? "true" : "false"}>
      <h1 className="sr-only lg:hidden">Belgrade event map</h1>
      <section className="hero-panel hidden px-4 py-5 sm:px-6 sm:py-6 lg:block">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="section-kicker flex items-center gap-2"><MapPin aria-hidden="true" className="h-3.5 w-3.5 text-primary" /> Belgrade, day by day</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Find your next stop.</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Pick a day. See what&apos;s happening and where to go.</p>
          </div>
          <Link className="button-secondary min-h-10 gap-2 px-4 py-0 text-sm" href="/venues/directory" prefetch={false}>
            <Warehouse aria-hidden="true" className="h-4 w-4" />
            Venue directory
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section aria-label="Choose an event date" className="glass-panel hidden min-w-0 p-3 sm:p-4 lg:block">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link aria-label="Previous week" className="button-secondary min-h-10 w-10 p-0" href={buildEventMapHref(addDaysToDateKey(selectedDate, -7))} onKeyDown={(event) => preserveDayFocus(event, addDaysToDateKey(selectedDate, -7))} prefetch={false} scroll={false}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            </Link>
            <p className="min-w-24 text-sm font-semibold sm:min-w-32">{formatDate(selectedDate, { month: "long", year: "numeric" })}</p>
            <Link aria-label="Next week" className="button-secondary min-h-10 w-10 p-0" href={buildEventMapHref(addDaysToDateKey(selectedDate, 7))} onKeyDown={(event) => preserveDayFocus(event, addDaysToDateKey(selectedDate, 7))} prefetch={false} scroll={false}>
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Link className={cn("button-secondary min-h-10 px-3 py-0 text-xs", selectedDate === todayDate && "border-primary/40 text-primary")} href={buildEventMapHref(todayDate)} onKeyDown={(event) => preserveDayFocus(event, todayDate)} prefetch={false} scroll={false}>Today</Link>
            <form action="/map" className="flex items-center gap-2">
              <label className="sr-only" htmlFor="event-map-date">Choose date</label>
              <input className="min-h-10 min-w-0 max-w-36 rounded-xl border border-border bg-background/80 px-2 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:max-w-40" defaultValue={selectedDate} id="event-map-date" key={selectedDate} max={MAP_MAX_DATE} min={MAP_MIN_DATE} name="date" type="date" required />
              <button aria-label="Go to selected date" className="button-secondary min-h-10 w-10 p-0" type="submit"><ArrowRight aria-hidden="true" className="h-4 w-4" /></button>
            </form>
          </div>
        </div>
        <nav aria-label="Event days" className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {days.map((day) => {
            const selected = day.date === selectedDate;
            const eventCount = selected && openNowActive ? visibleEvents.length : day.eventCount;
            return (
              <Link aria-current={selected ? "date" : undefined} aria-label={`${formatDate(day.date, { weekday: "long", day: "numeric", month: "long" })}, ${eventCount} ${eventCount === 1 ? "event" : "events"}${selected && openNowActive ? " open now" : ""}${openNowActive ? "; show all events for this day" : ""}`} className={cn("flex min-w-0 flex-col items-center rounded-xl border px-1 py-3 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-white/[0.02] hover:border-primary/40 hover:bg-white/[0.05]")} href={buildEventMapHref(day.date)} key={day.date} onKeyDown={(event) => preserveDayFocus(event, day.date)} prefetch={false} ref={selected ? selectedDayRef : undefined} scroll={false}>
                <span className={cn("text-[10px] font-semibold uppercase tracking-wider sm:text-xs", !selected && "text-muted-foreground")}>{formatDate(day.date, { weekday: "short" })}</span>
                <span className="mt-1 text-xl font-semibold leading-7 sm:text-2xl">{formatDate(day.date, { day: "numeric" })}</span>
                <span className={cn("mt-1 text-[10px] sm:text-xs", !selected && "text-muted-foreground")}><span className="sm:hidden">{eventCount}</span><span className="hidden sm:inline">{eventCount} {eventCount === 1 ? "event" : "events"}</span></span>
              </Link>
            );
          })}
        </nav>
      </section>

      <div className="hidden flex-wrap items-center justify-between gap-2 px-1 lg:flex">
        <h2 className="text-base font-semibold sm:text-lg">{formatDate(selectedDate, { weekday: "long", day: "numeric", month: "long" })}</h2>
        <p aria-live="polite" className="text-xs text-muted-foreground sm:text-sm">{visibleEvents.length} {visibleEvents.length === 1 ? "event" : "events"} <span aria-hidden="true">·</span> {mappedEventCount} mapped</p>
      </div>

      <div className="event-calendar-layout grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="relative h-full min-h-0 lg:h-auto">
          <EventLocationMap
            controls={<OpenNowFilter active={openNowActive} appearance="map" href={openNowHref} initialNow={initialNow} />}
            locations={locations}
            onSelectLocation={selectFromMap}
            possibleEventIds={[...openNowStates].flatMap(([id, state]) => state === "possible" ? [id] : [])}
            selectedLocationId={selectedLocationId}
          />
          <section aria-label="Choose a map date" className="absolute inset-x-3 top-3 z-[600] hidden items-center gap-2 rounded-2xl border border-border bg-card/95 p-2 shadow-lg md:flex lg:hidden">
            <a aria-label="Previous day" className="button-secondary min-h-10 w-10 flex-none p-0" href={buildEventMapHref(addDaysToDateKey(selectedDate, -1))}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            </a>
            <form action="/map" className="flex min-w-0 flex-1 items-center gap-2">
              <label className="sr-only" htmlFor="event-map-mobile-date">Choose date</label>
              <input className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" defaultValue={selectedDate} id="event-map-mobile-date" key={selectedDate} max={MAP_MAX_DATE} min={MAP_MIN_DATE} name="date" onChange={(event) => { if (event.currentTarget.validity.valid) event.currentTarget.form?.requestSubmit(); }} type="date" required />
            </form>
            <a aria-label="Next day" className="button-secondary min-h-10 w-10 flex-none p-0" href={buildEventMapHref(addDaysToDateKey(selectedDate, 1))}>
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </a>
          </section>
        </div>
        <section aria-label={`Events for ${fullDateLabel}`} className="glass-panel hidden min-w-0 overflow-hidden lg:flex lg:max-h-[622px] lg:flex-col">
          <div className="hidden border-b border-border px-4 py-4 lg:block">
            <p className="section-kicker">The lineup</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Tap a pin or a venue to explore its events.</p>
          </div>
          <div className="min-h-0 space-y-3 p-3 lg:overflow-y-auto">
            {locations.map((location, index) => (
              <article className={cn("rounded-xl border transition-colors", selectedLocationId === location.id ? "border-primary/70 bg-primary/[0.07]" : "border-border bg-white/[0.015]")} key={location.id} ref={(element) => { if (element) locationCards.current.set(location.id, element); else locationCards.current.delete(location.id); }}>
                <button aria-label={`Show ${location.name} on the map`} aria-pressed={selectedLocationId === location.id} className="flex min-h-14 w-full items-start gap-3 rounded-xl px-3 pt-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setSelection({ date: selectedDate, id: location.id })} type="button">
                  <span aria-hidden="true" className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold leading-5">{location.name}</h3>
                    <p className="mt-1 text-xs leading-4 text-muted-foreground">{location.address || "View location on the map"}</p>
                  </div>
                  <MapPin aria-hidden="true" className="mt-1 h-4 w-4 flex-none text-primary" />
                </button>
                <div className="mt-1">{location.events.map((event) => <MapEventRow event={event} key={event._id} openNowState={openNowStates.get(event._id)} />)}</div>
                <div className="flex flex-wrap gap-3 border-t border-border px-3 py-3">
                  <a className="inline-flex min-h-8 items-center gap-1.5 text-xs font-semibold text-primary hover:underline" href={`https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`} rel="noopener noreferrer" target="_blank"><Navigation aria-hidden="true" className="h-3.5 w-3.5" /> Directions</a>
                  {location.venueId ? <Link className="inline-flex min-h-8 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" href={`/venues/${location.venueId}`} prefetch={false}>Venue page <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link> : null}
                </div>
              </article>
            ))}
            {unmappedEvents.length > 0 ? (
              <div className="rounded-xl border border-dashed border-border px-1 py-2">
                <div className="px-3 py-2"><h3 className="text-sm font-semibold">Location not mapped</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">These events don&apos;t have confirmed map coordinates yet.</p></div>
                {unmappedEvents.map((event) => <div key={event._id}><p className="px-3 pt-2 text-xs font-semibold text-primary">{event.venue || "Venue to be announced"}</p><MapEventRow event={event} openNowState={openNowStates.get(event._id)} /></div>)}
              </div>
            ) : null}
            {visibleEvents.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <CalendarDays aria-hidden="true" className="mx-auto h-8 w-8 text-primary" />
                <h3 className="mt-4 text-lg font-semibold">{openNowActive ? "No events open now" : "No events listed for this day"}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{openNowActive ? "Check back later or choose another day to explore events." : "Try another day to see what's coming up in Belgrade."}</p>
                <Link className="button-secondary mt-5 min-h-10 gap-2 px-4 py-0 text-sm" href={buildEventMapHref(addDaysToDateKey(selectedDate, 1))} prefetch={false} scroll={false}>Next day <ChevronRight aria-hidden="true" className="h-4 w-4" /></Link>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <p className="hidden px-1 text-xs leading-5 text-muted-foreground lg:block">Dates and times are local to Belgrade. Select a venue pin to see its full lineup.</p>
    </main>
  );
}
