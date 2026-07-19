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
): DailyCarouselEvent[] {
  const ranked = events
    .filter((event) => event.date === publishDate && normalizeInstagramHandle(event.venueInstagramHandle))
    .map((event) => ({
      event: {
        ...event,
        venueInstagramHandle: normalizeInstagramHandle(event.venueInstagramHandle),
      },
      rank: stableHash(`${publishDate}:${event._id}`),
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
): DailyCarouselEvent[] {
  const boundedLimit = Math.max(1, Math.min(DEFAULT_CAROUSEL_EVENT_LIMIT, Math.floor(limit)));
  return rankDailyCarouselEvents(events, publishDate).slice(0, boundedLimit);
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

export function buildDailyCarouselCaption(
  selectedEvents: DailyCarouselEvent[],
  publicOrigin = EVENT_ZEKA_PUBLIC_ORIGIN,
): string {
  if (selectedEvents.length === 0) {
    return "";
  }

  const entries = selectedEvents.map((event, index) => {
    const handle = normalizeInstagramHandle(event.venueInstagramHandle);
    return `${index + 1}. ${displayEventTime(event.time)}${compactCaptionText(event.title)}\n@${handle}`;
  });

  return [
    "Beograde, gde ćemo danas? 🐇",
    "",
    `Danas izdvajamo ${selectedEvents.length} događaja na ${selectedEvents.length} različitih mesta:`,
    "",
    ...entries.flatMap((entry) => [entry, ""]),
    "Sve događaje, detalje i još predloga pronađi na:",
    publicOrigin.replace(/^https?:\/\//, ""),
    "",
    "Zeka zna gde se ide. 💜",
    "",
    "#EventZeka #GdeDanas #Beograd #DesavanjaBeograd #BeogradskiDogadjaji",
  ].join("\n");
}

export function buildDailyCarouselPayload(options: {
  events: DailyCarouselEvent[];
  publishDate: string;
  publicOrigin: string;
  selectedEvents?: DailyCarouselEvent[];
}): DailyCarouselPayload {
  const selected = options.selectedEvents
    ? options.selectedEvents.slice(0, DEFAULT_CAROUSEL_EVENT_LIMIT)
    : selectDailyCarouselEvents(options.events, options.publishDate);
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
    selectionKey: `${options.publishDate}:${selected.map((event) => event._id).join(",")}`,
    sourceEventCount: options.events.length,
    selectedCount: selected.length,
    caption: buildDailyCarouselCaption(selected, options.publicOrigin),
    slides,
  };
}
