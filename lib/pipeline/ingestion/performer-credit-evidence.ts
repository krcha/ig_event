type ArtistEvidenceOptions = {
  text: string;
  artist: string;
  context?: string;
  identityAppearsInText: (text: string, identity: string) => boolean;
};

const creditLabel = String.raw`(?:(?:autor(?:ka)?|author|reditelj(?:ka)?|rezija|režija|director|koreograf(?:ija)?|choreograph(?:er|y)|composer|scenograf(?:ija)?|kostimograf(?:ija)?|costume\s+design|photograph(?:er|y)|photo|foto|design|sponsor(?:ed)?)\s*(?::+|\bby\b)|(?:written|directed|composed)\s+by\s*:?)`;
const repertoireLabel = String.raw`(?:reperto(?:ire|ar)|tribute\s+to|(?:songs|hits|music)\s+of|(?:songs|hits)\s+by|inspired\s+by)\s*:?`;
const performerLabel = String.raw`(?:(?:performers?|performing|lineup|cast|starring|vocal(?:s|ist)?|guests?|nastupaju|nastupa|izvodjaci|izvođači|pevaju|peva|dj\s+set)\s*:|(?:special\s+guests?|featuring)\s*:?)`;
const marker = new RegExp(`(?<![\\p{L}\\p{N}_])(${creditLabel}|${repertoireLabel}|music\\s+by\\s*:?|${performerLabel})`, "giu");
const creditMarker = new RegExp(`^(?:${creditLabel}|${repertoireLabel})$`, "iu");
const performingMarker = new RegExp(`^(?:${performerLabel})$`, "iu");
const plainRoleNames = String.raw`(?:AUTOR(?:KA)?|AUTHOR|REDITELJ(?:KA)?|REZIJA|REŽIJA|DIRECTOR|KOREOGRAF(?:IJA)?|CHOREOGRAPH(?:ER|Y)|COMPOSER|SCENOGRAF(?:IJA)?|KOSTIMOGRAF(?:IJA)?)`;

function retainPlainCreditHeadings(text: string): string {
  // Uppercase role labels before a name and standalone role-heading lines are
  // common poster typography. Punctuation within an act's name (Author &
  // Punisher, Director's Cut) does not establish a creative-credit role.
  return text.replace(new RegExp(`(^|\\n)([ \\t]*)(${plainRoleNames})(?=[ \\t]+[\\p{L}\\p{N}]|[ \\t]*$)`, "gmu"), "$1$2$3:")
    .replace(new RegExp(`(^|\\n)([ \\t]*)(${plainRoleNames})([ \\t]*)(?=\\n|$)`, "giu"), "$1$2$3:");
}

/** Credit and repertoire names do not prove an appearance. Inspect the
 * identity's own clause, so a photographer footer cannot erase a real lineup.
 */
export function hasPerformingArtistEvidence(options: ArtistEvidenceOptions): boolean {
  const symphonicOrTributeContext = /\b(?:symphon\w*|simfonij\w*|orchestra\w*|orkestr\w*|tribute|greatest\s+hits)\b/iu.test(
    options.context ?? options.text,
  );
  const normalizedText = options.text.normalize("NFKC");
  // A complete bare act name is not itself an explicit credit label.
  if (normalizedText.trim().toLocaleLowerCase() === options.artist.normalize("NFKC").trim().toLocaleLowerCase()) return true;
  for (const paragraph of retainPlainCreditHeadings(normalizedText).split(/\n\s*\n/u)) {
    let role: "performer" | "credit" | "music_by" = "performer";
    for (const part of paragraph.split(marker)) {
      if (creditMarker.test(part)) {
        role = "credit";
        continue;
      }
      if (performingMarker.test(part)) {
        role = "performer";
        continue;
      }
      if (/^music\s+by\s*:?$/iu.test(part)) {
        role = "music_by";
        continue;
      }
      for (const clause of part.split(/\r?\n|;|[|•·●]/u)) {
        if (!options.identityAppearsInText(clause, options.artist)) continue;
        // The appearance cue belongs to the same name-bearing clause, never
        // to a different guest elsewhere in a broad evidence quote.
        const explicitPerformance = /^\s*(?:dj\s|live\s|nastupa\s|nastupaju\s|performing\s|appearing\s)/iu.test(clause) ||
          /\b(?:live|nastupa|performs?|appearing)\s*[.!]*\s*$/iu.test(clause);
        if (explicitPerformance || role === "performer" ||
          (role === "music_by" && !symphonicOrTributeContext)) return true;
      }
    }
  }
  return false;
}
