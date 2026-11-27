import { normalizeTaxonomyText } from "./venue-types";
import type { DiscoveryTextSource, ExplicitDiscoveryInput } from "./explicit-event-discovery";
import type { DiscoveryFormat } from "./event-discovery";

type Clauses = Record<DiscoveryTextSource, readonly { quote: string; words: string }[]>;
type Programme = { category: "party" | "live"; format?: DiscoveryFormat; source: DiscoveryTextSource; quote: string };
const NON_PERFORMANCE = /\b(?:radionic\w*|workshops?|masterclass|kurs\w*|school|predavanj\w*|lecture|intervju|interview|panel|razgovor|quiz|kviz\w*|projekc\w*|screening|film|movie|documentary|podcast|radio|playlist\w*|plejlist\w*|soundtrack|otkazan\w*|odlozen\w*|postponed|cancell?ed|not performing|ne nastupa|nece (?:nastup\w*|pust\w*|izvod\w*)|will not (?:perform|play)|not appearing|tbc|to be confirmed|mozda|maybe|no dj|without djs?|bez di dzeja|bez dj|background|pozadinsk\w*)\b/;
const SLOT_WORD = /^(?:w|with|uz|dj|di|dzej|u|od|at|h|start|do|pon(?:edeljak)?|uto(?:rak)?|sre(?:da)?|cet(?:vrtak)?|pet(?:ak)?|sub(?:ota)?|ned(?:elja)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan\w*|feb\w*|mar\w*|apr\w*|maj|may|jun\w*|jul\w*|avg\w*|aug\w*|sep\w*|okt\w*|oct\w*|nov\w*|dec\w*|\d{1,4}(?:h|c)?)$/;
const WEEKDAYS = [
  /\b(?:ned(?:elja)?|sun(?:day)?)\b/, /\b(?:pon(?:edeljak)?|mon(?:day)?)\b/,
  /\b(?:uto(?:rak)?|tue(?:sday)?)\b/, /\b(?:sre(?:da)?|wed(?:nesday)?)\b/,
  /\b(?:cet(?:vrtak)?|thu(?:rsday)?)\b/, /\b(?:pet(?:ak)?|fri(?:day)?)\b/, /\b(?:sub(?:ota)?|sat(?:urday)?)\b/,
];

function calendarEvidence(quote: string, date: string) {
  const words = normalizeTaxonomyText(quote);
  const days = WEEKDAYS.map((re, day) => re.test(words) ? day : -1).filter(day => day >= 0);
  const dates = [...quote.matchAll(/(?<![\d./])(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?(?![\d/])/gu)]
    .filter(m => +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12);
  const isoDates = [...quote.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/gu)];
  // A dot-separated clock can resemble a date. If so, abstain rather than
  // accepting an unsupported weekday or the lineup from the adjacent night.
  return { dated: Boolean(days.length || dates.length || isoDates.length),
    matches: days.every(day => day === new Date(date + "T12:00:00Z").getUTCDay()) && isoDates.every(m => m[0] === date) &&
      dates.every(m => +m[1] === +date.slice(8) && +m[2] === +date.slice(5, 7) && (!m[3] || m[3] === date.slice(0, 4))) };
}

/** Source-scoped billing, independent of a venue's reputation or legacy event type. */
export function billedMusicProgramme(input: ExplicitDiscoveryInput, bySource: Clauses): Programme | undefined {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.artists?.length) return;
  const venue = normalizeTaxonomyText(input.venue);
  const acts = input.artists.map(normalizeTaxonomyText).filter(act => act && act !== venue);
  if (!acts.length) return;
  // bySource has already dropped rows belonging to another occurrence. A DJ
  // credit on a panel or a film soundtrack cannot establish a music event.
  if (Object.values(bySource).some(parts => parts.some(p => NON_PERFORMANCE.test(p.words)))) return;
  const title = normalizeTaxonomyText(input.title);
  const row = input.occurrenceText?.trim() ?? "";
  const rowWords = normalizeTaxonomyText(row.replace(/#[\p{L}\p{N}_-]+/gu, " "));
  const rowDate = calendarEvidence(row, input.date);
  if (row && row.length <= 120 && rowDate.dated && rowDate.matches) {
    for (const act of acts) {
      if (!/^dj [a-z0-9]/.test(act) || !(` ${rowWords} `).includes(` ${act} `)) continue;
      const remainder = (` ${rowWords} `).replace(` ${act} `, " ").replace(` ${title} `, " ").trim();
      if (remainder.split(/\s+/u).filter(Boolean).every(token => SLOT_WORD.test(token))) {
        return { category: "party", format: "dj-set", source: "occurrenceText", quote: row };
      }
    }
  }
  for (const source of ["occurrenceText", "sourceCaption"] as const) {
    const lines = (input[source] ?? "").split(/[\r\n]+/u);
    for (const { quote } of bySource[source]) {
      // Preserve the complete clause's negation and uncertainty before taking
      // a short, verbatim, credit-bearing excerpt from a longer sentence.
      const matchingLines = lines.filter(line => line.includes(quote));
      if (!matchingLines.length || matchingLines.some(line => !calendarEvidence(line, input.date!).matches ||
          /\b(?:bez|ne|nije|nece|no|not|never|maybe|mozda|ako|formerly|known for|poznat\w* po)\b/.test(normalizeTaxonomyText(line)))) continue;
      const parts = quote.length <= 120 ? [quote] : quote.split(/[,;:]/u).map(s => s.trim());
      for (const part of parts) {
        if (!part || part.length > 120) continue;
        const text = ` ${normalizeTaxonomyText(part.replace(/#[\p{L}\p{N}_-]+/gu, " "))} `;
        for (const act of acts) {
          const at = text.indexOf(` ${act} `);
          if (at < 0) continue;
          const after = text.slice(at + act.length + 2);
          if (/^(?:(?:ponovo|veceras|tonight|will|ce) )?(?:vrti|pusta|pustati|spins?|spin) (?:najvec\w* |vinil\w* )?(?:hitov\w*|hits|ploc\w*|records|vinyl|techno|tehno|house|haus|disco|disko|funk|punk|pank|rock|rok|hip hop|reggae|dnb)\b/.test(after)) {
            return { category: "party", format: "dj-set", source, quote: part };
          }
          if (/^(?:(?:ce|will) )?(?:izvodic?e|izvodi|odsvirace|svirace|pevace|performs?|sings?) (?:pesm\w*|songs?|uzivo|live)\b/.test(after)) {
            return { category: "live", format: "live-performance", source, quote: part };
          }
        }
      }
    }
  }
  // A named selection with explicit dancing bills a party; the source may
  // leave the playback format (DJ set, vinyl, etc.) unstated.
  const caption = input.sourceCaption ?? "";
  const lineup = caption.split(/\r?\n/).find(line => acts.every(act => ` ${normalizeTaxonomyText(line)} `.includes(` ${act} `)));
  const selectors = caption.split(/\r?\n/).find(line => /^(?:two selectors one dancefloor|dva selektora jedan podijum)$/.test(normalizeTaxonomyText(line)));
  if (selectors && selectors.trim().length <= 120 && acts.length === 2 && lineup &&
    acts.every(act => ` ${rowWords} `.includes(` ${act} `)) && rowDate.dated && rowDate.matches && calendarEvidence(caption, input.date).matches) {
    return { category: "party", source: "sourceCaption", quote: selectors.trim() };
  }
  const dance = bySource.sourceCaption.some(p => /\b(?:endless dance|djuskamo se|dance all night)\b/.test(p.words));
  if (dance && calendarEvidence(input.sourceCaption ?? "", input.date).matches && rowDate.dated && rowDate.matches && row.length <= 120 && /^muzicki izbor\b/.test(rowWords) &&
      acts.some(act => (` ${rowWords} `).includes(` ${act} `))) {
    return { category: "party", source: "occurrenceText", quote: row };
  }
}
