import { toSearchableText } from "@/lib/pipeline/venue-normalization";

export type ScopedBranchVenueEvidence = {
  heading: string;
  source: "caption" | "alt_text";
  rowQuote: string;
};

function quoteComparable(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isNamedPhysicalBranchHeading(value: string): boolean {
  const normalized = toSearchableText(value);
  // Restrict this fallback to named cultural branches. A promoter, room,
  // performer or generic program heading cannot establish a physical venue.
  return /^(?:legat|galerija|muzej|gallery|museum|biblioteka|library|bioskop|cinema|pozoriste|theatre|theater)\s+[a-z][a-z\d ]+$/u.test(normalized) &&
    normalized.split(" ").length >= 3;
}

/**
 * A section heading may be far outside the 200-character exact row quote.
 * Bind that row to its preceding named physical branch without stitching the
 * heading into the quote or treating a venue elsewhere in a roundup as shared.
 */
export function findScopedBranchVenueEvidence(options: {
  venue: string;
  rowSourceText: string;
  rowDateText: string;
  source: "caption" | "alt_text";
  sourceText: string;
  declaredVenues: string[];
}): ScopedBranchVenueEvidence | null {
  const requested = toSearchableText(options.venue);
  const declared = new Set(options.declaredVenues.map(toSearchableText));
  const rowQuote = quoteComparable(options.rowSourceText);
  const dateQuote = quoteComparable(options.rowDateText);
  if (
    !requested ||
    !declared.has(requested) ||
    !isNamedPhysicalBranchHeading(options.venue) ||
    !rowQuote ||
    !dateQuote ||
    !rowQuote.includes(dateQuote)
  ) {
    return null;
  }

  let heading: string | null = null;
  let sectionLabel = "";
  const requestedHeadingAppearsExactly = options.sourceText.split(/\r?\n/u).some((line) =>
    quoteComparable(line) === quoteComparable(options.venue),
  );
  const matchedRows: Array<{ heading: string | null; rowQuote: string }> = [];
  for (const rawLine of options.sourceText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const normalizedLine = toSearchableText(line);
    if (
      isNamedPhysicalBranchHeading(line) ||
      (declared.has(normalizedLine) && normalizedLine)
    ) {
      // A new branch is a barrier even if the model omitted its occurrences.
      heading = isNamedPhysicalBranchHeading(line) ? line : null;
      sectionLabel = "";
    } else if (/^[\p{L}][\p{L}\p{M}\s]{1,60}:$/u.test(line)) {
      sectionLabel = quoteComparable(line);
    } else if (/^[\p{L}][\p{L}\p{M}\s&'’()-]{0,70}$/u.test(line) && normalizedLine.split(" ").length <= 8) {
      // Any unrecognized standalone heading could be an omitted physical
      // venue. Holding the row is safer than carrying a previous branch past it.
      heading = null;
      sectionLabel = "";
    }
    const sourceLine = quoteComparable(line);
    let actualRowQuote = rowQuote;
    if (requestedHeadingAppearsExactly && sectionLabel) {
      // Recover only a model's exact branch + actual section-label prefix.
      // Neither that synthetic adjacency nor any arbitrary prefix is proof.
      const prefix = `${quoteComparable(options.venue)} — ${sectionLabel} `;
      if (rowQuote.startsWith(prefix)) actualRowQuote = rowQuote.slice(prefix.length);
    }
    if (actualRowQuote.includes(dateQuote) && sourceLine.includes(actualRowQuote)) {
      matchedRows.push({ heading, rowQuote: actualRowQuote });
    }
  }

  // An abbreviated/repeated row that appears under several branches is not
  // sufficiently scoped; all exact matches must identify the same heading.
  if (
    matchedRows.length === 0 ||
    matchedRows.some((value) => !value.heading || toSearchableText(value.heading) !== requested || value.rowQuote !== matchedRows[0].rowQuote)
  ) {
    return null;
  }
  return {
    heading: matchedRows[0].heading!,
    source: options.source,
    rowQuote: matchedRows[0].rowQuote,
  };
}
