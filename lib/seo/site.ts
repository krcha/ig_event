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
  title: string;
  venue: string;
  venueId?: string;
  venueLatitude?: number;
  venueLocation?: string;
  venueLongitude?: number;
};

type VenueStructuredDataInput = {
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

type EventStructuredData = {
  "@context": "https://schema.org";
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
  };
  name: string;
  performer?: Array<{ "@type": "Person"; name: string }>;
  startDate: string;
  url: string;
};

type VenueStructuredData = {
  "@context": "https://schema.org";
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

function parseEventTime(value: string | null | undefined): string | null {
  const match = value
    ?.trim()
    .match(/^([01]?\d|2[0-3]):([0-5]\d)(?:\s*[-–—]\s*(?:[01]?\d|2[0-3]):[0-5]\d)?$/);
  if (!match) {
    return null;
  }

  return `${match[1].padStart(2, "0")}:${match[2]}`;
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

export function buildEventStartDate(date: string, time?: string): string {
  const normalizedTime = parseEventTime(time);
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
): EventStructuredData {
  const url = absoluteUrl(`/events/${event._id}`);
  const streetAddress = getStreetAddress(event.venueLocation);
  const location: EventStructuredData["location"] = {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressCountry: "RS",
      addressLocality: "Belgrade",
      ...(streetAddress ? { streetAddress } : {}),
    },
    ...(typeof event.venueLatitude === "number" && typeof event.venueLongitude === "number"
      ? {
          geo: {
            "@type": "GeoCoordinates" as const,
            latitude: event.venueLatitude,
            longitude: event.venueLongitude,
          },
        }
      : {}),
    name: event.venue,
  };
  const description =
    clipText(event.description, 400) ||
    `${event.title} at ${event.venue} in Belgrade on ${event.date}.`;
  const accessibleForFree = isExplicitlyFree(event.ticketPrice);

  return {
    "@context": "https://schema.org",
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
    startDate: buildEventStartDate(event.date, event.time),
    url,
  };
}

export function buildVenueStructuredData(
  venue: VenueStructuredDataInput,
): VenueStructuredData {
  const locationLabel = venue.location?.trim() || "Belgrade";
  const streetAddress = getStreetAddress(venue.location);
  const mapsQuery = [venue.name, locationLabel].filter(Boolean).join(" ");
  const instagramUrl =
    venue.instagramProfileUrl?.trim() ||
    (venue.instagramHandle
      ? `https://www.instagram.com/${venue.instagramHandle.replace(/^@+/, "")}/`
      : null);

  return {
    "@context": "https://schema.org",
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
    ...(typeof venue.latitude === "number" && typeof venue.longitude === "number"
      ? {
          geo: {
            "@type": "GeoCoordinates" as const,
            latitude: venue.latitude,
            longitude: venue.longitude,
          },
        }
      : {}),
    hasMap: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
    name: venue.name,
    ...(instagramUrl ? { sameAs: [instagramUrl] } : {}),
    url: absoluteUrl(`/venues/${venue._id}`),
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
