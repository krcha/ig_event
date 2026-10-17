import { getDisplayEventTime, normalizeEventTime, UNKNOWN_EVENT_TIME_LABEL } from "./event-time.ts";
import { getVenueClosingForEventStart } from "../venues/venue-open-now.ts";
import {
  formatVenueHoursWindow,
  getVenueHoursWindowsForDate,
  type VenueHoursCacheFields,
} from "../venues/venue-hours-cache.ts";

type EventTimePresentation = {
  endLabel?: string;
  heading: "Time";
  inferredEnd?: true;
  kind: "event" | "venue_hours" | "unknown";
  label: string;
};

// Display context only: venue hours never become the event's time, sorting key,
// day period, or structured-data start/end time.
export function resolveEventTimePresentation(options: {
  date: string;
  time?: string | null;
  venueHours?: VenueHoursCacheFields | null;
}): EventTimePresentation {
  const eventTime = getDisplayEventTime(options.time);
  if (eventTime) {
    const normalized = normalizeEventTime(options.time);
    const closing = normalized.startLabel && !normalized.endLabel
      ? getVenueClosingForEventStart({
          date: options.date,
          startTime: normalized.startLabel,
          venueHours: options.venueHours,
        })
      : null;
    if (closing) {
      return {
        endLabel: closing.time,
        heading: "Time",
        inferredEnd: true,
        kind: "event",
        label: `${normalized.startLabel}–${closing.time}`,
      };
    }
    return { heading: "Time", kind: "event", label: eventTime };
  }

  const venueHours = getVenueHoursWindowsForDate(options.venueHours, options.date);
  if (venueHours.status === "open") {
    return {
      heading: "Time",
      kind: "venue_hours",
      label: venueHours.windows.map(formatVenueHoursWindow).join(", "),
    };
  }

  return { heading: "Time", kind: "unknown", label: UNKNOWN_EVENT_TIME_LABEL };
}
