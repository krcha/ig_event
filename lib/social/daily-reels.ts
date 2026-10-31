import {
  AGENDA_EVENTS_PER_DAY, buildAgendaRenderVersion, formatAgendaDate,
  getAgendaEventDetail, getAgendaEventTime, getNextIsoDate,
  selectDailyCarouselEvents, type DailyCarouselEvent,
} from "./daily-carousel.ts";
import { cleanAgendaText } from "./agenda-layout.ts";
import { selectUnpostedFirstEvents, SOCIAL_SELECTION_POLICY, type PublicationContext } from "./publication-history.ts";
import { getPosterDesignReceipt, resolvePosterPublicationDate, type PosterDesignReceipt } from "./poster-directions.ts";

export const REEL_DURATION_SECONDS = 18;
export const REEL_EVENTS_PER_DAY = 4;
export const REEL_LOCATION_NAME = "Belgrade, Serbia";
export type DailyReelPayload = {
  design: PosterDesignReceipt;
  publishDate: string; eventDate: string; selectionKey: string;
  sourceEventCount: number; selectedCount: number; eventIds: string[];
  excludedEventIds: string[]; selectionPolicy: typeof SOCIAL_SELECTION_POLICY;
  previouslyPublishedEventIds: string[]; repeatedEventIds: string[];
  videoUrl: string | null; coverUrl: string | null; caption: string;
  durationSeconds: number; locationName: string; musicMode: "instagram_catalog";
  hasClosingCta: true;
};

export function buildReelRenderVersion(date: string, events: DailyCarouselEvent[], publishDate?: string): string {
  return `r5-${buildAgendaRenderVersion(date, events, 0, resolvePosterPublicationDate(date, 0, "reel", publishDate))}`;
}

export function buildDailyReelPayload(options: {
  events: DailyCarouselEvent[]; publishDate: string; publicOrigin: string;
} & PublicationContext): DailyReelPayload {
  const eventDate = getNextIsoDate(options.publishDate);
  const excluded = new Set(options.excludedEventIds || []);
  // A credential-free preview reserves the planned feed choices. Live runs
  // use actual published history instead of reserving an already obsolete plan.
  const reserved = options.publishedCaptions === undefined
    ? selectDailyCarouselEvents(options.events, options.publishDate, AGENDA_EVENTS_PER_DAY, [eventDate]).map(event => event._id) : [];
  const selection = selectUnpostedFirstEvents({ ...options, previouslyPublishedEventIds: [...(options.previouslyPublishedEventIds || []), ...reserved],
    events: options.events, publishDate: options.publishDate, eventDates: [eventDate], format: "reel", perDay: REEL_EVENTS_PER_DAY });
  const selected = selection.selected;
  const origin = options.publicOrigin.replace(/\/+$/, "");
  const eventIds = selected.map(event => event._id);
  const version = buildReelRenderVersion(eventDate, selected, options.publishDate);
  const query = new URLSearchParams({ events: eventIds.join(","), v: version, publishDate: options.publishDate });
  const date = formatAgendaDate(eventDate);
  const leads = ["Sutra u Beogradu.", "Evo šta se sprema za sutra.", "Sutrašnji raspored je tu.", "Za sutra smo izdvojili ove adrese.", "Sačuvaj satnice za sutra.", "Prosledi ekipi za sutra.", "Nekoliko predloga za sutra."];
  const lead = leads[Number(options.publishDate.replaceAll("-", "")) % leads.length];
  const assemble = (includeDetail: boolean) => [
    lead, `${date.weekday}, ${date.dateLabel}`,
    ...selected.map(event => [
      [getAgendaEventTime(event) || "Satnica nije objavljena", cleanAgendaText(event.title), cleanAgendaText(event.venue)].join(" · "),
      includeDetail ? getAgendaEventDetail(event) : "",
    ].filter(Boolean).join("\n")),
    "Jo\u0161 doga\u0111aja: eventzeka.com.",
  ].join("\n\n");
  let caption = selected.length ? assemble(true) : "";
  if (caption.length > 2200) caption = assemble(false);
  if (caption.length > 2200) throw new Error("Complete Reel event identities exceed the caption limit.");
  return {
    design: getPosterDesignReceipt(eventDate, 0, "reel", options.publishDate),
    publishDate: options.publishDate, eventDate,
    selectionKey: `${options.publishDate}:reel:${eventDate}:${eventIds.join(",")}@${version}`,
    sourceEventCount: options.events.filter(event => event.date === eventDate).length,
    excludedEventIds: [...excluded].sort(), selectionPolicy: SOCIAL_SELECTION_POLICY,
    previouslyPublishedEventIds: selection.previouslyPublishedEventIds, repeatedEventIds: selection.repeatedEventIds,
    selectedCount: selected.length, eventIds,
    videoUrl: selected.length ? `${origin}/api/social/reels/days/${eventDate}?${query}` : null,
    coverUrl: selected.length ? `${origin}/api/social/reels/days/${eventDate}?${query}&cover=1` : null,
    caption, durationSeconds: REEL_DURATION_SECONDS, hasClosingCta: true, locationName: REEL_LOCATION_NAME, musicMode: "instagram_catalog",
  };
}
