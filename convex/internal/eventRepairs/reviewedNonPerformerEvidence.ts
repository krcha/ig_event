export type ReviewedNonPerformerEvidence = {
  expectedArtists: string[];
  evidence: string;
};

/** A service operator may remove misread creator/repertoire credits after review. */
export function assertReviewedNonPerformerEvidence(args: {
  review?: ReviewedNonPerformerEvidence;
  currentArtists: string[];
  nextArtists: string[];
  posterArtistEvidence: string[];
  captionMode: boolean;
}): { removedArtists: string[]; evidence: string } | undefined {
  if (args.review === undefined) return undefined;
  const evidence = args.review.evidence.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    args.captionMode ||
    args.currentArtists.length === 0 ||
    args.nextArtists.length !== 0 ||
    args.posterArtistEvidence.length !== 0 ||
    JSON.stringify(args.review.expectedArtists) !== JSON.stringify(args.currentArtists) ||
    evidence.length < 20
  ) {
    throw new Error(
      "Reviewed non-performer removal requires exact existing artists, no replacement artist evidence, and substantive credit or repertoire evidence.",
    );
  }
  return { removedArtists: [...args.currentArtists], evidence };
}
