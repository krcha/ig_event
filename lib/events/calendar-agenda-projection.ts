import "server-only";
import { getEventTags } from "../taxonomy/event-categories";
import { DISCOVERY_CATEGORY_TONES, getEventDiscoveryTaxonomy } from "../taxonomy/event-discovery";
import { resolveEventTimePresentation } from "./event-time-presentation";
import { normalizeEventTime } from "./event-time";
import { getCalendarTimeBandKey } from "./calendar-time-bands";
import { getEventSessionLabel } from "./event-session";
import type { CalendarAgendaEvent, CalendarEventSummary } from "./calendar-agenda-types";
import type { OpenNowEventState } from "../venues/venue-open-now";

/** Keep hours JSON, descriptions, follower counts and source evidence on the server. */
export function projectCalendarAgendaEvents(
  events: readonly CalendarEventSummary[],
  mobileOrder: ReadonlyMap<string, number>,
  states: ReadonlyMap<string, OpenNowEventState>,
): CalendarAgendaEvent[] {
  return events.map(event => {
    const presentation = resolveEventTimePresentation(event);
    const hours = resolveEventTimePresentation({ date: event.date, venueHours: event.venueHours });
    const time = normalizeEventTime(event.time);
    const row = { ...event };
    delete row.description;
    delete row.venueHours;
    delete row.venueInstagramFollowerCount;
    const eventTaxonomy = getEventDiscoveryTaxonomy(event);
    return {
      ...row,
      eventTaxonomy,
      category: DISCOVERY_CATEGORY_TONES[eventTaxonomy.primaryCategory],
      tags: getEventTags(event),
      mobileOrder: mobileOrder.get(event._id) ?? 0,
      sessionLabel: getEventSessionLabel(event),
      venueHoursLabel: hours.kind === "venue_hours" ? hours.label : null,
      band: getCalendarTimeBandKey(event),
      presentation,
      timeParts: {
        startLabel: event.displayTimeStart ?? time.startLabel,
        endLabel: event.displayTimeStart ? event.displayTimeEnd ?? presentation.endLabel : time.endLabel ?? presentation.endLabel,
      },
      openNowState: states.get(event._id),
    };
  });
}
