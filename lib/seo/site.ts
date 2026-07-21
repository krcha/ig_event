export const SITE_NAME = "Event Zeka";
export const SITE_ORIGIN = "https://eventzeka.com";
export const SITE_DESCRIPTION =
  "Find Belgrade events today: nightlife, concerts, DJ nights, exhibitions, theatre, film, festivals, and culture for locals and visitors.";
export const BELGRADE_TIME_ZONE = "Europe/Belgrade";

export const HOME_FAQ_ITEMS = [
  {
    question: "What events can I find on Event Zeka?",
    answer:
      "Event Zeka covers approved Belgrade nightlife and culture listings, including club nights, concerts, DJ sets, exhibitions, theatre, film, festivals, talks, and workshops.",
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
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function getBelgradeUtcOffset(date: string): string {
  const reference = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(reference.getTime())) {
    return "+01:00";
  }

  const offsetPart = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    timeZone: BELGRADE_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(reference)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = offsetPart?.match(/^GMT([+-]\d{2}:\d{2})$/);
  return match?.[1] ?? "+01:00";
}

export function buildEventStartDate(date: string, time?: string): string {
  const normalizedTime = parseEventTime(time);
  if (!normalizedTime) {
    return date;
  }

  return `${date}T${normalizedTime}:00${getBelgradeUtcOffset(date)}`;
}

function isExplicitlyFree(ticketPrice: string | null | undefined): boolean {
  return /\b(free|besplatan|besplatno|slobodan ulaz)\b/i.test(ticketPrice?.trim() ?? "");
}

export function buildEventStructuredData(
  event: EventStructuredDataInput,
): EventStructuredData {
  const url = absoluteUrl(`/events/${event._id}`);
  const location: EventStructuredData["location"] = {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressCountry: "RS",
      addressLocality: "Belgrade",
      ...(event.venueLocation ? { streetAddress: event.venueLocation } : {}),
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
      ...(venue.location ? { streetAddress: venue.location } : {}),
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
