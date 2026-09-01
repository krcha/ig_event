import type { SourceProvider } from "@/lib/domain/source-url";
import {
  adaptInstagramScrapedPostToSourceDocument,
  buildSourceDocumentIdentity,
  type InstagramSourceDocumentRecord,
  type SourceDocument,
} from "@/lib/domain/source-documents";
import {
  getInstagramScrapeRawItemCount,
  loadRecentApifyRunPosts,
  scrapeInstagramAccount,
  type InstagramScrapedPost,
} from "@/lib/scraper/instagram-scraper";

/**
 * Provider boundary for acquiring raw source documents. Canonical-event and
 * reconciliation code consume the generic SourceDocument/SourceOccurrence
 * domain models and do not depend on this adapter.
 */
export type SourceProviderFetchBatch = {
  documents: SourceDocument[];
  rawDocumentCount: number;
};

export interface SourceProviderAdapter<TCompatibilityDocument, TFetchRequest> {
  readonly provider: SourceProvider;
  fetchDocuments(request: TFetchRequest): Promise<SourceProviderFetchBatch>;
  projectForCompatibilityParser(
    document: SourceDocument,
  ): TCompatibilityDocument;
}

export type InstagramSourceProviderAdapter = SourceProviderAdapter<
  InstagramScrapedPost,
  Parameters<typeof scrapeInstagramAccount>[0]
> & {
  adaptPersistedDocument(record: InstagramSourceDocumentRecord): SourceDocument;
  loadRecentDocuments(
    request: Parameters<typeof loadRecentApifyRunPosts>[0],
  ): Promise<InstagramRecentSourceDocumentBatch>;
};

export type InstagramSourceProviderDependencies = {
  fetchProviderRows: typeof scrapeInstagramAccount;
  now: () => number;
};

export type InstagramRecentSourceDocumentBatch = {
  documentsByHandle: Record<string, SourceDocument[]>;
  importedPosts: number;
  runsScanned: number;
};

export type InstagramRecentSourceProviderDependencies = {
  loadProviderRows: typeof loadRecentApifyRunPosts;
  now: () => number;
};

const DEFAULT_INSTAGRAM_SOURCE_PROVIDER_DEPENDENCIES: InstagramSourceProviderDependencies =
  {
    fetchProviderRows: scrapeInstagramAccount,
    now: Date.now,
  };

const DEFAULT_INSTAGRAM_RECENT_SOURCE_PROVIDER_DEPENDENCIES: InstagramRecentSourceProviderDependencies =
  {
    loadProviderRows: loadRecentApifyRunPosts,
    now: Date.now,
  };

function adaptFetchedInstagramPostToSourceDocument(
  post: InstagramScrapedPost,
  capturedAt: number,
): SourceDocument {
  return adaptInstagramScrapedPostToSourceDocument({
    _id: `fetched-instagram:${post.postId || post.instagramPostUrl}`,
    altText: post.altText ?? undefined,
    caption: post.caption ?? undefined,
    createdAt: capturedAt,
    handle: post.username,
    imageUrl: post.imageUrl ?? undefined,
    imageUrls: post.imageUrls,
    instagramPostUrl: post.instagramPostUrl,
    locationName: post.locationName ?? undefined,
    postId: post.postId,
    postedAt: post.postedAt ?? undefined,
    postType: post.postType ?? undefined,
    isPinned: post.isPinned,
  });
}

/** Acquires provider rows and crosses the generic SourceDocument boundary. */
export async function fetchInstagramSourceDocuments(
  request: Parameters<typeof scrapeInstagramAccount>[0],
  dependencies: InstagramSourceProviderDependencies = DEFAULT_INSTAGRAM_SOURCE_PROVIDER_DEPENDENCIES,
): Promise<SourceProviderFetchBatch> {
  const providerRows = await dependencies.fetchProviderRows(request);
  const capturedAt = dependencies.now();
  return {
    documents: providerRows.map((providerRow) =>
      adaptFetchedInstagramPostToSourceDocument(providerRow, capturedAt),
    ),
    rawDocumentCount: getInstagramScrapeRawItemCount(providerRows),
  };
}

/** Historical Apify recovery crosses the same SourceDocument boundary. */
export async function loadRecentInstagramSourceDocuments(
  request: Parameters<typeof loadRecentApifyRunPosts>[0],
  dependencies: InstagramRecentSourceProviderDependencies = DEFAULT_INSTAGRAM_RECENT_SOURCE_PROVIDER_DEPENDENCIES,
): Promise<InstagramRecentSourceDocumentBatch> {
  const providerResult = await dependencies.loadProviderRows(request);
  const capturedAt = dependencies.now();
  return {
    documentsByHandle: Object.fromEntries(
      Object.entries(providerResult.importedPostsByHandle).map(
        ([handle, providerRows]) => [
          handle,
          providerRows.map((providerRow) =>
            adaptFetchedInstagramPostToSourceDocument(providerRow, capturedAt),
          ),
        ],
      ),
    ),
    importedPosts: providerResult.importedPosts,
    runsScanned: providerResult.runsScanned,
  };
}

/**
 * Explicit parser projection owned by the Instagram adapter. Parser evidence
 * is reconstructed from SourceDocument rather than passed through from the
 * provider row, so acquisition cannot bypass the generic source boundary.
 */
export function projectInstagramSourceDocumentForCompatibilityParser(
  document: SourceDocument,
): InstagramScrapedPost {
  if (document.provider !== "instagram") {
    throw new TypeError(
      "Instagram compatibility projection received another provider.",
    );
  }
  if (
    buildSourceDocumentIdentity("instagram", document.canonicalSource) !==
    document.sourceIdentity
  ) {
    throw new TypeError(
      "Instagram parser projection received a changed source identity.",
    );
  }
  const mediaUrls = [...document.evidence.mediaUrls];
  return {
    postId: document.providerDocumentId,
    caption: document.evidence.caption,
    altText: document.evidence.altText,
    imageUrl: mediaUrls[0] ?? null,
    imageUrls: mediaUrls,
    postType: document.providerMetadata?.contentType ?? null,
    locationName: document.evidence.locationName,
    instagramPostUrl: document.canonicalSource.canonicalUrl,
    postedAt: document.publishedAt,
    username: document.providerAccount,
    ...(document.providerMetadata?.isPinned === undefined
      ? {}
      : { isPinned: document.providerMetadata.isPinned }),
  };
}

/** Current Instagram/Apify implementation of the provider boundary. */
export const instagramSourceProviderAdapter: InstagramSourceProviderAdapter = {
  provider: "instagram",
  adaptPersistedDocument: adaptInstagramScrapedPostToSourceDocument,
  fetchDocuments: fetchInstagramSourceDocuments,
  loadRecentDocuments: loadRecentInstagramSourceDocuments,
  projectForCompatibilityParser:
    projectInstagramSourceDocumentForCompatibilityParser,
};
