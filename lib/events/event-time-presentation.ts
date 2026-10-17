import { getDisplayEventTime, UNKNOWN_EVENT_TIME_LABEL } from "./event-time.ts";
import {
  formatVenueHoursWindow,
  getVenueHoursWindowsForDate,
  type VenueHoursCacheFields,
} from "../venues/venue-hours-cache.ts";

type EventTimePresentation = {
  heading: "Time" | "Venue hours";
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
    return { heading: "Time", kind: "event", label: eventTime };
  }

  const venueHours = getVenueHoursWindowsForDate(options.venueHours, options.date);
  if (venueHours.status === "open") {
    return {
      heading: "Venue hours",
      kind: "venue_hours",
      label: venueHours.windows.map(formatVenueHoursWindow).join(", "),
    };
  }

  return { heading: "Time", kind: "unknown", label: UNKNOWN_EVENT_TIME_LABEL };
}
