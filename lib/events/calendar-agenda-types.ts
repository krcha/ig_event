import type { PublicEvent } from "./public-events";
import type { EventPrimaryCategory } from "../taxonomy/event-categories";
import type { OpenNowEventState } from "../venues/venue-open-now";
import type { CalendarTimeBandKey } from "./calendar-time-bands";

export type CalendarEventSummary = Pick<PublicEvent,
  "_id" | "title" | "description" | "date" | "time" | "timeStatus" | "dayPeriod" |
  "displayTimeEnd" | "displayTimeLabel" | "displayTimeSource" | "displayTimeStart" |
  "venue" | "venueId" | "venueCategory" | "venueHours" | "artists" | "eventType" |
  "ticketPrice" | "attendance" | "attendanceCount" | "attendeeCount" | "attendees" |
  "attendeesCount" | "going" | "goingCount"
>;

export type CalendarAgendaEvent = Omit<CalendarEventSummary, "description" | "venueHours"> & {
  category: EventPrimaryCategory;
  tags: string[];
  mobileOrder: number;
  sessionLabel: string | null;
  band: CalendarTimeBandKey;
  presentation: {
    kind: "event" | "venue_hours" | "unknown";
    label: string;
    endLabel?: string;
    inferredEnd?: true;
  };
  timeParts: { startLabel?: string; endLabel?: string };
  openNowState?: OpenNowEventState;
};
