import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canonicalizeSourceUrl } from "../../lib/domain/source-url";
import { buildSourceDocumentIdentity } from "../../lib/domain/source-documents";
import { sha256Hex } from "../../lib/domain/reconciliation/evidence-digest";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "./sourceOccurrenceReceipts";

export const LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY =
  "legacy-source-occurrence-admission-v1" as const;

const MAX_SOURCE_DOCUMENT_MATCHES = 10;
const MAX_EVENT_ADMISSION_ROWS = 8;

type AdmissionCtx = QueryCtx | MutationCtx;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventEvidenceProjection(event: Doc<"events">) {
  const {
    _creationTime: _ignoredCreationTime,
    publicationEvaluatedAt: _ignoredPublicationEvaluatedAt,
    publicationPolicyVersion: _ignoredPublicationPolicyVersion,
    publicationReason: _ignoredPublicationReason,
    publicationState: _ignoredPublicationState,
    ...evidence
  } = event;
  return evidence;
}

function linkEvidenceProjection(link: Doc<"instagramEventSources">) {
  const {
    _creationTime: _ignoredCreationTime,
    canonicalSourceUrl: _ignoredCanonicalSourceUrl,
    sourceOccurrenceId: _ignoredSourceOccurrenceId,
    ...evidence
  } = link;
  return evidence;
}

function receiptEvidenceProjection(
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
  sourceOccurrenceKey: string,
) {
  const expectedOccurrences = receipt.expectedOccurrences
    ?.filter((expected) => expected.key === sourceOccurrenceKey)
    .map(
      ({ canonicalEventJson: _ignoredCanonicalEventJson, factsJson: _ignoredFactsJson, ...expected }) =>
        expected,
    );
  return {
    createdAt: receipt.createdAt,
    expectedKeyCount: receipt.expectedKeys.filter(
      (key) => key === sourceOccurrenceKey,
    ).length,
    expectedOccurrences,
    satisfiedKeyCount: receipt.satisfiedKeys.filter(
      (key) => key === sourceOccurrenceKey,
    ).length,
    satisfiedOccurrences: receipt.satisfiedOccurrences.filter(
      (satisfaction) => satisfaction.key === sourceOccurrenceKey,
    ),
    sourceFingerprint: receipt.sourceFingerprint,
    sourceIdentity: receipt.sourceIdentity,
  };
}

function sourceDocumentEvidenceProjection(source: Doc<"scrapedPosts">) {
  return {
    _id: source._id,
    altText: source.altText,
    analysisContractVersion: source.analysisContractVersion,
    analysisImageChecksumSha256: source.analysisImageChecksumSha256,
    analysisImageSourceUrl: source.analysisImageSourceUrl,
    analysisIsEvent: source.analysisIsEvent,
    analysisModel: source.analysisModel,
    analysisResultJson: source.analysisResultJson,
    analysisRevision: source.analysisRevision,
    canonicalSourceUrl: source.canonicalSourceUrl,
    caption: source.caption,
    handle: source.handle,
    imageStorageId: source.imageStorageId,
    imageUrl: source.imageUrl,
    imageUrls: source.imageUrls,
    instagramPostUrl: source.instagramPostUrl,
    locationName: source.locationName,
    postId: source.postId,
    postedAt: source.postedAt,
    processingStatus: source.processingStatus,
    sourceRevision: source.sourceRevision,
    username: source.username,
  };
}

export function buildLegacySourceOccurrenceAdmissionDigest(options: {
  event: Doc<"events">;
  link: Doc<"instagramEventSources">;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
  sourceDocument: Doc<"scrapedPosts">;
}): string {
  return sha256Hex(
    stableJson({
      event: eventEvidenceProjection(options.event),
      link: linkEvidenceProjection(options.link),
      migrationKey: LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY,
      receipt: receiptEvidenceProjection(
        options.receipt,
        options.link.sourceOccurrenceKey,
      ),
      sourceDocument: sourceDocumentEvidenceProjection(options.sourceDocument),
    }),
  );
}

export async function findLegacyAdmissionSourceDocument(
  ctx: AdmissionCtx,
  link: Doc<"instagramEventSources">,
): Promise<Doc<"scrapedPosts"> | null> {
  if (!link.instagramPostId) return null;
  const candidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_postId", (q) => q.eq("postId", link.instagramPostId!))
    .take(MAX_SOURCE_DOCUMENT_MATCHES + 1);
  if (candidates.length > MAX_SOURCE_DOCUMENT_MATCHES) return null;
  const expectedHandle = normalizeHandle(link.sourceHandle ?? "");
  const canonicalLink = canonicalizeSourceUrl(
    "instagram",
    link.instagramPostUrl,
  );
  if (link.instagramPostUrl && !canonicalLink.ok) return null;
  const matches = candidates.filter((candidate) => {
    const canonicalCandidate = canonicalizeSourceUrl(
      "instagram",
      candidate.instagramPostUrl,
    );
    return (
      canonicalCandidate.ok &&
      (!expectedHandle || normalizeHandle(candidate.handle) === expectedHandle) &&
      (!canonicalLink.ok ||
        canonicalCandidate.value.canonicalUrl ===
          canonicalLink.value.canonicalUrl)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function legacyAdmissionSourceIdentityMatches(
  link: Doc<"instagramEventSources">,
  sourceDocument: Doc<"scrapedPosts">,
): boolean {
  const canonical = canonicalizeSourceUrl(
    "instagram",
    sourceDocument.instagramPostUrl,
  );
  return Boolean(
    canonical.ok &&
      link.sourceIdentity ===
        buildSourceDocumentIdentity("instagram", canonical.value) &&
      link.instagramPostId === sourceDocument.postId &&
      link.instagramPostUrl === sourceDocument.instagramPostUrl,
  );
}

export async function loadVerifiedLegacySourceOccurrenceAdmission(
  ctx: AdmissionCtx,
  options: {
    event: Doc<"events">;
    link: Doc<"instagramEventSources">;
    receipt: Doc<"instagramSourceOccurrenceReceipts">;
    sourceDocument: Doc<"scrapedPosts">;
  },
): Promise<Doc<"legacySourceOccurrenceAdmissions"> | null> {
  const { event, link, receipt, sourceDocument } = options;
  if (
    (event.status !== "approved" && event.status !== "pending") ||
    event.legacySourceOccurrenceAdmissionPolicyVersion !== 1 ||
    isCrossPostCampaignLineageEvent(event) ||
    link.eventId !== event._id ||
    link.sourceIdentity !== receipt.sourceIdentity ||
    link.sourceFingerprint !== receipt.sourceFingerprint ||
    !legacyAdmissionSourceIdentityMatches(link, sourceDocument)
  ) {
    return null;
  }
  try {
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  } catch {
    return null;
  }
  const expected = receipt.expectedOccurrences?.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  const satisfactions = receipt.satisfiedOccurrences.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  if (
    expected?.length !== 1 ||
    satisfactions.length !== 1 ||
    satisfactions[0]?.eventId !== event._id ||
    !sourceOccurrenceRepresentativeMatchesExpected(event, expected[0])
  ) {
    return null;
  }
  const rows = await ctx.db
    .query("legacySourceOccurrenceAdmissions")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
        .eq("sourceIdentity", link.sourceIdentity)
        .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
    )
    .take(2);
  const row = rows.length === 1 ? rows[0]! : null;
  if (
    !row ||
    row.eventId !== event._id ||
    row.sourceLinkId !== link._id ||
    row.receiptId !== receipt._id ||
    row.sourceDocumentId !== sourceDocument._id ||
    !/^[0-9a-f]{64}$/u.test(row.evidenceDigestSha256) ||
    row.evidenceDigestSha256 !==
      buildLegacySourceOccurrenceAdmissionDigest(options)
  ) {
    return null;
  }
  return row;
}

export async function hasVerifiedLegacySourceOccurrenceAdmissionForEvent(
  ctx: AdmissionCtx,
  event: Doc<"events">,
): Promise<boolean> {
  if (event.legacySourceOccurrenceAdmissionPolicyVersion !== 1) return false;
  const rows = await ctx.db
    .query("legacySourceOccurrenceAdmissions")
    .withIndex("by_event", (q) =>
      q
        .eq("migrationKey", LEGACY_SOURCE_OCCURRENCE_ADMISSION_KEY)
        .eq("eventId", event._id),
    )
    .take(MAX_EVENT_ADMISSION_ROWS + 1);
  if (rows.length === 0 || rows.length > MAX_EVENT_ADMISSION_ROWS) return false;
  for (const row of rows) {
    const [link, receipt, sourceDocument] = await Promise.all([
      ctx.db.get(row.sourceLinkId),
      ctx.db.get(row.receiptId),
      ctx.db.get(row.sourceDocumentId),
    ]);
    if (
      link &&
      receipt &&
      sourceDocument &&
      (await loadVerifiedLegacySourceOccurrenceAdmission(ctx, {
        event,
        link,
        receipt,
        sourceDocument,
      }))
    ) {
      return true;
    }
  }
  return false;
}
