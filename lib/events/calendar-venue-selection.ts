import "server-only";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getCalendarConvexUrl } from "./calendar-convex-url";
import { loadPublicCalendarOverviewWindow } from "./public-calendar-overview";
import { resolvePublicEventVenueFilter } from "./public-event-venue-filter";

const publicVenueFieldsQuery = "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;

async function loadVenueLabel(id: string): Promise<string | undefined> {
  const convexUrl = getCalendarConvexUrl();
  if (!convexUrl || !id) return undefined;
  try {
    // One public venue lookup also works on days without events. Never scan the
    // directory or load the venue's event history just to render this label.
    const venues: { _id: string; name: string }[] = await new ConvexHttpClient(convexUrl).query(publicVenueFieldsQuery, { ids: [id] });
    return venues.find(venue => venue._id === id)?.name.trim() || undefined;
  } catch {
    // Invalid, hidden or unavailable IDs keep their filter behavior, while the
    // page can use its already loaded public event name or a readable fallback.
    return undefined;
  }
}

/** ID labels use one bounded public lookup; preserve month-wide legacy aliases. */
export async function resolveCalendarVenueSelection(requested: string | undefined, range: { fromDate: string; beforeDate: string; q?: string }) {
  if (!requested) return { value: requested };
  if (requested.startsWith("id:")) return { value: requested, label: await loadVenueLabel(requested.slice(3)) };
  if (requested.startsWith("name:")) return { value: requested, label: requested.slice(5).trim() || undefined };
  const overview = await loadPublicCalendarOverviewWindow({ ...range, venue: requested });
  const value = resolvePublicEventVenueFilter(requested, overview.venues);
  return { value, label: overview.venues.find(venue => venue.value === value)?.label ?? requested, error: overview.error };
}
