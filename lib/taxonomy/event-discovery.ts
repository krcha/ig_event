import { getEventPrimaryCategory, type EventCategoryInput } from "./event-categories";
import { classifyExplicitEventDiscovery } from "./explicit-event-discovery";
import { canonicalizeEventType, normalizeTaxonomyText } from "./venue-types";

export const EVENT_DISCOVERY_VERSION = 1;

export const DISCOVERY_CATEGORIES = [
  { key: "party", label: "Na žurku" },
  { key: "live", label: "Na svirku" },
  { key: "culture", label: "Film, scena i kultura" },
  { key: "exhibition", label: "Izložbe i sajmovi" },
  { key: "participate", label: "Kviz, igra i radionice" },
  { key: "food", label: "Hrana i piće" },
  { key: "talk", label: "Razgovori i predavanja" },
  { key: "other", label: "Ostali događaji" },
] as const;

export const MUSIC_GENRES = [
  { key: "electronic", label: "Elektronska muzika" },
  { key: "house", label: "House" },
  { key: "techno", label: "Techno" },
  { key: "trance", label: "Trance" },
  { key: "drum-and-bass", label: "Drum & bass" },
  { key: "disco-funk", label: "Disko i fank" },
  { key: "pop", label: "Pop" },
  { key: "rock", label: "Rok" },
  { key: "indie-alternative", label: "Indi i alternativa" },
  { key: "metal-punk", label: "Metal i pank" },
  { key: "hip-hop", label: "Hip-hop, rep i trap" },
  { key: "rnb-soul", label: "R&B i soul" },
  { key: "jazz-blues", label: "Džez i bluz" },
  { key: "folk", label: "Folk i narodna" },
  { key: "classical", label: "Klasična muzika" },
  { key: "latin", label: "Latino" },
  { key: "afro-amapiano", label: "Afro i amapiano" },
  { key: "reggae-dub", label: "Reggae i dub" },
  { key: "ambient", label: "Ambient" },
  { key: "etno-world", label: "Etno i world" },
] as const;

export const DISCOVERY_FORMATS = [
  { key: "dj-set", label: "DJ set" },
  { key: "party", label: "Žurka" },
  { key: "concert", label: "Koncert" },
  { key: "live-performance", label: "Nastup uživo" },
  { key: "tribute", label: "Tribute" },
  { key: "screening", label: "Projekcija" },
  { key: "theatre", label: "Predstava" },
  { key: "stand-up", label: "Stand-up" },
  { key: "exhibition", label: "Izložba" },
  { key: "fair", label: "Sajam" },
  { key: "quiz", label: "Kviz" },
  { key: "game", label: "Igra" },
  { key: "workshop", label: "Radionica" },
  { key: "karaoke", label: "Karaoke" },
  { key: "tasting", label: "Degustacija" },
  { key: "dinner", label: "Večera" },
  { key: "talk", label: "Razgovor" },
  { key: "lecture", label: "Predavanje" },
  { key: "festival", label: "Festival" },
] as const;

export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number]["key"];
export type MusicGenre = (typeof MUSIC_GENRES)[number]["key"];
export type DiscoveryFormat = (typeof DISCOVERY_FORMATS)[number]["key"];

export type EventDiscoveryTaxonomy = {
  primaryCategory: DiscoveryCategory;
  categories: DiscoveryCategory[];
  genres: MusicGenre[];
  formats: DiscoveryFormat[];
};

type DiscoveryEvent = EventCategoryInput & { eventTaxonomy?: EventDiscoveryTaxonomy; venue?: string; date?: string };

/** Baseline used by enrichment to distinguish durable labels from newly derived evidence. */
export function getStoredOrLegacyEventTaxonomy(event: DiscoveryEvent): EventDiscoveryTaxonomy {
  if (event.eventTaxonomy) return event.eventTaxonomy;
  const legacy = getEventPrimaryCategory(event);
  const type = canonicalizeEventType(event.eventType);
  const primaryCategory: DiscoveryCategory = legacy === "club"
    ? "party"
    : legacy !== "event"
      ? legacy
      : type === "food & market"
        ? "food"
        : "other";
  return { primaryCategory, categories: [primaryCategory], genres: [], formats: [] };
}

function summaryCancelsEvent(title: string | undefined, description: string | undefined): boolean {
  if (!description) return false;
  const name = normalizeTaxonomyText(title);
  return description.slice(0, 500).split(/[.!?;\n]/).some((sentence) => {
    const match = /^(?:(?:the|this) )?(.+?) (?:was |is |has been |je )?(?:cancell?ed|otkazan[aoie]?)(?: (?:due to|because|zbog) .+)?$/.exec(normalizeTaxonomyText(sentence));
    return match && (match[1] === name || match[1] === "event" || match[1] === "dogadjaj");
  });
}

export function getEventDiscoveryTaxonomy(event: DiscoveryEvent): EventDiscoveryTaxonomy {
  if (event.eventTaxonomy) return event.eventTaxonomy;
  if (summaryCancelsEvent(event.title, event.description)) {
    return { primaryCategory: "other", categories: ["other"], genres: [], formats: [] };
  }
  const baseline = getStoredOrLegacyEventTaxonomy(event);
  // Legacy rows have an occurrence-specific summary, while their Instagram
  // caption may advertise several different events. Never pass that caption
  // through this fallback, including when called on a full detail record.
  const discovery = classifyExplicitEventDiscovery({
    title: event.title ?? "", description: event.description, artists: event.artists,
    venue: event.venue, date: event.date,
  }, baseline.primaryCategory);
  return discovery?.complete ? discovery.taxonomy : baseline;
}

const ELECTRONIC_GENRES: readonly MusicGenre[] = [
  "electronic", "house", "techno", "trance", "drum-and-bass",
];

export function eventMatchesMusicGenre(genres: readonly MusicGenre[], genre: MusicGenre): boolean {
  return genre === "electronic"
    ? genres.some((key) => ELECTRONIC_GENRES.includes(key))
    : genres.includes(genre);
}
