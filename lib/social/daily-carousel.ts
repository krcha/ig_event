const DEFAULT_CAROUSEL_EVENT_LIMIT = 6;
const MAX_CAPTION_EVENT_TITLE_LENGTH = 120;

export const EVENT_ZEKA_PUBLIC_ORIGIN = "https://events.ineedtofeedmyrabbit.com";

export type DailyCarouselEvent = {
  _id: string;
  title: string;
  venue: string;
  date: string;
  time?: string;
  artists?: string[];
  venueInstagramHandle?: string;
};

export type DailyCarouselSlide = {
  kind: "event" | "cta";
  imageUrl: string;
  eventId?: string;
  title?: string;
  venue?: string;
  username?: string;
  userTags?: Array<{
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

function normalizeInstagramHandle(value: string | undefined): string {
  return value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
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
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid carousel date.");
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function rankDailyCarouselEvents(
  events: DailyCarouselEvent[],
  publishDate: string,
  eventDates: string[] = [publishDate],
): DailyCarouselEvent[] {
  const includedDates = new Set(eventDates);
  const ranked = events
    .filter(
      (event) => includedDates.has(event.date) && normalizeInstagramHandle(event.venueInstagramHandle),
    )
    .map((event) => ({
      event: {
        ...event,
        venueInstagramHandle: normalizeInstagramHandle(event.venueInstagramHandle),
      },
      rank: stableHash(`${publishDate}:${event.date}:${event._id}`),
    }))
    .sort((left, right) => left.rank - right.rank || left.event._id.localeCompare(right.event._id));

  const selected: DailyCarouselEvent[] = [];
  const seenVenues = new Set<string>();
  for (const { event } of ranked) {
    const venueKey = normalizeInstagramHandle(event.venueInstagramHandle);
    if (!venueKey || seenVenues.has(venueKey)) {
      continue;
    }
    seenVenues.add(venueKey);
    selected.push(event);
  }
  return selected;
}

export function selectDailyCarouselEvents(
  events: DailyCarouselEvent[],
  publishDate: string,
  limit = DEFAULT_CAROUSEL_EVENT_LIMIT,
  eventDates: string[] = [publishDate],
): DailyCarouselEvent[] {
  const boundedLimit = Math.max(1, Math.min(DEFAULT_CAROUSEL_EVENT_LIMIT, Math.floor(limit)));
  return balanceDailyCarouselEvents(
    rankDailyCarouselEvents(events, publishDate, eventDates),
    eventDates,
    boundedLimit,
  );
}

export function balanceDailyCarouselEvents(
  rankedEvents: DailyCarouselEvent[],
  eventDates: string[],
  limit = DEFAULT_CAROUSEL_EVENT_LIMIT,
): DailyCarouselEvent[] {
  const boundedLimit = Math.max(1, Math.min(DEFAULT_CAROUSEL_EVENT_LIMIT, Math.floor(limit)));
  const selected: DailyCarouselEvent[] = [];
  const selectedIds = new Set<string>();
  const dateQuota = Math.floor(boundedLimit / Math.max(1, eventDates.length));

  for (const date of eventDates) {
    for (const event of rankedEvents) {
      if (event.date !== date || selectedIds.has(event._id)) {
        continue;
      }
      selected.push(event);
      selectedIds.add(event._id);
      if (selected.filter((candidate) => candidate.date === date).length >= dateQuota) {
        break;
      }
    }
  }

  for (const event of rankedEvents) {
    if (!selectedIds.has(event._id)) {
      selected.push(event);
      selectedIds.add(event._id);
    }
    if (selected.length >= boundedLimit) {
      break;
    }
  }
  return selected.slice(0, boundedLimit);
}

function compactCaptionText(value: string, maxLength = MAX_CAPTION_EVENT_TITLE_LENGTH): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function displayEventTime(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.toUpperCase() === "TBD") {
    return "";
  }
  return `${normalized} — `;
}

function displayEventDay(date: string, eventDates: string[]): string {
  if (date === eventDates[0]) {
    return "SUTRA";
  }
  if (date === eventDates[1]) {
    return "PREKOSUTRA";
  }
  return date;
}

export function buildDailyCarouselCaption(
  selectedEvents: DailyCarouselEvent[],
  publicOrigin = EVENT_ZEKA_PUBLIC_ORIGIN,
  eventDates: string[] = [],
): string {
  if (selectedEvents.length === 0) {
    return "";
  }

  const entries = selectedEvents.map((event, index) => {
    const handle = normalizeInstagramHandle(event.venueInstagramHandle);
    const day = displayEventDay(event.date, eventDates);
    return `${index + 1}. ${day} • ${displayEventTime(event.time)}${compactCaptionText(event.title)}\n@${handle}`;
  });

  return [
    "Beograde, plan za sutra i prekosutra 🐇",
    "",
    `Izdvajamo ${selectedEvents.length} događaja na ${selectedEvents.length} različitih mesta:`,
    "",
    ...entries.flatMap((entry) => [entry, ""]),
    "Sve događaje, detalje i još predloga pronađi na:",
    publicOrigin.replace(/^https?:\/\//, ""),
    "",
    "Zeka zna gde se ide. 💜",
    "",
    "#EventZeka #GdeSutra #Beograd #DesavanjaBeograd #BeogradskiDogadjaji",
  ].join("\n");
}

export function buildDailyCarouselPayload(options: {
  events: DailyCarouselEvent[];
  publishDate: string;
  eventDates?: string[];
  publicOrigin: string;
  selectedEvents?: DailyCarouselEvent[];
}): DailyCarouselPayload {
  const eventDates = options.eventDates ?? [options.publishDate];
  const selected = options.selectedEvents
    ? options.selectedEvents.slice(0, DEFAULT_CAROUSEL_EVENT_LIMIT)
    : selectDailyCarouselEvents(
        options.events,
        options.publishDate,
        DEFAULT_CAROUSEL_EVENT_LIMIT,
        eventDates,
      );
  const eventSlides: DailyCarouselSlide[] = selected.map((event) => {
    const username = normalizeInstagramHandle(event.venueInstagramHandle);
    return {
      kind: "event",
      eventId: event._id,
      title: event.title,
      venue: event.venue,
      username,
      imageUrl: `${options.publicOrigin}/api/social/carousel/events/${encodeURIComponent(event._id)}`,
      userTags: [{ username, x: 0.5, y: 0.82 }],
    };
  });
  const slides = selected.length
    ? [
        ...eventSlides,
        {
          kind: "cta" as const,
          imageUrl: `${options.publicOrigin}/api/social/carousel/cta`,
        },
      ]
    : [];

  return {
    publishDate: options.publishDate,
    eventDates,
    selectionKey: `${options.publishDate}:${eventDates.join("+")}:${selected.map((event) => event._id).join(",")}`,
    sourceEventCount: options.events.length,
    selectedCount: selected.length,
    caption: buildDailyCarouselCaption(selected, options.publicOrigin, eventDates),
    slides,
  };
}
