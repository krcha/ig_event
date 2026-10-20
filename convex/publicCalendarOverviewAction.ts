import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  buildPublicCalendarOverviewPage,
  type PublicCalendarOverviewEvent,
} from "../lib/events/public-calendar-overview-types";
import { buildPublicCalendarDateWindows } from "../lib/events/public-calendar-windows";
import {
  projectPublicEventVenueDisplay,
  sanitizeVenueLinkedPublicEventFields,
} from "../lib/events/public-event-venue-fields";

type CalendarPage = {
  page: PublicCalendarOverviewEvent[];
  continueCursor: string;
  isDone: boolean;
  rawPageCount: number;
  scanLimitReached: boolean;
};
type PublicVenue = {
  _id: string;
  name: string;
  aliases?: string[];
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
};

const calendarQuery = makeFunctionReference<
  "query",
  { fromDate: string; beforeDate: string; cursor: string | null },
  CalendarPage
>("events:listPublicCalendarEventsWindowPaginated");
const venuesQuery = makeFunctionReference<"query", { ids: string[] }, PublicVenue[]>(
  "venues:listPublicVenueFieldsByIds",
);

/**
 * Additive adapter over the deployed public APIs. Keep source publication,
 * lifecycle, bounds and cursor authority in those existing read-only queries.
 * This module can be shipped without rebuilding ingestion or moderation code.
 */
export const listWindow = action({
  args: {
    fromDate: v.string(),
    beforeDate: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    q: v.optional(v.string()),
    venue: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(v.object({
      date: v.string(),
      category: v.union(
        v.literal("club"), v.literal("live"), v.literal("culture"),
        v.literal("social"), v.literal("event"),
      ),
      venueValue: v.string(),
      count: v.number(),
      legacyVenueMatchCount: v.number(),
    })),
    venues: v.array(v.object({
      value: v.string(),
      label: v.string(),
      names: v.array(v.string()),
      location: v.optional(v.string()),
    })),
    continueCursor: v.string(),
    isDone: v.boolean(),
    rawPageCount: v.number(),
    scanLimitReached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (buildPublicCalendarDateWindows(args.fromDate, args.beforeDate).length !== 1) {
      throw new Error("Public calendar overview window must span 1-45 days using valid YYYY-MM-DD dates.");
    }
    const result = await ctx.runQuery(calendarQuery, {
      fromDate: args.fromDate,
      beforeDate: args.beforeDate,
      cursor: args.cursor ?? null,
    });
    if (result.page.length > 50) throw new Error("Public calendar overview page exceeds its 50-row bound.");
    const ids = [...new Set(result.page.flatMap((event) => event.venueId ? [event.venueId] : []))];
    const venues = ids.length > 0 ? await ctx.runQuery(venuesQuery, { ids }) : [];
    const venuesById = new Map(venues.map((venue) => [venue._id, venue]));
    const events = result.page.map((event) => {
      const venue = event.venueId ? venuesById.get(event.venueId) : undefined;
      return projectPublicEventVenueDisplay(
        sanitizeVenueLinkedPublicEventFields(event, Boolean(venue)),
        venue,
      );
    });
    return {
      ...buildPublicCalendarOverviewPage(events, {
        q: args.q?.trim() || undefined,
        venue: args.venue?.trim() || undefined,
      }),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      rawPageCount: result.rawPageCount,
      scanLimitReached: result.scanLimitReached,
    };
  },
});
