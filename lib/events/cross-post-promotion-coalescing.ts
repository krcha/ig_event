export const CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION = 1;

const MAX_CANDIDATE_COUNT = 8;
export const MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY = 512;
const MIN_EXCLUSIVE_HASHTAG_CAMPAIGN_POSTS = 3;
const MAX_CAMPAIGN_POSTING_SPAN_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_CAMPAIGN_LEAD_MS = 21 * 24 * 60 * 60 * 1_000;
const MAX_CAMPAIGN_LAG_MS = 2 * 24 * 60 * 60 * 1_000;
const MIN_DISTINCTIVE_ANCHOR_LENGTH = 5;
const MIN_RELIABLE_TIME_CONFIDENCE = 0.8;

const GENERIC_PROMOTION_ANCHORS = new Set([
  "afterparty",
  "album",
  "avgust",
  "august",
  "beograd",
  "belgrade",
  "belgrademusic",
  "belgradenightlife",
  "caption",
  "club",
  "concert",
  "culture",
  "electronicmusic",
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
  "putem",
  "reservation",
  "reservations",
  "rezervacija",
  "rezervacije",
  "saturday",
  "serbia",
  "srbija",
  "start",
  "subota",
  "summerprogram",
  "sutra",
  "ticket",
  "tickets",
  "theme",
  "themed",
  "today",
  "tonight",
  "ulaz",
  "venue",
  "visitbelgrade",
  "vidimo",
  "wednesday",
  "weekend",
  "zurka",
  "zurku",
]);

const GENERIC_PROMOTION_COMPOUND_SUFFIXES = ["culture", "program"] as const;

function isGenericPromotionAnchor(anchor: string): boolean {
  return (
    GENERIC_PROMOTION_ANCHORS.has(anchor) ||
    GENERIC_PROMOTION_COMPOUND_SUFFIXES.some(
      (suffix) => anchor.length > suffix.length + 2 && anchor.endsWith(suffix),
    )
  );
}

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

export type CrossPostCampaignHistoryPost = {
  handle: string;
  postId: string;
  caption?: string;
  postedAt?: string;
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

function hasExactSocialHandleMention(
  evidenceText: string,
  canonicalHandle: string,
): boolean {
  const handle = normalizeHandle(canonicalHandle);
  if (!handle) return false;
  const exactHandlePattern =
    /(?:^|[^\p{L}\p{N}._])[@#]([a-z0-9_]+(?:\.[a-z0-9_]+)*)/giu;
  return [...evidenceText.matchAll(exactHandlePattern)].some(
    (match) => normalizeHandle(match[1] ?? "") === handle,
  );
}

function hasCanonicalNameTokenSequence(
  evidenceText: string,
  canonicalName: string,
): boolean {
  const evidenceTokens = normalizeWords(evidenceText)
    .split(" ")
    .filter(Boolean);
  const nameTokens = normalizeWords(canonicalName).split(" ").filter(Boolean);
  if (nameTokens.length === 0 || evidenceTokens.length < nameTokens.length)
    return false;
  const grammaticalSuffixes = ["u", "a", "om", "em", "ima", "ovima"];

  return evidenceTokens.some((_, start) =>
    nameTokens.every((nameToken, offset) => {
      const evidenceToken = evidenceTokens[start + offset];
      if (evidenceToken === nameToken) return true;
      return (
        offset === nameTokens.length - 1 &&
        nameToken.length >= 4 &&
        grammaticalSuffixes.some(
          (suffix) => evidenceToken === `${nameToken}${suffix}`,
        )
      );
    }),
  );
}

function hasLocativeCanonicalNameTokenSequence(
  evidenceText: string,
  canonicalName: string,
): boolean {
  const evidenceTokens = normalizeWords(evidenceText)
    .split(" ")
    .filter(Boolean);
  const nameTokens = normalizeWords(canonicalName).split(" ").filter(Boolean);
  if (nameTokens.length === 0 || evidenceTokens.length < nameTokens.length)
    return false;
  const grammaticalSuffixes = ["u", "a", "om", "em", "ima", "ovima"];
  const locativeTokens = new Set([
    "at",
    "kod",
    "lokacija",
    "location",
    "mesto",
    "mestu",
    "na",
    "u",
    "venue",
  ]);

  return evidenceTokens.some((_, start) => {
    const exactName = nameTokens.every((nameToken, offset) => {
      const evidenceToken = evidenceTokens[start + offset];
      if (evidenceToken === nameToken) return true;
      return (
        offset === nameTokens.length - 1 &&
        nameToken.length >= 4 &&
        grammaticalSuffixes.some(
          (suffix) => evidenceToken === `${nameToken}${suffix}`,
        )
      );
    });
    if (!exactName) return false;
    const nearby = evidenceTokens.slice(Math.max(0, start - 8), start);
    return (
      nearby.some((token) => locativeTokens.has(token)) ||
      nearby.some(
        (token, index) => token === "vidimo" && nearby[index + 1] === "se",
      )
    );
  });
}

function hasLocativeSocialHandleMention(
  evidenceText: string,
  canonicalHandle: string,
): boolean {
  const handle = normalizeHandle(canonicalHandle);
  if (!handle) return false;
  const exactHandlePattern =
    /(?:^|[^\p{L}\p{N}._])@([a-z0-9_]+(?:\.[a-z0-9_]+)*)/giu;
  for (const match of evidenceText.matchAll(exactHandlePattern)) {
    if (normalizeHandle(match[1] ?? "") !== handle) continue;
    const mentionIndex = match.index ?? 0;
    const nearby = normalizeWords(
      evidenceText.slice(Math.max(0, mentionIndex - 120), mentionIndex),
    )
      .split(" ")
      .filter(Boolean);
    if (
      nearby.some((token) =>
        new Set([
          "at",
          "kod",
          "lokacija",
          "location",
          "mesto",
          "mestu",
          "na",
          "u",
          "venue",
        ]).has(token),
      ) ||
      nearby.some(
        (token, index) => token === "vidimo" && nearby[index + 1] === "se",
      ) ||
      evidenceText
        .slice(Math.max(0, mentionIndex - 24), mentionIndex)
        .includes("📍")
    ) {
      return true;
    }
  }
  return false;
}

function hasExactEvidenceToken(
  evidenceText: string,
  expectedCompactToken: string,
): boolean {
  return normalizeWords(evidenceText)
    .split(" ")
    .filter(Boolean)
    .some((token) => compact(token) === expectedCompactToken);
}

function exactHashtagTokens(evidenceText: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = evidenceText.normalize("NFKC");
  const pattern = /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu;
  for (const match of normalized.matchAll(pattern)) {
    const token = compact(match[1] ?? "");
    if (token) tokens.add(token);
  }
  return tokens;
}

const NON_OCCURRENCE_URL_HOSTS = new Set([
  "beacons.ai",
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "tiktok.com",
  "www.facebook.com",
  "www.instagram.com",
  "www.tiktok.com",
  "www.youtube.com",
  "youtu.be",
  "youtube.com",
]);

const GENERIC_EVENT_URL_SEGMENTS = new Set([
  "calendar",
  "dogadjaj",
  "dogadjaji",
  "event",
  "events",
  "eventcalendar",
  "listing",
  "listings",
  "program",
  "programi",
  "programs",
  "ticket",
  "tickets",
  "ulaznica",
  "ulaznice",
  "upcoming",
]);

function normalizeExplicitOccurrenceUrl(rawValue: string): string | null {
  const trimmed = rawValue
    .normalize("NFKC")
    .trim()
    .replace(/[),.;!?\]}>'"]+$/gu, "");
  if (trimmed.length > 512) return null;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const pathSegments = url.pathname
      .split("/")
      .map((segment) => compact(decodeURIComponent(segment)))
      .filter(Boolean);
    const occurrencePathSegments = pathSegments.filter(
      (segment) =>
        !GENERIC_EVENT_URL_SEGMENTS.has(segment) &&
        !/^(?:en|hr|rs|sr|sr-latn)$/u.test(segment) &&
        !/^\d{4}(?:\d{2}){0,2}$/u.test(segment),
    );
    const hasDistinctOccurrencePath = occurrencePathSegments.some(
      (segment) =>
        (/\p{L}/u.test(segment) && /(?:20\d{6}|\d{5,})/u.test(segment)) ||
        (/^\d+$/u.test(segment) && segment.length >= 5),
    );
    const hasDistinctOccurrenceQuery = [...url.searchParams.entries()].some(
      ([key, value]) =>
        /^(?:event|eventid|performance|show|showid)$/iu.test(key) &&
        compact(value).length >= 4,
    );
    if (
      url.protocol !== "https:" ||
      NON_OCCURRENCE_URL_HOSTS.has(hostname) ||
      url.pathname === "/" ||
      (!hasDistinctOccurrencePath && !hasDistinctOccurrenceQuery) ||
      !/(?:ticket|ulaznic|event|dogadj|događ|gigstix|entrio|efinity|cooltix|residentadvisor)/iu.test(
        `${hostname}${url.pathname}`,
      )
    ) {
      return null;
    }
    url.hostname = hostname;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:fbclid|gclid|igsh|mc_cid|mc_eid|utm_)/iu.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function explicitOccurrenceUrls(evidenceText: string): Set<string> {
  const urls = new Set<string>();
  for (const match of evidenceText
    .normalize("NFKC")
    .matchAll(/https:\/\/[^\s<>]+/giu)) {
    const normalized = normalizeExplicitOccurrenceUrl(match[0] ?? "");
    if (normalized) urls.add(normalized);
  }
  return urls;
}

/**
 * Returns a positive, source-persisted identity for unattended coalescing.
 * Shared tags or prose are deliberately insufficient: the identity must be
 * the same explicit deep ticket/event URL in every caption. Profile links,
 * social links, link hubs, and tracking-only variations fail closed.
 */
export function deriveAutomaticCrossPostCampaignIdentity(
  captions: string[],
): string | null {
  if (
    captions.length < 2 ||
    captions.length > MAX_CANDIDATE_COUNT ||
    captions.some((caption) => !caption.normalize("NFKC").trim())
  ) {
    return null;
  }
  const urlSets = captions.map(explicitOccurrenceUrls);
  const shared = [...urlSets[0]!]
    .filter((url) => urlSets.slice(1).every((urls) => urls.has(url)))
    .sort();
  return shared.length === 1 ? shared[0]! : null;
}

/**
 * Returns the second, no-URL unattended identity accepted by policy v1.
 * It is intentionally much narrower than hashtag intersection: at least three
 * exact posts must share the reviewed anchors, every source must be persisted
 * inside one short pre-event campaign window, and the pair must occur nowhere
 * else in the complete bounded history for that author. The mutation repeats
 * this proof, so a stale runner scan cannot authorize a fold.
 */
export function deriveExclusiveHashtagCrossPostCampaignIdentity(args: {
  sourceHandle: string;
  targetVenueId: string;
  date: string;
  time: string;
  eventType: string;
  anchors: string[];
  candidatePostIds: string[];
  historyPosts: CrossPostCampaignHistoryPost[];
  historyComplete: boolean;
}): string | null {
  const sourceHandle = normalizeHandle(args.sourceHandle);
  const targetVenueId = args.targetVenueId.normalize("NFKC").trim();
  const eventType = compact(args.eventType);
  const anchors = normalizedUnique(args.anchors).map(compact).sort();
  const candidatePostIds = args.candidatePostIds
    .map((postId) => postId.normalize("NFKC").trim())
    .sort();
  if (
    !args.historyComplete ||
    !sourceHandle ||
    !targetVenueId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(args.date) ||
    !/^\d{2}:\d{2}$/.test(args.time) ||
    !eventType ||
    anchors.length < 2 ||
    anchors.length > 6 ||
    anchors.some(
      (anchor) =>
        anchor.length < MIN_DISTINCTIVE_ANCHOR_LENGTH ||
        !/\p{L}/u.test(anchor) ||
        isGenericPromotionAnchor(anchor) ||
        anchor === compact(sourceHandle),
    ) ||
    candidatePostIds.length < MIN_EXCLUSIVE_HASHTAG_CAMPAIGN_POSTS ||
    candidatePostIds.length > MAX_CANDIDATE_COUNT ||
    candidatePostIds.some((postId) => !postId) ||
    new Set(candidatePostIds).size !== candidatePostIds.length ||
    args.historyPosts.length > MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY
  ) {
    return null;
  }

  const historyByPostId = new Map<string, CrossPostCampaignHistoryPost>();
  for (const post of args.historyPosts) {
    const postId = post.postId.normalize("NFKC").trim();
    if (
      normalizeHandle(post.handle) !== sourceHandle ||
      !postId ||
      historyByPostId.has(postId)
    ) {
      return null;
    }
    historyByPostId.set(postId, post);
  }
  const matchingPostIds = [...historyByPostId.values()]
    .filter((post) => {
      const hashtags = exactHashtagTokens(post.caption ?? "");
      return anchors.every((anchor) => hashtags.has(anchor));
    })
    .map((post) => post.postId.normalize("NFKC").trim())
    .sort();
  if (
    matchingPostIds.length !== candidatePostIds.length ||
    !matchingPostIds.every(
      (postId, index) => postId === candidatePostIds[index],
    )
  ) {
    return null;
  }

  const eventDay = Date.parse(`${args.date}T00:00:00.000Z`);
  const postedAtValues = candidatePostIds.map((postId) =>
    Date.parse(historyByPostId.get(postId)?.postedAt ?? ""),
  );
  if (
    !Number.isFinite(eventDay) ||
    postedAtValues.some((postedAt) => !Number.isFinite(postedAt)) ||
    postedAtValues.some(
      (postedAt) =>
        postedAt < eventDay - MAX_CAMPAIGN_LEAD_MS ||
        postedAt > eventDay + MAX_CAMPAIGN_LAG_MS,
    ) ||
    Math.max(...postedAtValues) - Math.min(...postedAtValues) >
      MAX_CAMPAIGN_POSTING_SPAN_MS
  ) {
    return null;
  }

  return `instagram-exclusive-hashtag-campaign-v1:${encodeURIComponent(
    JSON.stringify([
      sourceHandle,
      targetVenueId,
      args.date,
      args.time,
      eventType,
      anchors,
    ]),
  )}`;
}

export function captionsHaveExactCampaignHashtagAnchors(
  captions: string[],
  anchors: string[],
): boolean {
  const normalizedAnchors = normalizedUnique(anchors).map(compact);
  if (
    captions.length < 2 ||
    captions.length > MAX_CANDIDATE_COUNT ||
    normalizedAnchors.length < 2 ||
    normalizedAnchors.length > 6
  ) {
    return false;
  }
  return captions.every((caption) => {
    const hashtags = exactHashtagTokens(caption);
    return normalizedAnchors.every((anchor) => hashtags.has(anchor));
  });
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

export function hasExactCrossPostCanonicalVenueEvidence(args: {
  evidenceText: string;
  canonicalVenueName: string;
  canonicalVenueHandle: string;
}): boolean {
  return hasCanonicalVenueEvidence(
    args.evidenceText,
    args.canonicalVenueName,
    args.canonicalVenueHandle,
  );
}

/**
 * The unattended path may repair a missing or promoter-self venue binding, but
 * it must not reinterpret an arbitrary collaborator mention as a location.
 * A different persisted venue therefore needs explicit locative name/handle
 * evidence. The sole weaker exception is a venue row bound back to the source
 * author itself (the known promoter-as-venue extraction error), where an exact
 * canonical hashtag/handle is still accepted and the mutation repeats every
 * other occurrence proof atomically.
 */
export function hasAutomaticCrossPostCanonicalVenueEvidence(args: {
  evidenceText: string;
  sourceHandle: string;
  targetVenueId: string;
  canonicalVenueName: string;
  canonicalVenueHandle: string;
  currentVenueId?: string;
  currentVenueName?: string;
  currentVenueHandle?: string;
}): boolean {
  const targetVenueId = args.targetVenueId.normalize("NFKC").trim();
  const sourceHandle = normalizeHandle(args.sourceHandle);
  const canonicalVenueHandle = normalizeHandle(args.canonicalVenueHandle);
  const currentVenueHandle = normalizeHandle(args.currentVenueHandle ?? "");
  const currentVenueId = args.currentVenueId?.normalize("NFKC").trim() ?? "";
  const canonicalVenueName = args.canonicalVenueName.normalize("NFKC").trim();
  const currentVenueName =
    args.currentVenueName?.normalize("NFKC").trim() ?? "";
  if (
    !targetVenueId ||
    !sourceHandle ||
    !canonicalVenueHandle ||
    !canonicalVenueName
  ) {
    return false;
  }

  const hasAnyExactEvidence = hasCanonicalVenueEvidence(
    args.evidenceText,
    canonicalVenueName,
    canonicalVenueHandle,
  );
  const exactPersistedTargetBinding =
    currentVenueId === targetVenueId &&
    currentVenueName === canonicalVenueName &&
    currentVenueHandle === canonicalVenueHandle;
  if (exactPersistedTargetBinding) return hasAnyExactEvidence;

  if (
    hasLocativeCanonicalNameTokenSequence(
      args.evidenceText,
      canonicalVenueName,
    ) ||
    hasLocativeSocialHandleMention(args.evidenceText, canonicalVenueHandle)
  ) {
    return true;
  }

  const promoterSelfBinding =
    Boolean(currentVenueId) &&
    Boolean(currentVenueName) &&
    currentVenueHandle === sourceHandle;
  return promoterSelfBinding && hasAnyExactEvidence;
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
        isGenericPromotionAnchor(anchor) ||
        excluded.has(anchor),
    )
  ) {
    return null;
  }
  return normalized;
}

/**
 * Derives the only anchors unattended campaign coalescing may submit. An
 * arbitrary repeated phrase is not campaign identity: authors routinely copy
 * reservation, ticket, and link boilerplate across unrelated events. Each
 * anchor must therefore be an exact author-supplied hashtag present in every
 * persisted caption. Venue, author, date/promo boilerplate, short tokens, and
 * non-letter tokens are excluded before intersection. The deterministic
 * longest-first cap keeps the downstream mutation's evidence surface bounded.
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
  const captionTokenSets = options.captions.map((caption) => {
    const hashtagTokens = exactHashtagTokens(caption);
    return new Set(
      [...hashtagTokens].filter(
        (token) =>
          token.length >= MIN_DISTINCTIVE_ANCHOR_LENGTH &&
          /\p{L}/u.test(token) &&
          !isGenericPromotionAnchor(token) &&
          !excluded.has(token),
      ),
    );
  });
  const shared = [...captionTokenSets[0]!]
    .filter((token) =>
      captionTokenSets.slice(1).every((tokens) => tokens.has(token)),
    )
    .sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )
    .slice(0, 6);
  return normalizeSharedAnchors(
    shared,
    options.sourceHandle,
    options.canonicalVenueName,
    options.canonicalVenueHandle,
  );
}

function chooseDescription(
  candidates: CrossPostPromotionCandidate[],
): string | undefined {
  return candidates
    .map((candidate, index) => ({
      index,
      value: candidate.description?.normalize("NFKC").trim() ?? "",
    }))
    .filter((item) => item.value.length > 0)
    .sort(
      (left, right) =>
        right.value.length - left.value.length || left.index - right.index,
    )[0]?.value;
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
  const canonicalVenueName = options.canonicalVenueName
    .normalize("NFKC")
    .trim();
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

  const uniqueFields: Array<
    keyof Pick<
      CrossPostPromotionCandidate,
      | "id"
      | "sourceIdentity"
      | "sourceOccurrenceKey"
      | "instagramPostId"
      | "instagramPostUrl"
    >
  > = [
    "id",
    "sourceIdentity",
    "sourceOccurrenceKey",
    "instagramPostId",
    "instagramPostUrl",
  ];
  for (const field of uniqueFields) {
    const values = candidates.map((candidate) => candidate[field].trim());
    if (
      values.some((value) => !value) ||
      new Set(values).size !== values.length
    ) {
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

  const artists = normalizedUnique(
    candidates.flatMap((candidate) => candidate.artists),
  );
  const preferredImage = options.preferredImageCandidateId
    ? candidates.find(
        (candidate) => candidate.id === options.preferredImageCandidateId,
      )
    : undefined;
  if (
    options.preferredImageCandidateId &&
    (!preferredImage?.imageUrl?.trim() ||
      !preferredImage.imageStorageId?.trim())
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
