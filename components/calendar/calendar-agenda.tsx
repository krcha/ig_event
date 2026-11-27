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
import { sortAgendaEvents } from "@/lib/events/agenda-sort";
import { useUserLocation } from "@/components/travel/user-location";
import type { CalendarAgendaEvent } from "@/lib/events/calendar-agenda-types";
import { DISCOVERY_CATEGORIES, DISCOVERY_CATEGORY_TONES, DISCOVERY_FORMATS, MUSIC_GENRES, eventMatchesMusicGenre, type DiscoveryFormat } from "@/lib/taxonomy/event-discovery";
import styles from "./mobile-events-home.module.css";

const categoryLabels = new Map(DISCOVERY_CATEGORIES.map(({ key, label }) => [key, label]));
const formatLabels = new Map(DISCOVERY_FORMATS.map(({ key, label }) => [key, label]));
const genreLabels = new Map(MUSIC_GENRES.map(({ key, label }) => [key, label]));
const musicFormats = {
  live: new Set<DiscoveryFormat>(["live-performance", "concert", "tribute"]),
  party: new Set<DiscoveryFormat>(["dj-set", "party"]),
};

type AgendaItem = { event: CalendarAgendaEvent; taxonomy: CalendarAgendaEvent["eventTaxonomy"] };

type Props = {
  events: CalendarAgendaEvent[];
  openNowActive: boolean;
  sortMode?: AgendaSortMode;
  hasActiveFilters: boolean;
  clearFiltersHref: string;
};

function renderEventRow({ event, taxonomy }: AgendaItem, openNowActive: boolean) {
  const { primaryCategory, formats } = taxonomy;
  const categoryLabel = primaryCategory === "party" ? "Žurke"
    : primaryCategory === "live" ? "Live/Svirke"
      : categoryLabels.get(primaryCategory);
  const format = primaryCategory === "live" || primaryCategory === "party"
    ? formats.find(key => musicFormats[primaryCategory].has(key))
    : formats[0];
  const formatLabel = format ? formatLabels.get(format) : undefined;
  const shownLabels = new Set([formatLabel, ...taxonomy.genres.map(genre => genreLabels.get(genre))]
    .flatMap(label => label ? [label.toLowerCase()] : []));
  const secondaryTags = event.tags.filter(tag => !shownLabels.has(tag.trim().toLowerCase()));
  const known = Boolean(event.timeParts.startLabel) && event.timeStatus !== "unknown";
  const venueHours = !known && event.venueHoursLabel
    ? event.venueHoursLabel === "Open 24 hours" ? "24 h" : event.venueHoursLabel
    : null;
  const timeDescription = !known
    ? calendarBandLabels["time-not-announced"]
    : event.presentation.inferredEnd
      ? `Najavljeni početak: ${event.timeParts.startLabel}. Pretpostavljeni završetak prema zatvaranju mesta: ${event.timeParts.endLabel}.`
      : event.presentation.label;
  return <article className={styles.eventRow}
    data-calendar-event-id={event._id} data-calendar-event-kind={event.category}
    data-calendar-event-discovery-categories={taxonomy.categories.join(",")}
    data-calendar-mobile-event-row="true" data-event-title={event.title} data-event-venue={event.venue}
    data-event-time={event.displayTimeLabel ?? event.time} data-calendar-open-now-state={openNowActive ? event.openNowState : undefined}>
    <CalendarEventPreviewRow eventId={event._id} title={event.title} headerClassName={styles.eventHeader}
      venueHoursLabel={event.venueHoursLabel} venueName={event.venue} venueLatitude={event.venueLatitude} venueLongitude={event.venueLongitude}>
      <LocalizedElement as="span" className={styles.eventTime} title={timeDescription} aria-label={timeDescription}
        data-time-source={known ? "event" : "unknown"}>
        <span>{known ? event.timeParts.startLabel : "—"}</span>
        {known && event.timeParts.endLabel ? <small data-inferred-end={event.presentation.inferredEnd ? "true" : undefined}>{event.timeParts.endLabel}</small> : null}
      </LocalizedElement>
      <div className={styles.eventInfo}>
        <h3 className={styles.eventTitle}>{event.title}</h3>
        {event.venueId ? <Link className={styles.venueName} href={`/venues/${event.venueId}`} prefetch={false}>{event.venue}</Link> : <p className={styles.venueName}>{event.venue}</p>}
        {event.sessionLabel ? <span className={styles.session} data-event-session="true"><PublicText text={event.sessionLabel} /></span> : null}
        <div className={styles.rowMeta}>
          <span className={styles.categoryLabel} data-category-tone={DISCOVERY_CATEGORY_TONES[primaryCategory]}><span aria-hidden="true" /><PublicText text={categoryLabel} />
            {formatLabel ? <> · <PublicText text={formatLabel} /></> : null}
          </span>
          {taxonomy.genres.map(genre => <span key={genre} className={styles.genreLabel} data-calendar-genre-label={genre}>
            <PublicText text={genreLabels.get(genre)} />
          </span>)}
          <EventMetaRow event={event} presentation={{ category: event.category, tags: secondaryTags }} />
        </div>
        {venueHours ? <p className={styles.venueHours} data-time-source="venue_hours"><PublicText text={`Radno vreme mesta: ${venueHours}`} /></p> : null}
        <OpenNowStatus eventId={event._id} state={event.openNowState} />
      </div>
      <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="icon" />
    </CalendarEventPreviewRow>
  </article>;
}

/** Filter the selected day's sorted projection before measuring its virtual rows. */
export function CalendarAgenda({ events, openNowActive, sortMode = "time", hasActiveFilters, clearFiltersHref }: Props) {
  const { categories, genre, format, hiddenCategories } = useCalendarDiscoveryFilters();
  const { position, status: locationStatus, error: locationError, requestLocation } = useUserLocation();
  const items = useMemo(() => {
    const distinct = new Map<string, AgendaItem>();
    for (const event of events) {
      if (!distinct.has(event._id)) distinct.set(event._id, { event, taxonomy: event.eventTaxonomy });
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
      if (hiddenCategories.includes(event.category)) continue;
      const isStandUp = taxonomy.formats.includes("stand-up");
      const matchesFormat = !format || isStandUp;
      const hasUnknownGenre = !taxonomy.genres.length && musicIntents.some(category => taxonomy.categories.includes(category));
      const matchesGenre = !genre || (genre === "unknown" ? hasUnknownGenre : eventMatchesMusicGenre(taxonomy.genres, genre));
      if (matchesGenre && matchesFormat) {
        for (const category of new Set(taxonomy.categories)) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
      allCount += 1;
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
  }, [categories, format, genre, hiddenCategories, items]);
  const orderedVisible = useMemo(() => {
    if (sortMode !== "distance" || !position) return visible;
    const order = new Map(sortAgendaEvents(visible.map(({ event }) => event), "distance", position).map((event, index) => [event._id, index]));
    return [...visible].sort((a, b) => order.get(a.event._id)! - order.get(b.event._id)!);
  }, [position, sortMode, visible]);
  const ungrouped = sortMode !== "time";
  const sortLabel = AGENDA_SORT_OPTIONS.find(option => option.value === sortMode)!.label;
  const groups = ungrouped
    ? [{ key: "selection", label: sortMode === "distance" && !position ? "Po vremenu" : sortLabel, description: "", events: orderedVisible }]
    : AGENDA_BAND_ORDER.map(key => ({ key, label: calendarBandLabels[key], description: key === "time-not-announced" ? "" : CALENDAR_TIME_BANDS.find(band => band.key === key)!.description, events: visible.filter(({ event }) => event.band === key) })).filter(group => group.events.length);
  const hasDiscoveryFilters = Boolean(categories.length || genre || format || hiddenCategories.length);

  return <CalendarEventPreviews><section className={styles.agenda}
    data-calendar-agenda-scope="mobile-week" data-calendar-scroll-region="selected-day-agenda"
    data-calendar-virtualized-agenda="true" data-calendar-sort-mode={sortMode}>
    <CalendarDiscoveryFilters categories={categories} categoryCounts={categoryCounts} allCount={allCount} hasLegacyFilter={hiddenCategories.length > 0}
      genre={genre} genreCounts={genreCounts} unknownGenreCount={unknownGenreCount} format={format} standUpCount={standUpCount} />
    <p className={styles.resultCount} role="status"><span data-calendar-visible-event-count="true"><PublicEventCount count={visible.length} /></span> · <PublicText text={sortLabel} /></p>
    {sortMode === "distance" && !position ? <div className={styles.locationSort} data-calendar-distance-location="true">
      <p role="status"><PublicText text={locationError ? "Lokacija nije dostupna. Dozvoli lokaciju i pokušaj ponovo." : "Uključi lokaciju za najbliže događaje. Do tada su poređani po vremenu."} /></p>
      <button disabled={locationStatus === "loading"} onClick={requestLocation} type="button"><PublicText text={locationStatus === "loading" ? "Tražimo lokaciju…" : "Koristi moju lokaciju"} /></button>
    </div> : null}
    <div className={styles.contentGrid}>
      <div>{groups.map(group => <section className={styles.band} id={`agenda-${group.key}`} key={group.key}
        data-calendar-time-band={ungrouped ? undefined : group.key} data-calendar-time-band-event-count={group.events.length}
        aria-labelledby={`heading-${group.key}`}>
        <header className={styles.bandHeader}><h2 id={`heading-${group.key}`}><PublicText text={group.label} /></h2>{group.description ? <span>{group.description}</span> : null}<span data-calendar-time-band-visible-count="true">{group.events.length}</span></header>
        <VirtualAgendaList items={group.events} getKey={item => item.event._id} estimateSize={108}>{item => renderEventRow(item, openNowActive)}</VirtualAgendaList>
      </section>)}
      {!visible.length ? <div className={styles.empty} data-calendar-empty-state="true">
        <h2><PublicText text="Nema događaja za ovaj izbor." /></h2>
        <p><PublicText text="Probaj drugu pretragu, kategoriju ili datum." /></p>
        {hasActiveFilters ? <Link className="button-secondary" href={clearFiltersHref} prefetch={false} scroll={false}><PublicText text="Poništi filtere" /></Link>
          : hasDiscoveryFilters ? <button className="button-secondary" type="button" onClick={() => replaceCalendarDiscoveryFilters({ category: null, genre: null, format: null, hide: null })}><PublicText text="Poništi filtere" /></button> : null}
      </div> : null}
      </div>
      <LocalizedElement as="aside" className={styles.side} aria-label="Pregled dana"><h2><PublicText text={sortMode === "time" ? "Po satima" : sortMode === "venue" ? "Abecedni pregled" : sortLabel} /></h2><nav>{groups.map(group => <LocalizedElement as="a" key={group.key} href={`#agenda-${group.key}`}><span><PublicText text={group.label} /></span><span>{group.events.length}</span></LocalizedElement>)}</nav><p><strong><PublicText text={"Vreme i izvor."} /></strong><br /><PublicText text={"Ako početak nije najavljen, prikazujemo dostupno radno vreme mesta za taj dan. Radno vreme mesta nije trajanje programa."} /></p></LocalizedElement>
    </div>
  </section></CalendarEventPreviews>;
}
