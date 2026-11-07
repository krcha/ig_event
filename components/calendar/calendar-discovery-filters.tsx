"use client";

import { ChevronDown, X } from "lucide-react";
import { useId, useState } from "react";
import { LocalizedElement, PublicText } from "@/components/i18n/public-text";
import { DISCOVERY_CATEGORIES, MUSIC_GENRES } from "@/lib/taxonomy/event-discovery";
import {
  calendarBandLabels,
  musicIntents,
  type DiscoveryCategory,
  type DiscoveryGenre,
  type DiscoveryGenreFilter,
} from "./calendar-discovery-state";
import { replaceCalendarDiscoveryFilters } from "./calendar-discovery-query";
import type { CalendarTimeBandKey } from "@/lib/events/calendar-time-band-definitions";
import styles from "./mobile-events-home.module.css";

const quickCategories = DISCOVERY_CATEGORIES.filter(({ key }) => key === "party" || key === "live");
const moreCategories = DISCOVERY_CATEGORIES.filter(({ key }) => key !== "party" && key !== "live");
const genreLimit = 5;

type CategoryFiltersProps = {
  categories: readonly DiscoveryCategory[];
  categoryCounts: ReadonlyMap<DiscoveryCategory, number>;
  allCount: number;
  hasLegacyFilter: boolean;
  genre?: DiscoveryGenreFilter;
  genreCounts: ReadonlyMap<DiscoveryGenre, number>;
  unknownGenreCount: number;
  time?: CalendarTimeBandKey;
  format?: "stand-up";
  standUpCount: number;
};

export function CalendarDiscoveryFilters({ categories, categoryCounts, allCount, hasLegacyFilter, genre, genreCounts, unknownGenreCount, time, format, standUpCount }: CategoryFiltersProps) {
  const panelId = useId();
  const extraGenresId = useId();
  const selectedMore = categories.filter(key => key !== "party" && key !== "live").length;
  const [expanded, setExpanded] = useState(selectedMore > 0);
  const [showAllGenres, setShowAllGenres] = useState(false);
  const showGenres = genre !== undefined || musicIntents.some(key => categories.includes(key));
  const availableGenres = MUSIC_GENRES.filter(({ key }) => genreCounts.has(key))
    .sort((left, right) => (genreCounts.get(right.key) ?? 0) - (genreCounts.get(left.key) ?? 0));
  const topGenres = availableGenres.slice(0, genreLimit);
  const remainingGenres = availableGenres.slice(genreLimit);
  const activeGenre = MUSIC_GENRES.find(({ key }) => key === genre);
  const activeIsExpanded = showAllGenres && remainingGenres.some(({ key }) => key === genre);
  if (activeGenre && !activeIsExpanded && !topGenres.some(({ key }) => key === activeGenre.key)) topGenres.push(activeGenre);
  const extraGenres = remainingGenres.filter(({ key }) => !topGenres.some(item => item.key === key));

  function toggleCategory(key: DiscoveryCategory) {
    const next = categories.includes(key) ? categories.filter(item => item !== key) : [...categories, key];
    const category = DISCOVERY_CATEGORIES.filter(item => next.includes(item.key)).map(item => item.key).join(",");
    const keepGenre = musicIntents.some(item => next.includes(item));
    replaceCalendarDiscoveryFilters({ category, hide: null, genre: keepGenre ? genre : null, format: next.includes("culture") ? format : null });
  }

  function renderCategory({ key, label }: (typeof DISCOVERY_CATEGORIES)[number]) {
    return <button key={key} type="button" aria-pressed={categories.includes(key)} data-calendar-kind-toggle={key}
      onClick={() => toggleCategory(key)}>
      <span><PublicText text={label} /></span>
      <span className={styles.facetCount}>{categoryCounts.get(key) ?? 0}</span>
    </button>;
  }

  function renderGenre(key: DiscoveryGenreFilter, label: string, count: number) {
    return <button key={key} type="button" aria-pressed={genre === key} data-calendar-genre-filter={key}
      onClick={() => replaceCalendarDiscoveryFilters({ genre: genre === key ? null : key })}>
      <PublicText text={label} /><span className={styles.facetCount}>{count}</span>
    </button>;
  }

  return <>
    <div className={styles.stickyFilters} data-calendar-mobile-sticky-filters="true">
      <LocalizedElement as="nav" aria-label="Kategorije događaja" data-calendar-mobile-filter-chips="true" data-calendar-category-selection="multiple">
        <button type="button" aria-pressed={!categories.length && !genre && !format && !hasLegacyFilter} data-calendar-kind-toggle="all"
          onClick={() => replaceCalendarDiscoveryFilters({ category: null, genre: null, format: null, hide: null })}>
          <span><PublicText text="Sve" /></span><span className={styles.facetCount}>{allCount}</span>
        </button>
        {quickCategories.map(renderCategory)}
        <LocalizedElement as="button" type="button" aria-label="Još kategorija" aria-expanded={expanded} aria-controls={panelId} className={styles.moreCategoriesToggle}
          onClick={() => setExpanded(!expanded)}>
          <span><PublicText text="Još" /></span>{selectedMore ? <span className={styles.facetCount}>{selectedMore}</span> : null}
          <ChevronDown aria-hidden="true" size={14} />
        </LocalizedElement>
      </LocalizedElement>
    </div>
    <LocalizedElement as="div" id={panelId} className={styles.facetRow} hidden={!expanded} aria-label="Još kategorija" role="group">
      {moreCategories.map(renderCategory)}
    </LocalizedElement>
    {showGenres ? <>
      <LocalizedElement as="div" className={styles.facetRow} aria-label="Žanr" role="group" data-calendar-genre-filters="true">
        <span className={styles.facetLabel}><PublicText text="Žanr" /></span>
        {topGenres.map(({ key, label }) => renderGenre(key, label, genreCounts.get(key) ?? 0))}
        {renderGenre("unknown", "Žanr nije naveden", unknownGenreCount)}
        {extraGenres.length ? <button type="button" className={styles.moreCategoriesToggle} aria-expanded={showAllGenres} aria-controls={extraGenresId}
          onClick={() => setShowAllGenres(!showAllGenres)}>
          <PublicText text={showAllGenres ? "Manje žanrova" : "Još žanrova"} /><ChevronDown aria-hidden="true" size={14} />
        </button> : null}
      </LocalizedElement>
      {extraGenres.length ? <LocalizedElement as="div" id={extraGenresId} className={styles.facetRow} hidden={!showAllGenres} aria-label="Još žanrova" role="group">
        {extraGenres.map(({ key, label }) => renderGenre(key, label, genreCounts.get(key) ?? 0))}
      </LocalizedElement> : null}
    </> : null}
    {format || (standUpCount > 0 && categories.includes("culture")) ? <LocalizedElement as="div" className={styles.facetRow} aria-label="Format događaja" role="group">
      <button type="button" aria-pressed={Boolean(format)} data-calendar-format-filter="stand-up"
        onClick={() => replaceCalendarDiscoveryFilters({ format: format ? null : "stand-up" })}>
        <PublicText text="Stand-up" /><span className={styles.facetCount}>{standUpCount}</span>
      </button>
    </LocalizedElement> : null}
    {time ? <div className={styles.facetRow}>
      <LocalizedElement as="button" className={styles.activeTime} type="button" aria-label="Ukloni filter vremena"
        onClick={() => replaceCalendarDiscoveryFilters({ time: null })}>
        <PublicText text={calendarBandLabels[time]} /><X aria-hidden="true" size={14} />
      </LocalizedElement>
    </div> : null}
  </>;
}
