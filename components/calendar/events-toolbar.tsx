"use client";
import { LocalizedElement, PublicText } from "@/components/i18n/public-text";


import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { AutoApplyFilterForm } from "./auto-apply-filter-form";
import { OpenNowFilter } from "./open-now-filter";
import { useEventsUi } from "./events-ui-provider";
import { AGENDA_SORT_OPTIONS, type AgendaSortMode } from "@/lib/events/agenda-sort-options";
import { CALENDAR_TIME_BANDS } from "@/lib/events/calendar-time-band-definitions";
import { calendarBandLabels, useCalendarDiscoveryFilters } from "./calendar-discovery-state";
import { replaceCalendarDiscoveryFilters } from "./calendar-discovery-query";
import { useLocale } from "@/i18n/client";
import { publicText } from "@/lib/i18n/public-messages";
import styles from "./mobile-events-home.module.css";

export function EventsToolbar({ query, sortMode, openNowActive, openNowHref, now }: {
  query?: string; sortMode: AgendaSortMode; openNowActive: boolean; openNowHref: string; now: number;
}) {
  const { filtersOpen, setFiltersOpen } = useEventsUi();
  const { time } = useCalendarDiscoveryFilters();
  const locale = useLocale();
  const [selectedSort, setSelectedSort] = useState(sortMode);
  useEffect(() => setSelectedSort(sortMode), [sortMode]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current && document.activeElement !== input.current) input.current.value = query ?? "";
  }, [query]);
  const active = openNowActive || selectedSort !== "time" || Boolean(time);

  return <LocalizedElement as="section" className={styles.toolbar} aria-label="Pretraga i filteri">
    <AutoApplyFilterForm searchDebounceMs={300}>
    <div className={styles.searchRow}>
      <div className={styles.searchForm}>
        <label className={styles.searchLabel}>
          <Search aria-hidden="true" size={19} />
          <span className="sr-only"><PublicText text={"Pretraži događaje"} /></span>
          <LocalizedElement as="input" ref={input} className={styles.search} data-calendar-mobile-search-input="true" name="q" type="search" defaultValue={query ?? ""} placeholder="Događaj, mesto ili žanr" autoComplete="off" />
        </label>
      </div>
      <LocalizedElement as="button" className={styles.filterButton} type="button" aria-label="Filteri" aria-expanded={filtersOpen} aria-controls="events-extra-filters" data-filters-active={active || undefined} onClick={() => setFiltersOpen(!filtersOpen)}>
        <SlidersHorizontal aria-hidden="true" size={20} />
        {active ? <span className={styles.indicator} aria-hidden="true" /> : null}
        <span className="sr-only"><PublicText text={active ? "Dodatne kontrole su aktivne." : "Otvori dodatne kontrole."} /></span>
      </LocalizedElement>
    </div>
    <div className={styles.extraFilters} id="events-extra-filters" hidden={!filtersOpen}>
      <OpenNowFilter active={openNowActive} appearance="events" href={openNowHref} initialNow={now} />
      <div className={styles.sortForm}>
        <label><span className="sr-only"><PublicText text={"Sortiranje"} /></span><LocalizedElement as="select" aria-label="Sortiranje" className={styles.sort} name="sort" data-calendar-sort-select="true" value={selectedSort} onChange={event => setSelectedSort(event.target.value as AgendaSortMode)}>
          {AGENDA_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}><PublicText text={option.label} /></option>)}
        </LocalizedElement></label>
      </div>
      <label className={styles.startFilter}>
        <span><PublicText text="Početak događaja" /></span>
        <select className={styles.sort} data-calendar-time-filter="true" value={time ?? ""}
          onChange={event => replaceCalendarDiscoveryFilters({ time: event.target.value })}>
          <option value=""><PublicText text="Bilo kada" /></option>
          {CALENDAR_TIME_BANDS.map(({ key, description }) => <option key={key} value={key}>
            {publicText(locale, calendarBandLabels[key])}{key === "time-not-announced" ? "" : ` · ${description.replace("-", "–")}`}
          </option>)}
        </select>
      </label>
    </div>
    </AutoApplyFilterForm>
  </LocalizedElement>;
}
