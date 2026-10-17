import { getVenueCoordinates } from "../venues/coordinates.ts";
import { getEventAgeRange } from "../events/event-session.ts";
import {
  parseVenueHoursJson,
  type VenueHoursCacheFields,
} from "../venues/venue-hours-cache.ts";

export const SITE_NAME = "Event Zeka";
export const SITE_ORIGIN = "https://eventzeka.com";
export const SITE_INSTAGRAM_URL = "https://www.instagram.com/eventzeka/";
export const SITE_DESCRIPTION =
  "Dešavanja u Beogradu danas i za vikend: pronađite žurke, koncerte, kvizove i izložbe. Izaberite datum i saznajte gde da izađete.";
export const BELGRADE_TIME_ZONE = "Europe/Belgrade";

export const HOME_FAQ_ITEMS = [
  {
    question: "What events can I find on Event Zeka?",
    answer:
      "Find club nights, concerts, exhibitions, theatre, and other events in Belgrade. Choose a date in the calendar to see what's on.",
  },
  {
    question: "Is Event Zeka useful for tourists visiting Belgrade?",
    answer:
      "Yes. The calendar is in English and includes dates, announced times, venues, locations, artists, ticket details when available, and links to the original Instagram source.",
  },
  {
    question: "Kako da pronađem događaje u Beogradu?",
    answer:
      "Izaberite datum u kalendaru, pretražite naziv događaja, izvođača ili mesto, a zatim otvorite detalje i originalnu Instagram objavu.",
  },
] as const;

type EventStructuredDataInput = {
  _id: string;
  artists: string[];
  date: string;
  description?: string;
  eventType: string;
  imageUrl?: string;
  ticketPrice?: string;
  time?: string;
  timeStatus?: "confirmed" | "inferred" | "unknown" | null;
  title: string;
  venue: string;
  venueId?: string;
  venueHours?: VenueHoursCacheFields | null;
  venueLatitude?: number;
  venueLocation?: string;
  venueLongitude?: number;
};

type VenueStructuredDataInput = VenueHoursCacheFields & {
  _id: string;
  category?: string | null;
  instagramHandle: string;
  instagramProfileUrl?: string | null;
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
  name: string;
  neighborhood?: string | null;
};

type OpeningHoursSpecification = {
  "@type": "OpeningHoursSpecification";
  dayOfWeek: string;
  opens: string;
  closes: string;
};

type EventStructuredData = {
  "@context": "https://schema.org";
  "@id": string;
  "@type": "Event";
  description: string;
  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode";
  eventStatus: "https://schema.org/EventScheduled";
  image?: string[];
  inLanguage: string[];
  isAccessibleForFree?: true;
  keywords: string;
  location: {
    "@type": "Place";
    "@id"?: string;
    url?: string;
    hasMap?: string;
    address: {
      "@type": "PostalAddress";
      addressCountry: "RS";
      addressLocality: "Belgrade";
      streetAddress?: string;
    };
    geo?: {
      "@type": "GeoCoordinates";
      latitude: number;
      longitude: number;
    };
    name: string;
    openingHoursSpecification?: OpeningHoursSpecification[];
  };
  name: string;
  performer?: Array<{ "@type": "Person"; name: string }>;
  startDate: string;
  endDate?: string;
  typicalAgeRange?: string;
  url: string;
};

type VenueStructuredData = {
  "@context": "https://schema.org";
  "@id": string;
  "@type": "LocalBusiness";
  address: {
    "@type": "PostalAddress";
    addressCountry: "RS";
    addressLocality: "Belgrade";
    addressRegion?: string;
    streetAddress?: string;
  };
  areaServed: {
    "@type": "City";
    name: "Belgrade";
  };
  description: string;
  geo?: {
    "@type": "GeoCoordinates";
    latitude: number;
    longitude: number;
  };
  hasMap: string;
  name: string;
  openingHoursSpecification?: OpeningHoursSpecification[];
  sameAs?: string[];
  url: string;
};

type HomeStructuredEvent = {
  _id: string;
  date: string;
  title: string;
  venue: string;
};

type VenueDirectoryStructuredItem = {
  _id: string;
  name: string;
};

export function absoluteUrl(path = "/"): string {
  return new URL(path, SITE_ORIGIN).toString();
}

export function clipText(value: string | null | undefined, maxLength: number): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const clipped = normalized.slice(0, Math.max(0, maxLength - 1));
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace >= Math.floor(maxLength * 0.7) ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

function parseEventTime(value: string | null | undefined): {
  start: string;
  end?: string;
} | null {
  const match = value
    ?.trim()
    .match(/^([01]?\d|2[0-3]):([0-5]\d)(?:\s*[-–—]\s*([01]?\d|2[0-3]):([0-5]\d))?$/);
  if (!match) {
    return null;
  }

  return {
    start: `${match[1].padStart(2, "0")}:${match[2]}`,
    ...(match[3] ? { end: `${match[3].padStart(2, "0")}:${match[4]}` } : {}),
  };
}

function isValidEventDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const belgradeDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: BELGRADE_TIME_ZONE,
  timeZoneName: "longOffset",
});

function getBelgradeUtcOffsets(date: string, time: string): string[] {
  const wallClockTimestamp = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(wallClockTimestamp)) {
    return [];
  }

  // Check both sides of a clock change, then round-trip each candidate instant.
  // An offset sampled at noon can differ from an event earlier that same day.
  const candidateOffsets = new Set<string>();
  for (const dayOffset of [-1, 0, 1]) {
    const offsetPart = belgradeDateTimeFormatter
      .formatToParts(new Date(wallClockTimestamp + dayOffset * 86_400_000))
      .find((part) => part.type === "timeZoneName")?.value;
    const offset = offsetPart?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
    if (offset) {
      candidateOffsets.add(offset);
    }
  }

  return [...candidateOffsets].filter((offset) => {
    const candidate = new Date(`${date}T${time}:00${offset}`);
    const parts = Object.fromEntries(
      belgradeDateTimeFormatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}` === date &&
      `${parts.hour}:${parts.minute}` === time;
  });
}

export function buildEventStartDate(date: string, time?: string): string | null {
  if (!isValidEventDate(date)) {
    return null;
  }
  const normalizedTime = parseEventTime(time)?.start;
  if (!normalizedTime) {
    return date;
  }

  const offsets = getBelgradeUtcOffsets(date, normalizedTime);
  if (offsets.length === 0) {
    // A clock in the spring DST gap cannot identify a real event instant.
    return date;
  }

  // The repeated autumn hour has two valid offsets. Keep the announced local
  // clock without selecting a UTC instant that the source did not identify.
  return `${date}T${normalizedTime}:00${offsets.length === 1 ? offsets[0] : ""}`;
}

function buildEventEndDate(date: string, time?: string): string | null {
  const range = parseEventTime(time);
  if (!range?.end || !isValidEventDate(date)) return null;
  const startDate = buildEventStartDate(date, range.start);
  if (!startDate?.includes("T")) return null;
  const start = readClockMinutes(range.start);
  const end = readClockMinutes(range.end);
  if (start === end) return null;
  // During the repeated autumn hour a lower closing clock can refer to the
  // second occurrence of that hour or to tomorrow. The source does not decide.
  if (end < start && getBelgradeUtcOffsets(date, range.start).length > 1 &&
    getBelgradeUtcOffsets(date, range.end).length > 1) return null;
  const dayTimestamp = Date.parse(`${date}T00:00:00Z`);
  const endDay = end < start
    ? new Date(dayTimestamp + 86_400_000).toISOString().slice(0, 10)
    : date;
  const value = buildEventStartDate(endDay, range.end);
  return value?.includes("T") ? value : null;
}

function readClockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

const SCHEMA_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Publish sourced weekly place hours separately from an event's announced time. */
export function buildVenueOpeningHoursSpecification(
  venueHours: VenueHoursCacheFields | null | undefined,
): OpeningHoursSpecification[] {
  const hours = parseVenueHoursJson(venueHours?.hoursJson);
  if (!hours || hours.source === "none" || venueHours?.hoursSource === "none" ||
    hours.timezone !== BELGRADE_TIME_ZONE ||
    (venueHours?.hoursSource && venueHours.hoursSource !== hours.source) ||
    (venueHours?.hoursTimezone && venueHours.hoursTimezone !== BELGRADE_TIME_ZONE)) {
    return [];
  }
  // The shared display parser can discard malformed entries. Do not turn a
  // partly unreadable source schedule into an assertion of complete hours.
  const raw = JSON.parse(venueHours!.hoursJson!) as {
    timezone?: unknown;
    weekly?: Array<{ closed?: unknown; day?: unknown; windows?: Array<{
      day?: unknown; start?: unknown; end?: unknown; spansNextDay?: unknown;
    }> }>;
  };
  if (raw.timezone !== BELGRADE_TIME_ZONE || !Array.isArray(raw.weekly) ||
    raw.weekly.length !== hours.weekly.length ||
    raw.weekly.some((day, index) =>
      !day || typeof day.closed !== "boolean" || !Array.isArray(day.windows) ||
      day.windows.length !== hours.weekly[index].windows.length ||
      day.windows.some((window) => window?.spansNextDay !== undefined &&
        typeof window.spansNextDay !== "boolean"))) return [];
  // A conflicting day can affect the next day's overnight carry too; omit the
  // whole schedule instead of declaring that next day closed from partial data.
  if (new Set(hours.weekly.map((day) => day.day)).size !== hours.weekly.length ||
    hours.weekly.some((day) => day.windows.some((window) => window.day !== day.day) ||
      (day.closed && day.windows.length > 0))) return [];

  const specifications: OpeningHoursSpecification[] = [];
  const carryDays = new Set<number>();
  const closedDays: number[] = [];
  const append = (day: number, opens: string, closes: string) => {
    specifications.push({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: `https://schema.org/${SCHEMA_WEEKDAYS[day]}`,
      opens,
      closes,
    });
  };
  for (const day of hours.weekly) {
    // Missing days remain unknown, rather than closed.
    if (day.closed) {
      closedDays.push(day.day);
      continue;
    }
    for (const window of day.windows) {
      const start = readClockMinutes(window.start);
      const end = readClockMinutes(window.end);
      const overnight = window.spansNextDay === true || end <= start;
      const nextDay = (day.day + 1) % 7;
      if (overnight && end > 0) carryDays.add(nextDay);
      if (start === 0 && end === 0) {
        // Google's all-day convention avoids the 00:00/00:00 closed sentinel.
        append(day.day, "00:00", "23:59");
      } else if (overnight && end >= start) {
        // Equal clocks or an explicit >24h period cannot be encoded as one
        // same-day schema range; retain the two portions at midnight.
        append(day.day, window.start, start === 0 ? "23:59" : "00:00");
        append(nextDay, "00:00", window.end);
      } else {
        // A closing clock before opening is Schema.org's overnight notation.
        append(day.day, window.start, window.end);
      }
    }
  }
  for (const day of closedDays) {
    // Source "closed" can mean no session starts that day. An earlier night's
    // continuing session must not also be marked as closed for the whole day.
    if (!carryDays.has(day)) append(day, "00:00", "00:00");
  }
  return specifications.filter((entry, index) => specifications.findIndex((candidate) =>
    candidate.dayOfWeek === entry.dayOfWeek && candidate.opens === entry.opens &&
    candidate.closes === entry.closes) === index);
}

function isExplicitlyFree(ticketPrice: string | null | undefined): boolean {
  const normalized = ticketPrice?.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "") ?? "";
  // A conditional or negated price must not describe the whole event as free.
  return /^(?:free(?: (?:entry|admission))?|(?:entry|admission)(?: is)? free|besplatan(?: ulaz)?|besplatno|slobodan ulaz|ulaz(?: je)? (?:besplatan|slobodan))$/i.test(normalized);
}

function getStreetAddress(location: string | null | undefined): string | null {
  const trimmed = location?.trim();
  if (
    !trimmed ||
    /^(?:belgrade|beograd|београд)(?:,\s*(?:serbia|srbija|србија|rs))?$/iu.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

export function buildEventStructuredData(
  event: EventStructuredDataInput,
): EventStructuredData | null {
  // A display fallback (venue hours or assumed venue closing) is not an
  // announcement of this event's start/end. Legacy untagged times stay usable.
  const announcedTime = event.timeStatus === "unknown" || event.timeStatus === "inferred"
    ? undefined
    : event.time;
  const startDate = buildEventStartDate(event.date, announcedTime);
  if (!startDate) return null;
  const url = absoluteUrl(`/events/${event._id}`);
  const streetAddress = getStreetAddress(event.venueLocation);
  const coordinates = getVenueCoordinates(event.venueLatitude, event.venueLongitude);
  const venueUrl = event.venueId ? absoluteUrl(`/venues/${event.venueId}`) : null;
  const openingHoursSpecification = buildVenueOpeningHoursSpecification(event.venueHours);
  const location: EventStructuredData["location"] = {
    "@type": "Place",
    ...(venueUrl ? { "@id": `${venueUrl}#place`, url: venueUrl } : {}),
    address: {
      "@type": "PostalAddress",
      addressCountry: "RS",
      addressLocality: "Belgrade",
      ...(streetAddress ? { streetAddress } : {}),
    },
    ...(coordinates
      ? {
          geo: {
            "@type": "GeoCoordinates" as const,
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
          },
          hasMap: `https://www.google.com/maps/search/?api=1&query=${coordinates.latitude},${coordinates.longitude}`,
        }
      : {}),
    name: event.venue,
    ...(openingHoursSpecification.length ? { openingHoursSpecification } : {}),
  };
  const description =
    clipText(event.description, 400) ||
    `${event.title} at ${event.venue} in Belgrade on ${event.date}.`;
  const accessibleForFree = isExplicitlyFree(event.ticketPrice);
  const ageRange = getEventAgeRange(event);
  const endDate = buildEventEndDate(event.date, announcedTime);

  return {
    "@context": "https://schema.org",
    "@id": `${url}#event`,
    "@type": "Event",
    description,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    ...(event.imageUrl ? { image: [absoluteUrl(event.imageUrl)] } : {}),
    inLanguage: ["en-RS", "sr-Latn-RS"],
    ...(accessibleForFree ? { isAccessibleForFree: true as const } : {}),
    keywords: [event.eventType, ...event.artists, "Belgrade events"].filter(Boolean).join(", "),
    location,
    name: event.title,
    ...(event.artists.length > 0
      ? {
          performer: event.artists.map((artist) => ({
            "@type": "Person" as const,
            name: artist,
          })),
        }
      : {}),
    startDate,
    ...(endDate ? { endDate } : {}),
    ...(ageRange ? { typicalAgeRange: ageRange } : {}),
    url,
  };
}

export function buildVenueStructuredData(
  venue: VenueStructuredDataInput,
): VenueStructuredData {
  const locationLabel = venue.location?.trim() || "Belgrade";
  const streetAddress = getStreetAddress(venue.location);
  const mapsQuery = [venue.name, locationLabel].filter(Boolean).join(" ");
  const coordinates = getVenueCoordinates(venue.latitude, venue.longitude);
  const url = absoluteUrl(`/venues/${venue._id}`);
  const openingHoursSpecification = buildVenueOpeningHoursSpecification(venue);
  const instagramUrl =
    venue.instagramProfileUrl?.trim() ||
    (venue.instagramHandle
      ? `https://www.instagram.com/${venue.instagramHandle.replace(/^@+/, "")}/`
      : null);

  return {
    "@context": "https://schema.org",
    "@id": `${url}#place`,
    "@type": "LocalBusiness",
    address: {
      "@type": "PostalAddress",
      addressCountry: "RS",
      addressLocality: "Belgrade",
      ...(venue.neighborhood ? { addressRegion: venue.neighborhood } : {}),
      ...(streetAddress ? { streetAddress } : {}),
    },
    areaServed: {
      "@type": "City",
      name: "Belgrade",
    },
    description: `${venue.name} is ${venue.category ? `a ${venue.category.toLowerCase()} venue` : "an event venue"} in Belgrade. Find upcoming events, location details, and the official Instagram profile on Event Zeka.`,
    ...(coordinates
      ? {
          geo: {
            "@type": "GeoCoordinates" as const,
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
          },
        }
      : {}),
    hasMap: coordinates
      ? `https://www.google.com/maps/search/?api=1&query=${coordinates.latitude},${coordinates.longitude}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
    name: venue.name,
    ...(openingHoursSpecification.length ? { openingHoursSpecification } : {}),
    ...(instagramUrl ? { sameAs: [instagramUrl] } : {}),
    url,
  };
}

export function buildBreadcrumbStructuredData(
  items: Array<{ name: string; path: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function buildHomePageStructuredData(events: HomeStructuredEvent[] = []) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        name: SITE_NAME,
        url: SITE_ORIGIN,
        description: SITE_DESCRIPTION,
        inLanguage: ["en-RS", "sr-Latn-RS"],
        sameAs: [SITE_INSTAGRAM_URL],
        potentialAction: {
          "@type": "SearchAction",
          target: `${SITE_ORIGIN}/?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "CollectionPage",
        "@id": `${SITE_ORIGIN}/#calendar`,
        name: "Belgrade events, nightlife & culture",
        description: SITE_DESCRIPTION,
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: events.map((event, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: `${event.title} at ${event.venue} — ${event.date}`,
            url: absoluteUrl(`/events/${event._id}`),
          })),
        },
        url: SITE_ORIGIN,
      },
      {
        "@type": "FAQPage",
        mainEntity: HOME_FAQ_ITEMS.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        })),
      },
    ],
  };
}

export function buildVenueDirectoryStructuredData(
  venues: VenueDirectoryStructuredItem[],
  page = 1,
  firstPosition = 1,
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: page > 1 ? `Belgrade venue guide — page ${page}` : "Belgrade venue guide",
    itemListElement: venues.map((venue, index) => ({
      "@type": "ListItem",
      position: firstPosition + index,
      name: venue.name,
      url: absoluteUrl(`/venues/${venue._id}`),
    })),
  };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
