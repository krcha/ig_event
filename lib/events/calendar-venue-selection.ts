import "server-only";
import { loadPublicCalendarOverviewWindow } from "./public-calendar-overview";
import { resolvePublicEventVenueFilter } from "./public-event-venue-filter";

/** Current ID/name filters are immediate; preserve month-wide legacy alias URLs. */
export async function resolveCalendarVenueSelection(requested: string | undefined, range: { fromDate: string; beforeDate: string; q?: string }) {
  if (!requested || /^(?:id|name):/u.test(requested)) return { value: requested };
  const overview = await loadPublicCalendarOverviewWindow({ ...range, venue: requested });
  const value = resolvePublicEventVenueFilter(requested, overview.venues);
  return { value, label: overview.venues.find(venue => venue.value === value)?.label, error: overview.error };
}
