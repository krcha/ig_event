import type { DiscoveryCategory, DiscoveryFormat, EventDiscoveryTaxonomy, MusicGenre } from "./event-discovery";
import { billedHeadlineMatchesDate, billedMusicProgramme } from "./billed-music-programme";
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

// Inputs are normalized (hyphens/diacritics included). Named compound styles
// must not independently prove a broader token's bucket: post-punk is not punk,
// and qualified experimental/indie folk is not this taxonomy's regional folk.
export const genreProof: Record<MusicGenre, RegExp> = {
  electronic: /\b(?:electronic(?:a)?|elektronsk\w* muzik\w*|elektronik\w*|elektronn\w* muzy\w*|edm|electro|idm|hardstyle|hardcore techno|breakcore|breakbeat|break beat)\b/,
  house: /\b(?:house|haus)(?:a|u|om)?\b/,
  techno: /\b(?:techn[oa]|tekn[oa]|tehn[oa]|schranz)\b/,
  trance: /\b(?:trance|psytrance|psy trance|psajtrens|trans muzik\w*)\b/,
  "drum-and-bass": /\b(?:drum (?:and |n )?bass|dram (?:end |en |n )?bejs|dnb|jungle)\b/,
  "disco-funk": /\b(?:disco|disko|funk|fank|funky|fanki)\b/,
  pop: /\b(?:pop(?! up\b)|britpop|electropop|synthpop|hyperpop|schlager|slager)\b/,
  rock: /\b(?:rock(?:a|u|om)?|rok|folk rok(?:a|u|om)|rokenrol\w*|rockabilly|r n r)\b/,
  "indie-alternative": /\b(?:indie|indi|alternativ\w*|post ?(?:punk|pank)|emo|grunge|shoegaze|doomgaze|new wave|darkwave|industrial|ebm|aggrotech|futurepop|dark electro|americana)\b/,
  "metal-punk": /\b(?:metal(?:a|u|om)?|(?<!post )(?:pank|punk)|metalcore|thrashcore|post hardcore|screamo)\b/,
  "hip-hop": /\b(?:hip ?hop(?:a|u|om)?|rap|rep|trap)\b/,
  "rnb-soul": /\b(?:r and b|r n b|rnb|rhythm and blues|ritam i bluz|soul)\b/,
  "jazz-blues": /\b(?:(?:jazz|dzez|dzhaz)(?:a|u|om)?|(?<!rhythm and |ritam i )(?:blues|bluz|blyuz)(?:a|u|om)?|swing)\b/,
  folk: /\b(?:(?<!weird )(?<!freak )(?<!indie )folk(?! (?:rock|rok|metal|punk|pank)(?:a|u|om)?\b)|turbo folk|narodn\w* muzik\w*|narodn\w* orkest\w*|narodn\w* pesm\w*|starogradsk\w* (?:muzik\w*|pesm\w*))\b/,
  classical: /\b(?:classical|klasicn\w* muzik\w*|klassichesk\w* muzy\w*|klavirsk\w* resital\w*|piano recital|harpsichord concert|opera|baroque|barok)\b/,
  latin: /\b(?:latino|latin(?: music)?|salsa|bachata|reggaeton|flamenco|kubansk\w* muzik\w*)\b/,
  "afro-amapiano": /\b(?:afrobeats?|afro beats?|amapiano|afro house)\b/,
  "reggae-dub": /\b(?:reggae|rege|dub|dancehall|dance hall)\b/,
  ambient: /\b(?:ambient|ambijent\w* muzik\w*|drone)\b/,
  "etno-world": /\b(?:etno|ethno|world music|muzik\w* svet\w*|tradicionaln\w* muzik\w*)\b/,
};

const GENRES = Object.keys(genreProof) as MusicGenre[];
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
const MUSIC_CUE = /\b(?:will play|plays?|spins?|pusta\w*|vrti\w*|svir\w*|izvodi\w*|repertoar\w*|muzick\w* putovanj\w*|music|muzik\w*|genres?|zanr\w*|music policy|dj set|live set)\b/;
const STYLE_FIELD = /^(?:music(?: policy)?|muzik\w*|genres?|zanr\w*|sound|stil(?:ovi)?|repertoar)\s*[:=–—-]/iu;
const NEGATIVE_START = /\b(?:without|bez|not(?: playing)?|no|won t play|don t play|nije|nema|ne (?:pusta\w*|svira\w*|vrti\w*)|nece (?:pust\w*|svir\w*|vrt\w*))(?: (?:any|ikakv\w*|a|an))? /g;
const NEGATIVE_END = /^ (?:is |will be |je |bice )?(?:excluded|canceled|cancelled|otkazan\w*|iskljucen\w*|not (?:played|included|on the program)|nije u programu)\b/;
const NON_MUSIC_GENRE_PHRASES = /\b(?:blues|jazz|rock|house|techno|pop) (?:club|bar|stage|venue|wine)\b/g;
const PROGRAMME_STYLE_SUFFIX = /\b(?:vece|evening|night|session|sesij\w*|muzik\w*|music|svirk\w*|koncert\w*|concert\w*)$/;
const PROGRAMME_STYLE_PREFIX = /^(?:(?:an?|the) )?(?:evening|night) of /;
const SPECIALIST_LIVE_HOST = /\b(?:jazz|dzez|dzhaz|blues|bluz|blyuz) (?:club|klub|bar)\b/;
const DATED_PROGRAMME_ROW = /^(?:(\p{L}+)\.?\s+)?(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\.?\s*[-–—|:]\s*(\S.*)$/u;
const WEEKDAY = /^(?:pon|ponedeljak|uto|utorak|sre|sreda|cet|cetvrtak|pet|petak|sub|subota|ned|nedelja|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)$/;

type Clause = { quote: string; words: string };

function activityWords(text: string): string {
  // A parenthetical activity can be a speaker's affiliation or a work title.
  // Look outside it for what attendees are actually invited to do.
  return normalizeTaxonomyText(text.replace(/\([^()]*\)|#[\p{L}\p{N}_-]+/gu, " "));
}

function readDatedProgrammeRow(quote: string) {
  const match = DATED_PROGRAMME_ROW.exec(quote.trim());
  if (!match || (match[1] && !WEEKDAY.test(normalizeTaxonomyText(match[1])))) return;
  const [, , day, month, year, bill] = match;
  if (Number(day) < 1 || Number(day) > 31 || Number(month) < 1 || Number(month) > 12) return;
  return { day: Number(day), month: Number(month), year, bill };
}

function programmeRows(text: string): string[] {
  return text.split(/[\r\n]+/u).flatMap((line) => {
    const rows: string[] = [];
    let start = 0;
    for (const delimiter of line.matchAll(/;\s*/gu)) {
      const next = delimiter.index + delimiter[0].length;
      if (!readDatedProgrammeRow(line.slice(next))) continue;
      rows.push(line.slice(start, delimiter.index));
      start = next;
    }
    rows.push(line.slice(start));
    return rows;
  });
}

export function discoveryQuoteMatchesOccurrence(quote: string, date: string | undefined | null): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const scheduled = readDatedProgrammeRow(quote);
  if (scheduled && (scheduled.day !== Number(date.slice(-2)) || scheduled.month !== Number(date.slice(5, 7)) ||
    (scheduled.year && scheduled.year !== date.slice(0, 4)))) return false;
  const days = [...normalizeTaxonomyText(quote).matchAll(
    /\b(?:planiran\w* za|zakazan\w* za|scheduled for) (\d{1,2})(?!\d)\b/g,
  )].map(([, day]) => Number(day)).filter((day) => day >= 1 && day <= 31);
  return !days.length || days.every((day) => day === Number(date.slice(-2)));
}

export function summaryCancelsEvent(title: string | undefined, description: string | undefined): boolean {
  if (!description) return false;
  const name = normalizeTaxonomyText(title);
  return description.slice(0, 500).split(/[.!?;\n]/).some((sentence) => {
    const match = /^(?:(?:the|this) )?(.+?) (?:was |is |has been |je )?(?:cancell?ed|otkazan[aoie]?)(?: (?:due to|because|zbog) .+)?$/.exec(normalizeTaxonomyText(sentence));
    return match && (match[1] === name || match[1] === "event" || match[1] === "dogadjaj");
  });
}

// Evaluate the calendar date before splitting sentences. Dots inside "27.11"
// belong to the occurrence and cannot be treated as sentence terminators.
const ACTIVITY_NOUN = "live music|koncert\\w*|concert|dj set|festival|radionic\\w*|workshop|quiz|kviz|projekc\\w*|screening|predstav\\w*|exhibition|izlozb\\w*|party|zurk\\w*|panel|talk|lecture|speed dating";
const CANCELLED_ACTIVITY = new RegExp(`\\b(?:otkazan\\w* (?:${ACTIVITY_NOUN})|(?:${ACTIVITY_NOUN}) (?:is |je )?(?:cancell?ed|otkazan\\w*))\\b`);
const EXCLUDED_ACTIVITY = new RegExp(`\\b(?:no|without|bez|nema) (${ACTIVITY_NOUN})\\b`);

const MUSIC_ROLE_TERMS = {
  party: /(?:dj|didzej) (?:sets?|seta|setova|nastup[aie]?)|party|parties|zurk[aeiu]|zabav[aeu]/,
  live: /live (?:music|shows?|concerts?|bands?|performances?)|concerts?|koncer(?:t[aieu]?|ata)|svirk[aeiu]|(?:ziv[aeu] muzik[aeu]|muzik[aeu] uzivo)|nastup[aie]? uzivo/,
};
const MUSIC_DENIAL = /(?:no|without|not|nece biti|nema|bez|nije)/;
const MUSIC_WHEN = /(?:tonight|today|at this event|on the programme?|this time|ovog (?:puta|petka)|ovde|veceras|danas|u programu)/;
const deniedRole = (term: RegExp) => new RegExp(
  `\\b${MUSIC_DENIAL.source} (?:any |an? |nikakv\\w* )?(?:${term.source})(?: ${MUSIC_WHEN.source})?$`,
);
const roleDenials = { party: deniedRole(MUSIC_ROLE_TERMS.party), live: deniedRole(MUSIC_ROLE_TERMS.live) };

/** An artist profile may establish a role only if this occurrence permits it. */
export function isExternalMusicRoleExcluded(input: ExplicitDiscoveryInput, role: "party" | "live"): boolean {
  return DISCOVERY_TEXT_SOURCES.some(source => {
    let dateMatches = true;
    return programmeRows((input[source] ?? "").slice(0, SOURCE_LIMIT[source])).some(line => {
      const heading = /^(?:(\p{L}+\.?)\s+)?(\d{1,2}[./]\d{1,2}(?:[./]\d{4})?)\.?\s*(?:[-–—|:]\s*|\s+|$)(.*)$/u.exec(line.trim());
      if (heading && (!heading[1] || WEEKDAY.test(normalizeTaxonomyText(heading[1])))) {
        dateMatches = discoveryQuoteMatchesOccurrence(`${heading[2]} - program`, input.date);
        line = heading[3];
      }
      if (!dateMatches || !discoveryQuoteMatchesOccurrence(line, input.date)) return false;
      return line.split(/[,.!?:;–—]/u).some(part =>
        clauses(part).some(({ words }) => roleDenials[role].test(words)));
    });
  });
}

export function hasConflictingProgrammeEvidence(input: ExplicitDiscoveryInput): boolean {
  const scoped = DISCOVERY_TEXT_SOURCES.flatMap(source => programmeRows((input[source] ?? "").slice(0, SOURCE_LIMIT[source]))
    .filter(line => discoveryQuoteMatchesOccurrence(line.trim(), input.date))
    .flatMap(line => clauses(readDatedProgrammeRow(line)?.bill ?? line)));
  return scoped.some(({ quote, words }) => {
    if (summaryCancelsEvent(input.title, quote) || CANCELLED_ACTIVITY.test(words)) return true;
    const denied = EXCLUDED_ACTIVITY.exec(words);
    if (!denied) return false;
    // A DJ night can explicitly say "no live music". Only contradictory
    // positive evidence for that activity should disqualify its programme.
    const term = new RegExp(`\\b${denied[1]}\\b`);
    return scoped.some(part => hasAffirmedMatch(part.words, part.words, term));
  });
}

function clauses(text: string): Clause[] {
  // Keep a dated programme line whole so its claims cannot lose their date.
  return programmeRows(text).flatMap((line) => readDatedProgrammeRow(line) ? [line] :
    line.split(/(?<=[.!?;])\s+|\s+(?=(?:but|ali|nego|while|dok)\b)|(?<=,)\s+(?=(?:this time|ovog puta|ve[cč]eras|tonight)\b)/iu))
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

// In a show listing, take styles from the words describing the programme.
// A club name, opening band's name, review or artist biography is not a style.
const OTHER_SHOW_CONTEXT = /\b(?:tribute|tribut\w*|covers?|oma[zj]\w*|listening|preslusavanj\w*|slusaonic\w*|about|film\w*|bioskop\w*|theat\w*|pozoris\w*|panel|talk|screening|podcast|playlist|radio|recap|previous|formerly|regularly|venue|poznat\w* po|cancel\w*|otkazan\w*|postponed|no|not|without|bez|nije|nema|mozda|maybe)\b/;
const SHOW_STYLE_QUALIFIERS = /\b(?:sludge|doom|prog|progressive|ex yu|hits?|millennials)\b/g;

function confirmedShowStyles(words: string, names: readonly string[]) {
  const styles = styleWords(words, names);
  return styles && isGenreList(styles.replace(SHOW_STYLE_QUALIFIERS, " "))
    ? GENRES.filter(genre => genreProof[genre].test(styles)) : [];
}

// A scoped invitation can bill the music across several floors without naming
// a DJ set. Keep the dated invitation separate from the quoted music promise.
function advertisedDancefloors(original: string, names: readonly string[], date: string | null | undefined) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || OTHER_SHOW_CONTEXT.test(normalizeTaxonomyText(original)) ||
      NON_MUSIC_CONTEXT.test(normalizeTaxonomyText(original))) return;
  const bill = /^join us on ([a-z]+ \d{1,2}) (across (?:two|three|\d) dancefloors?(?: at [^\s]{1,45})? for a night of ([\p{L} &,-]{2,82}))[.!]?$/iu.exec(original);
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][Number(date.slice(5, 7)) - 1];
  if (!bill || bill[1].toLowerCase() !== month + " " + Number(date.slice(8)) || bill[2].length > 120) return;
  const styles = confirmedShowStyles(normalizeTaxonomyText(bill[3]).replace(/\b(?:deep|immersive|multi layered)\b/g, " "), names);
  if (styles.length) return { quote: bill[2], styles, role: "party" as const };
}

function showStyles(original: string, names: readonly string[]) {
  const raw = readDatedProgrammeRow(original)?.bill ?? original;
  const text = normalizeTaxonomyText(raw);
  if (OTHER_SHOW_CONTEXT.test(text) || NON_MUSIC_CONTEXT.test(text)) return;
  const show = /^(?:(?:a|an|the) )?(.*?)\b(show|gig|concert|svirka|koncert|party|club night)(?: (?:with|featuring) (.+))?$/.exec(text);
  // A Serbian announcement can describe the coming performance in the future tense.
  const sound = /(?:^|\s)((?:će|ce) se oriti [\p{L}\s]{1,65} notama\s+[^.!?;]+)/iu.exec(raw);
  const selection = /^(([\p{L}&'’ -]{1,40}?) (?:nostalgija|nostalgia night|u svim svojim nijansama|across its shades))(?=\s*[,;.!?]|$)/iu.exec(raw);
  if (!show && !sound && !selection) return;
  const role: "party" | "live" = selection || show && (show[2] === "party" || show[2] === "club night") ? "party" : "live";
  const stylePhrases = selection ? [normalizeTaxonomyText(selection[2])] :
    sound ? [normalizeTaxonomyText(sound[1]).split(" notama ")[1]!] : [show![1], show![3] ?? ""];
  const styles = [...new Set(stylePhrases.flatMap(phrase => confirmedShowStyles(phrase, names)))];
  if (!styles.length) return;
  const quote = selection?.[1] ?? sound?.[1] ?? raw;
  if (quote.length <= 120) return { quote, styles, role };
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
  return clauses(input[source] ?? "").some((part) => {
    if (!part.quote.includes(quote) || !discoveryQuoteMatchesOccurrence(part.quote, input.date) || NON_MUSIC_CONTEXT.test(part.words)) return false;
    if (source === "sourceCaption" || source === "occurrenceText") {
      const floors = advertisedDancefloors(part.quote, names, input.date);
      if (floors?.quote === quote) return floors.styles.includes(genre) &&
        !OTHER_SHOW_CONTEXT.test(normalizeTaxonomyText(input.title)) && !NON_MUSIC_CONTEXT.test(normalizeTaxonomyText(input.title)) &&
        !isExternalMusicRoleExcluded(input, "party");
    }
    const programme = showStyles(quote, names);
    if (programme?.styles.includes(genre)) {
      const current = showStyles(part.quote, names);
      const title = normalizeTaxonomyText(input.title);
      return Boolean(current?.styles.includes(genre)) && !OTHER_SHOW_CONTEXT.test(title) && !NON_MUSIC_CONTEXT.test(title) && !isExternalMusicRoleExcluded(input, programme.role) &&
        !getExcludedDiscoveryGenres(input, DISCOVERY_TEXT_SOURCES).has(genre);
    }
    return hasAffirmedMatch(styleWords(part.words, names), proof, genreProof[genre], true);
  });
}

export function getExcludedDiscoveryGenres(input: ExplicitDiscoveryInput, sources: readonly DiscoveryTextSource[] = ["sourceCaption", "occurrenceText"]): ReadonlySet<MusicGenre> {
  const excluded = new Set<MusicGenre>();
  const names = normalizedNames(input);
  for (const source of sources) {
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

/** A genre may be explicit in this listing while the activity itself is unresolved. */
export function scopedProgrammeGenreEvidence(input: ExplicitDiscoveryInput, music: EventDiscoveryTaxonomy): ExplicitDiscoveryEvidence[] {
  if (!["live", "party"].includes(music.primaryCategory) || hasConflictingProgrammeEvidence(input) ||
    isExternalMusicRoleExcluded(input, music.primaryCategory as "live" | "party")) return [];
  const current = classifyExplicitEventDiscovery({ ...input, currentTaxonomy: { ...music, genres: [] } });
  const excluded = getExcludedDiscoveryGenres(input, DISCOVERY_TEXT_SOURCES);
  const result: ExplicitDiscoveryEvidence[] = [];
  for (const claim of current?.evidence ?? []) {
    if (claim.kind !== "genre" || excluded.has(claim.label as MusicGenre)) continue;
    for (const source of ["sourceCaption", "occurrenceText"] as const) {
      const raw = input[source] ?? "";
      // A clipping boundary may have removed the end of a negative statement.
      if (!raw || raw.length >= SOURCE_LIMIT[source] || raw.trimEnd().endsWith("…") || raw.trimEnd().endsWith("...")) continue;
      let quote = claim.source === source ? claim.quote : undefined;
      if (!quote && claim.source === "description") {
        // Corroborate a translated genre list with the announced evening in the
        // original source. Individual biographies elsewhere in the caption do not qualify.
        for (const part of clauses(raw)) {
          if (!discoveryQuoteMatchesOccurrence(part.quote, input.date) || !/\b(?:ocekuje nas|pred nama je) vece\b.*\bmuzik\w*\b/.test(part.words)) continue;
          const list = /[–—-]\s*(uz\s+[^.!?;]{3,115})[.!?]?$/iu.exec(part.quote)?.[1];
          if (list && hasExplicitGenreEvidence(input, source, list, claim.label as MusicGenre)) { quote = list; break; }
        }
      }
      if (quote && hasExplicitGenreEvidence(input, source, quote, claim.label as MusicGenre)) {
        result.push({ ...claim, source, quote });
        break;
      }
    }
  }
  return result;
}

export function corroborateLiveProgrammeGenre(input: ExplicitDiscoveryInput, taxonomy: EventDiscoveryTaxonomy): {
  genre: MusicGenre; occurrenceText: string;
} | undefined {
  if (taxonomy.primaryCategory !== "live" || taxonomy.genres.length ||
    !taxonomy.formats.some((format) => format === "concert" || format === "live-performance") ||
    !input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.occurrenceText) return;
  const title = normalizeTaxonomyText(input.title);
  const venue = normalizeTaxonomyText(input.venue);
  if (title === venue || !SPECIALIST_LIVE_HOST.test(venue) || !genreProof["jazz-blues"].test(title) ||
    GENRES.some((genre) => genre !== "jazz-blues" && genreProof[genre].test(title))) return;

  // The exact dated bill must corroborate the performer and its name must
  // carry the same genre family as the venue. This remains an estimate.
  const hasNamedAct = input.artists?.some((artist) => {
    const name = normalizeTaxonomyText(artist);
    return name !== venue && containsTerm(title, name) && genreProof["jazz-blues"].test(name);
  });
  if (!hasNamedAct || getExcludedDiscoveryGenres(input).has("jazz-blues")) return;
  for (const line of programmeRows(input.occurrenceText.slice(0, SOURCE_LIMIT.occurrenceText))) {
    const quote = line.trim();
    const scheduled = readDatedProgrammeRow(quote);
    if (scheduled && discoveryQuoteMatchesOccurrence(quote, input.date) && normalizeTaxonomyText(scheduled.bill) === title) {
      return { genre: "jazz-blues", occurrenceText: quote };
    }
  }
}

type ActivityRule = { category: DiscoveryCategory; format?: DiscoveryFormat; cue: RegExp; except?: RegExp };

const ROUTINE_MENU = /\b(?:our menu|nas\w* menij\w*|svakog dana|every day|uvek u ponudi|u redovnoj ponudi|regular menu)\b/;
const PANEL_HEADING = /^(?:panel|панел)\s*[:–—-]\s*[\p{L}\p{N}]/iu;
export const ADVERTISED_TALK = /^razgovor\w* (?:o|povodom|sa|s)\b|\b(?:tribin\w*|panel (?:discussion|diskusij\w*|razgovor\w*)|promocij\w* (?:knjig\w*|monografij\w*)|razgovor\w* (?:sa|s) (?:autor\w*|pisc\w*|reditelj\w*|umetni\w*|gost\w*)|discussion with (?:the )?(?:film s )?(?:authors?|directors?)|book (?:discussion|presentation)|(?:artist|author|curator|guest) talk|talk by|moderis\w* (?:razgovor\w*|diskusij\w*)|moderated (?:talk|discussion|conversation)|javn\w* razgovor\w*|razgovor vodi|vodi razgovor|q and a|(?:sledi|usledi\w*|followed by(?: a)?) (?:razgovor\w*|diskusij\w*|discussion))\b/;
const JAZZ_EVENING = /^(?:\d{1,2} \d{1,2}(?: \d{4})? )?(?:jazz|dzez|dzhaz|blues|bluz|blyuz) (?:vece|evening|night)(?: (?:ponedeljk\w*|utork\w*|sred\w*|cetvrtk\w*|petk\w*|subot\w*|nedelj\w*|monday\w*|tuesday\w*|wednesday\w*|thursday\w*|friday\w*|saturday\w*|sunday\w*))?$/;
const JAZZ_EVENING_CONFLICT = /\b(?:dj|di ?dzej|deejay|vinyl|gramofonsk\w* ploc\w*|playlist\w*|plejlist\w*|u pozadini|pozadinsk\w* muzik\w*|background (?:music|jazz)|bez (?:svirk\w*|(?:muzik\w* )?uzivo)|no live music|films? about|film\w* o|dokumentar\w*)\b/;
const UNCONFIRMED_LIVE_ACT = /^(?:dj|di ?dzej|deejay|tba|tbc|unknown|nepoznat\w*)\b/;

const ACTIVITIES: readonly ActivityRule[] = [
  { category: "other", cue: /\b(?:gledanj\w* utakmic\w*|prenos\w* utakmic\w*|projekc\w* utakmic\w*|sports? watch party|sports? screening|watch party za utakmic\w*)\b/ },
  { category: "party", format: "dj-set", cue: /\b(?:dj set\w*|di ?dzej set\w*|dj lineup|all night dj program(?:me)?|open decks|behind the decks|(?:dj|di ?dzej)(?: [a-z0-9]+){0,4} (?:pusta\w*|vrti\w*|plays?|spins?))\b/,
    except: /\b(?:dj radionic\w*|radionic\w* dj|dj workshop|dj school|skola dj|background music|u pozadini)\b/ },
  { category: "party", format: "party", cue: /\b(?:zurk\w*|club night|afterparty|after party|dance party|dance night|rave|rejv|maskenbal\w*)\b/,
    except: /\b(?:watch party|birthday party|zurk\w* za decu|rodjendansk\w* zurk\w*|projekc\w*|kviz\w*)\b/ },
  { category: "live", format: "concert", cue: /\b(?:koncert\w*|concert\w*|recital\w*|resital\w*)\b/,
    except: /\b(?:film o|film about|screening|projekc\w*|snim\w* koncert\w*|koncertn\w* dvoran\w*|(?:quiz|trivia|kviz\w*|workshop|radionic\w*) (?:about|on|o))\b/ },
  { category: "live", format: "live-performance", cue: /\b(?:svirk\w*|muzik\w* uzivo|ziv\w* muzik\w*|live music|live band|bend uzivo|nastup\w* uzivo)\b/,
    except: /\b(?:live stream|prenos\w* uzivo|u pozadini|background)\b/ },
  { category: "live", format: "tribute", cue: /\b(?:tribute (?:concert|band)|tribut\w* koncert\w*|cover band)\b/ },
  { category: "culture", format: "screening", cue: /\b(?:projekc\w* (?:film\w*|dokumentarc\w*)|filmsk\w* projekc\w*|film screening|documentary screening|kino ?pokaz\w*|(?:nakon|posle|after) (?:the )?(?:projekc\w*|screening))\b|^projekc\w*$/,
    except: /\b(?:utakmic\w*|sports?)\b/ },
  { category: "culture", format: "theatre", cue: /\b(?:(?:pozorisn\w*|premijer\w*) predstav\w*|theat(?:re|er) play|monodram\w*|balet\w*|ballet\w*|mjuzikl\w*|opera)\b/ },
  { category: "culture", format: "theatre", cue: /\b(?:(?:uzrast\w*|tem\w*|termin\w*|trajanj\w*) predstave (?:\w+ ){0,3}(?:ulaznice|karte)|(?:rezervisite|kupite|obezbedite) (?:svoje )?(?:ulaznice|karte) za predstavu)\b/,
    except: /\b(?:snimak|snimljen\w*|projekc\w*|film|nagradn\w*|giveaway)\b/ },
  { category: "culture", format: "stand-up", cue: /\b(?:stand up|standup|stendap|standap)\b/,
    except: /\b(?:radionic\w*|workshop\w*|masterclass)\b/ },
  { category: "culture", format: "festival", cue: /\b(?:film festival|filmsk\w* festival\w*|festival\w* (?:autorsk\w* |nem\w* |kratk\w* |dokumentarn\w* )?film\w*)\b/ },
  { category: "culture", cue: /^(?:modna revija|fashion show)(?:$| (?:u|na|at)\b)/ },
  { category: "culture", cue: /\b(?:poetsko vece|poetry reading|spoken word|dramsk\w* komad\w*)\b/ },
  { category: "exhibition", format: "exhibition", cue: /\b(?:izlozb\w*|exhibition\w*|vernissag\w*|vystavk\w*)\b/ },
  { category: "exhibition", format: "fair", cue: /\b(?:sajam\w*|sajm\w*|bazar\w*|bazaar\w*|buvljak\w*|flea market|craft market|vintage market|berz\w* ploc\w*)\b/ },
  { category: "participate", format: "quiz", cue: /\b(?:kviz\w*|quiz\w*|trivia|viktorin\w*)\b/ },
  { category: "participate", format: "workshop", cue: /\b(?:radionic\w*|workshop\w*|masterclass|master klass|dance (?:lessons?|class(?:es)?)|cas\w* ples\w*|kurs\w* ples\w*)\b/ },
  { category: "participate", format: "game", cue: /\b(?:bingo|board games?|drustven\w* igr\w*|turnir\w* u (?:pikad\w*|sah\w*)|dart tournament|chess tournament)\b/ },
  { category: "participate", format: "karaoke", cue: /\b(?:karaok\w*)\b/ },
  { category: "food", format: "tasting", cue: /\b(?:degustac\w*|wine tasting|beer tasting|coffee tasting)\b/, except: ROUTINE_MENU },
  { category: "food", cue: /^dani (?:[a-z]+ ){0,2}kuhinje$/, except: ROUTINE_MENU },
  { category: "food", cue: /\bbrunch\b/, except: ROUTINE_MENU },
  { category: "food", format: "dinner", cue: /\b(?:chef dinner|wine dinner|gala dinner|gala vecer\w*|vecer\w* i dj set|vecer\w* sa degustac\w*|vecer\w* uz degustac\w*)\b/, except: ROUTINE_MENU },
  { category: "food", format: "festival", cue: /\b(?:food festival|gastro festival|festival\w* hran\w*|festival\w* piv\w*|craft beer festival)\b/ },
  { category: "talk", format: "talk", cue: ADVERTISED_TALK },
  { category: "talk", format: "talk", cue: /^predstavljanje (?:knjige|memoara|monografije)\b/ },
  { category: "talk", format: "lecture", cue: /\b(?:predavanj\w*|lecture\w*|konferencij\w*|conference\w*)\b/ },
];

function advertisedHeadline(input: ExplicitDiscoveryInput, bySource: Record<DiscoveryTextSource, Clause[]>, names: string[]) {
  const title = normalizeTaxonomyText(input.title);
  if (!title || names.includes(title)) return;
  const styleParty = /\bparty$/.test(title) && showStyles(input.title ?? "", names)?.role === "party";
  const speedDating = /^(?:[a-z0-9]+ ){0,3}speed dating$/.test(title);
  if (!styleParty && !speedDating) return;
  const parts = Object.values(bySource).flat();
  if (parts.some(({ words }) => NON_MUSIC_CONTEXT.test(words) ||
    /\b(?:film|movie|documentary|predstav\w*|theat\w*|predavanj\w*|lecture|intervju|interview|radionic\w*|otkazan\w*|cancel\w*|postponed|odlozen\w*)\b/.test(words))) return;
  if (speedDating && !bySource.sourceCaption.some(({ words }) =>
    /\b(?:potvrd\w* ucesca|prijav\w* za (?:ucesc\w*|upoznavanj\w*)|(?:rezervisite|prijavite se) za upoznavanje|meet (?:other |new )?singles|register (?:to meet|for speed dating))\b/.test(words))) return;
  for (const source of ["occurrenceText", "sourceCaption"] as const) {
    for (const { quote } of bySource[source]) {
      const parentLines = (input[source] ?? "").split(/\r?\n/u).filter(line => line.includes(quote));
      if (quote.length > 120 || !parentLines.length || parentLines.some(line => !billedHeadlineMatchesDate(line, input.date)) ||
          !discoveryQuoteMatchesOccurrence(quote, input.date)) continue;
      const headline = quote.split(/\s+[|—–]\s+/u, 1)[0].trim();
      const name = normalizeTaxonomyText(headline).replace(/ je tu$/, "");
      if (name === title) return { category: styleParty ? "party" as const : "participate" as const,
        format: styleParty ? "party" as const : undefined, source, quote: headline };
    }
  }
}

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

export function classifyExplicitEventDiscovery(input: ExplicitDiscoveryInput, fallbackCategory?: DiscoveryCategory): {
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
  let billedSelection = false;
  if (!input.currentTaxonomy && !categorySet.size) {
    const eventName = normalizeTaxonomyText(input.title);
    const floors = !OTHER_SHOW_CONTEXT.test(eventName) && !NON_MUSIC_CONTEXT.test(eventName) &&
      bySource.sourceCaption.map(({ quote }) => advertisedDancefloors(quote, names, input.date)).find(Boolean);
    const billed = advertisedHeadline(input, bySource, names) ??
      (floors ? { category: "party" as const, format: "party" as const, source: "sourceCaption" as const, quote: floors.quote } : undefined) ??
      billedMusicProgramme(input, bySource);
    if (billed && (billed.category === "participate" || !isExternalMusicRoleExcluded(input, billed.category))) {
      const { category, format, source, quote } = billed;
      billedSelection = category === "party" && !format;
      categorySet.add(category);
      evidence.push({ kind: "category", label: category, source, quote });
      if (format) {
        formatSet.add(format);
        evidence.push({ kind: "format", label: format, source, quote });
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
  if (!categorySet.size && fallbackCategory) categorySet.add(fallbackCategory);
  const onlyTitleCategory = titleCategories.size === 1 ? [...titleCategories][0] : undefined;
  const titleCategory = onlyTitleCategory && categorySet.has(onlyTitleCategory) ? onlyTitleCategory : undefined;
  const categories = input.currentTaxonomy?.categories ?? [...new Set([...(titleCategory ? [titleCategory] : []), ...categorySet])];
  const primaryCategory = input.currentTaxonomy?.primaryCategory ?? categories[0];
  if (!primaryCategory) return null;
  const music = categories.includes("party") || categories.includes("live");
  const excluded = getExcludedDiscoveryGenres(input, fallbackCategory ? ["title", "description"] : undefined);
  const genres = new Set<MusicGenre>();
  const plausibleGenres = new Set<MusicGenre>();
  if (music && !input.currentTaxonomy?.genres.length) {
    for (const source of DISCOVERY_TEXT_SOURCES) {
      for (const { quote, words } of bySource[source]) {
        const context = styleWords(words, names);
        if (NON_MUSIC_CONTEXT.test(context)) continue;
        const programme = (source === "sourceCaption" || source === "occurrenceText" ? advertisedDancefloors(quote, names, input.date) : undefined) ?? showStyles(quote, names);
        const isStyleHeading = (source === "title" || source === "description") && PROGRAMME_STYLE_SUFFIX.test(context) &&
          isGenreList(context.replace(PROGRAMME_STYLE_SUFFIX, "").replace(/\blive\b/g, " "));
        const isBilledStyleList = PROGRAMME_STYLE_PREFIX.test(context) &&
          isGenreList(context.replace(PROGRAMME_STYLE_PREFIX, "").replace(/\bgospel\b/g, " "));
        const strong = MUSIC_CUE.test(context) || (billedSelection && /\b(?:hitovi|hitove|hits)\b/.test(context)) || STYLE_FIELD.test(quote) || isBilledStyleList || isStyleHeading ||
          (source === jazzHeadline?.source && quote === jazzHeadline.quote) ||
          (source === "title" && (Boolean(input.currentTaxonomy) && isGenreList(context) ||
            ACTIVITIES.some(({ category, cue }) => (category === "party" || category === "live") && cue.test(context))));
        for (const genre of GENRES) {
          const programmeQuote = programme && categories.includes(programme.role) && programme.styles.includes(genre) ? programme.quote : undefined;
          const genreQuote = programmeQuote ?? quote;
          if (excluded.has(genre) || !genreProof[genre].test(context) || !hasExplicitGenreEvidence(input, source, genreQuote, genre)) continue;
          // A separately named influence ("disco roots", "disco koreni") does
          // not put that style on the bill or make an explicit selection incomplete.
          if (programme && !programmeQuote && !genreProof[genre].test(context.replace(/\b\w+ (?:roots|koreni)\b/g, " "))) continue;
          if ((!strong && !programmeQuote) || genreQuote.length > 120) {
            plausibleGenres.add(genre);
            continue;
          }
          if (!genres.has(genre)) {
            genres.add(genre);
            evidence.push({ kind: "genre", label: genre, source, quote: genreQuote });
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
