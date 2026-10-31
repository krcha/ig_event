"use client";

import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { AutoApplyFilterForm } from "./auto-apply-filter-form";
import { OpenNowFilter } from "./open-now-filter";
import { useEventsUi } from "./events-ui-provider";
import { AGENDA_SORT_OPTIONS, type AgendaSortMode } from "@/lib/events/agenda-sort-options";
import styles from "./mobile-events-home.module.css";

export function EventsToolbar({ query, sortMode, openNowActive, openNowHref, now }: {
  query?: string; sortMode: AgendaSortMode; openNowActive: boolean; openNowHref: string; now: number;
}) {
  const { filtersOpen, setFiltersOpen } = useEventsUi();
  const [selectedSort, setSelectedSort] = useState(sortMode);
  useEffect(() => setSelectedSort(sortMode), [sortMode]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current && document.activeElement !== input.current) input.current.value = query ?? "";
  }, [query]);
  const active = openNowActive || selectedSort !== "time";

  return <section className={styles.toolbar} aria-label="Pretraga i filteri">
    <AutoApplyFilterForm searchDebounceMs={300}>
    <div className={styles.searchRow}>
      <div className={styles.searchForm}>
        <label className={styles.searchLabel}>
          <Search aria-hidden="true" size={19} />
          <span className="sr-only">Pretraži događaje</span>
          <input ref={input} className={styles.search} data-calendar-mobile-search-input="true" name="q" type="search" defaultValue={query ?? ""} placeholder="Događaj, mesto ili žanr" autoComplete="off" />
        </label>
      </div>
      <button className={styles.filterButton} type="button" aria-label="Filteri" aria-expanded={filtersOpen} aria-controls="events-extra-filters" data-filters-active={active || undefined} onClick={() => setFiltersOpen(!filtersOpen)}>
        <SlidersHorizontal aria-hidden="true" size={20} />
        {active ? <span className={styles.indicator} aria-hidden="true" /> : null}
        <span className="sr-only">{active ? "Dodatne kontrole su aktivne." : "Otvori dodatne kontrole."}</span>
      </button>
    </div>
    <div className={styles.extraFilters} id="events-extra-filters" hidden={!filtersOpen}>
      <OpenNowFilter active={openNowActive} appearance="events" href={openNowHref} initialNow={now} />
      <div className={styles.sortForm}>
        <label><span className="sr-only">Sortiranje</span><select aria-label="Sortiranje" className={styles.sort} name="sort" data-calendar-sort-select="true" value={selectedSort} onChange={event => setSelectedSort(event.target.value as AgendaSortMode)}>
          {AGENDA_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
      </div>
    </div>
    </AutoApplyFilterForm>
  </section>;
}
