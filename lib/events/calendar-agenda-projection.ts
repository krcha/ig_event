import "server-only";
import { getEventPrimaryCategory, getEventTags } from "../taxonomy/event-categories";
import { resolveEventTimePresentation } from "./event-time-presentation";
import { normalizeEventTime } from "./event-time";
import { getCalendarTimeBandKey } from "./calendar-time-bands";
import { getEventSessionLabel } from "./event-session";
import type { CalendarAgendaEvent, CalendarEventSummary } from "./calendar-agenda-types";
import type { OpenNowEventState } from "../venues/venue-open-now";

/** Keep hours JSON, descriptions and source evidence on the server. */
export function projectCalendarAgendaEvents(
  events: readonly CalendarEventSummary[],
  mobileOrder: ReadonlyMap<string, number>,
  states: ReadonlyMap<string, OpenNowEventState>,
): CalendarAgendaEvent[] {
  return events.map(event => {
    const presentation = resolveEventTimePresentation(event);
    const time = normalizeEventTime(event.time);
    const row = { ...event };
    delete row.description;
    delete row.venueHours;
    return {
      ...row,
      category: getEventPrimaryCategory(event),
      tags: getEventTags(event),
      mobileOrder: mobileOrder.get(event._id) ?? 0,
      sessionLabel: getEventSessionLabel(event),
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
