import { MUSIC_GENRES, type MusicGenre } from "./event-discovery";

export type MusicGenreRelationKind = "same" | "close" | "contrast" | "mixed" | "unknown";
export type MusicGenrePair = readonly [MusicGenre, MusicGenre];
export type MusicGenreComparison = {
  kind: MusicGenreRelationKind;
  reason: "missing-genres" | "identical-genres" | "related-genres" | "contrasting-genres" | "mixed-programme" | "unresolved-relation";
  left: MusicGenre[];
  right: MusicGenre[];
  shared: MusicGenre[];
  closePairs: MusicGenrePair[];
  contrastPairs: MusicGenrePair[];
  unknownPairs: MusicGenrePair[];
};

/** Application buckets, not claims that all styles within a bucket are identical. */
export const MUSIC_GENRE_DEFINITIONS = {
  electronic: "Broad or otherwise unnamed electronic music; examples: electronica, IDM, breakbeat. Prefer a named specific electronic bucket when supported; generic DJ/rave/party is not genre evidence.",
  house: "House music and explicitly named house subgenres; examples: deep house, tech house, acid house, soulful house.",
  techno: "Techno and explicitly named techno subgenres; examples: minimal techno, dub techno, hard techno, schranz. Tech house belongs to house, not automatically techno.",
  trance: "Trance and its explicitly named subgenres; examples: progressive trance, uplifting trance, psytrance.",
  "drum-and-bass": "Drum and bass and jungle; examples: liquid drum and bass, drum and bass, jungle. A bass-heavy song alone is not evidence.",
  "disco-funk": "The combined disco/funk bucket; examples: disco, dark disco, nu-disco, funk. Dark disco does not by itself establish darkwave or another genre. A funky description alone does not establish house or soul.",
  pop: "Pop and explicitly named pop styles; examples: synthpop, electropop, hyperpop, britpop. Popularity or chart success alone is not genre evidence.",
  rock: "Rock and explicitly named rock styles; examples: rock and roll, hard rock, rockabilly. A rock quiz or a rock musician's biography does not establish a rock performance.",
  "indie-alternative": "The broad indie/alternative bucket; examples: post-punk, postpunk, post-pank, indie rock, alternative rock, grunge, shoegaze, new wave, darkwave, industrial/EBM. Post-punk/post-pank belongs here, not automatically in metal-punk. These examples do not imply one another or prove a single uniform sound.",
  "metal-punk": "The combined metal/punk bucket; examples: heavy metal, thrash metal, punk, hardcore punk, metalcore. Only independently advertised punk/pank or metal establishes this bucket; the word punk inside post-punk/post-pank does not. If separate punk or metal is also advertised, retain that independent claim. Do not assume every metal act also plays punk.",
  "hip-hop": "Hip-hop, rap and explicitly identified trap music; examples: hip-hop, conscious rap, trap. A word in a performer name is not evidence.",
  "rnb-soul": "The combined rhythm-and-blues/soul bucket; examples: R&B, contemporary R&B, soul, neo-soul. Rhythm and blues must not be mistaken for an independently billed blues programme.",
  "jazz-blues": "The combined jazz/blues bucket; examples: jazz, swing, blues, electric blues. An act called Jazz or Blues is not enough to establish this label.",
  folk: "Folk/narodna in this application's regional music bucket; examples: explicitly billed narodna muzika, folk, turbo-folk. Qualified Weird Folk, Freak Folk and Indie Folk do not establish this regional/narodna bucket; abstain unless a separate supported folk/narodna style is advertised. Do not infer indie-alternative from Weird Folk alone. A venue's name or location does not establish it.",
  classical: "Classical/art-music programmes; examples: baroque, opera, a classical piano recital. An instrumental or quiet performance is not automatically classical.",
  latin: "Explicitly named Latin music/styles; examples: salsa, bachata, reggaeton, flamenco. A dance lesson is an activity, not proof of a musical performance.",
  "afro-amapiano": "The combined Afro/Amapiano bucket; examples: Afrobeats, Amapiano, Afro house. Do not equate these styles or infer all of them from one example.",
  "reggae-dub": "The combined reggae/dub bucket; examples: reggae, roots reggae, dub, dancehall. Dub techno does not by itself establish reggae/dub.",
  ambient: "Explicit ambient and drone music; examples: ambient, dark ambient, drone. Quiet, relaxed or background music alone is not genre evidence.",
  "etno-world": "Explicitly billed ethno/world/traditional music; examples: etno, ethno, world music, tradicionalna muzika. Nationality or an instrument alone is not enough.",
} as const satisfies Record<MusicGenre, string>;

const specificElectronic: readonly MusicGenre[] = ["house", "techno", "trance", "drum-and-bass"];

// Every edge is an explicit product rule, symmetric and one hop only. In
// particular house -> disco/funk -> R&B/soul -> jazz/blues is not a house/jazz edge.
export const CLOSE_MUSIC_GENRE_PAIRS: readonly MusicGenrePair[] = [
  ["electronic", "house"], ["electronic", "techno"],
  ["electronic", "trance"], ["electronic", "drum-and-bass"],
  ["house", "techno"], ["techno", "trance"], ["house", "trance"],
  ["house", "disco-funk"], ["disco-funk", "rnb-soul"],
  ["rnb-soul", "jazz-blues"], ["hip-hop", "rnb-soul"],
  ["rock", "indie-alternative"], ["rock", "metal-punk"],
  ["folk", "etno-world"],
];

// Different musical directions, not objective opposites. Broad/composite
// labels deliberately have no inferred contrast merely because an edge is absent.
const contrastDirections: readonly MusicGenre[] = ["rock", "metal-punk", "folk", "classical"];
export const CONTRASTING_MUSIC_GENRE_PAIRS: readonly MusicGenrePair[] = [
  ...specificElectronic.flatMap((electronic): MusicGenrePair[] => contrastDirections.map(
    (other) => [electronic, other] as const)),
  // These declared styles offer a different musical direction in this product.
  // Crossover programmes containing both styles are handled as mixed below.
  ["electronic", "classical"], ["electronic", "folk"],
  ["electronic", "rock"], ["electronic", "hip-hop"],
  ["disco-funk", "classical"], ["disco-funk", "metal-punk"],
  ["pop", "classical"], ["pop", "metal-punk"], ["pop", "techno"],
  ["indie-alternative", "classical"], ["indie-alternative", "hip-hop"],
  ["hip-hop", "classical"], ["hip-hop", "metal-punk"], ["hip-hop", "rock"],
  ["hip-hop", "house"], ["hip-hop", "techno"], ["hip-hop", "trance"],
  ["rnb-soul", "classical"], ["rnb-soul", "metal-punk"], ["rnb-soul", "techno"], ["rnb-soul", "trance"],
  ["jazz-blues", "metal-punk"], ["house", "jazz-blues"], ["techno", "jazz-blues"], ["trance", "jazz-blues"],
  ["latin", "metal-punk"], ["latin", "classical"],
  ["latin", "techno"], ["latin", "trance"], ["latin", "drum-and-bass"],
  ["afro-amapiano", "classical"], ["afro-amapiano", "metal-punk"], ["afro-amapiano", "rock"],
  ["reggae-dub", "techno"], ["reggae-dub", "classical"],
  ["ambient", "metal-punk"],
  ["etno-world", "techno"], ["etno-world", "house"],
];

const key = (a: MusicGenre, b: MusicGenre) => a < b ? `${a}|${b}` : `${b}|${a}`;
const closeKeys = new Set(CLOSE_MUSIC_GENRE_PAIRS.map(([a, b]) => key(a, b)));
const contrastKeys = new Set(CONTRASTING_MUSIC_GENRE_PAIRS.map(([a, b]) => key(a, b)));
const genreKeys = new Set<string>(MUSIC_GENRES.map(({ key: genre }) => genre));

function normalize(genres: readonly MusicGenre[]): MusicGenre[] {
  const known = new Set(genres.filter((genre) => genreKeys.has(genre)));
  if (specificElectronic.some((genre) => known.has(genre))) known.delete("electronic");
  // Canonical order makes both directions deterministic without mutating inputs.
  return MUSIC_GENRES.map(({ key: genre }) => genre).filter((genre) => known.has(genre));
}

/** Unknown relationships never become contrast by negation or transitive closure. */
export function compareMusicGenres(a: readonly MusicGenre[], b: readonly MusicGenre[]): MusicGenreComparison {
  const left = normalize(a), right = normalize(b);
  const result: MusicGenreComparison = { kind: "unknown", reason: "missing-genres", left, right,
    shared: left.filter((genre) => right.includes(genre)), closePairs: [], contrastPairs: [], unknownPairs: [] };
  if (!left.length || !right.length) return result;
  const coveredLeft = new Set<MusicGenre>(), coveredRight = new Set<MusicGenre>();
  for (const first of left) for (const second of right) {
    if (first === second || closeKeys.has(key(first, second))) {
      coveredLeft.add(first); coveredRight.add(second);
      if (first !== second) result.closePairs.push([first, second]);
    } else if (contrastKeys.has(key(first, second))) result.contrastPairs.push([first, second]);
    else result.unknownPairs.push([first, second]);
  }
  const hasMatch = coveredLeft.size > 0;
  const complete = coveredLeft.size === left.length && coveredRight.size === right.length;
  if (hasMatch && (result.contrastPairs.length || !complete)) {
    result.kind = "mixed"; result.reason = "mixed-programme";
  } else if (complete) {
    result.kind = left.length === right.length && left.every((genre, index) => genre === right[index]) ? "same" : "close";
    result.reason = result.kind === "same" ? "identical-genres" : "related-genres";
  } else if (result.contrastPairs.length === left.length * right.length) {
    result.kind = "contrast"; result.reason = "contrasting-genres";
  } else result.reason = "unresolved-relation";
  return result;
}

/** One glossary for all existing agents; relationship metadata never enters canonical genre arrays. */
export function getMusicGenreGuide(): string {
  return [
    "CANONICAL MUSIC GENRE GUIDE v1 (the existing 20 keys; no new output fields or labels):",
    ...MUSIC_GENRES.map(({ key: genre }) => `${genre}: ${MUSIC_GENRE_DEFINITIONS[genre]}`),
    "Examples clarify an evidenced style's canonical bucket; they are not extra styles to add. Return only genres actually established under this task's evidence/identity rules. Do not add house because techno is related, rock because house contrasts with it, or electronic just because a named specific electronic genre is supported.",
    "For navigation only, the application uses symmetric one-hop close-style rules: " + CLOSE_MUSIC_GENRE_PAIRS.map(([a, b]) => `${a} <-> ${b}`).join("; ") + ". Never follow chains of these relationships.",
    "Navigation contrast uses this explicit curated application policy: " + CONTRASTING_MUSIC_GENRE_PAIRS.map(([a, b]) => `${a} <-> ${b}`).join("; ") + ". These are different declared musical directions, not objective or universal opposites. Do not infer additional contrast edges by negation or transitivity. Unlisted pairs can remain unknown; a crossover programme can contain both shared and contrasting styles and must be treated as mixed.",
    "Same/close/contrast/mixed/unknown are recommendation metadata, NOT genres. Never expand a canonical genres array with these relations or with related/contrasting styles. A venue's usual programme or another occurrence alone does not establish this event's advertised genre.",
    "A performer's characteristic genre describes that performer, not proof of what is playing at a venue now. Existing performer-research identity/style proof and no-search recognition rules still apply: a task-authorized characteristic-style result remains performer-based fallback, not an occurrence announcement. Current-event claims require that occurrence's evidence; historical venue patterns must remain explicitly separate and uncertain. Preserve empty results and abstention whenever this task's proof is missing.",
  ].join("\n");
}
