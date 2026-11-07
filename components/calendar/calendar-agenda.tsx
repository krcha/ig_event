"use client";
import { PublicText, LocalizedElement, PublicEventCount } from "@/components/i18n/public-text";


import { LocalizedLink as Link } from "@/components/i18n/public-text";
import { useMemo } from "react";
import { VirtualAgendaList } from "./virtual-agenda-list";
import { CalendarEventPreviews, CalendarEventPreviewRow } from "./calendar-event-preview";
import { CalendarDiscoveryFilters } from "./calendar-discovery-filters";
import { calendarBandLabels, musicIntents, useCalendarDiscoveryFilters, type DiscoveryCategory, type DiscoveryGenre } from "./calendar-discovery-state";
import { replaceCalendarDiscoveryFilters } from "./calendar-discovery-query";
import { EventMetaRow } from "@/components/events/event-meta";
import { OpenNowStatus } from "@/components/events/open-now-status";
import { SaveEventButton } from "@/components/events/save-event-button";
import { CALENDAR_TIME_BANDS } from "@/lib/events/calendar-time-band-definitions";
import { AGENDA_BAND_ORDER, AGENDA_SORT_OPTIONS, type AgendaSortMode } from "@/lib/events/agenda-sort-options";
import type { CalendarAgendaEvent } from "@/lib/events/calendar-agenda-types";
import { DISCOVERY_CATEGORIES, DISCOVERY_FORMATS, eventMatchesMusicGenre, getEventDiscoveryTaxonomy } from "@/lib/taxonomy/event-discovery";
import styles from "./mobile-events-home.module.css";

const categoryLabels = new Map(DISCOVERY_CATEGORIES.map(({ key, label }) => [key, label]));
const formatLabels = new Map(DISCOVERY_FORMATS.map(({ key, label }) => [key, label]));

type AgendaItem = { event: CalendarAgendaEvent; taxonomy: ReturnType<typeof getEventDiscoveryTaxonomy> };

type Props = {
  events: CalendarAgendaEvent[];
  openNowActive: boolean;
  sortMode?: AgendaSortMode;
  hasActiveFilters: boolean;
  clearFiltersHref: string;
};

function renderEventRow({ event, taxonomy }: AgendaItem, openNowActive: boolean) {
  const categoryLabel = taxonomy.primaryCategory === "party" ? "Žurke"
    : taxonomy.primaryCategory === "live" ? "Live/Svirke"
      : categoryLabels.get(taxonomy.primaryCategory);
  const formatLabel = taxonomy.formats[0] ? formatLabels.get(taxonomy.formats[0]) : undefined;
  const normalizedFormat = formatLabel?.toLowerCase();
  const secondaryTags = normalizedFormat ? event.tags.filter(tag => tag.trim().toLowerCase() !== normalizedFormat) : event.tags;
  const known = Boolean(event.timeParts.startLabel) && event.timeStatus !== "unknown";
  const venueHours = !known && event.presentation.kind === "venue_hours";
  const timeDescription = venueHours
    ? `Radno vreme mesta: ${event.presentation.label}`
    : event.presentation.inferredEnd
      ? `Najavljeni početak: ${event.timeParts.startLabel}. Pretpostavljeni završetak prema zatvaranju mesta: ${event.timeParts.endLabel}.`
      : event.presentation.label;
  return <article className={styles.eventRow}
    data-calendar-event-id={event._id} data-calendar-event-kind={event.category}
    data-calendar-event-discovery-categories={taxonomy.categories.join(",")}
    data-calendar-mobile-event-row="true" data-event-title={event.title} data-event-venue={event.venue}
    data-event-time={event.displayTimeLabel ?? event.time} data-calendar-open-now-state={openNowActive ? event.openNowState : undefined}>
    <CalendarEventPreviewRow eventId={event._id} title={event.title} headerClassName={styles.eventHeader}>
      <LocalizedElement as="span" className={styles.eventTime} title={timeDescription} aria-label={timeDescription}
        data-time-source={venueHours ? "venue_hours" : known ? "event" : "unknown"}>
        {venueHours ? <>
          {event.presentation.label.split(", ").map(window => {
            const [start, end] = window.split("–");
            return <span className={styles.venueHoursWindow} key={window}>
              <span>{window === "Open 24 hours" ? "24 h" : start}</span>
              {end ? <small>{end}</small> : null}
            </span>;
          })}
        </> : <>
          <span>{known ? event.timeParts.startLabel || "—" : "—"}</span>
          {known && event.timeParts.endLabel ? <small data-inferred-end={event.presentation.inferredEnd ? "true" : undefined}>{event.timeParts.endLabel}</small> : null}
        </>}
      </LocalizedElement>
      <div className={styles.eventInfo}>
        <h3 className={styles.eventTitle}>{event.title}</h3>
        {event.venueId ? <Link className={styles.venueName} href={`/venues/${event.venueId}`} prefetch={false}>{event.venue}</Link> : <p className={styles.venueName}>{event.venue}</p>}
        {event.sessionLabel ? <span className={styles.session} data-event-session="true"><PublicText text={event.sessionLabel} /></span> : null}
        <div className={styles.rowMeta}>
          <span className={styles.categoryLabel} data-category-tone={event.category}><span aria-hidden="true" /><PublicText text={categoryLabel} />
            {formatLabel ? <> · <PublicText text={formatLabel} /></> : null}
          </span>
          <EventMetaRow event={event} presentation={{ category: event.category, tags: secondaryTags }} />
        </div>
        <OpenNowStatus eventId={event._id} state={event.openNowState} />
      </div>
      <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="icon" />
    </CalendarEventPreviewRow>
  </article>;
}

/** Filter the selected day's sorted projection before measuring its virtual rows. */
export function CalendarAgenda({ events, openNowActive, sortMode = "time", hasActiveFilters, clearFiltersHref }: Props) {
  const { categories, genre, time, format, hiddenCategories } = useCalendarDiscoveryFilters();
  const items = useMemo(() => {
    const distinct = new Map<string, AgendaItem>();
    for (const event of events) {
      if (!distinct.has(event._id)) distinct.set(event._id, { event, taxonomy: getEventDiscoveryTaxonomy(event) });
    }
    return Array.from(distinct.values());
  }, [events]);
  const { visible, categoryCounts, genreCounts, unknownGenreCount, standUpCount, allCount } = useMemo(() => {
    const visible: AgendaItem[] = [];
    const categoryCounts = new Map<DiscoveryCategory, number>();
    const genreCounts = new Map<DiscoveryGenre, number>();
    let allCount = 0;
    let unknownGenreCount = 0;
    let standUpCount = 0;

    for (const item of items) {
      const { event, taxonomy } = item;
      if (time && time !== event.band) continue;
      const isStandUp = taxonomy.formats.includes("stand-up");
      const matchesFormat = !format || isStandUp;
      const hasUnknownGenre = !taxonomy.genres.length && musicIntents.some(category => taxonomy.categories.includes(category));
      const matchesGenre = !genre || (genre === "unknown" ? hasUnknownGenre : eventMatchesMusicGenre(taxonomy.genres, genre));
      if (matchesGenre && matchesFormat) {
        for (const category of new Set(taxonomy.categories)) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
      allCount += 1;
      if (hiddenCategories.includes(event.category)) continue;
      if (categories.length && !taxonomy.categories.some(category => categories.includes(category))) continue;
      if (isStandUp && matchesGenre) standUpCount += 1;
      if (!matchesFormat) continue;
      if (hasUnknownGenre) unknownGenreCount += 1;
      const eventGenres = new Set(taxonomy.genres);
      if (eventMatchesMusicGenre(taxonomy.genres, "electronic")) eventGenres.add("electronic");
      for (const eventGenre of eventGenres) genreCounts.set(eventGenre, (genreCounts.get(eventGenre) ?? 0) + 1);
      if (matchesGenre) visible.push(item);
    }
    return { visible, categoryCounts, genreCounts, unknownGenreCount, standUpCount, allCount };
  }, [categories, format, genre, hiddenCategories, items, time]);
  const alphabetical = sortMode === "title" || sortMode === "venue";
  const sortLabel = AGENDA_SORT_OPTIONS.find(option => option.value === sortMode)!.label;
  const groups = alphabetical
    ? [{ key: "alphabetical", label: sortLabel, description: "", events: visible }]
    : AGENDA_BAND_ORDER[sortMode === "late" ? "late" : "time"].map(key => ({ key, label: calendarBandLabels[key], description: key === "time-not-announced" ? "" : CALENDAR_TIME_BANDS.find(band => band.key === key)!.description, events: visible.filter(({ event }) => event.band === key) })).filter(group => group.events.length);
  const hasDiscoveryFilters = Boolean(categories.length || genre || time || format || hiddenCategories.length);

  return <CalendarEventPreviews><section className={styles.agenda}
    data-calendar-agenda-scope="mobile-week" data-calendar-scroll-region="selected-day-agenda"
    data-calendar-virtualized-agenda="true" data-calendar-sort-mode={sortMode}>
    <CalendarDiscoveryFilters categories={categories} categoryCounts={categoryCounts} allCount={allCount} hasLegacyFilter={hiddenCategories.length > 0}
      genre={genre} genreCounts={genreCounts} unknownGenreCount={unknownGenreCount} time={time} format={format} standUpCount={standUpCount} />
    <p className={styles.resultCount} role="status"><span data-calendar-visible-event-count="true"><PublicEventCount count={visible.length} /></span> · <PublicText text={sortLabel} /></p>
    <div className={styles.contentGrid}>
      <div>{groups.map(group => <section className={styles.band} id={`agenda-${group.key}`} key={group.key}
        data-calendar-time-band={alphabetical ? undefined : group.key} data-calendar-time-band-event-count={group.events.length}
        aria-labelledby={`heading-${group.key}`}>
        <header className={styles.bandHeader}><h2 id={`heading-${group.key}`}><PublicText text={group.label} /></h2>{group.description ? <span>{group.description}</span> : null}<span data-calendar-time-band-visible-count="true">{group.events.length}</span></header>
        <VirtualAgendaList items={group.events} getKey={item => item.event._id} estimateSize={108}>{item => renderEventRow(item, openNowActive)}</VirtualAgendaList>
      </section>)}
      {!visible.length ? <div className={styles.empty} data-calendar-empty-state="true">
        <h2><PublicText text="Nema događaja za ovaj izbor." /></h2>
        <p><PublicText text="Probaj drugu pretragu, kategoriju ili datum." /></p>
        {hasActiveFilters ? <Link className="button-secondary" href={clearFiltersHref} prefetch={false} scroll={false}><PublicText text="Poništi filtere" /></Link>
          : hasDiscoveryFilters ? <button className="button-secondary" type="button" onClick={() => replaceCalendarDiscoveryFilters({ category: null, genre: null, time: null, format: null, hide: null })}><PublicText text="Poništi filtere" /></button> : null}
      </div> : null}
      </div>
      <LocalizedElement as="aside" className={styles.side} aria-label="Pregled dana"><h2><PublicText text={alphabetical ? "Abecedni pregled" : "Po satima"} /></h2><nav>{groups.map(group => <LocalizedElement as="a" key={group.key} href={`#agenda-${group.key}`}><span><PublicText text={group.label} /></span><span>{group.events.length}</span></LocalizedElement>)}</nav><p><strong><PublicText text={"Vreme i izvor."} /></strong><br /><PublicText text={"Ako početak nije najavljen, prikazujemo dostupno radno vreme mesta za taj dan. Radno vreme mesta nije trajanje programa."} /></p></LocalizedElement>
    </div>
  </section></CalendarEventPreviews>;
}
