import { CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION } from "./cross-post-promotion-coalescing.ts";

export const CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD =
  "crossPostCampaignAggregateAttestation";
export const REVIEWED_PROMOTION_VARIANT_FOLD_FIELD =
  "reviewedPromotionVariantFold";
export const REVIEWED_SAME_SOURCE_CONTINUATION_FOLD_FIELD =
  "reviewedSameSourceContinuationFold";

export type CrossPostCampaignAggregateBinding = {
  title: string;
  date: string;
  time?: string;
  venue: string;
  artists: string[];
};

export type CrossPostCampaignAggregateSource = {
  eventId: string;
  eventUpdatedAt: number;
  sourceLinkId: string;
  sourceLinkUpdatedAt: number;
  receiptId: string;
  receiptUpdatedAt: number;
  sourceIdentity: string;
  sourceFingerprint: string;
  sourceOccurrenceKey: string;
  instagramPostId: string;
  instagramPostUrl: string;
  sourceHandle: string;
};

export type CrossPostCampaignAggregateAttestation = {
  policyVersion: typeof CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION;
  operationId: string;
  primaryEventId: string;
  targetVenueId: string;
  lineageDepth: number;
  totalSourceCount: number;
  campaignAnchors: string[];
  campaignPostIds: string[];
  automaticCampaignIdentity?: string;
  legacyOperationId?: string;
  publicBinding: CrossPostCampaignAggregateBinding;
  sources: CrossPostCampaignAggregateSource[];
};

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBinding(value: unknown): CrossPostCampaignAggregateBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (
    !isNonemptyString(binding.title) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(binding.date ?? "")) ||
    (binding.time !== undefined &&
      (!isNonemptyString(binding.time) || !/^\d{2}:\d{2}$/.test(binding.time))) ||
    !isNonemptyString(binding.venue) ||
    !Array.isArray(binding.artists) ||
    binding.artists.some((artist) => !isNonemptyString(artist)) ||
    new Set(binding.artists).size !== binding.artists.length
  ) {
    return null;
  }
  return {
    title: binding.title,
    date: String(binding.date),
    ...(binding.time !== undefined ? { time: binding.time } : {}),
    venue: binding.venue,
    artists: [...binding.artists],
  };
}

function parseSource(value: unknown): CrossPostCampaignAggregateSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    !isNonemptyString(source.eventId) ||
    !isSafeVersion(source.eventUpdatedAt) ||
    !isNonemptyString(source.sourceLinkId) ||
    !isSafeVersion(source.sourceLinkUpdatedAt) ||
    !isNonemptyString(source.receiptId) ||
    !isSafeVersion(source.receiptUpdatedAt) ||
    !isNonemptyString(source.sourceIdentity) ||
    !isNonemptyString(source.sourceFingerprint) ||
    !isNonemptyString(source.sourceOccurrenceKey) ||
    !isNonemptyString(source.instagramPostId) ||
    !isNonemptyString(source.instagramPostUrl) ||
    !isNonemptyString(source.sourceHandle)
  ) {
    return null;
  }
  return source as CrossPostCampaignAggregateSource;
}

export function parseCrossPostCampaignAggregateAttestation(
  value: unknown,
): CrossPostCampaignAggregateAttestation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attestation = value as Record<string, unknown>;
  const publicBinding = parseBinding(attestation.publicBinding);
  const sources = Array.isArray(attestation.sources)
    ? attestation.sources.map(parseSource)
    : [];
  if (
    attestation.policyVersion !== CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION ||
    !isNonemptyString(attestation.operationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(attestation.operationId) ||
    !isNonemptyString(attestation.primaryEventId) ||
    !isNonemptyString(attestation.targetVenueId) ||
    !isSafeVersion(attestation.lineageDepth) ||
    attestation.lineageDepth < 1 ||
    attestation.lineageDepth > 7 ||
    !isSafeVersion(attestation.totalSourceCount) ||
    attestation.totalSourceCount < 2 ||
    attestation.totalSourceCount > 8 ||
    !Array.isArray(attestation.campaignAnchors) ||
    attestation.campaignAnchors.length < 2 ||
    attestation.campaignAnchors.length > 6 ||
    attestation.campaignAnchors.some((anchor) => !isNonemptyString(anchor)) ||
    new Set(attestation.campaignAnchors).size !== attestation.campaignAnchors.length ||
    !Array.isArray(attestation.campaignPostIds) ||
    attestation.campaignPostIds.length !== attestation.totalSourceCount ||
    attestation.campaignPostIds.some((postId) => !isNonemptyString(postId)) ||
    new Set(attestation.campaignPostIds).size !== attestation.campaignPostIds.length ||
    (attestation.automaticCampaignIdentity !== undefined &&
      !isNonemptyString(attestation.automaticCampaignIdentity)) ||
    (attestation.legacyOperationId !== undefined &&
      (!isNonemptyString(attestation.legacyOperationId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(
          attestation.legacyOperationId,
        ) ||
        attestation.legacyOperationId === attestation.operationId)) ||
    !publicBinding ||
    sources.length < 2 ||
    sources.length > 8 ||
    sources.some((source) => source === null)
  ) {
    return null;
  }
  const exactSources = sources as CrossPostCampaignAggregateSource[];
  const exactCampaignPostIds = attestation.campaignPostIds as string[];
  for (const field of [
    "eventId",
    "sourceLinkId",
    "receiptId",
    "sourceIdentity",
    "sourceOccurrenceKey",
    "instagramPostId",
    "instagramPostUrl",
  ] as const) {
    if (new Set(exactSources.map((source) => source[field])).size !== exactSources.length) {
      return null;
    }
  }
  if (
    exactSources[0]?.eventId !== attestation.primaryEventId ||
    exactSources[0]?.instagramPostId !== exactCampaignPostIds[0] ||
    exactSources.some(
      (source) => !exactCampaignPostIds.includes(source.instagramPostId),
    )
  ) {
    return null;
  }
  return {
    policyVersion: CROSS_POST_PROMOTION_COALESCING_POLICY_VERSION,
    operationId: attestation.operationId,
    primaryEventId: attestation.primaryEventId,
    targetVenueId: attestation.targetVenueId,
    lineageDepth: attestation.lineageDepth,
    totalSourceCount: attestation.totalSourceCount,
    campaignAnchors: [...attestation.campaignAnchors] as string[],
    campaignPostIds: [...exactCampaignPostIds],
    ...(attestation.automaticCampaignIdentity !== undefined
      ? { automaticCampaignIdentity: attestation.automaticCampaignIdentity }
      : {}),
    ...(attestation.legacyOperationId !== undefined
      ? { legacyOperationId: attestation.legacyOperationId }
      : {}),
    publicBinding,
    sources: exactSources,
  };
}

export function readCrossPostCampaignAggregateAttestation(
  normalizedFieldsJson: string | undefined,
): CrossPostCampaignAggregateAttestation | null {
  if (!normalizedFieldsJson) return null;
  try {
    const parsed = JSON.parse(normalizedFieldsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseCrossPostCampaignAggregateAttestation(
      (parsed as Record<string, unknown>)[
        CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD
      ],
    );
  } catch {
    return null;
  }
}

export function hasCrossPostCampaignAggregateAttestationField(
  normalizedFieldsJson: string | null | undefined,
): boolean {
  if (!normalizedFieldsJson) return false;
  try {
    const parsed = JSON.parse(normalizedFieldsJson) as unknown;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.hasOwn(
          parsed as Record<string, unknown>,
          CROSS_POST_CAMPAIGN_AGGREGATE_ATTESTATION_FIELD,
        ),
    );
  } catch {
    return false;
  }
}

export function isCrossPostCampaignLineageEvent(event: {
  normalizedFieldsJson?: string | null;
  moderationNote?: string | null;
}): boolean {
  let hasReviewedOccurrenceFold = false;
  try {
    const parsed = JSON.parse(event.normalizedFieldsJson ?? "null") as unknown;
    hasReviewedOccurrenceFold = Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        [
          REVIEWED_PROMOTION_VARIANT_FOLD_FIELD,
          REVIEWED_SAME_SOURCE_CONTINUATION_FOLD_FIELD,
        ].some((field) => Object.hasOwn(parsed as Record<string, unknown>, field)),
    );
  } catch {
    hasReviewedOccurrenceFold = false;
  }
  return (
    hasCrossPostCampaignAggregateAttestationField(event.normalizedFieldsJson) ||
    hasReviewedOccurrenceFold ||
    event.moderationNote?.startsWith("[cross_post_campaign_variant:") === true ||
    event.moderationNote?.startsWith("[cross_post_campaign_primary:") === true ||
    event.moderationNote?.startsWith("[reviewed_promotion_variant:") === true ||
    event.moderationNote?.startsWith("[reviewed_same_source_continuation:") === true
  );
}

/** True only for the dedicated cross-post campaign proof protocol. Reviewed
 * promotion/continuation folds have their own audited transition proof and
 * must not be routed through the campaign re-attestation verifier. */
export function isCrossPostCampaignAttestationEvent(event: {
  normalizedFieldsJson?: string | null;
  moderationNote?: string | null;
}): boolean {
  return (
    hasCrossPostCampaignAggregateAttestationField(event.normalizedFieldsJson) ||
    event.moderationNote?.startsWith("[cross_post_campaign_variant:") === true ||
    event.moderationNote?.startsWith("[cross_post_campaign_primary:") === true
  );
}

function exactArtistsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((artist, index) => artist === right[index])
  );
}

export function crossPostCampaignAggregateBindingMatchesEvent(
  attestation: CrossPostCampaignAggregateAttestation,
  event: {
    _id: string;
    title: string;
    date: string;
    time?: string;
    venue: string;
    artists: string[];
    venueId?: string;
  },
): boolean {
  return (
    attestation.primaryEventId === event._id &&
    attestation.targetVenueId === event.venueId &&
    attestation.publicBinding.title === event.title &&
    attestation.publicBinding.date === event.date &&
    attestation.publicBinding.time === event.time &&
    attestation.publicBinding.venue === event.venue &&
    exactArtistsEqual(attestation.publicBinding.artists, event.artists)
  );
}
