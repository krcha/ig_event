import { MUSIC_GENRES, type DiscoveryCategory, type DiscoveryFormat, type EventDiscoveryTaxonomy, type MusicGenre } from "./event-discovery";
import { normalizeTaxonomyText } from "./venue-types";

export const DISCOVERY_TEXT_SOURCES = ["sourceCaption", "occurrenceText", "title", "description"] as const;
export type DiscoveryTextSource = typeof DISCOVERY_TEXT_SOURCES[number];
export type ExplicitDiscoveryInput = {
  title: string;
  description?: string | null;
  occurrenceText?: string | null;
  sourceCaption?: string | null;
  venue?: string | null;
  artists?: readonly string[] | null;
  currentTaxonomy?: EventDiscoveryTaxonomy;
  date?: string | null;
  time?: string | null;
  eventType?: string | null;
};
export type ExplicitDiscoveryEvidence = {
  kind: "category" | "format" | "genre";
  label: DiscoveryCategory | DiscoveryFormat | MusicGenre;
  source: DiscoveryTextSource;
  quote: string;
};

export const genreProof: Record<MusicGenre, RegExp> = {
  electronic: /\b(?:electronic(?:a)?|elektronsk\w* muzik\w*|elektronik\w*|elektronn\w* muzy\w*|edm|electro|idm|hardstyle|hardcore techno|breakcore|breakbeat|break beat)\b/,
  house: /\b(?:house|haus)(?:a|u|om)?\b/,
  techno: /\b(?:techn[oa]|tekn[oa]|tehn[oa]|schranz)\b/,
  trance: /\b(?:trance|psytrance|psy trance|psajtrens|trans muzik\w*)\b/,
  "drum-and-bass": /\b(?:drum (?:and |n )?bass|dram (?:end |en |n )?bejs|dnb|jungle)\b/,
  "disco-funk": /\b(?:disco|disko|funk|fank|funky|fanki)\b/,
  pop: /\b(?:pop(?! up\b)|britpop|electropop|synthpop|hyperpop|schlager)\b/,
  rock: /\b(?:rock|rok|rokenrol\w*|rockabilly|r n r)\b/,
  "indie-alternative": /\b(?:indie|indi|alternativ\w*|emo|grunge|shoegaze|doomgaze|new wave|darkwave|industrial|ebm|aggrotech|futurepop|dark electro|americana)\b/,
  "metal-punk": /\b(?:metal|pank|punk|metalcore|thrashcore|post hardcore|screamo)\b/,
  "hip-hop": /\b(?:hip hop|hiphop|rap|rep|trap)\b/,
  "rnb-soul": /\b(?:r and b|r n b|rnb|rhythm and blues|ritam i bluz|soul)\b/,
  "jazz-blues": /\b(?:(?:jazz|dzez|dzhaz|blues|bluz|blyuz)(?:a|u|om)?|swing)\b/,
  folk: /\b(?:folk|turbo folk|narodn\w* muzik\w*|narodn\w* orkest\w*|narodn\w* pesm\w*)\b/,
  classical: /\b(?:classical|klasicn\w* muzik\w*|klassichesk\w* muzy\w*|klavirsk\w* resital\w*|piano recital|harpsichord concert|opera|baroque|barok)\b/,
  latin: /\b(?:latino|latin(?: music)?|salsa|bachata|reggaeton|flamenco|kubansk\w* muzik\w*)\b/,
  "afro-amapiano": /\b(?:afrobeats?|afro beats?|amapiano|afro house)\b/,
  "reggae-dub": /\b(?:reggae|rege|dub|dancehall|dance hall)\b/,
  ambient: /\b(?:ambient|ambijent\w* muzik\w*|drone)\b/,
  "etno-world": /\b(?:etno|ethno|world music|muzik\w* svet\w*|tradicionaln\w* muzik\w*)\b/,
};

const GENRES = MUSIC_GENRES.map(({ key }) => key);
const SPECIFIC_ELECTRONIC: readonly MusicGenre[] = ["house", "techno", "trance", "drum-and-bass"];
const SOURCE_LIMIT: Record<DiscoveryTextSource, number> = { sourceCaption: 2200, occurrenceText: 400, title: 250, description: 500 };
const CATEGORY_SOURCES: readonly DiscoveryTextSource[] = ["occurrenceText", "sourceCaption", "title", "description"];
const INCIDENTAL = [
  /\b(?:background (?:music|playlist)|u pozadini|pozadinsk\w* muzik\w*|soundtrack|playlist\w*|plejlist\w*|known for|poznat\w* po)\b/,
  /\b(?:last (?:week|night|set|time)|next week|prosle (?:nedelje|sedmice)|sledece (?:nedelje|sedmice)|previous (?:event|party|set))\b/,
  /^(?:(?:\d{1,2}|dve|dvi|tri|cetiri|pet) godin\w* (?:druzenj\w*|muzik\w*|dobrih zurki)|(?:\d{1,2}|two|three|four|five) years of (?:music|parties|dancing))\b/,
  /\b(?:ignore (?:all |previous |prior )*instructions|ignorisi (?:sva |prethodna )*uputstva|classify (?:this|the) event as|klasifikuj (?:ovaj )?dogadjaj kao)\b/,
];
const NON_MUSIC_CONTEXT = /\b(?:quiz\w*|kviz\w*|trivia|screening\w*|projekc\w*|films? about|film\w* o|workshop\w*|radionic\w*|dance (?:lessons?|class(?:es)?)|cas\w* ples\w*|skol\w* ples\w*|kurs\w* ples\w*)\b/;
const MUSIC_CUE = /\b(?:will play|plays?|spins?|pusta\w*|vrti\w*|svir\w*|izvodi\w*|repertoar\w*|music|muzik\w*|genres?|zanr\w*|music policy|dj set|live set)\b/;
const STYLE_FIELD = /^(?:music(?: policy)?|muzik\w*|genres?|zanr\w*|sound|stil(?:ovi)?|repertoar)\s*[:=–—-]/iu;
const NEGATIVE_START = /\b(?:without|bez|not(?: playing)?|no|won t play|don t play|nije|nema|ne (?:pusta\w*|svira\w*|vrti\w*)|nece (?:pust\w*|svir\w*|vrt\w*))(?: (?:any|ikakv\w*|a|an))? /g;
const NEGATIVE_END = /^ (?:is |will be |je |bice )?(?:excluded|canceled|cancelled|otkazan\w*|iskljucen\w*|not (?:played|included|on the program)|nije u programu)\b/;
const NON_MUSIC_GENRE_PHRASES = /\b(?:blues|jazz|rock|house|techno|pop) (?:club|bar|stage|venue|wine)\b/g;

type Clause = { quote: string; words: string };

function activityWords(text: string): string {
  // A parenthetical activity can be a speaker's affiliation or a work title.
  // Look outside it for what attendees are actually invited to do.
  return normalizeTaxonomyText(text.replace(/\([^()]*\)|#[\p{L}\p{N}_-]+/gu, " "));
}

export function discoveryQuoteMatchesOccurrence(quote: string, date: string | undefined | null): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const days = [...normalizeTaxonomyText(quote).matchAll(
    /\b(?:planiran\w* za|zakazan\w* za|scheduled for) (\d{1,2})(?!\d)\b/g,
  )].map(([, day]) => Number(day)).filter((day) => day >= 1 && day <= 31);
  return !days.length || days.every((day) => day === Number(date.slice(-2)));
}

function clauses(text: string): Clause[] {
  return text.split(/(?<=[.!?;])\s+|[\r\n]+|\s+(?=(?:but|ali|nego|while|dok)\b)|(?<=,)\s+(?=(?:this time|ovog puta|ve[cč]eras|tonight)\b)/iu)
    .map((value) => {
      const quote = value.trim();
      return { quote, words: normalizeTaxonomyText(quote.replace(/#[\p{L}\p{N}_-]+/gu, " ")) };
    }).filter(({ words }) => words && !INCIDENTAL.some((pattern) => pattern.test(words)));
}

function normalizedNames(input: ExplicitDiscoveryInput): string[] {
  return [...new Set([...(input.artists ?? []), input.venue].map(normalizeTaxonomyText).filter(Boolean))];
}

function removeNames(text: string, names: readonly string[]): string {
  return names.reduce((value, name) => value.replace(new RegExp(`\\b${name}\\b`, "g"), " "), text).trim().replace(/\s+/g, " ");
}

function styleWords(words: string, names: readonly string[]): string {
  return removeNames(words, names).replace(NON_MUSIC_GENRE_PHRASES, " ").trim().replace(/\s+/g, " ");
}

function isGenreList(words: string): boolean {
  const remainder = GENRES.reduce((text, genre) => text.replace(new RegExp(genreProof[genre].source, "g"), " "), words);
  return !remainder.replace(/\b(?:i|ili|ni|niti|and|or|nor)\b/g, " ").trim();
}

function isNegated(words: string, index: number, match: string, includeGenreList = false): boolean {
  if (NEGATIVE_END.test(words.slice(index + match.length))) return true;
  const before = words.slice(0, index);
  const last = [...before.matchAll(NEGATIVE_START)].at(-1);
  if (!last) return false;
  const between = before.slice(last.index + last[0].length);
  return !between.trim() || (includeGenreList && isGenreList(between));
}

function containsTerm(text: string, part: string): boolean {
  return Boolean(part) && ` ${text} `.includes(` ${part} `);
}

function hasAffirmedMatch(text: string, quote: string, pattern: RegExp, includeGenreList = false): boolean {
  const claims = [...text.matchAll(new RegExp(pattern.source, "g"))];
  if (!claims.length) return false;
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    if ((start && text[start - 1] !== " ") || (end < text.length && text[end] !== " ")) continue;
    if (claims.some((match) => match.index >= start && match.index + match[0].length <= end &&
      !isNegated(text, match.index, match[0], includeGenreList))) return true;
  }
  return false;
}

export function hasAffirmedDiscoveryCue(text: string, quote: string, pattern: RegExp, format?: DiscoveryFormat, date?: string): boolean {
  const except = format ? ACTIVITIES.find((rule) => rule.format === format)?.except : undefined;
  return clauses(text).some((part) => part.quote.includes(quote) && discoveryQuoteMatchesOccurrence(part.quote, date) && !except?.test(part.words) &&
    ((format === "talk" && part.quote.startsWith(quote) && PANEL_HEADING.test(quote)) ||
      hasAffirmedMatch(activityWords(part.quote), activityWords(quote), pattern)));
}

export function hasExplicitGenreEvidence(input: ExplicitDiscoveryInput, source: DiscoveryTextSource, quote: string, genre: MusicGenre): boolean {
  const names = normalizedNames(input);
  const proof = styleWords(normalizeTaxonomyText(quote), names);
  if (names.some((name) => containsTerm(name, proof)) &&
    !containsTerm(styleWords(normalizeTaxonomyText(input[source]), names), proof)) return false;
  return clauses(input[source] ?? "").some((part) => part.quote.includes(quote) && discoveryQuoteMatchesOccurrence(part.quote, input.date) && !NON_MUSIC_CONTEXT.test(part.words) &&
    hasAffirmedMatch(styleWords(part.words, names), proof, genreProof[genre], true));
}

export function getExcludedDiscoveryGenres(input: ExplicitDiscoveryInput): ReadonlySet<MusicGenre> {
  const excluded = new Set<MusicGenre>();
  const names = normalizedNames(input);
  for (const source of ["sourceCaption", "occurrenceText"] as const) {
    for (const { words, quote } of clauses((input[source] ?? "").slice(0, SOURCE_LIMIT[source]))) {
      if (!discoveryQuoteMatchesOccurrence(quote, input.date) || NON_MUSIC_CONTEXT.test(words)) continue;
      const text = styleWords(words, names);
      for (const genre of GENRES) {
        if ([...text.matchAll(new RegExp(genreProof[genre].source, "g"))].some((match) => isNegated(text, match.index, match[0], true))) {
          excluded.add(genre);
        }
      }
    }
  }
  return excluded;
}

type ActivityRule = { category: DiscoveryCategory; format?: DiscoveryFormat; cue: RegExp; except?: RegExp };

const ROUTINE_MENU = /\b(?:our menu|nas\w* menij\w*|svakog dana|every day|uvek u ponudi|u redovnoj ponudi|regular menu)\b/;
const PANEL_HEADING = /^(?:panel|панел)\s*[:–—-]\s*[\p{L}\p{N}]/iu;
export const ADVERTISED_TALK = /^razgovor\w* (?:o|povodom|sa|s)\b|\b(?:tribin\w*|panel (?:discussion|diskusij\w*|razgovor\w*)|promocij\w* knjig\w*|razgovor\w* (?:sa|s) (?:autor\w*|pisc\w*|reditelj\w*|umetni\w*|gost\w*)|discussion with (?:the )?(?:film s )?(?:authors?|directors?)|book discussion|(?:artist|author|curator|guest) talk|talk by|moderis\w* (?:razgovor\w*|diskusij\w*)|moderated (?:talk|discussion|conversation)|javn\w* razgovor\w*|razgovor vodi|vodi razgovor|q and a|(?:sledi|usledi\w*|followed by(?: a)?) (?:razgovor\w*|diskusij\w*|discussion))\b/;
const JAZZ_EVENING = /^(?:\d{1,2} \d{1,2}(?: \d{4})? )?(?:jazz|dzez|dzhaz|blues|bluz|blyuz) (?:vece|evening|night)(?: (?:ponedeljk\w*|utork\w*|sred\w*|cetvrtk\w*|petk\w*|subot\w*|nedelj\w*|monday\w*|tuesday\w*|wednesday\w*|thursday\w*|friday\w*|saturday\w*|sunday\w*))?$/;
const JAZZ_EVENING_CONFLICT = /\b(?:dj|di ?dzej|deejay|vinyl|gramofonsk\w* ploc\w*|playlist\w*|plejlist\w*|u pozadini|pozadinsk\w* muzik\w*|background (?:music|jazz)|bez (?:svirk\w*|(?:muzik\w* )?uzivo)|no live music|films? about|film\w* o|dokumentar\w*)\b/;
const UNCONFIRMED_LIVE_ACT = /^(?:dj|di ?dzej|deejay|tba|tbc|unknown|nepoznat\w*)\b/;

const ACTIVITIES: readonly ActivityRule[] = [
  { category: "other", cue: /\b(?:gledanj\w* utakmic\w*|prenos\w* utakmic\w*|projekc\w* utakmic\w*|sports? watch party|sports? screening|watch party za utakmic\w*)\b/ },
  { category: "party", format: "dj-set", cue: /\b(?:dj set\w*|di ?dzej set\w*|dj lineup|open decks|behind the decks|(?:dj|di ?dzej)(?: [a-z0-9]+){0,4} (?:pusta\w*|vrti\w*|plays?|spins?))\b/,
    except: /\b(?:dj radionic\w*|radionic\w* dj|dj workshop|dj school|skola dj|background music|u pozadini)\b/ },
  { category: "party", format: "party", cue: /\b(?:zurk\w*|club night|afterparty|after party|dance party|dance night|rave|rejv|maskenbal\w*)\b/,
    except: /\b(?:watch party|birthday party|zurk\w* za decu|rodjendansk\w* zurk\w*|projekc\w*|kviz\w*)\b/ },
  { category: "live", format: "concert", cue: /\b(?:koncert\w*|concert\w*|recital\w*|resital\w*)\b/,
    except: /\b(?:film o|film about|screening|projekc\w*|snim\w* koncert\w*|koncertn\w* dvoran\w*)\b/ },
  { category: "live", format: "live-performance", cue: /\b(?:svirk\w*|muzik\w* uzivo|ziv\w* muzik\w*|live music|live band|bend uzivo|nastup\w* uzivo)\b/,
    except: /\b(?:live stream|prenos\w* uzivo|u pozadini|background)\b/ },
  { category: "live", format: "tribute", cue: /\b(?:tribute (?:concert|band)|tribut\w* koncert\w*|cover band)\b/ },
  { category: "culture", format: "screening", cue: /\b(?:projekc\w* (?:film\w*|dokumentarc\w*)|filmsk\w* projekc\w*|film screening|documentary screening|kino ?pokaz\w*|(?:nakon|posle|after) (?:the )?(?:projekc\w*|screening))\b|^projekc\w*$/,
    except: /\b(?:utakmic\w*|sports?)\b/ },
  { category: "culture", format: "theatre", cue: /\b(?:pozorisn\w* predstav\w*|theat(?:re|er) play|monodram\w*|balet\w*|ballet\w*|mjuzikl\w*|opera)\b/ },
  { category: "culture", format: "stand-up", cue: /\b(?:stand up|standup|stendap|standap)\b/,
    except: /\b(?:radionic\w*|workshop\w*|masterclass)\b/ },
  { category: "culture", cue: /\b(?:poetsko vece|poetry reading|spoken word|dramsk\w* komad\w*)\b/ },
  { category: "exhibition", format: "exhibition", cue: /\b(?:izlozb\w*|exhibition\w*|vernissag\w*|vystavk\w*)\b/ },
  { category: "exhibition", format: "fair", cue: /\b(?:sajam\w*|sajm\w*|bazar\w*|bazaar\w*|buvljak\w*|flea market|craft market|vintage market|berz\w* ploc\w*)\b/ },
  { category: "participate", format: "quiz", cue: /\b(?:kviz\w*|quiz\w*|trivia|viktorin\w*)\b/ },
  { category: "participate", format: "workshop", cue: /\b(?:radionic\w*|workshop\w*|masterclass|master klass|dance (?:lessons?|class(?:es)?)|cas\w* ples\w*|kurs\w* ples\w*)\b/ },
  { category: "participate", format: "game", cue: /\b(?:bingo|board games?|drustven\w* igr\w*|turnir\w* u (?:pikad\w*|sah\w*)|dart tournament|chess tournament)\b/ },
  { category: "participate", format: "karaoke", cue: /\b(?:karaok\w*)\b/ },
  { category: "food", format: "tasting", cue: /\b(?:degustac\w*|wine tasting|beer tasting|coffee tasting)\b/, except: ROUTINE_MENU },
  { category: "food", cue: /\bbrunch\b/, except: ROUTINE_MENU },
  { category: "food", format: "dinner", cue: /\b(?:chef dinner|wine dinner|gala dinner|gala vecer\w*|vecer\w* i dj set|vecer\w* sa degustac\w*|vecer\w* uz degustac\w*)\b/, except: ROUTINE_MENU },
  { category: "food", format: "festival", cue: /\b(?:food festival|gastro festival|festival\w* hran\w*|festival\w* piv\w*|craft beer festival)\b/ },
  { category: "talk", format: "talk", cue: ADVERTISED_TALK },
  { category: "talk", format: "lecture", cue: /\b(?:predavanj\w*|lecture\w*|konferencij\w*|conference\w*)\b/ },
];

function findJazzEveningHeadline(
  input: ExplicitDiscoveryInput, bySource: Record<DiscoveryTextSource, Clause[]>,
  names: readonly string[], categories: ReadonlySet<DiscoveryCategory>,
): Pick<ExplicitDiscoveryEvidence, "source" | "quote"> | undefined {
  if (input.currentTaxonomy || (categories.size && !categories.has("live"))) return;
  const title = normalizeTaxonomyText(input.title);
  const venue = normalizeTaxonomyText(input.venue);
  // A genre-themed evening needs separate live proof or a performer billed in the announcement.
  if (!categories.has("live")) {
    const hasBilledAct = (input.artists ?? []).map(normalizeTaxonomyText).some((name) =>
      name && name !== title && name !== venue && !UNCONFIRMED_LIVE_ACT.test(name) &&
      [...bySource.occurrenceText, ...bySource.sourceCaption].some(({ words }) => containsTerm(words, name)));
    if (!hasBilledAct || DISCOVERY_TEXT_SOURCES.some((source) =>
      JAZZ_EVENING_CONFLICT.test(removeNames(normalizeTaxonomyText(input[source]), venue ? [venue] : [])))) return;
  }
  for (const source of ["title", "occurrenceText"] as const) {
    const match = bySource[source].find(({ quote }) => quote.length <= 120 && JAZZ_EVENING.test(removeNames(activityWords(quote), names)));
    if (match) return { source, quote: match.quote };
  }
}

export function classifyExplicitEventDiscovery(input: ExplicitDiscoveryInput): {
  taxonomy: EventDiscoveryTaxonomy; evidence: ExplicitDiscoveryEvidence[]; complete: boolean; titleCategory?: DiscoveryCategory;
} | null {
  const evidence: ExplicitDiscoveryEvidence[] = [];
  const categorySet = new Set<DiscoveryCategory>();
  const titleCategories = new Set<DiscoveryCategory>();
  const formatSet = new Set<DiscoveryFormat>();
  const names = normalizedNames(input);
  let incomplete = false;
  const bySource = Object.fromEntries(DISCOVERY_TEXT_SOURCES.map((source) => [source,
    clauses((input[source] ?? "").slice(0, SOURCE_LIMIT[source])).filter(({ quote }) => discoveryQuoteMatchesOccurrence(quote, input.date))])) as Record<DiscoveryTextSource, Clause[]>;
  if (!input.currentTaxonomy) {
    for (const source of CATEGORY_SOURCES) {
      for (const { quote, words } of bySource[source]) {
        const context = removeNames(activityWords(quote), names);
        for (const { category, format, cue, except } of ACTIVITIES) {
          const isPanel = format === "talk" && PANEL_HEADING.test(quote);
          if (except?.test(words) || (!isPanel && (!cue.test(context) || !hasAffirmedMatch(context, context, cue)))) continue;
          if (quote.length > 120 || /\b(?:tbc|mozda|maybe|ako bude|subject to change|to be confirmed)\b/.test(context)) {
            incomplete = true;
            continue;
          }
          if (source === "title") titleCategories.add(category);
          if (!categorySet.has(category)) {
            categorySet.add(category);
            evidence.push({ kind: "category", label: category, source, quote });
          }
          if (format && !formatSet.has(format)) {
            formatSet.add(format);
            evidence.push({ kind: "format", label: format, source, quote });
          }
        }
      }
    }
  }
  const jazzHeadline = findJazzEveningHeadline(input, bySource, names, categorySet);
  if (jazzHeadline) {
    if (jazzHeadline.source === "title") titleCategories.add("live");
    if (!categorySet.has("live")) {
      categorySet.add("live");
      formatSet.add("live-performance");
      evidence.push({ kind: "category", label: "live", ...jazzHeadline }, { kind: "format", label: "live-performance", ...jazzHeadline });
    }
  }
  if (categorySet.size > 1 && categorySet.delete("other")) incomplete = true;
  const onlyTitleCategory = titleCategories.size === 1 ? [...titleCategories][0] : undefined;
  const titleCategory = onlyTitleCategory && categorySet.has(onlyTitleCategory) ? onlyTitleCategory : undefined;
  const categories = input.currentTaxonomy?.categories ?? [...new Set([...(titleCategory ? [titleCategory] : []), ...categorySet])];
  const primaryCategory = input.currentTaxonomy?.primaryCategory ?? categories[0];
  if (!primaryCategory) return null;
  const music = categories.includes("party") || categories.includes("live");
  const excluded = getExcludedDiscoveryGenres(input);
  const genres = new Set<MusicGenre>();
  const plausibleGenres = new Set<MusicGenre>();
  if (music && !input.currentTaxonomy?.genres.length) {
    for (const source of DISCOVERY_TEXT_SOURCES) {
      for (const { quote, words } of bySource[source]) {
        const context = styleWords(words, names);
        if (NON_MUSIC_CONTEXT.test(context)) continue;
        const strong = MUSIC_CUE.test(context) || STYLE_FIELD.test(quote) ||
          (source === jazzHeadline?.source && quote === jazzHeadline.quote) ||
          (source === "title" && (Boolean(input.currentTaxonomy) && isGenreList(context) ||
            ACTIVITIES.some(({ category, cue }) => (category === "party" || category === "live") && cue.test(context))));
        for (const genre of GENRES) {
          if (excluded.has(genre) || !genreProof[genre].test(context) || !hasExplicitGenreEvidence(input, source, quote, genre)) continue;
          if (!strong || quote.length > 120) {
            plausibleGenres.add(genre);
            continue;
          }
          if (!genres.has(genre)) {
            genres.add(genre);
            evidence.push({ kind: "genre", label: genre, source, quote });
          }
        }
      }
      if (genres.size) break;
    }
  }
  if ([...genres].some((genre) => SPECIFIC_ELECTRONIC.includes(genre))) genres.delete("electronic");
  const selectedGenres = input.currentTaxonomy?.genres.length ? input.currentTaxonomy.genres : [...genres].slice(0, 5);
  return {
    taxonomy: { primaryCategory, categories, formats: input.currentTaxonomy?.formats ?? [...formatSet], genres: selectedGenres },
    titleCategory,
    evidence: evidence.filter(({ kind, label }) => (kind !== "genre" || selectedGenres.includes(label as MusicGenre)) &&
      (kind !== "category" || categories.includes(label as DiscoveryCategory))),
    complete: !incomplete && (Boolean(input.currentTaxonomy) || categories.length === 1) &&
      [...plausibleGenres].every((genre) => selectedGenres.includes(genre)) && genres.size <= 5,
  };
}
