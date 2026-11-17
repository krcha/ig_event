import { resolveEventTimePresentation } from "../events/event-time-presentation";
import type { PublicEvent } from "../events/public-events";
import { getEventPrimaryCategory, getEventTags, type EventPrimaryCategory } from "../taxonomy/event-categories";

export type MobileDiscoverEvent = {
  _id: string;
  date: string;
  title: string;
  venue: string;
  venueLatitude?: number;
  venueLongitude?: number;
  ticketPrice?: string;
  primaryCategory: EventPrimaryCategory;
  tags: string[];
  timeLabel: string;
  imageVersion?: string | number;
};

export function projectMobileDiscoverEvent(event: PublicEvent): MobileDiscoverEvent {
  const tags = getEventTags(event).filter(tag=>tag.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase().trim() !== "besplatan ulaz").slice(0,2);
  return {
    _id:event._id,
    date:event.date,
    title:event.title,
    venue:event.venue,
    ...(event.venueLatitude !== undefined ? {venueLatitude:event.venueLatitude} : {}),
    ...(event.venueLongitude !== undefined ? {venueLongitude:event.venueLongitude} : {}),
    ...(event.ticketPrice ? {ticketPrice:event.ticketPrice} : {}),
    primaryCategory:getEventPrimaryCategory(event),
    tags,
    timeLabel:resolveEventTimePresentation({date:event.date,time:event.time,venueHours:event.venueHours}).label,
    ...(event.imageStorageId || event.updatedAt ? {imageVersion:event.imageStorageId || event.updatedAt} : {}),
  };
}
