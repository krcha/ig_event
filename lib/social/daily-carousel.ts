import { getDisplayEventTime, type EventTimeSource, type EventTimeStatus } from "../events/event-time.ts";
import { getAgendaTagPositions } from "./agenda-layout.ts";

export const AGENDA_EVENTS_PER_DAY = 3;
const DEFAULT_CAROUSEL_EVENT_LIMIT = AGENDA_EVENTS_PER_DAY * 3;
const MAX_INSTAGRAM_CAPTION_LENGTH = 2_200;
const CAROUSEL_RENDER_VERSION = "5-agenda";
const INSTAGRAM_HANDLE_PATTERN = /^(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const SERBIAN_WEEKDAYS = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"];
const SERBIAN_MONTHS = ["januara", "februara", "marta", "aprila", "maja", "juna", "jula", "avgusta", "septembra", "oktobra", "novembra", "decembra"];

export const EVENT_ZEKA_PUBLIC_ORIGIN = "https://eventzeka.com";

export type DailyCarouselEvent = {
  _id: string;
  title: string;
  venue: string;
  venueId?: string;
  date: string;
  time?: string;
  timeSource?: EventTimeSource;
  timeStatus?: EventTimeStatus;
  artists?: string[];
  eventType?: string;
  ticketPrice?: string;
  description?: string;
  venueInstagramHandle?: string;
};

export type DailyCarouselSlide = {
  kind: "agenda";
  date: string;
  eventIds: string[];
  position: number;
  imageUrl: string;
  userTags: Array<{
    username: string;
    x: number;
    y: number;
  }>;
};

export type DailyCarouselPayload = {
  publishDate: string;
  eventDates: string[];
  selectionKey: string;
  sourceEventCount: number;
  selectedCount: number;
  caption: string;
  slides: DailyCarouselSlide[];
};

export function normalizeInstagramHandle(value: string | undefined): string {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  return INSTAGRAM_HANDLE_PATTERN.test(normalized) ? normalized : "";
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getBelgradeDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getNextIsoDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Invalid carousel date.");
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) throw new Error("Invalid carousel date.");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function getUpcomingAgendaDates(publishDate: string): string[] {
  const tomorrow = getNextIsoDate(publishDate);
  const dayAfterTomorrow = getNextIsoDate(tomorrow);
  return [tomorrow, dayAfterTomorrow, getNextIsoDate(dayAfterTomorrow)];
}

export function formatAgendaDate(date: string): { weekday: string; dateLabel: string } {
  getNextIsoDate(date);
  const parsed = new Date(`${date}T12:00:00Z`);
  return {
    weekday: SERBIAN_WEEKDAYS[parsed.getUTCDay()],
    dateLabel: `${parsed.getUTCDate()}. ${SERBIAN_MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}.`,
  };
}

function cleanText(value: string): string {
  return value
    .replace(UNSAFE_TEXT_PATTERN, "")
    .replace(/[@#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

function compactText(value: string, maxLength: number): string {
  const compact = cleanText(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getAgendaEventTime(event: DailyCarouselEvent): string {
  // Legacy approved records may lack provenance. Explicitly inferred/unknown
  // times never become an announced start time on the social poster.
  if (event.timeStatus === "inferred" || event.timeStatus === "unknown" || event.timeSource === "model" || event.timeSource === "unknown") return "";
  const time = event.time?.replace(UNSAFE_TEXT_PATTERN, "").trim() ?? "";
  return time.length <= 72 ? getDisplayEventTime(time) ?? "" : "";
}

export function getAgendaEventDetail(event: DailyCarouselEvent): string {
  const title = cleanText(event.title).toLocaleLowerCase("sr-Latn");
  const artists = (event.artists ?? [])
    .map(cleanText)
    .filter((artist) => artist && !title.includes(artist.toLocaleLowerCase("sr-Latn")));
  const lineup = [...new Set(artists)].join(", ");
  const rawPrice = cleanText(event.ticketPrice ?? "")
    .replace(/(?<![\p{L}\p{N}_])suggested donation(?![\p{L}\p{N}_])/giu, "Preporučeni prilog")
    .replace(/(?<![\p{L}\p{N}_])for lecture and party(?![\p{L}\p{N}_])/giu, "za predavanje i žurku")
    .replace(/(?<![\p{L}\p{N}_])for party(?![\p{L}\p{N}_])/giu, "za žurku");
  const price = /^(?:free|free entry|free entrance|besplatno|besplatan ulaz|slobodan ulaz|0(?:\s*(?:rsd|din|eur|€))?)$/iu.test(rawPrice)
    ? "Slobodan ulaz"
    : /^(?:tba|tbd|unknown|n\/a|nepoznato)$/iu.test(rawPrice) || rawPrice.length > 94 ? "" : rawPrice;
  // Translate known price phrases while preserving every amount and condition:
  // a recommended contribution is not a mandatory fee.
  // Descriptions are omitted because the public calendar projection does not
  // contain them; the payload and image route must render identical facts.
  const detail = [lineup, price].filter(Boolean).join(" · ");
  // Optional facts can be omitted; artist names and price conditions stay whole.
  return detail.length <= 94 ? detail : price || (lineup.length <= 94 ? lineup : "");
}

// Retained for already published single-event image URLs.
export function buildEventRenderVersion(event: DailyCarouselEvent): string {
  return stableHash(
    ["3", event._id, event.title, event.venue, event.date, event.time ?? "", normalizeInstagramHandle(event.venueInstagramHandle)].join("\u001F"),
  ).toString(36);
}

export function buildAgendaRenderVersion(date: string, events: DailyCarouselEvent[], position: number): string {
  return stableHash(JSON.stringify({
    version: CAROUSEL_RENDER_VERSION,
    date,
    position,
    events: events.map((event) => ({
      id: event._id,
      title: event.title,
      venue: event.venue,
      date: event.date,
      time: getAgendaEventTime(event),
      detail: getAgendaEventDetail(event),
      handle: normalizeInstagramHandle(event.venueInstagramHandle),
    })),
  })).toString(36);
}

function venueKey(event: DailyCarouselEvent): string {
  return event.venueId || normalizeInstagramHandle(event.venueInstagramHandle) || compactText(event.venue, 200).toLocaleLowerCase("sr-Latn");
}

export function rankDailyCarouselEvents(
  events: DailyCarouselEvent[],
  publishDate: string,
  eventDates: string[] = getUpcomingAgendaDates(publishDate),
): DailyCarouselEvent[] {
  const includedDates = new Set(eventDates);
  const seenIds = new Set<string>();
  return events
    .filter((event) => {
      if (!includedDates.has(event.date) || seenIds.has(event._id)) return false;
      seenIds.add(event._id);
      return Boolean(compactText(event.title, 200) && compactText(event.venue, 200));
    })
    .map((event) => ({ ...event, venueInstagramHandle: normalizeInstagramHandle(event.venueInstagramHandle) }))
    .sort((left, right) =>
      eventDates.indexOf(left.date) - eventDates.indexOf(right.date) ||
      Number(Boolean(getAgendaEventTime(right))) - Number(Boolean(getAgendaEventTime(left))) ||
      stableHash(`${left.date}:${left._id}`) - stableHash(`${right.date}:${right._id}`) ||
      left._id.localeCompare(right._id),
    );
}

export function balanceDailyCarouselEvents(
  rankedEvents: DailyCarouselEvent[],
  eventDates: string[],
  limit = DEFAULT_CAROUSEL_EVENT_LIMIT,
): DailyCarouselEvent[] {
  const dates = [...new Set(eventDates)].slice(0, 3);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(DEFAULT_CAROUSEL_EVENT_LIMIT, Math.floor(limit))) : DEFAULT_CAROUSEL_EVENT_LIMIT;
  const dateQuota = Math.min(AGENDA_EVENTS_PER_DAY, Math.max(1, Math.floor(boundedLimit / Math.max(1, dates.length))));
  const selected: DailyCarouselEvent[] = [];
  const selectedIds = new Set<string>();
  for (const date of dates) {
    const dayEvents = rankedEvents.filter((event) => event.date === date && !selectedIds.has(event._id));
    const daySelection: DailyCarouselEvent[] = [];
    const seenVenues = new Set<string>();
    for (const event of dayEvents) {
      const key = venueKey(event);
      if (seenVenues.has(key)) continue;
      seenVenues.add(key);
      daySelection.push(event);
      if (daySelection.length >= dateQuota) break;
    }
    // Sparse days can still include several genuine events at one venue.
    for (const event of dayEvents) {
      if (daySelection.length >= dateQuota) break;
      if (!daySelection.some((candidate) => candidate._id === event._id)) daySelection.push(event);
    }
    daySelection.sort((left, right) =>
      (getAgendaEventTime(left) || "99:99").localeCompare(getAgendaEventTime(right) || "99:99") ||
      stableHash(`${date}:${left._id}`) - stableHash(`${date}:${right._id}`),
    );
    for (const event of daySelection) {
      selected.push(event);
      selectedIds.add(event._id);
    }
  }
  return selected.slice(0, boundedLimit);
}

export function selectDailyCarouselEvents(
  events: DailyCarouselEvent[],
  publishDate: string,
  limit = DEFAULT_CAROUSEL_EVENT_LIMIT,
  eventDates: string[] = getUpcomingAgendaDates(publishDate),
): DailyCarouselEvent[] {
  return balanceDailyCarouselEvents(rankDailyCarouselEvents(events, publishDate, eventDates), eventDates, limit);
}

export function buildDailyCarouselCaption(
  selectedEvents: DailyCarouselEvent[],
  publicOrigin = EVENT_ZEKA_PUBLIC_ORIGIN,
  eventDates: string[] = [...new Set(selectedEvents.map((event) => event.date))],
): string {
  if (selectedEvents.length === 0) return "";
  const groups = eventDates.flatMap((date) => {
    const events = selectedEvents.filter((event) => event.date === date);
    if (events.length === 0) return [];
    const { weekday, dateLabel } = formatAgendaDate(date);
    return [{ heading: `${weekday}, ${dateLabel}`, entries: events.map((event) => {
      const time = getAgendaEventTime(event);
      const title = compactText(event.title, 85);
      const venue = compactText(event.venue, 50);
      const fullDetail = getAgendaEventDetail(event);
      const priceDetail = getAgendaEventDetail({ ...event, artists: [], eventType: undefined });
      const detail = fullDetail.length > 65 ? (priceDetail.length <= 80 ? priceDetail : "") : fullDetail;
      return { identity: `${time ? `${time} · ` : ""}${title}\n${venue}`, detail };
    }) }];
  });
  const website = publicOrigin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const footer = `Detalji događaja: ${website}`;
  const assemble = () => [...groups.map((group) => [group.heading, ...group.entries.map((entry) =>
    `${entry.identity}${entry.detail ? ` · ${entry.detail}` : ""}`,
  )].join("\n\n")), footer].join("\n\n");
  let caption = assemble();
  const optionalEntries = groups.flatMap((group) => group.entries)
    .filter((entry) => entry.detail)
    .sort((left, right) => right.detail.length - left.detail.length);
  for (const entry of optionalEntries) {
    if (caption.length <= MAX_INSTAGRAM_CAPTION_LENGTH) break;
    entry.detail = "";
    caption = assemble();
  }
  if (caption.length > MAX_INSTAGRAM_CAPTION_LENGTH) {
    throw new Error("Event identities and website exceed the Instagram caption limit.");
  }
  return caption;
}

export function buildDailyCarouselPayload(options: {
  events: DailyCarouselEvent[];
  publishDate: string;
  eventDates?: string[];
  publicOrigin: string;
  selectedEvents?: DailyCarouselEvent[];
}): DailyCarouselPayload {
  const eventDates = [...new Set(options.eventDates ?? getUpcomingAgendaDates(options.publishDate))].slice(0, 3);
  const selected = options.selectedEvents
    ? balanceDailyCarouselEvents(options.selectedEvents, eventDates)
    : selectDailyCarouselEvents(options.events, options.publishDate, DEFAULT_CAROUSEL_EVENT_LIMIT, eventDates);
  const origin = options.publicOrigin.replace(/\/+$/, "");
  const slides: DailyCarouselSlide[] = eventDates.map((date, position) => {
    const dayEvents = selected.filter((event) => event.date === date);
    const renderVersion = buildAgendaRenderVersion(date, dayEvents, position);
    const query = new URLSearchParams({
      events: dayEvents.map((event) => event._id).join(","),
      position: String(position),
      v: renderVersion,
    });
    const tagPositions = dayEvents.length ? getAgendaTagPositions(dayEvents.map((event) => ({
      title: event.title,
      venue: event.venue,
      time: getAgendaEventTime(event),
      detail: getAgendaEventDetail(event),
    }))) : [];
    const seenHandles = new Set<string>();
    return {
      kind: "agenda" as const,
      date,
      eventIds: dayEvents.map((event) => event._id),
      position,
      imageUrl: `${origin}/api/social/carousel/days/${date}?${query.toString()}`,
      userTags: dayEvents.flatMap((event, index) => {
        const username = normalizeInstagramHandle(event.venueInstagramHandle);
        if (!username || seenHandles.has(username)) return [];
        seenHandles.add(username);
        return [{ username, ...tagPositions[index] }];
      }),
    };
  }).filter((slide) => slide.eventIds.length > 0);
  return {
    publishDate: options.publishDate,
    eventDates,
    selectionKey: `${options.publishDate}:${slides.map((slide) => `${slide.date}:${slide.eventIds.join(",")}@${new URL(slide.imageUrl).searchParams.get("v")}`).join("+")}`,
    sourceEventCount: options.events.length,
    selectedCount: selected.length,
    caption: buildDailyCarouselCaption(selected, origin, eventDates),
    slides,
  };
}
