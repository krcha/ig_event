import {
  canonicalizeSourceUrl,
  type CanonicalSourceUrl,
  type SourceProvider,
} from "./source-url";

export type SourceDocumentEvidence = {
  altText: string | null;
  caption: string | null;
  locationName: string | null;
  mediaUrls: readonly string[];
};

export type SourceDocument = {
  canonicalSource: CanonicalSourceUrl;
  capturedAt: number;
  evidence: SourceDocumentEvidence;
  id: string;
  legacyMetadata?: {
    sourceKey?: string;
  };
  provider: SourceProvider;
  providerAccount: string;
  providerDocumentId: string;
  /** Provider-neutral publication instant when the source exposes one. */
  publishedAt: string | null;
  /** Opaque acquisition metadata used only by the owning provider adapter. */
  providerMetadata?: Readonly<{
    contentType?: string | null;
    isPinned?: boolean;
  }>;
  sourceIdentity: string;
  sourceRevision: number;
};

export type InstagramSourceDocumentRecord = {
  _id: unknown;
  _creationTime?: number;
  altText?: string;
  caption?: string;
  createdAt?: number;
  handle: string;
  imageUrl?: string;
  imageUrls?: string[];
  instagramPostUrl: string;
  locationName?: string;
  postId: string;
  postedAt?: string;
  postType?: string;
  isPinned?: boolean;
  sourceKey?: string;
  sourceRevision?: number;
};

function normalizeProviderAccount(value: string): string {
  return value.replace(/^@/u, "").trim().toLowerCase();
}

/**
 * The single identity authority for source documents and their occurrences.
 * A canonical source carries the provider external ID; legacy callers may pass
 * that external ID directly after applying their bounded compatibility fallback.
 */
export function buildSourceDocumentIdentity(
  provider: SourceProvider,
  canonicalSourceOrExternalId: CanonicalSourceUrl | string,
): string {
  if (
    typeof canonicalSourceOrExternalId !== "string" &&
    canonicalSourceOrExternalId.provider !== provider
  ) {
    throw new TypeError(
      "Source identity provider does not match the canonical source.",
    );
  }

  const externalId =
    typeof canonicalSourceOrExternalId === "string"
      ? canonicalSourceOrExternalId.trim()
      : canonicalSourceOrExternalId.externalId.trim();
  if (!externalId) {
    throw new TypeError("Source identity requires a canonical external ID.");
  }

  return `${provider}-source-identity-v1:${externalId}`;
}

/** Compatibility adapter: `scrapedPosts` remains the durable source-document
 * table during the strangler migration. */
export function adaptInstagramScrapedPostToSourceDocument(
  record: InstagramSourceDocumentRecord,
): SourceDocument {
  const canonicalSource = canonicalizeSourceUrl(
    "instagram",
    record.instagramPostUrl,
  );
  if (!canonicalSource.ok) throw canonicalSource.error;

  const providerAccount = normalizeProviderAccount(record.handle);
  const providerDocumentId =
    record.postId.trim() || canonicalSource.value.externalId;
  const legacySourceKey = record.sourceKey?.trim();

  return {
    canonicalSource: canonicalSource.value,
    capturedAt: record.createdAt ?? record._creationTime ?? 0,
    evidence: {
      altText: record.altText?.trim() || null,
      caption: record.caption?.trim() || null,
      locationName: record.locationName?.trim() || null,
      mediaUrls: [
        ...new Set([
          record.imageUrl,
          ...(record.imageUrls ?? []),
        ].filter(Boolean)),
      ] as string[],
    },
    id: String(record._id),
    ...(legacySourceKey
      ? { legacyMetadata: { sourceKey: legacySourceKey } }
      : {}),
    provider: "instagram",
    providerAccount,
    providerDocumentId,
    publishedAt: record.postedAt?.trim() || null,
    providerMetadata: {
      contentType: record.postType?.trim() || null,
      ...(record.isPinned === undefined ? {} : { isPinned: record.isPinned }),
    },
    sourceIdentity: buildSourceDocumentIdentity(
      "instagram",
      canonicalSource.value,
    ),
    sourceRevision: record.sourceRevision ?? 1,
  };
}
