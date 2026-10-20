import { canonicalizeEventType, normalizeTaxonomyText } from "./venue-types";

export const EVENT_PRIMARY_CATEGORIES = [
  { key: "club", label: "Zurke" },
  { key: "live", label: "Live music" },
  { key: "culture", label: "Kultura" },
  { key: "social", label: "Barovi" },
  { key: "event", label: "Ostalo" },
] as const;

export type EventPrimaryCategory = (typeof EVENT_PRIMARY_CATEGORIES)[number]["key"];

export function normalizeEventCategoryKey(value: string | undefined): EventPrimaryCategory | undefined {
  if (value === "experience") return "event";
  return EVENT_PRIMARY_CATEGORIES.find(({ key }) => key === value)?.key;
}

export function normalizeHiddenEventCategories(categories: readonly string[]): EventPrimaryCategory[] {
  const requested = new Set(categories.map((value) => normalizeEventCategoryKey(value.trim())));
  const keys = EVENT_PRIMARY_CATEGORIES.map(({ key }) => key);

  // Old links focused on Radionice or Ostalo can hide every current key after
  // the merge. Keep the combined Ostalo category visible for those selections.
  if (keys.every((key) => requested.has(key))) requested.delete("event");
  return keys.filter((key) => requested.has(key));
}

export function getHiddenCategoriesAfterCategoryToggle(
  hiddenCategories: readonly EventPrimaryCategory[],
  category: EventPrimaryCategory,
): EventPrimaryCategory[] {
  const keys = EVENT_PRIMARY_CATEGORIES.map(({ key }) => key);
  const hidden = new Set(hiddenCategories);

  // Start a focused selection from All, and let its only active chip reset All.
  if (hidden.size === 0) return keys.filter((key) => key !== category);
  if (hidden.size === keys.length - 1 && !hidden.has(category)) return [];

  if (hidden.has(category)) hidden.delete(category);
  else hidden.add(category);
  return keys.filter((key) => hidden.has(key));
}

export type EventCategoryInput = {
  eventType: string;
  title?: string;
  artists?: readonly string[];
  description?: string;
  venueCategory?: string;
  ticketPrice?: string | null;
};

const EXPERIENCE = /\b(workshops?|radionic[a-z]*|classes|class|course|kurs[a-z]*|quiz|kviz[a-z]*|trivia|tastings?|degustacij[a-z]*|paint and sip|sip and paint|creative activit[a-z]*)\b/;
const CULTURE = /\b(arts? and culture|kultura|umetnost|theat(?:er|re)|pozoris[a-z]*|predstav[a-z]*|stand ?up(?:fest)?|comedy|ballet|balet|exhibitions?|izlozb[a-z]*|gallery|galerij[a-z]*|cinema|bioskop|films?|movies?|screenings?|projekcij[a-z]*|performance art|performans[a-z]*|poetry|poezij[a-z]*|lectures?|predavanj[a-z]*|panels?|talks?|tribin[a-z]*|razgovor[a-z]*)\b/;
const LIVE = /\b(live music|live band|live performance|muzika uzivo|svirk[a-z]*|concerts?|koncert[a-z]*|gigs?|tribute|ensemble|jam session|bend(?:a|ovi)?|band)\b/;
const CLUB = /\b(clubbing|club night|dj(?:s| set)?|disco|rave|techno|after ?party|nightlife|part(?:y|ies)|zurk[a-z]*|zur|darkwave night|retro mania)\b|\b(?:house|retro|mainstream|hip hop|r and b) (?:night|vece|party)\b/;
const SOCIAL = /\b(bars? and social|barovi|social|after ?work|meet ?up|networking|mixer|speed dating|upoznavanj[a-z]*|druzenj[a-z]*|cocktails?|koktel[a-z]*|pub night|bar night|tematsk[a-z]* vec[a-z]*)\b/;
const SPECIAL = /\b(otvaranj[a-z]*|grand opening|club opening|opening night|sports? (?:screening|broadcast|watch|night)|watch party|match screening|sportski prenos|prenosi utakmic[a-z]*|prenos utakmic[a-z]*|utakmic[a-z]*|football|fudbal|basketball|kosarka)\b/;

function categoryFromProgram(text: string): EventPrimaryCategory | undefined {
  // Activity takes precedence over music used as a theme, e.g. a rock pub quiz.
  if (SPECIAL.test(text)) return "event";
  if (EXPERIENCE.test(text)) return "event";
  if (CULTURE.test(text)) return "culture";
  if (/\bfestivals?\b/.test(text)) return "event";
  if (/\b(?:dj|techno|house) live performance\b/.test(text)) return "club";
  if (
    /\bdj(?: set)?\b/.test(text) &&
    !/\b(?:live music|live band|concerts?|koncert[a-z]*|svirk[a-z]*|band|bend|ensemble)\b/.test(text)
  ) {
    return "club";
  }
  if (LIVE.test(text)) return "live";
  if (CLUB.test(text)) return "club";
  if (SOCIAL.test(text)) return "social";
  return undefined;
}

export function getEventPrimaryCategory(event: EventCategoryInput): EventPrimaryCategory {
  const type = normalizeTaxonomyText(event.eventType);
  const title = normalizeTaxonomyText(event.title);
  const description = normalizeTaxonomyText(event.description);
  const namedCategory = EVENT_PRIMARY_CATEGORIES.find(
    (category) => normalizeTaxonomyText(category.label) === type,
  );

  // The announced program refines coarse legacy types; a venue is never evidence
  // of the activity. Do not use source captions shared by unrelated carousel rows.
  const titleCategory = categoryFromProgram(title);
  if (titleCategory) return titleCategory;
  const descriptionCategory = categoryFromProgram(description);
  if (descriptionCategory) return descriptionCategory;
  if (namedCategory) return namedCategory.key;
  // Historical display labels and primary keys can also appear in old records.
  if (type === "club") return "club";
  if (type === "culture") return "culture";
  if (type === "live" || type === "music") return "live";
  if (type === "experience") return "event";
  const typeCategory = categoryFromProgram(type);
  if (typeCategory) return typeCategory;

  switch (canonicalizeEventType(event.eventType)) {
    case "nightlife":
      return "club";
    case "live music":
      return "live";
    case "arts & culture":
      return "culture";
    case "learning":
      return "event";
    case "food & market":
    case "event":
      return "event";
  }
}

const TAG_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "Techno", pattern: /\btechno\b/ },
  { label: "House", pattern: /\b(?:deep |tech |acid |progressive )?house\b/ },
  { label: "Disco", pattern: /\bdisco\b/ },
  { label: "R&B", pattern: /\br (?:and )?b\b/ },
  { label: "Hip-hop", pattern: /\bhip hop\b/ },
  { label: "Retro", pattern: /\bretro\b/ },
  { label: "Mainstream", pattern: /\bmainstream\b/ },
  { label: "Darkwave", pattern: /\bdark ?wave\b/ },
  { label: "Rock", pattern: /\brock\b/ },
  { label: "Jazz", pattern: /\b(?:jazz|dzez)\b/ },
  { label: "Blues", pattern: /\b(?:blues|bluz)\b/ },
  { label: "Pop", pattern: /\bpop(?! up)\b/ },
  { label: "Metal", pattern: /\bmetal\b/ },
  { label: "DJ set", pattern: /\bdj set\b/ },
  { label: "Tribute", pattern: /\btribute\b/ },
  { label: "Stand-up", pattern: /\bstand ?up(?:fest)?\b/ },
  { label: "Pozori\u0161te", pattern: /\b(?:theat(?:er|re)|pozoris[a-z]*|predstav[a-z]*)\b/ },
  { label: "Film", pattern: /\b(?:films?|movies?|cinema|bioskop|projekcij[a-z]*)\b/ },
  { label: "Izlo\u017eba", pattern: /\b(?:exhibitions?|izlozb[a-z]*)\b/ },
  { label: "Radionica", pattern: /\b(?:workshops?|radionic[a-z]*)\b/ },
  { label: "Kviz", pattern: /\b(?:quiz|kviz[a-z]*|trivia)\b/ },
  { label: "Degustacija", pattern: /\b(?:tastings?|degustacij[a-z]*)\b/ },
  { label: "After-work", pattern: /\bafter ?work\b/ },
  { label: "Festival", pattern: /\bfestivals?\b/ },
];

export function getEventTags(event: EventCategoryInput): string[] {
  // Artist names and venue names are identities, not evidence of a music genre.
  const text = normalizeTaxonomyText(
    [event.eventType, event.title, event.description].filter(Boolean).join(" "),
  );
  const tags = TAG_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
  if (isFreeEventAdmission(event.ticketPrice)) {
    tags.push("Besplatan ulaz");
  }
  return tags;
}

export function isFreeEventAdmission(value: string | null | undefined): boolean {
  const price = normalizeTaxonomyText(value);
  // Conditional free admission must retain its condition in the price display.
  return /^(?:free(?: entry| admission)?|no cover|besplat(?:no|an(?: ulaz)?|na ulaznica)|slobodan ulaz|ulaz slobodan|0(?: rsd| din| dinara| eur)?)$/.test(price);
}
