import { buildSourceDocumentIdentity } from "@/lib/domain/source-documents";
import { canonicalizeSourceUrl } from "@/lib/domain/source-url";
import { canonicalizeVenueName, type CanonicalVenueAliasesByHandle, normalizeExtractedArtists, toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import type { SourceDocument } from "@/lib/domain/source-documents";
import { ConvexHttpClient } from "convex/browser";
import type { EventImportRecord, SavedScrapedPostRecord, ScrapedPostsPage } from "@/lib/pipeline/ingestion/contracts";
import { getScrapedPostsManyByHandleAndPostRefsQuery, getScrapedPostsManyByIdsQuery, listScrapedPostsByHandlePaginatedQuery, listScrapedPostsByHandleQuery, upsertScrapedPostsByHandleMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import { chunkItems, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { normalizeString } from "@/lib/pipeline/ingestion/values";
import { instagramSourceProviderAdapter } from "@/lib/pipeline/ingestion/source-provider";

const SCRAPED_POST_UPSERT_BATCH_SIZE = 25;

/** `scrapedPosts` is the persisted Instagram implementation of SourceDocument. */
export function mapSavedScrapedPostToSourceDocument(
  record: SavedScrapedPostRecord,
): SourceDocument {
  return instagramSourceProviderAdapter.adaptPersistedDocument(record);
}


export async function persistScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  posts: InstagramScrapedPost[],
  serviceSecret: string,
  fetchLeaseOwner?: string,
): Promise<Array<{ scrapedPostId: string; postId: string; sourceRevision: number }>> {
  if (posts.length === 0) {
    return [];
  }

  const persistedPosts: Array<{
    scrapedPostId: string;
    postId: string;
    sourceRevision: number;
  }> = [];
  for (const postBatch of chunkItems(posts, SCRAPED_POST_UPSERT_BATCH_SIZE)) {
    const persistedBatch = await client.mutation(
      upsertScrapedPostsByHandleMutation,
      withServiceSecret(
        {
          handle,
          ...(fetchLeaseOwner ? { fetchLeaseOwner } : {}),
          posts: postBatch.map((post) => ({
            handle,
            postId: post.postId,
            caption: post.caption ?? "",
            altText: post.altText ?? "",
            ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
            imageUrls: post.imageUrls,
            postType: post.postType ?? "",
            locationName: post.locationName ?? "",
            instagramPostUrl: post.instagramPostUrl,
            ...(post.postedAt ? { postedAt: post.postedAt } : {}),
            username: post.username,
          })),
        },
        serviceSecret,
      ),
    ) as Array<{ scrapedPostId: string; postId: string; sourceRevision: number }>;
    persistedPosts.push(...persistedBatch);
  }
  return persistedPosts;
}

export async function loadSavedScrapedPostsForHandle(
  client: ConvexHttpClient,
  handle: string,
  resultsLimit: number | undefined,
  daysBack: number | undefined,
  serviceSecret: string,
): Promise<InstagramScrapedPost[]> {
  const savedPosts = (await client.query(
    listScrapedPostsByHandleQuery,
    withServiceSecret({ handle }, serviceSecret),
  )) as SavedScrapedPostRecord[];

  const now = Date.now();
  const filtered = savedPosts
    .filter(
      (record) =>
        !(
          record.processingStatus === "completed" &&
          ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(
            record.processingOutcome ?? "",
          )
        ) &&
        !(
          record.processingStatus === "retryable_failure" &&
          (record.processingRetryAt ?? 0) > now
        ),
    )
    .map(mapSavedScrapedPostToInstagramPost)
    .filter((post) => isPostWithinDaysBack(post.postedAt, daysBack))
    .sort((left, right) => comparePostedAtDescending(left.postedAt, right.postedAt));

  if (!resultsLimit || resultsLimit < 1) {
    return filtered;
  }

  return filtered.slice(0, resultsLimit);
}

export async function loadSavedScrapedPostPageForHandle(options: {
  client: ConvexHttpClient;
  handle: string;
  cursor: string | null;
  pageSize: number;
  daysBack: number | undefined;
  alreadyAcceptedCount: number;
  resultsLimit: number | undefined;
  serviceSecret: string;
}): Promise<{
  candidateIds: string[];
  continueCursor: string;
  isDone: boolean;
  shouldCompleteHandle: boolean;
  acceptedCount: number;
}> {
  const page = (await options.client.query(
    listScrapedPostsByHandlePaginatedQuery,
    withServiceSecret(
      {
        handle: options.handle,
        paginationOpts: {
          cursor: options.cursor,
          numItems: options.pageSize,
        },
      },
      options.serviceSecret,
    ),
  )) as ScrapedPostsPage;
  const candidateIds: string[] = [];
  let acceptedCount = options.alreadyAcceptedCount;
  let hitDaysBackBoundary = false;

  for (const record of page.page) {
    if (!isPostWithinDaysBack(record.postedAt ?? null, options.daysBack)) {
      hitDaysBackBoundary = true;
      continue;
    }
    if (
      record.processingStatus === "completed" &&
      ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(
        record.processingOutcome ?? "",
      )
    ) {
      continue;
    }
    if (
      record.processingStatus === "retryable_failure" &&
      (record.processingRetryAt ?? 0) > Date.now()
    ) {
      continue;
    }
    if (options.resultsLimit && options.resultsLimit > 0 && acceptedCount >= options.resultsLimit) {
      break;
    }
    candidateIds.push(record._id);
    acceptedCount += 1;
  }

  const reachedResultLimit =
    Boolean(options.resultsLimit && options.resultsLimit > 0) &&
    acceptedCount >= (options.resultsLimit ?? 0);

  return {
    candidateIds,
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    shouldCompleteHandle: page.isDone || reachedResultLimit || hitDaysBackBoundary,
    acceptedCount,
  };
}

export async function loadScrapedPostsByIds(
  client: ConvexHttpClient,
  ids: string[],
  serviceSecret: string,
): Promise<InstagramScrapedPost[]> {
  if (ids.length === 0) {
    return [];
  }
  const posts = (await client.query(
    getScrapedPostsManyByIdsQuery,
    withServiceSecret({ ids }, serviceSecret),
  )) as SavedScrapedPostRecord[];
  return posts
    .map(mapSavedScrapedPostToInstagramPost)
    .sort((left, right) => comparePostedAtDescending(left.postedAt, right.postedAt));
}

export async function loadSavedScrapedPostRecordById(
  client: ConvexHttpClient,
  id: string,
  serviceSecret: string,
): Promise<SavedScrapedPostRecord | null> {
  const posts = (await client.query(
    getScrapedPostsManyByIdsQuery,
    withServiceSecret({ ids: [id] }, serviceSecret),
  )) as SavedScrapedPostRecord[];
  return posts[0] ?? null;
}

export async function loadLatestSavedScrapedPostForHandle(
  client: ConvexHttpClient,
  handle: string,
  serviceSecret: string,
): Promise<{
  post: InstagramScrapedPost;
  processingStatus?: SavedScrapedPostRecord["processingStatus"];
  processingOutcome?: string;
} | null> {
  const page = (await client.query(
    listScrapedPostsByHandlePaginatedQuery,
    withServiceSecret(
      {
        handle,
        paginationOpts: { cursor: null, numItems: 1 },
      },
      serviceSecret,
    ),
  )) as ScrapedPostsPage;
  const latest = page.page[0];
  if (!latest) {
    return null;
  }
  return {
    post: mapSavedScrapedPostToInstagramPost(latest),
    processingStatus: latest.processingStatus,
    processingOutcome: latest.processingOutcome,
  };
}

export async function filterAlreadySavedScrapedPosts(
  client: ConvexHttpClient,
  handle: string,
  posts: InstagramScrapedPost[],
): Promise<{ freshPosts: InstagramScrapedPost[]; skippedCount: number }> {
  if (posts.length === 0) {
    return { freshPosts: [], skippedCount: 0 };
  }
  const existing = (await client.query(getScrapedPostsManyByHandleAndPostRefsQuery, {
    refs: posts.map((post) => ({
      handle,
      postId: post.postId || undefined,
      instagramPostUrl: post.instagramPostUrl || undefined,
    })),
  })) as Array<unknown | null>;
  return {
    freshPosts: posts.filter((_post, index) => existing[index] == null),
    skippedCount: existing.filter((record) => record != null).length,
  };
}

export function normalizeScrapedPost(post: InstagramScrapedPost): InstagramScrapedPost {
  const normalizedImageUrls = (post.imageUrls ?? [])
    .map((url) => normalizeString(url))
    .filter((url) => url.length > 0);

  return {
    postId: normalizeString(post.postId) || post.postId,
    caption: normalizeString(post.caption) || null,
    altText: normalizeString(post.altText) || null,
    imageUrl: normalizeString(post.imageUrl) || null,
    imageUrls: normalizedImageUrls,
    postType: normalizeString(post.postType).toLowerCase() || null,
    locationName: normalizeString(post.locationName) || null,
    instagramPostUrl: normalizeString(post.instagramPostUrl) || post.instagramPostUrl,
    postedAt: normalizeString(post.postedAt) || null,
    username: normalizeString(post.username) || post.username,
  };
}

export function buildVenueHandleByCanonicalVenueName(
  canonicalVenueNamesByHandle: Record<string, string>,
): Map<string, string> {
  const handlesByVenueName = new Map<string, string>();

  for (const [handle, venueName] of Object.entries(canonicalVenueNamesByHandle)) {
    const key = toSearchableText(venueName);
    if (!key || handlesByVenueName.has(key)) {
      continue;
    }
    handlesByVenueName.set(key, handle);
  }

  return handlesByVenueName;
}

export function buildSyntheticVenueHandle(venue: string, fallbackId: string): string {
  const normalizedVenue = toSearchableText(venue).replace(/\s+/g, "_");
  return normalizedVenue ? `event_import_${normalizedVenue}` : `event_import_${fallbackId}`;
}

export function resolveImportedEventHandle(
  venue: string,
  fallbackId: string,
  canonicalVenueNamesByHandle: Record<string, string>,
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle,
  handlesByVenueName: Map<string, string>,
): string {
  const canonicalVenueName = canonicalizeVenueName(venue, canonicalVenueNamesByHandle, {
    canonicalVenueAliasesByHandle,
  });
  if (canonicalVenueName) {
    const matchedHandle = handlesByVenueName.get(toSearchableText(canonicalVenueName));
    if (matchedHandle) {
      return matchedHandle;
    }
  }

  return buildSyntheticVenueHandle(venue, fallbackId);
}

export function buildImportedEventFallbackText(event: EventImportRecord): string | null {
  const lines = [
    normalizeString(event.title),
    normalizeExtractedArtists(event.artists).join(", "),
    normalizeString(event.venue),
    [normalizeString(event.date), normalizeString(event.time)].filter(Boolean).join(" "),
    normalizeString(event.description),
  ].filter((value) => value.length > 0);

  if (lines.length > 0) {
    return lines.join("\n");
  }

  const minimalTitle = normalizeString(event.title) || `Event ${event._id}`;
  const minimalDate = normalizeString(event.date) || "Date TBA";
  const minimalVenue = normalizeString(event.venue) || "Venue TBA";
  return [minimalTitle, minimalVenue, minimalDate].join("\n");
}

export function buildImportedEventInstagramPostUrl(event: EventImportRecord): string {
  const existingUrl = normalizeString(event.instagramPostUrl);
  if (existingUrl) {
    return existingUrl;
  }

  const postId = normalizeString(event.instagramPostId);
  if (postId) {
    return `https://www.instagram.com/p/${postId}/`;
  }

  return `https://www.instagram.com/p/event-${event._id}/`;
}

export function mapImportedEventToSavedScrapedPost(
  event: EventImportRecord,
  handle: string,
): InstagramScrapedPost | null {
  const fallbackText = buildImportedEventFallbackText(event);
  const instagramPostUrl = buildImportedEventInstagramPostUrl(event);
  const imageUrl = normalizeString(event.imageUrl);
  const postId =
    normalizeString(event.instagramPostId) ||
    extractShortcodeFromPostUrl(instagramPostUrl) ||
    `event_${event._id}`;
  const caption = normalizeString(event.sourceCaption) || fallbackText;

  return normalizeScrapedPost({
    postId,
    caption: caption || null,
    altText: !imageUrl ? fallbackText : null,
    imageUrl: imageUrl || null,
    imageUrls: imageUrl ? [imageUrl] : [],
    postType: imageUrl ? "image" : "video",
    locationName: normalizeString(event.venue) || null,
    instagramPostUrl,
    postedAt: normalizeString(event.sourcePostedAt) || null,
    username: handle,
  });
}

export function scoreSavedScrapedPostCandidate(post: InstagramScrapedPost): number {
  let score = 0;

  if (post.imageUrl) {
    score += 30;
  }
  if (post.caption) {
    score += 20 + Math.min(post.caption.length, 500) / 50;
  }
  if (post.postedAt) {
    score += 5;
  }

  return score;
}

export function parsePostedAt(postedAt: string | null): Date | null {
  if (!postedAt) {
    return null;
  }
  const parsed = Date.parse(postedAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

export function comparePostedAtDescending(left: string | null, right: string | null): number {
  return (
    (parsePostedAt(right)?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (parsePostedAt(left)?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

export function isPostWithinDaysBack(postedAt: string | null, daysBack: number | undefined): boolean {
  if (!daysBack || daysBack <= 0) {
    return true;
  }
  const parsed = parsePostedAt(postedAt);
  if (!parsed) {
    return true;
  }
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return parsed.getTime() >= cutoff;
}

export function mapSavedScrapedPostToInstagramPost(
  record: SavedScrapedPostRecord,
): InstagramScrapedPost {
  return instagramSourceProviderAdapter.projectForCompatibilityParser(
    mapSavedScrapedPostToSourceDocument(record),
  );
}

export function extractShortcodeFromPostUrl(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([^/?#]+)/i);
  return match?.[1]?.trim() || null;
}

export function getSourceIdentityKey(post: InstagramScrapedPost): string | null {
  const canonicalSource = canonicalizeSourceUrl("instagram", post.instagramPostUrl);
  const externalId = canonicalSource.ok
    ? canonicalSource.value.externalId
    : normalizeString(post.postId) ||
      extractShortcodeFromPostUrl(post.instagramPostUrl) ||
      normalizeString(post.instagramPostUrl).toLowerCase();
  if (externalId) {
    return buildSourceDocumentIdentity("instagram", externalId);
  }
  return null;
}
