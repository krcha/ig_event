import type { PublicEvent } from "./public-events";
import type { EventPrimaryCategory } from "../taxonomy/event-categories";
import type { EventDiscoveryTaxonomy } from "../taxonomy/event-discovery";
import type { OpenNowEventState } from "../venues/venue-open-now";
import type { CalendarTimeBandKey } from "./calendar-time-bands";

export type CalendarEventSummary = Pick<PublicEvent,
  "_id" | "title" | "description" | "date" | "time" | "timeStatus" | "dayPeriod" |
  "displayTimeEnd" | "displayTimeLabel" | "displayTimeSource" | "displayTimeStart" |
  "venue" | "venueId" | "venueCategory" | "venueHours" | "venueInstagramFollowerCount" | "venueLatitude" | "venueLongitude" | "artists" | "eventType" |
  "ticketPrice" | "attendance" | "attendanceCount" | "attendeeCount" | "attendees" |
  "attendeesCount" | "going" | "goingCount" | "eventTaxonomy" | "timeEvidenceKind"
>;

export type CalendarAgendaEvent = Omit<CalendarEventSummary, "description" | "venueHours" | "venueInstagramFollowerCount"> & {
  eventTaxonomy: EventDiscoveryTaxonomy;
  category: EventPrimaryCategory;
  tags: string[];
  mobileOrder: number;
  sessionLabel: string | null;
  venueHoursLabel: string | null;
  band: CalendarTimeBandKey;
  presentation: {
    kind: "event" | "unknown";
    label: string;
    endLabel?: string;
    inferredEnd?: true;
  };
  timeParts: { startLabel?: string; endLabel?: string };
  openNowState?: OpenNowEventState;
};
