import { cleanAgendaText } from "./agenda-layout.ts";
import { formatAgendaDate, getAgendaEventTime, type DailyCarouselEvent } from "./daily-carousel.ts";

export type PublicationContext = {
  publishedCaptions?: string[];
  previouslyPublishedEventIds?: string[];
  excludedEventIds?: string[];
};
export const SOCIAL_SELECTION_POLICY = "prefer_unposted" as const;

function normalize(value: string): string {
  return cleanAgendaText(value, 20_000).replace(/[@#]/g, "").toLocaleLowerCase("sr-Latn");
}
function compact(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
  return result >>> 0;
}

export function getEventPublicationUsage(events: DailyCarouselEvent[], context: PublicationContext) {
  const captions = [...new Set(context.publishedCaptions || [])];
  const remembered = new Set(context.previouslyPublishedEventIds || []);
  const usage = new Map<string, { count: number; lastUseRank: number }>();
  for (const event of events) {
    const dateLabel = normalize(formatAgendaDate(event.date).dateLabel);
    const title = normalize(event.title), venue = normalize(event.venue);
    let count = 0, lastUseRank = Number.MAX_SAFE_INTEGER;
    captions.forEach((caption, rank) => {
      // Restrict a match to its absolute event-date section. A different
      // occurrence of the same programme is still a different event.
      const sections = caption.split(/(?=^(?:Ponedeljak|Utorak|Sreda|Četvrtak|Petak|Subota|Nedelja), \d{1,2}\. [^\n]+ \d{4}\.$)/gmu);
      const matched = sections.some(section => {
        const text = normalize(section);
        return text.includes(dateLabel) && (text.includes(`${compact(title, 85)} ${compact(venue, 50)}`) || text.includes(`${title} — ${venue}`) || text.includes(`${title} ${venue}`) || text.includes(`${title} · ${venue}`));
      });
      if (matched) { count++; lastUseRank = Math.min(lastUseRank, rank); }
    });
    if (!count && remembered.has(event._id)) count = 1;
    usage.set(event._id, { count, lastUseRank });
  }
  return usage;
}

export function selectUnpostedFirstEvents(options: PublicationContext & {
  events: DailyCarouselEvent[]; publishDate: string; eventDates: string[];
  format: "feed" | "story" | "reel"; perDay?: number;
}) {
  const usage = getEventPublicationUsage(options.events, options);
  const excluded = new Set(options.excludedEventIds || []);
  const selected: DailyCarouselEvent[] = [];
  const seenIds = new Set<string>();
  const quota = Math.min(options.format === "feed" ? 3 : 4, Math.max(1, Math.floor(options.perDay || 3)));
  for (const date of [...new Set(options.eventDates)].slice(0, 3)) {
    const candidates = options.events.filter(event => event.date === date && !excluded.has(event._id) &&
      !seenIds.has(event._id) && cleanAgendaText(event.title) && cleanAgendaText(event.venue)).filter(event => {
        seenIds.add(event._id); return true;
      }).sort((left, right) => {
        const a = usage.get(left._id)!, b = usage.get(right._id)!;
        return a.count - b.count || b.lastUseRank - a.lastUseRank ||
          Number(Boolean(getAgendaEventTime(right))) - Number(Boolean(getAgendaEventTime(left))) ||
          hash(`${options.publishDate}:${options.format}:${date}:${left._id}`) - hash(`${options.publishDate}:${options.format}:${date}:${right._id}`) ||
          left._id.localeCompare(right._id);
      });
    const day: DailyCarouselEvent[] = [];
    const venues = new Set<string>();
    const tiers = [...new Set(candidates.map(event => usage.get(event._id)!.count))].sort((a, b) => a - b);
    for (const count of tiers) {
      const tier = candidates.filter(event => usage.get(event._id)!.count === count);
      // All unseen choices, including another venue's second event, precede
      // any repeat. Venue variety is optimized within each usage tier.
      for (const diverse of [true, false]) for (const event of tier) {
        if (day.length >= quota) break;
        const venue = (event.venueId || event.venueInstagramHandle || normalize(event.venue)).toLocaleLowerCase("sr-Latn");
        if (day.some(item => item._id === event._id) || (diverse && venues.has(venue))) continue;
        day.push(event); venues.add(venue);
      }
      if (day.length >= quota) break;
    }
    day.sort((left, right) => (getAgendaEventTime(left) || "99:99").localeCompare(getAgendaEventTime(right) || "99:99") || left._id.localeCompare(right._id));
    selected.push(...day);
  }
  return { selected, previouslyPublishedEventIds: [...usage].filter(([, value]) => value.count > 0).map(([id]) => id).sort(),
    repeatedEventIds: selected.filter(event => usage.get(event._id)!.count > 0).map(event => event._id) };
}

export async function readPublicationContext(request: Request): Promise<PublicationContext> {
  const text = await request.text();
  if (text.length > 1_200_000) throw new Error("Oversized publication context.");
  const body = JSON.parse(text);
  if (!body || !Array.isArray(body.publishedCaptions) || body.publishedCaptions.length > 500 ||
    body.publishedCaptions.some((caption: unknown) => typeof caption !== "string" || caption.length > 2200)) throw new Error("Invalid publication captions.");
  for (const name of ["excludedEventIds", "previouslyPublishedEventIds"]) {
    if (body[name] !== undefined && (!Array.isArray(body[name]) || body[name].length > 1000 ||
      body[name].some((id: unknown) => typeof id !== "string" || !/^[a-z0-9]{10,64}$/.test(id)))) throw new Error("Invalid publication event IDs.");
  }
  return { publishedCaptions: body.publishedCaptions, excludedEventIds: body.excludedEventIds || [], previouslyPublishedEventIds: body.previouslyPublishedEventIds || [] };
}
