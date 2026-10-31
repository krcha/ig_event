import type { CalendarOverviewData, CalendarOverviewOptions } from "./calendar-overview-data";

export const CALENDAR_OVERVIEW_TTL_MS = 60_000;
const entries = new Map<string, { expiresAt: number; data?: CalendarOverviewData; pending?: Promise<CalendarOverviewData> }>();

export function calendarOverviewKey(options: CalendarOverviewOptions) {
  return JSON.stringify([options.month, options.weekStart, options.q?.trim() || "", options.venue?.trim() || ""]);
}

export function peekCalendarOverview(options: CalendarOverviewOptions): CalendarOverviewData | undefined {
  const entry = entries.get(calendarOverviewKey(options));
  return entry && entry.expiresAt > Date.now() ? entry.data : undefined;
}

/** One bounded request per month/filter scope, shared across day navigations. */
export function fetchCalendarOverview(options: CalendarOverviewOptions): Promise<CalendarOverviewData> {
  const key = calendarOverviewKey(options);
  const old = entries.get(key);
  if (old?.pending) return old.pending;
  if (old?.data && old.expiresAt > Date.now()) return Promise.resolve(old.data);
  const params = new URLSearchParams({ month: options.month, weekStart: options.weekStart });
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.venue?.trim()) params.set("venue", options.venue.trim());
  const entry: { expiresAt: number; data?: CalendarOverviewData; pending?: Promise<CalendarOverviewData> } = { expiresAt: 0 };
  const pending = fetch(`/api/calendar/overview?${params}`, { cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error("Calendar counts are unavailable.");
    const data = await response.json() as CalendarOverviewData;
    if (!Array.isArray(data.groups) || !Array.isArray(data.venues)) throw new Error("Calendar counts are unavailable.");
    entry.data = data;
    entry.expiresAt = Date.now() + CALENDAR_OVERVIEW_TTL_MS;
    entry.pending = undefined;
    return data;
  }).catch(error => {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  });
  entry.pending = pending;
  entries.set(key, entry);
  while (entries.size > 6) entries.delete(entries.keys().next().value!);
  return pending;
}
