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

export type MainCategory = "club" | "live" | "culture" | "day" | "other";

export type CultureSubtype = "stage" | "screen" | "art";

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

const SERBIAN_CYRILLIC_TO_LATIN: Record<string, string> = {
  "\u0430": "a",
  "\u0431": "b",
  "\u0432": "v",
  "\u0433": "g",
  "\u0434": "d",
  "\u0452": "dj",
  "\u0435": "e",
  "\u0436": "z",
  "\u0437": "z",
  "\u0438": "i",
  "\u0458": "j",
  "\u043a": "k",
  "\u043b": "l",
  "\u0459": "lj",
  "\u043c": "m",
  "\u043d": "n",
  "\u045a": "nj",
  "\u043e": "o",
  "\u043f": "p",
  "\u0440": "r",
  "\u0441": "s",
  "\u0442": "t",
  "\u045b": "c",
  "\u0443": "u",
  "\u0444": "f",
  "\u0445": "h",
  "\u0446": "c",
  "\u0447": "c",
  "\u045f": "dz",
  "\u0448": "s",
};

const SERBIAN_LATIN_TO_ASCII: Record<string, string> = {
  "\u0111": "dj",
  "\u010d": "c",
  "\u0107": "c",
  "\u017e": "z",
  "\u0161": "s",
};

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
      "pijaca",
      "pop up",
      "popup",
      "razmena",
      "street food",
      "swap",
      "vasar",
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
      "klub",
      "night club",
      "nightlife",
      "party",
      "rave",
      "techno",
      "zur",
      "zurka",
      "zurke",
    ],
  },
  {
    canonical: "live music",
    terms: [
      "band",
      "concert",
      "gig",
      "jam",
      "bend",
      "koncert",
      "live",
      "live music",
      "nastup",
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
      "bioskop",
      "cinema",
      "comedy",
      "exhibition",
      "film",
      "gallery",
      "galerija",
      "izlozba",
      "movie",
      "performance",
      "performans",
      "play",
      "poetry",
      "poezija",
      "predstava",
      "projekcija",
      "screening",
      "stand up",
      "theater",
      "theatre",
      "pozoriste",
    ],
  },
  {
    canonical: "learning",
    terms: [
      "class",
      "course",
      "kurs",
      "lecture",
      "meetup",
      "panel",
      "predavanje",
      "seminar",
      "talk",
      "workshop",
      "radionica",
      "tribina",
    ],
  },
];

const CULTURE_STAGE_TERMS = [
  "theatre",
  "theater",
  "play",
  "performance",
  "pozoriste",
  "predstava",
  "performans",
];

const CULTURE_SCREEN_TERMS = [
  "film",
  "cinema",
  "screening",
  "bioskop",
  "projekcija",
];

const CULTURE_ART_TERMS = [
  "exhibition",
  "gallery",
  "izlozba",
  "galerija",
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
    .toLowerCase()
    .replace(/[\u0111\u010d\u0107\u017e\u0161]/g, (character) => {
      return SERBIAN_LATIN_TO_ASCII[character] ?? character;
    })
    .replace(/[\u0400-\u04ff]/g, (character) => {
      return SERBIAN_CYRILLIC_TO_LATIN[character] ?? character;
    })
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

export function mainCategoryForEventType(
  canonicalType: CanonicalEventType,
): MainCategory {
  switch (canonicalType) {
    case "nightlife":
      return "club";
    case "live music":
      return "live";
    case "arts & culture":
      return "culture";
    case "learning":
    case "food & market":
      return "day";
    case "event":
      return "other";
  }
}

export function cultureSubtypeFor({
  title,
  venue,
  venueCategory,
}: {
  title?: string | null;
  venue?: string | null;
  venueCategory?: string | null;
}): CultureSubtype | null {
  const normalizedText = normalizeTaxonomyText([title, venue].filter(Boolean).join(" "));
  const normalizedVenueCategory = normalizeTaxonomyText(venueCategory);
  const canonicalVenueCategory = canonicalizeVenueCategory(venueCategory);

  if (
    normalizedVenueCategory === "cinema" ||
    normalizedVenueCategory === "bioskop" ||
    CULTURE_SCREEN_TERMS.some((term) => includesNormalizedTerm(normalizedText, term))
  ) {
    return "screen";
  }

  if (
    canonicalVenueCategory === "gallery" ||
    CULTURE_ART_TERMS.some((term) => includesNormalizedTerm(normalizedText, term))
  ) {
    return "art";
  }

  if (
    canonicalVenueCategory === "culture" ||
    CULTURE_STAGE_TERMS.some((term) => includesNormalizedTerm(normalizedText, term))
  ) {
    return "stage";
  }

  return null;
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

export function eventTypeFromVenueCategory(
  venueCategory: string | null | undefined,
): CanonicalEventType {
  switch (canonicalizeVenueCategory(venueCategory)) {
    case "club":
      return "nightlife";
    case "gallery":
    case "culture":
      return "arts & culture";
    case "restaurant/cafe":
      return "food & market";
    case "bar":
    case "venue":
      return DEFAULT_EVENT_TYPE;
  }
}
