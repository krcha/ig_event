import type { MusicGenre } from "./event-discovery";
import { genreProof } from "./explicit-event-discovery";
import { normalizeTaxonomyText } from "./venue-types";

const keys = Object.keys(genreProof) as MusicGenre[];
const words = (value: string) =>
  normalizeTaxonomyText(
    value
      .normalize("NFKC")
      .replace(/@[\w.]+/gu, " ")
      .replace(/\bdrum(?:['’]?n['’]?|\s*&\s*)bass\b/giu, "drum and bass")
      .replace(/#livehousemusic\b/giu, "house music"),
  );

function styles(text: string) {
  return keys.filter((key) => genreProof[key].test(text));
}

export function directoryGenreKeys(labels: string[]): MusicGenre[] {
  const genres = new Set<MusicGenre>();
  for (const label of labels) {
    const normalized = words(label);
    if (/^(?:liquid funk|neurofunk)$/.test(normalized))
      genres.add("drum-and-bass");
    else if (normalized === "dub techno") genres.add("techno");
    else for (const key of styles(normalized)) genres.add(key);
  }
  return [...genres];
}

// Account tags and affiliations describe other people. Accept a self-description
// or a list made of musical styles and their ordinary qualifiers.
export function instagramBioGenreKeys(line: string): MusicGenre[] {
  if (
    !line.trim() ||
    line.length > 260 ||
    /https?:|[\w.+-]+@[\w-]+\.[\w.-]+|(?:\d[ ()-]*){7}/iu.test(line)
  )
    return [];
  const text = words(line);
  if (
    /\b(?:not|no|bez|nije|nisu|nikad|never|without|formerly|inspired|influences|lover|love for|fan of|for fans|favourite|favorite|listening|tribute|new single|album|out now|release|party at|festival|record label|records is|photo|photographer|photo by|booking|management|coffee|fashion|design studio|beach house|opera house|house of|rock climbing|guest|featuring|my brother|my sister|salsa dancer)\b/u.test(
      text,
    )
  )
    return [];
  const enriched = text
    .replace(/\brock and roll\b/g, "rock")
    .replace(/\bpopic\b/g, "pop")
    .replace(/\bnarodnjacic\b|\bnarodna$/g, "narodna muzika");
  const genres = styles(enriched);
  const selfDescription =
    /\b(?:dj|producer|producent|band|bend|trio|singer|pevac|musician|veteran|sviramo|igramo|playing|my sound|i play|house music|my sets)\b/u.test(
      enriched,
    );
  const remainder = genres
    .reduce(
      (s, g) => s.replace(new RegExp(genreProof[g].source, "gu"), " "),
      enriched,
    )
    .replace(
      /\b(?:and|i|n|roll|deep|hard|melodic|progressive|underground|bass|groove|liquid|jump up|heavy|stoner|mnml|tech|ex yu|domaci|strani|hitovi|music|muzika|genres|zanrovi|open format|70s80s90s2000s|breaks?|acid|remixes|mtv|leftfield|chugging|post|samo ljuti|po koji)\b/gu,
      " ",
    )
    .trim();
  if (!remainder || selfDescription) return genres;
  // Bios often separate a self-described style from personal information with
  // a bullet, or end a comma-separated list with “and everything …”.
  const first = line.split(/•|,\s*and everything\b/iu)[0].trim();
  const list = words(first).replace(
    /^(?:serbian|balkan|british|french|german|american) /u,
    "",
  );
  if (
    first !== line.trim() &&
    styles(list).length &&
    !styles(list)
      .reduce(
        (s, g) => s.replace(new RegExp(genreProof[g].source, "gu"), " "),
        list,
      )
      .trim()
  )
    return styles(list);
  return [];
}
