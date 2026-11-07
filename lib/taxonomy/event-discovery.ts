import { getEventPrimaryCategory, type EventCategoryInput } from "./event-categories";
import { canonicalizeEventType } from "./venue-types";

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

export function getEventDiscoveryTaxonomy(
  event: EventCategoryInput & { eventTaxonomy?: EventDiscoveryTaxonomy },
): EventDiscoveryTaxonomy {
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

const ELECTRONIC_GENRES: readonly MusicGenre[] = [
  "electronic", "house", "techno", "trance", "drum-and-bass",
];

export function eventMatchesMusicGenre(genres: readonly MusicGenre[], genre: MusicGenre): boolean {
  return genre === "electronic"
    ? genres.some((key) => ELECTRONIC_GENRES.includes(key))
    : genres.includes(genre);
}
