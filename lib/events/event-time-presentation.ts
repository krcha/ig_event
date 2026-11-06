import { getDisplayEventTime, normalizeEventTime, UNKNOWN_EVENT_TIME_LABEL } from "./event-time.ts";
import { getVenueClosingForEventStart } from "../venues/venue-open-now.ts";
import { addDaysToDateKey, NIGHTLIFE_BUSINESS_DAY_ROLLOVER_HOUR } from "./nightlife-date.ts";
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
    const previousHours = getVenueHoursWindowsForDate(options.venueHours, addDaysToDateKey(options.date, -1));
    const previousNightReachesMidnight = previousHours.status === "open" && previousHours.windows.some((window) =>
      window.start !== "00:00" && (window.spansNextDay || window.end <= window.start));
    const rolloverTime = `${String(NIGHTLIFE_BUSINESS_DAY_ROLLOVER_HOUR).padStart(2, "0")}:00`;
    const windows = venueHours.windows.filter((window) => !(
      // A civil-day midnight fragment belongs to the preceding night only
      // when that connection and a later, separate opening are both proven.
      previousNightReachesMidnight && window.start === "00:00" && !window.spansNextDay &&
      window.end > "00:00" && window.end <= rolloverTime && venueHours.windows.some((other) =>
        other.start >= rolloverTime && other.start > window.end)
    ));
    const labels = windows.map((window) => {
      // Complete provider ranges keep their exact boundaries. Only a range
      // clipped at midnight needs the next civil day's continuous closing.
      if (window.end !== "00:00" || window.start === "00:00") {
        return formatVenueHoursWindow(window);
      }
      const closing = getVenueClosingForEventStart({ date: options.date, startTime: window.start, venueHours: options.venueHours });
      return closing ? `${window.start}–${closing.time}` : formatVenueHoursWindow(window);
    });
    return {
      heading: "Time",
      kind: "venue_hours",
      label: labels.join(", "),
    };
  }

  return { heading: "Time", kind: "unknown", label: UNKNOWN_EVENT_TIME_LABEL };
}
