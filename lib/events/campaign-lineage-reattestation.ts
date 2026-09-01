import { digestOccurrenceSignature } from "../domain/occurrences/signature";
import { exactJsonValue } from "./exact-json-value";
import type {
  CrossPostCampaignAggregateAttestation,
  CrossPostCampaignAggregateSource,
} from "./cross-post-campaign-aggregate-attestation";

export const CAMPAIGN_LINEAGE_REATTESTATION_KEY =
  "campaign-lineage-reattestation-v1" as const;

export type CampaignLineageEvidenceSource = {
  canonicalSourceUrl: string;
  expected: {
    artists: string[];
    date: string;
    key: string;
    time?: string;
    title: string;
    venue: string;
  };
  occurrenceOrdinal: number;
  receiptId: string;
  sourceDocumentId: string;
  sourceFingerprint: string;
  sourceIdentity: string;
  sourceLinkId: string;
  sourceOccurrenceKey: string;
  sourceRevision: number;
};

export function buildCampaignLineageEvidenceDigest(input: {
  operationId: string;
  primaryEventId: string;
  sources: CampaignLineageEvidenceSource[];
  targetVenueId: string;
}): string {
  return digestOccurrenceSignature(JSON.stringify(input));
}

function sourceTransitionIsStrictlyAdditive(
  before: CrossPostCampaignAggregateSource,
  after: CrossPostCampaignAggregateSource,
  primary: boolean,
): boolean {
  const {
    eventUpdatedAt: beforeEventUpdatedAt,
    sourceLinkUpdatedAt: beforeSourceLinkUpdatedAt,
    ...beforeIdentity
  } = before;
  const {
    eventUpdatedAt: afterEventUpdatedAt,
    sourceLinkUpdatedAt: afterSourceLinkUpdatedAt,
    ...afterIdentity
  } = after;
  return (
    exactJsonValue(beforeIdentity, afterIdentity) &&
    (primary
      ? afterEventUpdatedAt >= beforeEventUpdatedAt
      : afterEventUpdatedAt === beforeEventUpdatedAt) &&
    afterSourceLinkUpdatedAt >= beforeSourceLinkUpdatedAt
  );
}

/**
 * Campaign re-attestation is allowed to advance only the primary event version
 * and the source-link versions needed to add first-class occurrence pointers.
 * Every semantic, source, receipt, and public-binding field remains immutable.
 */
export function isExactCampaignLineageReattestationTransition(
  before: CrossPostCampaignAggregateAttestation,
  after: CrossPostCampaignAggregateAttestation,
): boolean {
  const { sources: beforeSources, ...beforeCampaign } = before;
  const { sources: afterSources, ...afterCampaign } = after;
  return (
    exactJsonValue(beforeCampaign, afterCampaign) &&
    beforeSources.length === afterSources.length &&
    beforeSources.every((source, index) =>
      sourceTransitionIsStrictlyAdditive(
        source,
        afterSources[index]!,
        index === 0,
      ),
    )
  );
}
