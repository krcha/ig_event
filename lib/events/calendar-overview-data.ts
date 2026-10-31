import type { PublicCalendarOverviewGroup, PublicCalendarOverviewVenue } from "./public-calendar-overview-types";
import { EVENT_PRIMARY_CATEGORIES, type EventPrimaryCategory } from "../taxonomy/event-categories";

export type CalendarOverviewOptions = { month: string; weekStart: string; q?: string; venue?: string };
export type CalendarOverviewData = {
  groups: PublicCalendarOverviewGroup[];
  venues: PublicCalendarOverviewVenue[];
  generatedAt: number;
};
export type CalendarDaySnapshot = { date: string; groups: PublicCalendarOverviewGroup[] };
export type CalendarDayCounts = { eventCount: number; categoryCounts: Record<EventPrimaryCategory, number> };

export function buildCalendarOverviewPresentation(
  data: CalendarOverviewData,
  options: CalendarOverviewOptions,
  selected: CalendarDaySnapshot | undefined,
  hidden: readonly EventPrimaryCategory[],
) {
  const groups = selected
    ? [...data.groups.filter(group => group.date !== selected.date), ...selected.groups]
    : data.groups;
  const days = new Map<string, CalendarDayCounts>();
  const venues = new Set<string>();
  const hiddenSet = new Set(hidden);
  const metrics = { events: 0, "active-days": 0, venues: 0, weekend: 0 };
  for (const group of groups) {
    const count = !options.venue ? group.count : /^(?:id|name):/u.test(options.venue)
      ? group.venueValue === options.venue ? group.count : 0
      : group.legacyVenueMatchCount;
    let day = days.get(group.date);
    if (!day) {
      day = { eventCount: 0, categoryCounts: Object.fromEntries(EVENT_PRIMARY_CATEGORIES.map(({ key }) => [key, 0])) as Record<EventPrimaryCategory, number> };
      days.set(group.date, day);
    }
    day.categoryCounts[group.category] += count;
    if (hiddenSet.has(group.category)) continue;
    day.eventCount += count;
    if (!group.date.startsWith(`${options.month}-`) || count === 0) continue;
    metrics.events += count;
    venues.add(group.venueValue);
    const weekday = new Date(`${group.date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) metrics.weekend += count;
  }
  metrics.venues = venues.size;
  metrics["active-days"] = [...days].filter(([date, day]) => date.startsWith(`${options.month}-`) && date >= options.weekStart && day.eventCount > 0).length;
  return { days, metrics };
}
