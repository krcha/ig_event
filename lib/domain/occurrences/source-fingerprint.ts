import { sha256Hex } from "../reconciliation/evidence-digest";

export const SOURCE_OCCURRENCE_EXTRACTION_PROTOCOL_VERSION =
  "2026-08-23-event-evidence-v2-lineup-occurrence-v1";

export type InstagramSourceFingerprintEvidence = Readonly<{
  altText?: string | null;
  caption?: string | null;
  locationName?: string | null;
}>;

function normalizeEvidence(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Provider-portable source-generation fingerprint. Both the ingestion worker
 * and the Convex write boundary use this exact implementation so a leased
 * SourceDocument cannot be paired with a stale or unrelated occurrence plan.
 */
export function buildInstagramSourceOccurrenceFingerprint(
  evidence: InstagramSourceFingerprintEvidence,
): string {
  const digest = sha256Hex(
    JSON.stringify({
      protocolVersion: SOURCE_OCCURRENCE_EXTRACTION_PROTOCOL_VERSION,
      caption: normalizeEvidence(evidence.caption),
      altText: normalizeEvidence(evidence.altText),
      locationName: normalizeEvidence(evidence.locationName),
    }),
  );
  return `instagram-source-v2:${digest}`;
}
