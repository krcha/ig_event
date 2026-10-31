"use client";

import Link from "next/link";
import { ArrowUpDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { VirtualAgendaList } from "./virtual-agenda-list";
import { CalendarEventPreviews, CalendarEventPreviewRow } from "./calendar-event-preview";
import { EventKindToggleChips } from "./event-kind-toggle-chips";
import { OpenNowFilter } from "./open-now-filter";
import { EventMetaRow, type EventCategoryKind } from "@/components/events/event-meta";
import { OpenNowStatus } from "@/components/events/open-now-status";
import { SaveEventButton } from "@/components/events/save-event-button";
import { EVENT_PRIMARY_CATEGORIES } from "@/lib/taxonomy/event-categories";
import { CALENDAR_TIME_BANDS } from "@/lib/events/calendar-time-band-definitions";
import { groupBusyVenuesForDay } from "@/lib/events/venue-day-grouping";
import type { CalendarAgendaEvent } from "@/lib/events/calendar-agenda-types";
import { cn } from "@/lib/utils";
import mobileStyles from "./mobile-events-home.module.css";

function subscribeViewport(listener: () => void) {
  const query = window.matchMedia("(max-width: 767px)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
const readMobileViewport = () => window.matchMedia("(max-width: 767px)").matches;
const serverViewport = () => false;

type EventTone = {
  name: string;
  chip: string;
  dot: string;
  rail: string;
  badge: string;
  panel: string;
};
const EVENT_CATEGORY_LABELS = Object.fromEntries(
  EVENT_PRIMARY_CATEGORIES.map((category) => [category.key, category.label]),
) as Record<EventCategoryKind, string>;

const EVENT_TONES: Record<EventCategoryKind, EventTone> = {
  club: {
    name: EVENT_CATEGORY_LABELS.club,
    chip: "bg-[#8B86FB]/[0.14] text-[#8B86FB] hover:bg-[#8B86FB]/[0.18]",
    dot: "bg-[#8B86FB]",
    rail: "bg-[#8B86FB]",
    badge: "bg-[#8B86FB]/[0.14] text-[#8B86FB]",
    panel: "from-[#8B86FB]/[0.10] via-card to-card",
  },
  live: {
    name: EVENT_CATEGORY_LABELS.live,
    chip: "bg-[#FB7185]/[0.14] text-[#FB7185] hover:bg-[#FB7185]/[0.18]",
    dot: "bg-[#FB7185]",
    rail: "bg-[#FB7185]",
    badge: "bg-[#FB7185]/[0.14] text-[#FB7185]",
    panel: "from-[#FB7185]/[0.10] via-card to-card",
  },
  culture: {
    name: EVENT_CATEGORY_LABELS.culture,
    chip: "bg-[#FBBF24]/[0.14] text-[#FBBF24] hover:bg-[#FBBF24]/[0.18]",
    dot: "bg-[#FBBF24]",
    rail: "bg-[#FBBF24]",
    badge: "bg-[#FBBF24]/[0.14] text-[#FBBF24]",
    panel: "from-[#FBBF24]/[0.10] via-card to-card",
  },
  event: {
    name: EVENT_CATEGORY_LABELS.event,
    chip: "bg-[#34D399]/[0.14] text-[#34D399] hover:bg-[#34D399]/[0.18]",
    dot: "bg-[#34D399]",
    rail: "bg-[#34D399]",
    badge: "bg-[#34D399]/[0.14] text-[#34D399]",
    panel: "from-[#34D399]/[0.10] via-card to-card",
  },
};

function getDayCategory(event: CalendarAgendaEvent) { return event.category; }
function getEventTone(event: CalendarAgendaEvent) { return EVENT_TONES[event.category]; }
function getTimePresentation(event: CalendarAgendaEvent) { return event.presentation; }
function EventSessionLabel({ event, className }: { event: CalendarAgendaEvent; className?: string }) {
  return event.sessionLabel ? <span className={cn("mt-1 block text-xs font-semibold leading-5 tabular-nums text-primary", className)} data-event-session="true">{event.sessionLabel}</span> : null;
}
function pluralize(value: number, singular: string) { return `${value} ${value === 1 ? singular : `${singular}s`}`; }
function groupCalendarEventsByTimeBand(events: CalendarAgendaEvent[]) {
  return CALENDAR_TIME_BANDS.map(band => ({ ...band, events: events.filter(event => event.band === band.key) })).filter(band => band.events.length > 0);
}

function getVenueHref(event: Pick<CalendarAgendaEvent, "venueId">): string | null {
  return event.venueId ? `/venues/${event.venueId}` : null;
}

function VenueNameLink({
  className,
  event,
}: {
  className?: string;
  event: Pick<CalendarAgendaEvent, "venue" | "venueId">;
}) {
  const href = getVenueHref(event);
  if (!href) {
    return <span className={className}>{event.venue}</span>;
  }

  return (
    <Link
      className={cn(className, "hover:text-primary focus-visible:text-primary focus-visible:outline-none")}
      href={href}
      prefetch={false}
    >
      {event.venue}
    </Link>
  );
}

function VenueTimeLabel({ label }: { label: string }) {
  return (
    <span className="block space-y-1 text-center" data-calendar-venue-hours="true">
      {label.split(", ").map((window, index) => {
        const [start, end] = window.split("–");
        return (
          <span className="block" key={`${window}-${index}`}>
            <span className="block text-xs font-normal leading-4 tabular-nums text-foreground">{start}</span>
            {end ? (
              <span className="block text-[10px] font-normal leading-3 tabular-nums text-muted-foreground">{end}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}


type Props = {
  events: CalendarAgendaEvent[];
  hiddenDayCategories: EventCategoryKind[];
  selectedDayEventCount: number;
  dayLabel: string;
  openNowActive: boolean;
  openNowHref: string;
  now: number;
  authEnabled: boolean;
  hiddenSort?: string;
  hasActiveFilters: boolean;
  clearFiltersHref: string;
  advancedSearch: ReactNode;
  advancedSort: ReactNode;
};

/** One data projection and one event tree; only presentation changes at 768px. */
export function CalendarAgenda({ events: selectedDayAgendaEvents, hiddenDayCategories, dayLabel, openNowActive, openNowHref, now, hiddenSort, hasActiveFilters, clearFiltersHref, advancedSearch, advancedSort }: Props) {
  const mobileWeek = useSyncExternalStore(subscribeViewport, readMobileViewport, serverViewport);
  const [activeHiddenCategories, setActiveHiddenCategories] = useState(hiddenDayCategories);
  const [openVenueGroups, setOpenVenueGroups] = useState<ReadonlySet<string>>(new Set());
  const hiddenDayCategorySet = useMemo(() => new Set(activeHiddenCategories), [activeHiddenCategories]);
  useEffect(() => setActiveHiddenCategories(hiddenDayCategories), [hiddenDayCategories]);
  useEffect(() => {
    const count = selectedDayAgendaEvents.filter(event => !hiddenDayCategorySet.has(getDayCategory(event))).length;
    document.querySelectorAll<HTMLElement>("[data-calendar-mobile-day-count]").forEach(target => {
      if (target.textContent !== String(count)) target.textContent = String(count);
    });
  }, [hiddenDayCategorySet, selectedDayAgendaEvents]);
  function renderSelectedDayAgenda(mobileWeek: boolean) {
    const agendaEvents = mobileWeek
      ? [...selectedDayAgendaEvents].filter(event => !hiddenDayCategorySet.has(getDayCategory(event))).sort((left, right) => left.mobileOrder - right.mobileOrder)
      : selectedDayAgendaEvents.filter(event => !hiddenDayCategorySet.has(getDayCategory(event)));
    const { groups: venueGroups, individualEvents } = mobileWeek
      ? { groups: [], individualEvents: agendaEvents }
      : groupBusyVenuesForDay(agendaEvents, (event) => !hiddenDayCategorySet.has(getDayCategory(event)));
    const agendaTimeBandGroups = groupCalendarEventsByTimeBand(individualEvents);
    const initialVisibleAgendaEventCount = agendaEvents.filter(
      (event) => !hiddenDayCategorySet.has(getDayCategory(event)),
    ).length;

    function renderMobileAdvancedControls() {
      const iconButtonClass =
        "relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/75 bg-white/[0.045] text-foreground shadow-[0_14px_34px_-28px_rgba(0,0,0,0.85)] hover:border-primary/35 hover:bg-primary/10 hover:text-primary";
      const panelClass =
        "absolute right-0 top-full z-40 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-[1rem] border border-border/80 bg-card/98 p-2.5 shadow-[0_24px_70px_-42px_rgba(0,0,0,0.95)] backdrop-blur";

      return (
        <div className="flex flex-none items-center gap-1">
          <details className="group relative">
            <summary
              aria-label="Search calendar events"
              className={`${iconButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
              data-calendar-mobile-search-button="true"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="sr-only">Search</span>
            </summary>
            <div className={panelClass} data-calendar-mobile-search-panel="true">
              {advancedSearch}
            </div>
          </details>

          <details className="group relative">
            <summary
              aria-label="Sort calendar events"
              className={`${iconButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
              data-calendar-mobile-sort-button="true"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              <span className="sr-only">Sort</span>
              {hiddenSort ? (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
              ) : null}
            </summary>
            <div className={panelClass} data-calendar-mobile-sort-panel="true">
              {advancedSort}
            </div>
          </details>
        </div>
      );
    }

    function renderCategoryChips({ withActions = false }: { withActions?: boolean } = {}) {
      return (
        <EventKindToggleChips
          afterAll={mobileWeek ? <OpenNowFilter active={openNowActive} appearance="chip" href={openNowHref} initialNow={now} /> : undefined}
          initialHiddenCategories={hiddenDayCategories}
          onHiddenCategoriesChange={setActiveHiddenCategories}
          singleSelection={mobileWeek}
        >
          {withActions ? renderMobileAdvancedControls() : null}
        </EventKindToggleChips>
      );
    }

    function renderAgendaCards() {
      return (
        <>
          {venueGroups.length > 0 ? (
            <div className="space-y-1.5" data-calendar-venue-groups="true">
              <VirtualAgendaList items={venueGroups} getKey={group => group.key} estimateSize={62} containsEvent={(group, id) => group.events.some(event => event._id === id)}>{(group) => (
                <details
                  className="group rounded-[0.9rem] border border-primary/25 bg-primary/[0.07] open:border-primary/40"
                  data-calendar-venue-group="true"
                  hidden={group.visibleCount === 0}
                  key={group.key}
                  open={openVenueGroups.has(group.key)}
                  onToggle={event => {
                    const open = event.currentTarget.open;
                    setOpenVenueGroups(current => {
                      if (current.has(group.key) === open) return current;
                      const next = new Set(current);
                      if (open) next.add(group.key); else next.delete(group.key);
                      return next;
                    });
                  }}
                >
                  <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{group.venue}</span>
                      <span className="block text-[11px] font-medium text-muted-foreground">
                        <span data-calendar-venue-group-visible-count="true">
                          {pluralize(group.visibleCount, "event")}
                        </span>{" "}
                        · <span lang="sr-Latn-RS">Više događaja</span>
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-none text-primary transition-transform group-open:rotate-90" />
                  </summary>
                  {openVenueGroups.has(group.key) ? <div className="border-t border-primary/15 px-2 py-2">
                    <VirtualAgendaList items={group.events} getKey={event => event._id} estimateSize={52}>{(event) => {
                      const eventCategory = getDayCategory(event);
                      const isHiddenByKind = hiddenDayCategorySet.has(eventCategory);
                      const tone = getEventTone(event);
                      const timePresentation = getTimePresentation(event);

                      return (
                        <article
                          data-calendar-event-id={event._id}
                          data-calendar-open-now-state={openNowActive ? event.openNowState : undefined}
                          data-calendar-event-kind={eventCategory}
                          data-calendar-hidden-by-kind={isHiddenByKind ? "true" : "false"}
                          data-event-time={event.displayTimeLabel ?? event.time}
                          data-event-title={event.title}
                          data-event-tone={tone.name}
                          data-event-venue={event.venue}
                          hidden={isHiddenByKind}
                          key={event._id}
                        >
                          <CalendarEventPreviewRow
                            eventId={event._id}
                            headerClassName="min-h-10 px-2 py-1 text-foreground"
                            title={event.title}
                          >
                            <span
                              className={cn("w-16 flex-none text-xs font-semibold tabular-nums text-muted-foreground", timePresentation.kind === "venue_hours" ? "py-1" : "truncate")}
                              title={timePresentation.label}
                            >
                              {timePresentation.kind === "venue_hours"
                                ? <VenueTimeLabel label={timePresentation.label} />
                                : timePresentation.label}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-semibold">{event.title}</span>
                              <EventSessionLabel className="mt-0 text-[11px] leading-4" event={event} />
                              <OpenNowStatus eventId={event._id} state={event.openNowState} />
                            </span>
                            <span className="max-w-[40%] truncate text-[10px] font-medium text-muted-foreground">{tone.name}</span>
                            <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="icon" />
                          </CalendarEventPreviewRow>
                        </article>
                      );
                    }}</VirtualAgendaList>
                  </div> : null}
                </details>
              )}</VirtualAgendaList>
            </div>
          ) : null}
          {agendaTimeBandGroups.map((timeBand) => {
            const initialVisibleTimeBandCount = timeBand.events.filter(
              (event) => !hiddenDayCategorySet.has(getDayCategory(event)),
            ).length;

            return (
              <section
                aria-labelledby={`calendar-${mobileWeek ? "week" : "mobile"}-${timeBand.key}`}
                className="space-y-1.5"
                data-calendar-time-band-event-count={timeBand.events.length}
                data-calendar-time-band={timeBand.key}
                hidden={initialVisibleTimeBandCount === 0}
                key={timeBand.key}
              >
                <div className="flex min-w-0 items-baseline justify-between gap-3 px-1 pt-1">
                  <div className="min-w-0">
                    <h3
                      className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground"
                      id={`calendar-${mobileWeek ? "week" : "mobile"}-${timeBand.key}`}
                    >
                      {timeBand.label}
                    </h3>
                    <p className="truncate text-[10px] leading-4 text-muted-foreground">
                      {timeBand.description}
                    </p>
                  </div>
                  <span
                    className="flex-none text-[10px] font-medium tabular-nums text-muted-foreground"
                    data-calendar-time-band-visible-count="true"
                  >
                    {pluralize(initialVisibleTimeBandCount, "event")}
                  </span>
                </div>
                <VirtualAgendaList items={timeBand.events} getKey={event => event._id}>
                  {(event) => {
            const tone = getEventTone(event);
            const eventCategory = getDayCategory(event);
            const isHiddenByKind = hiddenDayCategorySet.has(eventCategory);
            const timePresentation = getTimePresentation(event);
            const eventTime = event.timeParts;


              return (
                <article
                  className={cn(
                    "group overflow-hidden rounded-[0.9rem] border border-border/75 bg-gradient-to-r shadow-[0_14px_38px_-32px_rgba(0,0,0,0.86)] transition hover:border-primary/35 hover:bg-primary/[0.04]",
                    tone.panel,
                  )}
                  data-calendar-event-kind={eventCategory}
                  data-calendar-event-id={event._id}
                  data-calendar-open-now-state={openNowActive ? event.openNowState : undefined}
                  data-calendar-hidden-by-kind={isHiddenByKind ? "true" : "false"}
                  data-calendar-mobile-event-row="true"
                  data-event-time={event.displayTimeLabel ?? event.time}
                  data-event-title={event.title}
                  data-event-tone={tone.name}
                  data-event-venue={event.venue}
                  hidden={isHiddenByKind}
                  key={event._id}
                >
                  <CalendarEventPreviewRow eventId={event._id} headerClassName="px-2.5 py-2" title={event.title}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {eventTime.startLabel ? (
                      <span
                        className="box-border flex h-9 w-16 flex-none flex-col items-center justify-center overflow-hidden rounded-[0.72rem] border border-border/65 bg-background/45 px-1 text-center hover:border-primary/35"
                        title={mobileWeek && timePresentation.inferredEnd ? `Mesto radi do ${eventTime.endLabel}; kraj događaja nije najavljen.` : undefined}
                      >
                        <span className="block max-w-full truncate text-xs font-semibold leading-4 tabular-nums text-foreground">
                          {eventTime.startLabel}
                        </span>
                        {eventTime.endLabel ? (
                          <span className={cn("block max-w-full truncate text-[10px] leading-3 tabular-nums text-muted-foreground", timePresentation.inferredEnd ? "font-normal" : "font-semibold")}>
                            {mobileWeek && timePresentation.inferredEnd ? "do " : ""}
                            {eventTime.endLabel}
                          </span>
                        ) : null}
                      </span>
                    ) : timePresentation.kind === "venue_hours" ? (
                      <span
                        className="box-border flex min-h-9 w-16 flex-none flex-col items-center justify-center rounded-[0.72rem] border border-border/65 bg-background/45 px-1 py-1 text-center hover:border-primary/35"
                        title={timePresentation.label}
                        aria-label={mobileWeek ? `Radno vreme mesta: ${timePresentation.label}. Početak događaja nije najavljen.` : undefined}
                      >
                        <VenueTimeLabel label={timePresentation.label} />
                      </span>
                    ) : (
                      <span
                        className="box-border flex h-9 w-16 flex-none items-center justify-center overflow-hidden rounded-[0.72rem] border border-border/65 bg-background/45 px-1 text-center hover:border-primary/35"
                      >
                        <span className="block max-w-full truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          —
                        </span>
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className="block min-w-0 hover:text-primary"
                      >
                        <h4 className="truncate text-[13px] font-semibold leading-4 tracking-tight text-foreground">
                          {event.title}
                        </h4>
                        <EventSessionLabel event={event} />
                      </div>
                      <VenueNameLink
                        className="mt-0.5 block w-fit max-w-full truncate text-[11px] font-medium leading-4 text-muted-foreground"
                        event={event}
                      />
                      <EventMetaRow className="mt-1 flex-nowrap" event={event} presentation={event} />
                      <OpenNowStatus eventId={event._id} state={event.openNowState} />
                    </div>
                  </div>
                    <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="icon" />
                  </CalendarEventPreviewRow>
                </article>
              );
                  }}
                </VirtualAgendaList>
              </section>
            );
          })}

          <div
            className="rounded-[1.2rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center"
            data-calendar-empty-state="true"
            hidden={initialVisibleAgendaEventCount > 0}
          >
            <p className="text-sm font-semibold text-foreground">
              No events match this date and filter set.
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Pick another date, change filters, or clear the current search.
            </p>
            {hasActiveFilters ? (
              <Link prefetch={false}
                data-calendar-client-navigation="true"
                className="button-secondary mt-4 min-h-10 px-4 py-0"
                href={clearFiltersHref}
                scroll={false}
              >
                Clear filters
              </Link>
            ) : null}
          </div>
        </>
      );
    }


      return (
        <section
          className={mobileWeek ? mobileStyles.agenda : "space-y-1.5"}
          data-calendar-agenda-scope={mobileWeek ? "mobile-week" : "mobile"}
          data-calendar-scroll-region="selected-day-agenda"
          data-calendar-virtualized-agenda="true"
        >
          {mobileWeek ? (
            <div className={mobileStyles.stickyFilters} data-calendar-mobile-sticky-filters="true">
              {renderCategoryChips()}
            </div>
          ) : <div className="sticky top-[4.25rem] z-20 rounded-[1rem] border border-border/75 bg-background/92 px-2.5 py-1.5 shadow-[0_18px_46px_-34px_rgba(0,0,0,0.9)] backdrop-blur">
            <div className="flex items-center justify-between gap-2">
              <h2 className="min-w-0 truncate text-xs font-semibold tracking-tight text-foreground">
                {dayLabel}{" "}
                <span className="text-muted-foreground">·</span>{" "}
                <span data-calendar-visible-event-count="true">
                  {pluralize(initialVisibleAgendaEventCount, "event")}
                </span>
              </h2>
              <OpenNowFilter active={openNowActive} href={openNowHref} initialNow={now} />
            </div>
            {renderCategoryChips({ withActions: true })}
          </div>}

          <div className="space-y-1.5">{renderAgendaCards()}</div>
        </section>
      );

  }

  return <CalendarEventPreviews>{renderSelectedDayAgenda(mobileWeek)}</CalendarEventPreviews>;
}
