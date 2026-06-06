export const CANONICAL_EVENT_TYPES = [
  "nightlife",
  "live music",
  "arts & culture",
  "learning",
  "food & market",
  "event",
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export const CANONICAL_EVENT_TYPE_PROMPT_LIST = CANONICAL_EVENT_TYPES.join(", ");

export const CANONICAL_VENUE_CATEGORIES = [
  "club",
  "bar",
  "restaurant/cafe",
  "culture",
  "gallery",
  "venue",
] as const;

export type CanonicalVenueCategory = (typeof CANONICAL_VENUE_CATEGORIES)[number];

export const DEFAULT_EVENT_TYPE: CanonicalEventType = "event";
export const DEFAULT_VENUE_CATEGORY: CanonicalVenueCategory = "venue";

const EVENT_TYPE_ALIASES: Array<{
  canonical: CanonicalEventType;
  terms: string[];
}> = [
  {
    canonical: "food & market",
    terms: [
      "bazaar",
      "bazar",
      "brunch",
      "dinner",
      "fair",
      "food",
      "market",
      "pop up",
      "popup",
      "street food",
    ],
  },
  {
    canonical: "nightlife",
    terms: [
      "afterparty",
      "club night",
      "dance",
      "disco",
      "dj",
      "dj set",
      "festival",
      "night club",
      "nightlife",
      "party",
      "rave",
      "techno",
    ],
  },
  {
    canonical: "live music",
    terms: [
      "band",
      "concert",
      "gig",
      "jam",
      "koncert",
      "live",
      "live music",
      "svirka",
    ],
  },
  {
    canonical: "arts & culture",
    terms: [
      "art",
      "arts and culture",
      "arts culture",
      "ballet",
      "cinema",
      "comedy",
      "exhibition",
      "film",
      "gallery",
      "movie",
      "performance",
      "play",
      "poetry",
      "screening",
      "stand up",
      "theater",
      "theatre",
      "izlozba",
      "pozoriste",
    ],
  },
  {
    canonical: "learning",
    terms: [
      "class",
      "course",
      "lecture",
      "meetup",
      "panel",
      "seminar",
      "talk",
      "workshop",
      "radionica",
      "tribina",
    ],
  },
];

const VENUE_CATEGORY_ALIASES: Array<{
  canonical: CanonicalVenueCategory;
  terms: string[];
}> = [
  {
    canonical: "club",
    terms: [
      "club",
      "dance club",
      "discotheque",
      "disco",
      "night club",
      "nightclub",
      "party venue",
    ],
  },
  {
    canonical: "bar",
    terms: [
      "bar",
      "beer bar",
      "brewery",
      "cocktail bar",
      "pub",
      "taproom",
    ],
  },
  {
    canonical: "restaurant/cafe",
    terms: [
      "bistro",
      "cafe",
      "caffe",
      "coffee",
      "kafana",
      "restaurant",
      "restoran",
    ],
  },
  {
    canonical: "gallery",
    terms: ["art space", "gallery", "galerija", "museum", "muzej"],
  },
  {
    canonical: "culture",
    terms: [
      "bioskop",
      "cinema",
      "cultural center",
      "culture",
      "kulturni centar",
      "pozoriste",
      "theater",
      "theatre",
    ],
  },
];

function normalizeTaxonomyText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function includesNormalizedTerm(value: string, term: string): boolean {
  const normalizedTerm = normalizeTaxonomyText(term);
  if (!normalizedTerm) {
    return false;
  }

  return ` ${value} `.includes(` ${normalizedTerm} `);
}

export function canonicalizeEventType(
  value: string | null | undefined,
): CanonicalEventType {
  const normalized = normalizeTaxonomyText(value);
  if (!normalized) {
    return DEFAULT_EVENT_TYPE;
  }

  const canonicalMatch = CANONICAL_EVENT_TYPES.find(
    (eventType) => normalizeTaxonomyText(eventType) === normalized,
  );
  if (canonicalMatch) {
    return canonicalMatch;
  }

  for (const aliasGroup of EVENT_TYPE_ALIASES) {
    if (aliasGroup.terms.some((term) => includesNormalizedTerm(normalized, term))) {
      return aliasGroup.canonical;
    }
  }

  return DEFAULT_EVENT_TYPE;
}

export function canonicalizeVenueCategory(
  value: string | null | undefined,
): CanonicalVenueCategory {
  const normalized = normalizeTaxonomyText(value);
  if (!normalized) {
    return DEFAULT_VENUE_CATEGORY;
  }

  const canonicalMatch = CANONICAL_VENUE_CATEGORIES.find(
    (category) => normalizeTaxonomyText(category) === normalized,
  );
  if (canonicalMatch) {
    return canonicalMatch;
  }

  for (const aliasGroup of VENUE_CATEGORY_ALIASES) {
    if (aliasGroup.terms.some((term) => includesNormalizedTerm(normalized, term))) {
      return aliasGroup.canonical;
    }
  }

  return DEFAULT_VENUE_CATEGORY;
}
