export const CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION = 1;

const MAX_CANDIDATE_COUNT = 8;
const MIN_DISTINCTIVE_ANCHOR_LENGTH = 5;
const MIN_RELIABLE_TIME_CONFIDENCE = 0.8;

const GENERIC_PROMOTION_ANCHORS = new Set([
  "afterparty",
  "avgust",
  "august",
  "beograd",
  "belgrade",
  "caption",
  "club",
  "concert",
  "datum",
  "dodjite",
  "doors",
  "event",
  "festival",
  "friday",
  "grad",
  "instagram",
  "klub",
  "live",
  "music",
  "night",
  "nocas",
  "petak",
  "party",
  "poster",
  "promoter",
  "saturday",
  "start",
  "subota",
  "sutra",
  "theme",
  "themed",
  "today",
  "tonight",
  "ulaz",
  "venue",
  "vidimo",
  "wednesday",
  "zurka",
  "zurku",
]);

export type CrossPostPromotionCandidate = {
  id: string;
  sourceHandle: string;
  sourceIdentity: string;
  sourceOccurrenceKey: string;
  instagramPostId: string;
  instagramPostUrl: string;
  title: string;
  date: string;
  time?: string;
  timeStatus?: string;
  timeEvidenceKind?: string;
  timeConfidence?: number;
  dateEvidenceVerified: boolean;
  timeEvidenceVerified: boolean;
  venueEvidenceText: string;
  eventType: string;
  sourceConflictFields: string[];
  artists: string[];
  description?: string;
  ticketPrice?: string;
  imageUrl?: string;
  imageStorageId?: string;
};

export type CrossPostPromotionCoalescingPlan = {
  policyVersion: typeof CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION;
  primaryId: string;
  duplicateIds: string[];
  sourceHandle: string;
  date: string;
  time: string;
  eventType: string;
  canonicalVenueName: string;
  canonicalVenueHandle: string;
  sharedAnchors: string[];
  artists: string[];
  description?: string;
  ticketPrice?: string;
  imageSourceCandidateId?: string;
  imageUrl?: string;
  imageStorageId?: string;
};

function normalizeWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("sr-Latn")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compact(value: string): string {
  return normalizeWords(value).replace(/\s+/gu, "");
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLocaleLowerCase("sr-Latn");
}

function normalizedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.normalize("NFKC").trim();
    const key = compact(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function hasExactSocialHandleMention(evidenceText: string, canonicalHandle: string): boolean {
  const handle = normalizeHandle(canonicalHandle);
  if (!handle) return false;
  const exactHandlePattern =
    /(?:^|[^\p{L}\p{N}._])[@#]([a-z0-9_]+(?:\.[a-z0-9_]+)*)/giu;
  return [...evidenceText.matchAll(exactHandlePattern)].some(
    (match) => normalizeHandle(match[1] ?? "") === handle,
  );
}

function hasCanonicalNameTokenSequence(evidenceText: string, canonicalName: string): boolean {
  const evidenceTokens = normalizeWords(evidenceText).split(" ").filter(Boolean);
  const nameTokens = normalizeWords(canonicalName).split(" ").filter(Boolean);
  if (nameTokens.length === 0 || evidenceTokens.length < nameTokens.length) return false;
  const grammaticalSuffixes = ["u", "a", "om", "em", "ima", "ovima"];

  return evidenceTokens.some((_, start) =>
    nameTokens.every((nameToken, offset) => {
      const evidenceToken = evidenceTokens[start + offset];
      if (evidenceToken === nameToken) return true;
      return (
        offset === nameTokens.length - 1 &&
        nameToken.length >= 4 &&
        grammaticalSuffixes.some((suffix) => evidenceToken === `${nameToken}${suffix}`)
      );
    }),
  );
}

function hasExactEvidenceToken(evidenceText: string, expectedCompactToken: string): boolean {
  return normalizeWords(evidenceText)
    .split(" ")
    .filter(Boolean)
    .some((token) => compact(token) === expectedCompactToken);
}

function hasCanonicalVenueEvidence(
  evidenceText: string,
  canonicalVenueName: string,
  canonicalVenueHandle: string,
): boolean {
  const handle = compact(canonicalVenueHandle);
  const name = compact(canonicalVenueName);
  return Boolean(
    normalizeWords(evidenceText) &&
      ((handle.length >= MIN_DISTINCTIVE_ANCHOR_LENGTH &&
        hasExactSocialHandleMention(evidenceText, canonicalVenueHandle)) ||
        (name.length >= MIN_DISTINCTIVE_ANCHOR_LENGTH &&
          hasCanonicalNameTokenSequence(evidenceText, canonicalVenueName))),
  );
}

function normalizeSharedAnchors(
  anchors: string[],
  sourceHandle: string,
  canonicalVenueName: string,
  canonicalVenueHandle: string,
): string[] | null {
  const excluded = new Set([
    compact(sourceHandle),
    compact(canonicalVenueName),
    compact(canonicalVenueHandle),
  ]);
  const normalized = normalizedUnique(anchors).map(compact);
  if (
    normalized.length < 2 ||
    normalized.length > 6 ||
    normalized.some(
      (anchor) =>
        anchor.length < MIN_DISTINCTIVE_ANCHOR_LENGTH ||
        !/\p{L}/u.test(anchor) ||
        GENERIC_PROMOTION_ANCHORS.has(anchor) ||
        excluded.has(anchor),
    )
  ) {
    return null;
  }
  return normalized;
}

/**
 * Derives the only anchors unattended campaign coalescing may submit. Tokens
 * are exact NFKC-normalized caption tokens, not fuzzy title fragments. Venue,
 * author, date/promo boilerplate, short tokens, and non-letter tokens are
 * excluded before intersecting every caption. The deterministic longest-first
 * cap keeps the downstream mutation's evidence surface bounded.
 */
export function deriveCrossPostPromotionSharedEvidenceAnchors(options: {
  captions: string[];
  sourceHandle: string;
  canonicalVenueName: string;
  canonicalVenueHandle: string;
}): string[] | null {
  if (
    options.captions.length < 2 ||
    options.captions.length > MAX_CANDIDATE_COUNT ||
    options.captions.some((caption) => !caption.normalize("NFKC").trim())
  ) {
    return null;
  }
  const excluded = new Set([
    compact(options.sourceHandle),
    compact(options.canonicalVenueName),
    compact(options.canonicalVenueHandle),
    ...normalizeWords(options.sourceHandle).split(" ").map(compact),
    ...normalizeWords(options.canonicalVenueName).split(" ").map(compact),
    ...normalizeWords(options.canonicalVenueHandle).split(" ").map(compact),
  ]);
  const captionTokenSets = options.captions.map(
    (caption) =>
      new Set(
        normalizeWords(caption)
          .split(" ")
          .map(compact)
          .filter(
            (token) =>
              token.length >= MIN_DISTINCTIVE_ANCHOR_LENGTH &&
              /\p{L}/u.test(token) &&
              !GENERIC_PROMOTION_ANCHORS.has(token) &&
              !excluded.has(token),
          ),
      ),
  );
  const shared = [...captionTokenSets[0]!]
    .filter((token) => captionTokenSets.slice(1).every((tokens) => tokens.has(token)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 6);
  return normalizeSharedAnchors(
    shared,
    options.sourceHandle,
    options.canonicalVenueName,
    options.canonicalVenueHandle,
  );
}

function chooseDescription(candidates: CrossPostPromotionCandidate[]): string | undefined {
  return candidates
    .map((candidate, index) => ({
      index,
      value: candidate.description?.normalize("NFKC").trim() ?? "",
    }))
    .filter((item) => item.value.length > 0)
    .sort((left, right) => right.value.length - left.value.length || left.index - right.index)[0]
    ?.value;
}

/**
 * Builds a fail-closed plan for separate Instagram posts that promote one
 * occurrence. The caller chooses the strongest event as the first candidate;
 * this helper never uses title similarity as occurrence proof.
 *
 * Every post must independently attest the same author, date, confirmed start
 * time, and canonical venue. At least two non-generic anchors must occur in
 * every source caption. Distinct post identities and occurrence keys are kept
 * in the plan so a database mutation can preserve every receipt and source
 * link instead of contracting them as if they came from one post.
 */
export function buildCrossPostPromotionCoalescingPlan(options: {
  candidates: CrossPostPromotionCandidate[];
  canonicalVenueName: string;
  canonicalVenueHandle: string;
  sharedAnchors: string[];
  preferredImageCandidateId?: string;
}): CrossPostPromotionCoalescingPlan | null {
  const candidates = options.candidates;
  if (candidates.length < 2 || candidates.length > MAX_CANDIDATE_COUNT) {
    return null;
  }

  const primary = candidates[0];
  const sourceHandle = normalizeHandle(primary.sourceHandle);
  const canonicalVenueName = options.canonicalVenueName.normalize("NFKC").trim();
  const canonicalVenueHandle = normalizeHandle(options.canonicalVenueHandle);
  const time = primary.time?.trim() ?? "";
  const eventType = normalizeWords(primary.eventType);
  const sharedAnchors = normalizeSharedAnchors(
    options.sharedAnchors,
    sourceHandle,
    canonicalVenueName,
    canonicalVenueHandle,
  );
  if (
    !sourceHandle ||
    !canonicalVenueName ||
    !canonicalVenueHandle ||
    !/^\d{4}-\d{2}-\d{2}$/.test(primary.date) ||
    !/^\d{2}:\d{2}$/.test(time) ||
    !eventType ||
    !sharedAnchors
  ) {
    return null;
  }

  const uniqueFields: Array<keyof Pick<
    CrossPostPromotionCandidate,
    "id" | "sourceIdentity" | "sourceOccurrenceKey" | "instagramPostId" | "instagramPostUrl"
  >> = ["id", "sourceIdentity", "sourceOccurrenceKey", "instagramPostId", "instagramPostUrl"];
  for (const field of uniqueFields) {
    const values = candidates.map((candidate) => candidate[field].trim());
    if (values.some((value) => !value) || new Set(values).size !== values.length) {
      return null;
    }
  }

  for (const candidate of candidates) {
    if (
      normalizeHandle(candidate.sourceHandle) !== sourceHandle ||
      candidate.date !== primary.date ||
      candidate.time?.trim() !== time ||
      candidate.timeStatus !== "confirmed" ||
      candidate.timeEvidenceKind !== "start_time_stated" ||
      !Number.isFinite(candidate.timeConfidence) ||
      (candidate.timeConfidence as number) < MIN_RELIABLE_TIME_CONFIDENCE ||
      !candidate.dateEvidenceVerified ||
      !candidate.timeEvidenceVerified ||
      normalizeWords(candidate.eventType) !== eventType ||
      candidate.sourceConflictFields.length !== 0 ||
      !hasCanonicalVenueEvidence(
        candidate.venueEvidenceText,
        canonicalVenueName,
        canonicalVenueHandle,
      ) ||
      sharedAnchors.some(
        (anchor) => !hasExactEvidenceToken(candidate.venueEvidenceText, anchor),
      )
    ) {
      return null;
    }
  }

  const nonemptyPrices = normalizedUnique(
    candidates.flatMap((candidate) =>
      candidate.ticketPrice?.trim() ? [candidate.ticketPrice] : [],
    ),
  );
  if (nonemptyPrices.length > 1) {
    return null;
  }

  const artists = normalizedUnique(candidates.flatMap((candidate) => candidate.artists));
  const preferredImage = options.preferredImageCandidateId
    ? candidates.find((candidate) => candidate.id === options.preferredImageCandidateId)
    : undefined;
  if (
    options.preferredImageCandidateId &&
    (!preferredImage?.imageUrl?.trim() || !preferredImage.imageStorageId?.trim())
  ) {
    return null;
  }
  const description = chooseDescription(candidates);

  return {
    policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
    primaryId: primary.id,
    duplicateIds: candidates.slice(1).map((candidate) => candidate.id),
    sourceHandle,
    date: primary.date,
    time,
    eventType,
    canonicalVenueName,
    canonicalVenueHandle,
    sharedAnchors,
    artists,
    ...(description ? { description } : {}),
    ...(nonemptyPrices[0] ? { ticketPrice: nonemptyPrices[0] } : {}),
    ...(preferredImage
      ? {
          imageSourceCandidateId: preferredImage.id,
          imageUrl: preferredImage.imageUrl,
          imageStorageId: preferredImage.imageStorageId,
        }
      : {}),
  };
}
