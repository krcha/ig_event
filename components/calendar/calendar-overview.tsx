"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { buildCalendarOverviewPresentation, type CalendarDaySnapshot, type CalendarOverviewData, type CalendarOverviewOptions } from "@/lib/events/calendar-overview-data";
import { calendarOverviewKey, fetchCalendarOverview, peekCalendarOverview, CALENDAR_OVERVIEW_TTL_MS } from "@/lib/events/calendar-overview-client";
import { normalizeHiddenEventCategories } from "@/lib/taxonomy/event-categories";
import type { PublicEventVenueFilterOption } from "@/lib/events/public-event-venue-filter";

type OverviewContextValue = {
  ready: boolean;
  refreshing: boolean;
  openNow: boolean;
  selectedDate: string;
  presentation: ReturnType<typeof buildCalendarOverviewPresentation> | null;
  venues: PublicEventVenueFilterOption[];
};
const OverviewContext = createContext<OverviewContextValue | null>(null);

export function CalendarOverviewProvider({ options, selectedDay, openNow, children }: {
  options: CalendarOverviewOptions;
  selectedDay: CalendarDaySnapshot;
  openNow: boolean;
  children: ReactNode;
}) {
  const params = useSearchParams();
  const hiddenKey = params.get("hide") ?? "";
  const key = calendarOverviewKey(options);
  const [resource, setResource] = useState<{ key: string; data: CalendarOverviewData } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  // Date, sort and category changes retain this scope. Its request never blocks
  // the independently rendered day, and rapid navigation shares pending reads.
  const { month, weekStart, q, venue } = options;
  useEffect(() => {
    let active = true;
    let deferred: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(deferred);
      if (document.visibilityState === "hidden") return;
      if (document.querySelector("[data-calendar-loading-day]") || document.documentElement.dataset.navigationPending === "true") {
        deferred = setTimeout(refresh, 250);
        return;
      }
      if (!peekCalendarOverview({ month, weekStart, q, venue })) setRefreshingKey(key);
      void fetchCalendarOverview({ month, weekStart, q, venue }).then(data => {
        if (!active) return;
        setResource({ key, data });
        setFailedKey(null);
        setRefreshingKey(null);
      }).catch(() => { if (active) { setFailedKey(key); setRefreshingKey(null); } });
    };
    refresh();
    const interval = setInterval(refresh, CALENDAR_OVERVIEW_TTL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearTimeout(deferred);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [key, month, weekStart, q, venue]);
  const data = resource?.key === key ? resource.data : undefined;
  const presentation = useMemo(() => data
    ? buildCalendarOverviewPresentation(data, { month, weekStart, q, venue }, openNow ? undefined : selectedDay, normalizeHiddenEventCategories(hiddenKey.split(",")))
    : null, [data, month, weekStart, q, venue, openNow, selectedDay, hiddenKey]);
  const value = useMemo(() => ({ ready: Boolean(data), refreshing: refreshingKey === key, openNow, selectedDate: selectedDay.date, presentation, venues: data?.venues ?? [] }), [data, refreshingKey, key, openNow, selectedDay.date, presentation]);
  return <OverviewContext.Provider value={value}>
    {children}
    {failedKey === key ? <p className="px-1 text-xs text-muted-foreground" role="status">Calendar counts are temporarily unavailable. Events are still available.</p> : null}
  </OverviewContext.Provider>;
}

export function useCalendarOverviewDays<T extends { dayKey: string; eventCount: number; categoryCounts?: unknown }>(days: T[]): T[] {
  const overview = useContext(OverviewContext);
  return useMemo(() => days.map(day => {
    if (!overview || (!overview.openNow && day.dayKey === overview.selectedDate)) return day;
    const counts = overview.presentation?.days.get(day.dayKey);
    return { ...day, eventCount: counts?.eventCount ?? 0, ...(counts ? { categoryCounts: counts.categoryCounts } : {}), countsPending: !overview.ready };
  }), [days, overview]);
}

export function CalendarStatValue({ statKey, fallback }: { statKey: "events" | "active-days" | "venues" | "weekend"; fallback: number }) {
  const overview = useContext(OverviewContext);
  const pending = overview && !overview.openNow && !overview.ready;
  const value = overview?.openNow ? fallback : overview?.presentation?.metrics[statKey] ?? fallback;
  return <span aria-busy={pending || overview?.refreshing || undefined} data-calendar-stat-value={statKey}>{pending ? "\u2014" : value}</span>;
}

export function CalendarVenueSelect({ className, selected, selectedLabel, fallback }: {
  className?: string;
  selected?: string;
  selectedLabel: string;
  fallback: PublicEventVenueFilterOption[];
}) {
  const overview = useContext(OverviewContext);
  const venues = overview?.ready && !overview.openNow ? overview.venues : fallback;
  return <select className={className} defaultValue={selected ?? ""} key={selected ?? ""} name="venue">
    <option value="">All venues</option>
    {selected && !venues.some(venue => venue.value === selected) ? <option value={selected}>{selectedLabel}</option> : null}
    {venues.map(venue => <option key={venue.value} value={venue.value}>{venue.label}</option>)}
  </select>;
}
