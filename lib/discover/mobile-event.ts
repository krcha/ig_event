import { resolveEventTimePresentation } from "../events/event-time-presentation";
import type { PublicEvent } from "../events/public-events";
import { getEventPrimaryCategory, getEventTags, type EventPrimaryCategory } from "../taxonomy/event-categories";

export type MobileDiscoverEvent = {
  _id: string;
  date: string;
  title: string;
  venue: string;
  ticketPrice?: string;
  primaryCategory: EventPrimaryCategory;
  tags: string[];
  timeLabel: string;
};

export function projectMobileDiscoverEvent(event: PublicEvent): MobileDiscoverEvent {
  const tags = getEventTags(event).filter(tag=>tag.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase().trim() !== "besplatan ulaz").slice(0,2);
  return {
    _id:event._id,
    date:event.date,
    title:event.title,
    venue:event.venue,
    ...(event.ticketPrice ? {ticketPrice:event.ticketPrice} : {}),
    primaryCategory:getEventPrimaryCategory(event),
    tags,
    timeLabel:resolveEventTimePresentation({date:event.date,time:event.time,venueHours:event.venueHours}).label,
  };
}
