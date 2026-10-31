"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { VirtualAgendaList } from "./virtual-agenda-list";
import { CalendarEventPreviews, CalendarEventPreviewRow } from "./calendar-event-preview";
import { EventKindToggleChips } from "./event-kind-toggle-chips";
import { EventMetaRow, type EventCategoryKind } from "@/components/events/event-meta";
import { OpenNowStatus } from "@/components/events/open-now-status";
import { SaveEventButton } from "@/components/events/save-event-button";
import { CALENDAR_TIME_BANDS } from "@/lib/events/calendar-time-band-definitions";
import { AGENDA_BAND_ORDER, AGENDA_SORT_OPTIONS, type AgendaSortMode } from "@/lib/events/agenda-sort-options";
import type { CalendarAgendaEvent } from "@/lib/events/calendar-agenda-types";
import styles from "./mobile-events-home.module.css";

const labels = { club: "Žurke", live: "Uživo", culture: "Kultura", event: "Ostalo" };
const bandLabels = { daytime: "Tokom dana", evening: "Veče", night: "Noć", "time-not-announced": "Vreme nije najavljeno", "after-midnight": "Posle ponoći" };

type Props = {
  events: CalendarAgendaEvent[];
  hiddenDayCategories: EventCategoryKind[];
  selectedDayEventCount: number;
  dayLabel: string;
  openNowActive: boolean;
  openNowHref: string;
  now: number;
  authEnabled: boolean;
  sortMode?: AgendaSortMode;
  hasActiveFilters: boolean;
  clearFiltersHref: string;
};

function renderEventRow({ event, openNowActive }: { event: CalendarAgendaEvent; openNowActive: boolean }) {
  const known = Boolean(event.timeParts.startLabel) && event.timeStatus !== "unknown";
  return <article className={styles.eventRow}
    data-calendar-event-id={event._id} data-calendar-event-kind={event.category}
    data-calendar-mobile-event-row="true" data-event-title={event.title} data-event-venue={event.venue}
    data-event-time={event.displayTimeLabel ?? event.time} data-calendar-open-now-state={openNowActive ? event.openNowState : undefined}>
    <CalendarEventPreviewRow eventId={event._id} title={event.title} headerClassName={styles.eventHeader}>
      <span className={styles.eventTime} title={event.presentation.label}>
        <span>{known ? event.timeParts.startLabel || "—" : "—"}</span>
        {known && event.timeParts.endLabel && !event.presentation.inferredEnd ? <small>{event.timeParts.endLabel}</small> : null}
      </span>
      <div className={styles.eventInfo}>
        <h3 className={styles.eventTitle}>{event.title}</h3>
        {event.venueId ? <Link className={styles.venueName} href={`/venues/${event.venueId}`} prefetch={false}>{event.venue}</Link> : <p className={styles.venueName}>{event.venue}</p>}
        {event.sessionLabel ? <span className={styles.session} data-event-session="true">{event.sessionLabel}</span> : null}
        <div className={styles.rowMeta}>
          <span className={styles.categoryLabel} data-category-tone={event.category}><span aria-hidden="true" />{labels[event.category]}</span>
          <EventMetaRow event={event} presentation={event} />
        </div>
        <OpenNowStatus eventId={event._id} state={event.openNowState} />
      </div>
      <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="icon" />
    </CalendarEventPreviewRow>
  </article>;
}

/** One complete sorted projection, category state, and measured virtual list at every width. */
export function CalendarAgenda({ events, hiddenDayCategories, openNowActive, sortMode = "time", hasActiveFilters, clearFiltersHref }: Props) {
  const [activeHiddenCategories, setActiveHiddenCategories] = useState(hiddenDayCategories);
  const hiddenSet = useMemo(() => new Set(activeHiddenCategories), [activeHiddenCategories]);
  const visible = useMemo(() => events.filter(event => !hiddenSet.has(event.category)), [events, hiddenSet]);
  useEffect(() => setActiveHiddenCategories(hiddenDayCategories), [hiddenDayCategories]);
  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-calendar-mobile-day-count]").forEach(target => { target.textContent = String(visible.length); });
  }, [visible.length]);
  const alphabetical = sortMode === "title" || sortMode === "venue";
  const sortLabel = AGENDA_SORT_OPTIONS.find(option => option.value === sortMode)!.label;
  const groups = alphabetical
    ? [{ key: "alphabetical", label: sortLabel, description: "", events: visible }]
    : AGENDA_BAND_ORDER[sortMode === "late" ? "late" : "time"].map(key => ({ key, label: bandLabels[key], description: key === "time-not-announced" ? "" : CALENDAR_TIME_BANDS.find(band => band.key === key)!.description, events: visible.filter(event => event.band === key) })).filter(group => group.events.length);

  return <CalendarEventPreviews><section className={styles.agenda}
    data-calendar-agenda-scope="mobile-week" data-calendar-scroll-region="selected-day-agenda"
    data-calendar-virtualized-agenda="true" data-calendar-sort-mode={sortMode}>
    <div className={styles.stickyFilters} data-calendar-mobile-sticky-filters="true">
      <EventKindToggleChips appearance="tabs" singleSelection initialHiddenCategories={hiddenDayCategories} onHiddenCategoriesChange={setActiveHiddenCategories} />
    </div>
    <p className={styles.resultCount} role="status"><span data-calendar-visible-event-count="true">{visible.length} {visible.length === 1 ? "događaj" : "događaja"}</span> · {sortLabel}</p>
    <div className={styles.contentGrid}>
      <div>{groups.map(group => <section className={styles.band} id={`agenda-${group.key}`} key={group.key}
        data-calendar-time-band={alphabetical ? undefined : group.key} data-calendar-time-band-event-count={group.events.length}
        aria-labelledby={`heading-${group.key}`}>
        <header className={styles.bandHeader}><h2 id={`heading-${group.key}`}>{group.label}</h2>{group.description ? <span>{group.description}</span> : null}<span data-calendar-time-band-visible-count="true">{group.events.length}</span></header>
        <VirtualAgendaList items={group.events} getKey={event => event._id} estimateSize={108}>{event => renderEventRow({ event, openNowActive })}</VirtualAgendaList>
      </section>)}
      {!visible.length ? <div className={styles.empty} data-calendar-empty-state="true"><h2>Nema događaja za ovaj izbor.</h2><p>Probaj drugu pretragu, kategoriju ili datum.</p>{hasActiveFilters ? <Link className="button-secondary" href={clearFiltersHref} prefetch={false} scroll={false}>Poništi filtere</Link> : null}</div> : null}
      </div>
      <aside className={styles.side} aria-label="Pregled dana"><h2>{alphabetical ? "Abecedni pregled" : "Po satima"}</h2><nav>{groups.map(group => <a key={group.key} href={`#agenda-${group.key}`}><span>{group.label}</span><span>{group.events.length}</span></a>)}</nav><p><strong>Vreme i izvor.</strong><br />Ako početak nije najavljen, događaj je posebno označen. Radno vreme mesta nije trajanje programa.</p></aside>
    </div>
  </section></CalendarEventPreviews>;
}
