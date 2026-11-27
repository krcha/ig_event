import type { DiscoveryCategory, DiscoveryFormat, EventDiscoveryTaxonomy, MusicGenre } from "./event-discovery";
import { billedHeadlineMatchesDate } from "./billed-music-programme";
import { getExcludedDiscoveryGenres, genreProof, hasConflictingProgrammeEvidence, isExternalMusicRoleExcluded, type ExplicitDiscoveryEvidence, type ExplicitDiscoveryInput } from "./explicit-event-discovery";
import { normalizeTaxonomyText as words } from "./venue-types";

const scheduleHeading = /^[^\p{L}\p{N}]*([0-3]?\d)[./]([01]?\d)(?:[./](20\d\d))?\.?\s*[—–-]\s*(.+)$/u;
const unsafe = /\b(?:otkazan\w*|odlozen\w*|postponed|cancel\w*|not (?:happening|playing|performing)|nece (?:biti|nastupiti)|rescheduled|instead of|umesto|mozda|maybe|tbc|subject to change)\b/;
const competing = /\b(?:quiz|kviz|lecture|predavanj\w*|film (?:o|about)|documentary|podcast|tribute to|background playlist)\b/;
const disowned = /\b(?:without|no|not|bez|nema|nije) (?:a |an )?(?:part(?:y|ies)|dj|live (?:show|music)|radionic\w*|workshop|swap|razmen\w*|branc|brunch|projekc\w*|screening|organizacij\w*|takmicenj\w*)\b/;
const monthly = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "avg", "sep", "okt", "nov", "dec"];

function screeningHeader(input: ExplicitDiscoveryInput, caption: string) {
  const lines = caption.trim().split(/\n\s*\n/u);
  const schedule = input.occurrenceText?.trim().split(/\r?\n/u);
  if (schedule?.length !== 2 || lines.length < 3 || !input.date || words(schedule[0]) !== words(input.title) ||
    !/^bioskop\b/.test(words(lines[0])) || words(lines[1]) !== words(input.title) || words(lines[2]) !== words(schedule[1])) return;
  const range = /^svake veceri od (\d{1,2}) (\w+) do (\d{1,2}) (\w+) u \d{1,2}h?$/.exec(words(schedule[1]));
  if (!range || !/^\d{4}-\d\d-\d\d$/.test(input.date)) return;
  const y = Number(input.date.slice(0, 4)), m1 = monthly.findIndex(m => range[2].startsWith(m)), m2 = monthly.findIndex(m => range[4].startsWith(m));
  if (m1 < 0 || m2 < m1 || m2 - m1 > 1) return;
  const start = Date.UTC(y, m1, +range[1]), end = Date.UTC(y, m2, +range[3]), day = Date.parse(input.date + "T00:00:00Z");
  if (end - start > 31 * 86_400_000 || day < start || day > end || new Date(start).getUTCMonth() !== m1 || new Date(end).getUTCMonth() !== m2) return;
  const endOfHeading = caption.indexOf(lines[2], caption.indexOf(lines[1]) + lines[1].length) + lines[2].length;
  return caption.slice(0, endOfHeading).trim();
}

/** Extend an already anchored row only inside its own, independently dated programme paragraph. */
export function scopedScheduleCaption(input: ExplicitDiscoveryInput, rawCaption?: string | null, ambiguous = false) {
  if (ambiguous || !rawCaption || rawCaption.length > 2200 || /(?:…|\.\.\.)$/.test(rawCaption.trim()) ||
    !input.date || !input.occurrenceText || unsafe.test(words(rawCaption))) return;
  const film = screeningHeader(input, rawCaption);
  if (film) return film;
  const row = input.occurrenceText.trim();
  const paragraphs = rawCaption.split(/\r?\n\s*\r?\n/u);
  const matches = paragraphs.filter(paragraph => {
    const [heading] = paragraph.split(/\r?\n/u);
    const d = scheduleHeading.exec(heading);
    return d && words(heading) === words(row) && words(d[4]) === words(input.title) && +d[1] === +input.date!.slice(8) &&
      +d[2] === +input.date!.slice(5, 7) && (!d[3] || d[3] === input.date!.slice(0, 4));
  });
  if (matches.length !== 1 || !/\bdj collectives?\b/iu.test(matches[0]) || !/\bwith us on\b/iu.test(matches[0])) return;
  const lines = matches[0].split(/\r?\n/u);
  if (lines.length < 2 || matches[0].length > 750 || lines.slice(1).some(line =>
    /(?:^|\s)\d{1,2}[./]\d{1,2}\b|\b20\d\d-\d\d-\d\d\b/.test(line) || scheduleHeading.test(line) ||
    !billedHeadlineMatchesDate(line, input.date))) return;
  return matches[0];
}

export function classifyAnnouncedProgramme(input: ExplicitDiscoveryInput): {
  taxonomy: EventDiscoveryTaxonomy; evidence: ExplicitDiscoveryEvidence[]; complete: true; titleCategory?: DiscoveryCategory;
} | undefined {
  if (!input.date || !input.occurrenceText || hasConflictingProgrammeEvidence(input)) return;
  const row = input.occurrenceText, caption = input.sourceCaption ?? "", title = words(input.title);
  if (!title || [title, words(row), words(caption)].some(s => unsafe.test(s) || disowned.test(s))) return;
  const full = words(caption), rowWords = words(row), acts = (input.artists ?? []).map(words);
  const result = (category: DiscoveryCategory, format: DiscoveryFormat | undefined, source: "sourceCaption" | "occurrenceText", quote: string,
    styles: { genre: MusicGenre; source: "sourceCaption" | "occurrenceText"; quote: string }[] = []) => {
    if (quote.length > 120 || !input[source]?.includes(quote)) return;
    if ((category === "party" || category === "live") && (isExternalMusicRoleExcluded(input, category) || competing.test([title, rowWords, full].join(" ")))) return;
    const excluded = getExcludedDiscoveryGenres(input);
    const evidence: ExplicitDiscoveryEvidence[] = [{ kind: "category", label: category, source, quote }];
    if (format) evidence.push({ kind: "format", label: format, source, quote });
    const genres: MusicGenre[] = [];
    for (const style of styles) {
      if (excluded.has(style.genre) || !input[style.source]?.includes(style.quote) || style.quote.length > 120 || genres.includes(style.genre)) continue;
      genres.push(style.genre);
      evidence.push({ kind: "genre", label: style.genre, source: style.source, quote: style.quote });
    }
    const taxonomy: EventDiscoveryTaxonomy = { primaryCategory: category, categories: [category], formats: format ? [format] : [], genres };
    return { taxonomy, evidence, complete: true as const };
  };
  const film = screeningHeader(input, caption);
  if (film) return result("culture", "screening", "sourceCaption", film.split(/\n\s*\n/u)[0].trim());
  if (!billedHeadlineMatchesDate(row, input.date)) return;
  const captionLines = caption.split(/\r?\n/u).map(line => line.trim());
  const swap = /\b(?:clothes|clothing),? (?:accessories (?:&|and) )?books swap\b/iu.exec(input.title)?.[0];
  if (swap && /\bjoin us\b.{0,105}\bswap of (?:clothes|clothing)\b/.test(full)) {
    const quote = captionLines.find(line => line.includes(swap));
    if (quote) return result("participate", undefined, "sourceCaption", swap);
  }
  const sentences = captionLines.flatMap(line => line.split(/(?<=[.!?])\s+/u));
  const workshop = sentences.find(line => /^(?:kreiramo|pravimo|oslikavamo) (?:svoje |sopstvene )?(?:[a-z]+ ){1,4}(?:tehnikom|tehnikama)\b/.test(words(line)));
  if (workshop && /#(?:slikarska)?radionica\b/iu.test(caption)) return result("participate", "workshop", "sourceCaption", workshop);
  const challenge = sentences.find(line => /^izazov je .*\b(?:nacrtati|napisati)\b.*\b(?:stripa|price|pesme)\b/.test(words(line)));
  if (challenge && /\b(?:crtanj\w* stripa|pisanj\w* (?:pric\w*|pesm\w*))\b/.test(title) && /\bucestvujte uzivo\b/.test(full)) return result("participate", undefined, "sourceCaption", challenge);
  const brunch = captionLines.find(line => /\bpozivamo vas na\b.*\bbranc\b/.test(words(line)));
  if (brunch && /\bbranc\b/.test(title)) return result("food", undefined, "sourceCaption", brunch);
  if (/^(?:steak|stejk|pasta|sushi|susi|taco|ramen) (?:night|vece)$/.test(title) && rowWords === title && /\bu kuhinji se druzimo\b/.test(full) && /\bna meniju\b/.test(full)) return result("food", "dinner", "occurrenceText", row);
  const danceStyle = /^([a-z]+(?: [a-z]+)?) night$/.exec(title)?.[1];
  if (danceStyle && rowWords.includes("night full of " + danceStyle + " ") && /\bdancing\b/.test(rowWords) && /\battend the party\b/.test(full)) {
    const genres = (Object.keys(genreProof) as MusicGenre[]).filter(key => genreProof[key].test(danceStyle));
    if (genres.length === 1) return result("party", "party", "occurrenceText", row,
      [{ genre: genres[0], source: "occurrenceText", quote: row }]);
  }
  const live = row.split(/\r?\n/u).find(line => {
    const billed = /^\d{1,2}(?::\d\d)?h?\s+(.+?)\s+live$/iu.exec(line.trim());
    return billed && words(billed[1]) === title && acts.includes(title);
  });
  if (live && billedHeadlineMatchesDate(row, input.date)) {
    const style = row.split(/\r?\n/u).find(line => /^susret\b.*\bmelodij\w* i savremen\w* elektronsk\w* muzik\w*$/.test(words(line)));
    return result("live", "live-performance", "occurrenceText", live, style ? [{ genre: "electronic", source: "occurrenceText", quote: style }] : []);
  }
  const dj = row.split(/\s*[|;]\s*/u).find(part => /^dj (.+)$/.exec(words(part))?.[1] === title);
  if (dj && /\d/.test(row) && !competing.test(words(input.description))) return result("party", "dj-set", "occurrenceText", dj);
  const disco = row.split(/\s*;\s*/u).find(part => /^dis[ck]o sa @([\w.]+)$/iu.test(part) && acts.includes(words(part.split("@")[1])));
  if (disco && acts.includes(title)) return result("party", "party", "occurrenceText", disco);
  const b2b = row.split(/\s*[|;]\s*/u)[0].trim();
  if (words(b2b) === title && /\bb2b\b/.test(title) && title.split(" b2b ").every(act => acts.includes(act)) &&
    /\b(?:pult deli|dele pult|share the decks)\b/.test(full)) return result("party", "dj-set", "occurrenceText", b2b);
  // The role and vinyl selection must occur inside the same original dated block.
  const head = scheduleHeading.exec(captionLines[0] ?? "");
  if (!head || words(head[4]) !== title || !acts.includes(title) || !scopedScheduleCaption(input, caption)) return;
  const paragraph = captionLines.slice(1).join(" ");
  const role = /[^.!?]{0,68}\bDJ collectives?\b[^.!?]{0,48}\bwith us on (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/iu.exec(paragraph)?.[0].trim();
  if (!role || !billedHeadlineMatchesDate(role, input.date)) return;
  const list = /\bvinyl,\s*((?:[\p{L}-]+,\s*)+[\p{L}-]+)\s*[–—]/iu.exec(paragraph);
  const quote = list?.[0].replace(/\s*[–—]$/u, "");
  const tokens = list?.[1].split(/,\s*/u);
  const styles = quote && tokens?.every(token => Object.values(genreProof).some(pattern => pattern.test(words(token))))
    ? (Object.keys(genreProof) as MusicGenre[]).filter(genre => tokens.some(token => genreProof[genre].test(words(token))))
      .map(genre => ({ genre, source: "sourceCaption" as const, quote })) : [];
  return result("party", "dj-set", "sourceCaption", role, styles);
}

/** A concert and documentary can share a listing. Attribute an explicitly billed
 * sound to the concert, without discarding the screening or its own credits. */
export function announcedConcertGenres(input: ExplicitDiscoveryInput, taxonomy: EventDiscoveryTaxonomy): ExplicitDiscoveryEvidence[] {
  if (taxonomy.primaryCategory !== "live" || !taxonomy.formats.includes("concert") || !input.date ||
    !input.occurrenceText || !input.sourceCaption || !billedHeadlineMatchesDate(input.occurrenceText, input.date) ||
    hasConflictingProgrammeEvidence(input) || isExternalMusicRoleExcluded(input, "live") ||
    unsafe.test(words(input.sourceCaption)) || disowned.test(words(input.sourceCaption))) return [];
  const title = words(input.title);
  if (!title || !words(input.occurrenceText).includes("koncert sastava " + title)) return [];
  for (const line of input.sourceCaption.split(/\r?\n/u)) {
    const sentence = /^(?:pozivamo vas na koncert sastava|позивамо вас на концерт састава)\s+([^,]+),\s*(?:koji|који)\s+((?:kroz|кроз)\s+([\p{L}-]+)\s+(?:fuziju spaja|фузију спаја))(?=\s|[.,;!]|$)/iu.exec(line.trim());
    if (!sentence || words(sentence[1]) !== title) continue;
    const styles = (Object.keys(genreProof) as MusicGenre[]).filter(key => genreProof[key].test(words(sentence[3])));
    if (styles.length === 1 && !getExcludedDiscoveryGenres(input).has(styles[0])) {
      return [{ kind: "genre", label: styles[0], source: "sourceCaption", quote: sentence[2] }];
    }
  }
  return [];
}
