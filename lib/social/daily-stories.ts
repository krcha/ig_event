import {
  buildAgendaRenderVersion,
  getAgendaEventDetail,
  getAgendaEventTime,
  getNextIsoDate,
  normalizeInstagramHandle,
  type DailyCarouselEvent,
} from "./daily-carousel.ts";
import { selectUnpostedFirstEvents, SOCIAL_SELECTION_POLICY, type PublicationContext } from "./publication-history.ts";
import { getPosterDesignReceipt, resolvePosterPublicationDate, type PosterDesignReceipt } from "./poster-directions.ts";
import { getPosterTagPositions } from "./poster-layout.ts";

export const STORY_EVENTS_PER_DAY = 4;
export const STORY_DURATION_SECONDS = 18;

export type DailyStoryFrame = {
  kind: "agenda";
  date: string;
  imageUrl: string;
  videoUrl: string;
  mediaType: "VIDEO";
  durationSeconds: number;
  hasClosingCta: true;
  eventIds: string[];
  userTags: { username: string; x: number; y: number }[];
};

export type DailyStoriesPayload = {
  design: PosterDesignReceipt;
  publishDate: string;
  selectionKey: string;
  sourceEventCount: number;
  selectedCount: number;
  frames: DailyStoryFrame[];
  selectionPolicy: typeof SOCIAL_SELECTION_POLICY;
  previouslyPublishedEventIds: string[];
  repeatedEventIds: string[];
  durationSeconds: number;
  hasClosingCta: true;
};

export function isEventAvailableForMorningStory(event: DailyCarouselEvent, date: string): boolean {
  if (event.date !== date) return false;
  const time = getAgendaEventTime(event);
  const announcedStart = time.match(/^(\d{1,2}):(\d{2})(?:\b|\s|\u2013|-)/);
  // Only a confirmed start is evidence that an event has already begun before
  // the scheduled 10:00 publication. Unknown times remain unknown.
  return !announcedStart || Number(announcedStart[1]) * 60 + Number(announcedStart[2]) >= 600;
}

export function buildStoryAgendaRenderVersion(date: string, events: DailyCarouselEvent[], publishDate?: string): string {
  return `s5-${buildAgendaRenderVersion(date, events, 0, resolvePosterPublicationDate(date, 0, "story", publishDate))}`;
}

export function buildDailyStoriesPayload(options: {
  events: DailyCarouselEvent[];
  publishDate: string;
  publicOrigin: string;
} & PublicationContext): DailyStoriesPayload {
  getNextIsoDate(options.publishDate);
  const available = options.events.filter(event => isEventAvailableForMorningStory(event, options.publishDate));
  const selection = selectUnpostedFirstEvents({ ...options, events: available, eventDates: [options.publishDate], format: "story", perDay: STORY_EVENTS_PER_DAY });
  const selected = selection.selected;
  const origin = options.publicOrigin.replace(/\/+$/, "");
  const version = buildStoryAgendaRenderVersion(options.publishDate, selected, options.publishDate);
  const query = new URLSearchParams({ events: selected.map(event => event._id).join(","), v: version, publishDate: options.publishDate });
  const tagPositions = selected.length ? getPosterTagPositions(selected.map(event => ({
    title: event.title, venue: event.venue, time: getAgendaEventTime(event), detail: getAgendaEventDetail(event),
  })), { date: options.publishDate, position: 0, format: "story", publishDate: options.publishDate }) : [];
  const seenHandles = new Set<string>();
  const userTags = selected.flatMap((event, index) => {
    const username = normalizeInstagramHandle(event.venueInstagramHandle);
    if (!username || seenHandles.has(username)) return [];
    seenHandles.add(username);
    return [{ username, ...tagPositions[index] }];
  });
  const frames: DailyStoryFrame[] = selected.length ? [
    { kind: "agenda", date: options.publishDate, eventIds: selected.map(event => event._id), userTags,
      mediaType: "VIDEO", durationSeconds: STORY_DURATION_SECONDS, hasClosingCta: true,
      videoUrl: `${origin}/api/social/stories/days/${options.publishDate}?${query}`,
      imageUrl: `${origin}/api/social/stories/days/${options.publishDate}?${query}&cover=1` },
  ] : [];
  return {
    design: getPosterDesignReceipt(options.publishDate, 0, "story", options.publishDate),
    durationSeconds: STORY_DURATION_SECONDS, hasClosingCta: true,
    selectionPolicy: SOCIAL_SELECTION_POLICY,
    previouslyPublishedEventIds: selection.previouslyPublishedEventIds,
    repeatedEventIds: selection.repeatedEventIds,
    publishDate: options.publishDate,
    selectionKey: `${options.publishDate}:stories:${selected.map(event => event._id).join(",")}@${version}`,
    sourceEventCount: options.events.filter(event => event.date === options.publishDate).length,
    selectedCount: selected.length,
    frames,
  };
}
