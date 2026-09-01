import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import {
  canonicalizeSourceUrl,
  canonicalizeSourceUrlOrEmpty,
} from "../lib/domain/source-url";
import { normalizeHandle } from "../lib/pipeline/venue-normalization";
import { OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS } from "../lib/ai/openai-analysis-protocol";
import { PUBLICATION_POLICY_VERSION } from "../lib/domain/publication/policy";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
} from "./internal/sourceOccurrenceReceipts";
import {
  assertOperationBatchLength,
  assertOperationPaginationOptions,
  clampQueryPaginationOptions,
  resolveOperationLimit,
} from "./internal/requestBounds";
import {
  DEFAULT_APIFY_DAILY_BUDGET_USD,
  DEFAULT_APIFY_MAX_CHARGE_PER_HANDLE_USD,
  DEFAULT_INGESTION_BOOTSTRAP_DAYS,
  DEFAULT_INGESTION_FETCH_PAGE_SIZE,
  DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
  getFetchBoundary,
  nextContinuationResultsLimit,
  usdToMicros,
} from "../lib/pipeline/instagram-ingestion-durability";

const DEFAULT_PUBLIC_RECENT_POST_LIMIT = 6;
const MAX_PUBLIC_RECENT_POST_LIMIT = 12;
const MAX_SCRAPED_POST_COMPATIBILITY_LIST_SIZE = 1_000;
const MAX_SCRAPED_POST_BACKLOG_SCAN_SIZE = 5_000;
const MAX_SCRAPED_POST_PAGE_SIZE = 100;
const MAX_SCRAPED_POST_GET_MANY_SIZE = 100;
const MAX_PAID_FETCH_MIGRATION_BATCH_SIZE = 100;
const DEFAULT_SCRAPED_POST_RETENTION_BATCH_SIZE = 100;
const MAX_SCRAPED_POST_RETENTION_BATCH_SIZE = 500;
export const MAX_SCRAPED_POST_UPSERT_BATCH_SIZE = 25;
export const MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS =
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE;
export const MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_REFERENCE_READS =
  1_024;
export const SOURCE_REVISION_PUBLICATION_INVALIDATION_REASON =
  "source_document_revision_changed";
const MIN_PROCESSING_RETRY_DELAY_MS = 15 * 60_000;
const MAX_PROCESSING_RETRY_DELAY_MS = 6 * 60 * 60_000;
const processingStatusValidator = v.union(
  v.literal("completed"),
  v.literal("retryable_failure"),
);
const openAiDefinitiveOutputFailureKindValidator = v.union(
  v.literal("incomplete_max_output_tokens"),
  v.literal("empty_output"),
  v.literal("invalid_json"),
  v.literal("invalid_schema"),
);
const openAiDefinitiveOutputFailureKinds = new Set<string>(
  OPENAI_DEFINITIVE_OUTPUT_FAILURE_KINDS,
);

const scrapedPostRecord = {
  handle: v.string(),
  postId: v.string(),
  caption: v.optional(v.string()),
  altText: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageUrls: v.array(v.string()),
  postType: v.optional(v.string()),
  locationName: v.optional(v.string()),
  instagramPostUrl: v.string(),
  postedAt: v.optional(v.string()),
  username: v.string(),
};

function getSourceKey(post: {
  handle: string;
  instagramPostUrl: string;
  postId: string;
}): string {
  const identifier = post.postId || post.instagramPostUrl;
  return `${post.handle}:${identifier}`;
}

function projectPublicScrapedPost(post: Doc<"scrapedPosts">) {
  return {
    caption: post.caption,
    imageUrl: post.imageStorageId ? post.imageUrl : undefined,
    imageUrls: [] as string[],
    instagramPostUrl: post.instagramPostUrl,
    postId: post.postId,
  };
}

function parsePostedAtMs(postedAt: string | undefined): number | undefined {
  if (!postedAt) {
    return undefined;
  }

  const parsed = Date.parse(postedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getProcessingRetryAt(now: number, attempts: number | undefined): number {
  const retryIndex = Math.max(0, Math.min(5, Math.trunc(attempts ?? 1) - 1));
  const delayMs = Math.min(
    MAX_PROCESSING_RETRY_DELAY_MS,
    MIN_PROCESSING_RETRY_DELAY_MS * 2 ** retryIndex,
  );
  return now + delayMs;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readEventSourceHandle(event: Doc<"events">): string {
  let attestedHandle = "";
  try {
    const fields = event.normalizedFieldsJson
      ? (JSON.parse(event.normalizedFieldsJson) as unknown)
      : null;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      const value = (fields as Record<string, unknown>)
        .sourceGroundingInstagramHandle;
      if (typeof value === "string") attestedHandle = value;
    }
  } catch {
    attestedHandle = "";
  }
  return normalizeHandle(attestedHandle || event.venueInstagramHandle || "");
}

function eventMatchesScrapedPostIdentity(
  event: Doc<"events">,
  post: Doc<"scrapedPosts">,
): boolean {
  const sourceHandle = normalizeHandle(post.handle);
  const sourceCanonicalUrl =
    canonicalizeSourceUrlOrEmpty("instagram", post.canonicalSourceUrl) ||
    canonicalizeSourceUrlOrEmpty("instagram", post.instagramPostUrl);
  if (
    !sourceHandle ||
    !sourceCanonicalUrl ||
    event.instagramPostId?.trim() !== post.postId ||
    readEventSourceHandle(event) !== sourceHandle
  ) {
    return false;
  }
  return [
    event.canonicalSourceUrl,
    event.normalizedInstagramPostUrl,
    event.instagramPostUrl,
  ].some(
    (value) =>
      canonicalizeSourceUrlOrEmpty("instagram", value) === sourceCanonicalUrl,
  );
}

function sourceLinkMatchesScrapedPostIdentity(
  link: Doc<"instagramEventSources">,
  post: Doc<"scrapedPosts">,
): boolean {
  const sourceHandle = normalizeHandle(post.handle);
  const sourceCanonicalUrl =
    canonicalizeSourceUrlOrEmpty("instagram", post.canonicalSourceUrl) ||
    canonicalizeSourceUrlOrEmpty("instagram", post.instagramPostUrl);
  const linkCanonicalUrl =
    canonicalizeSourceUrlOrEmpty("instagram", link.canonicalSourceUrl) ||
    canonicalizeSourceUrlOrEmpty("instagram", link.instagramPostUrl);
  const handleMatches =
    !link.sourceHandle || normalizeHandle(link.sourceHandle) === sourceHandle;
  return Boolean(
    handleMatches &&
      ((link.instagramPostId && link.instagramPostId === post.postId) ||
        (sourceCanonicalUrl && linkCanonicalUrl === sourceCanonicalUrl)),
  );
}

function assertBoundedInvalidationRead(
  label: string,
  rows: readonly unknown[],
): void {
  if (rows.length > MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS) {
    throw new Error(
      `${label} exceeds the bounded source-revision publication invalidation limit.`,
    );
  }
}

/**
 * Resolves every canonical representative whose public grounding depends on a
 * source document before that document advances revision. All reads and the
 * event-ID union are hard bounded across the complete upsert mutation.
 */
async function preflightSourceRevisionPublicationInvalidation(
  ctx: MutationCtx,
  sourceDocuments: readonly Doc<"scrapedPosts">[],
): Promise<Doc<"events">[]> {
  if (sourceDocuments.length === 0) return [];

  const eventIds = new Set<Id<"events">>();
  const eventDocuments = new Map<Id<"events">, Doc<"events">>();
  const sourceIdentities = new Set<string>();
  let referenceReadCount = 0;
  const addReferenceReads = (count: number) => {
    referenceReadCount += count;
    if (
      referenceReadCount >
      MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_REFERENCE_READS
    ) {
      throw new Error(
        "Source-revision publication invalidation reference read budget was exceeded.",
      );
    }
  };
  const addEventId = (eventId: Id<"events">) => {
    eventIds.add(eventId);
    if (eventIds.size > MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS) {
      throw new Error(
        "Source-revision publication invalidation event union exceeds its hard bound.",
      );
    }
  };
  const addSourceIdentity = (sourceIdentity: string) => {
    if (!sourceIdentity.trim()) {
      throw new Error("Source-revision publication invalidation found an empty source identity.");
    }
    sourceIdentities.add(sourceIdentity);
    if (
      sourceIdentities.size >
      MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS
    ) {
      throw new Error(
        "Source-revision publication invalidation identity union exceeds its hard bound.",
      );
    }
  };

  for (const sourceDocument of sourceDocuments) {
    const canonicalSourceUrl =
      canonicalizeSourceUrlOrEmpty(
        "instagram",
        sourceDocument.canonicalSourceUrl,
      ) ||
      canonicalizeSourceUrlOrEmpty(
        "instagram",
        sourceDocument.instagramPostUrl,
      );
    const normalizedInstagramPostUrl = normalizeInstagramPostUrl(
      sourceDocument.instagramPostUrl,
    );
    const [
      occurrences,
      linksByPostId,
      linksByPostUrl,
      linksByCanonicalUrl,
      eventsByPostId,
      eventsByPostUrl,
      eventsByNormalizedUrl,
      eventsByCanonicalUrl,
    ] = await Promise.all([
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_document_occurrence", (q) =>
          q.eq("sourceDocumentId", sourceDocument._id),
        )
        .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1),
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_post_id", (q) =>
          q.eq("instagramPostId", sourceDocument.postId),
        )
        .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1),
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_post_url", (q) =>
          q.eq("instagramPostUrl", sourceDocument.instagramPostUrl),
        )
        .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1),
      canonicalSourceUrl
        ? ctx.db
            .query("instagramEventSources")
            .withIndex("by_canonical_source_url", (q) =>
              q.eq("canonicalSourceUrl", canonicalSourceUrl),
            )
            .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1)
        : Promise.resolve([]),
      ctx.db
        .query("events")
        .withIndex("by_instagramPostId", (q) =>
          q.eq("instagramPostId", sourceDocument.postId),
        )
        .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1),
      ctx.db
        .query("events")
        .withIndex("by_instagramPostUrl", (q) =>
          q.eq("instagramPostUrl", sourceDocument.instagramPostUrl),
        )
        .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1),
      normalizedInstagramPostUrl
        ? ctx.db
            .query("events")
            .withIndex("by_normalizedInstagramPostUrl", (q) =>
              q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
            )
            .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1)
        : Promise.resolve([]),
      canonicalSourceUrl
        ? ctx.db
            .query("events")
            .withIndex("by_canonicalSourceUrl", (q) =>
              q.eq("canonicalSourceUrl", canonicalSourceUrl),
            )
            .take(MAX_SOURCE_REVISION_PUBLICATION_INVALIDATION_EVENTS + 1)
        : Promise.resolve([]),
    ]);

    for (const [label, rows] of [
      ["Source occurrence set", occurrences],
      ["Post-ID provenance set", linksByPostId],
      ["Post-URL provenance set", linksByPostUrl],
      ["Canonical-URL provenance set", linksByCanonicalUrl],
      ["Post-ID event set", eventsByPostId],
      ["Post-URL event set", eventsByPostUrl],
      ["Normalized-URL event set", eventsByNormalizedUrl],
      ["Canonical-URL event set", eventsByCanonicalUrl],
    ] as const) {
      assertBoundedInvalidationRead(label, rows);
      addReferenceReads(rows.length);
    }

    for (const occurrence of occurrences) {
      addSourceIdentity(occurrence.sourceIdentity);
      if (occurrence.canonicalEventId) addEventId(occurrence.canonicalEventId);
    }
    const links = [
      ...new Map(
        [...linksByPostId, ...linksByPostUrl, ...linksByCanonicalUrl].map(
          (link) => [link._id, link] as const,
        ),
      ).values(),
    ];
    for (const link of links) {
      if (!sourceLinkMatchesScrapedPostIdentity(link, sourceDocument)) continue;
      addSourceIdentity(link.sourceIdentity);
      addEventId(link.eventId);
    }
    const directEvents = [
      ...new Map(
        [
          ...eventsByPostId,
          ...eventsByPostUrl,
          ...eventsByNormalizedUrl,
          ...eventsByCanonicalUrl,
        ].map((event) => [event._id, event] as const),
      ).values(),
    ];
    for (const event of directEvents) {
      if (!eventMatchesScrapedPostIdentity(event, sourceDocument)) continue;
      eventDocuments.set(event._id, event);
      addEventId(event._id);
    }
  }

  for (const sourceIdentity of sourceIdentities) {
    const receipts = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceIdentity))
      .take(2);
    addReferenceReads(receipts.length);
    if (receipts.length > 1) {
      throw new Error(
        "Source-revision publication invalidation found duplicate occurrence receipts.",
      );
    }
    const receipt = receipts[0];
    if (!receipt) continue;
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    for (const satisfaction of receipt.satisfiedOccurrences) {
      addEventId(satisfaction.eventId);
    }
  }

  const missingEventIds = [...eventIds].filter(
    (eventId) => !eventDocuments.has(eventId),
  );
  addReferenceReads(missingEventIds.length);
  const loadedEvents = await Promise.all(
    missingEventIds.map((eventId) => ctx.db.get(eventId)),
  );
  for (const event of loadedEvents) {
    if (event) eventDocuments.set(event._id, event);
  }
  return [...eventIds]
    .map((eventId) => eventDocuments.get(eventId))
    .filter(
      (event): event is Doc<"events"> =>
        Boolean(
          event &&
            event.status === "approved" &&
            !isCrossPostCampaignLineageEvent(event),
        ),
    );
}

function normalizePublicRecentPostLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PUBLIC_RECENT_POST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PUBLIC_RECENT_POST_LIMIT, Math.trunc(value as number)));
}

function buildScrapedPostPaginationOptions(options: {
  cursor: string | null;
  numItems: number;
}) {
  return clampQueryPaginationOptions(options, MAX_SCRAPED_POST_PAGE_SIZE);
}

export const listByHandle = query({
  args: {
    handle: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const posts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .take(MAX_SCRAPED_POST_COMPATIBILITY_LIST_SIZE + 1);
    if (posts.length > MAX_SCRAPED_POST_COMPATIBILITY_LIST_SIZE) {
      throw new Error(
        `Scraped-post compatibility list exceeds its safe bound of ${MAX_SCRAPED_POST_COMPATIBILITY_LIST_SIZE}; use listByHandlePaginated.`,
      );
    }
    return posts;
  },
});

export const listPublicRecentPostsByHandle = query({
  args: {
    handle: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    if (!handle) {
      return [];
    }

    const posts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postedAtMs", (q) => q.eq("handle", handle))
      .order("desc")
      .take(normalizePublicRecentPostLimit(args.limit));

    return posts.map((post) => ({
      _id: post._id,
      imageUrl: post.imageStorageId ? post.imageUrl : undefined,
      instagramPostUrl: post.instagramPostUrl,
      locationName: post.locationName,
      postType: post.postType,
      postedAt: post.postedAt,
      postedAtMs: post.postedAtMs,
    }));
  },
});

export const getLatestIngestionBoundaryByHandle = query({
  args: {
    handle: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    if (!handle) return null;
    const candidates = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postedAtMs", (q) => q.eq("handle", handle))
      .order("desc")
      .take(20);
    const latestAllowedMs = Date.now() + 5 * 60 * 1_000;
    for (const candidate of candidates) {
      const postedAtMs =
        typeof candidate.postedAtMs === "number" && Number.isFinite(candidate.postedAtMs)
          ? candidate.postedAtMs
          : parsePostedAtMs(candidate.postedAt);
      if (postedAtMs !== undefined && postedAtMs > 0 && postedAtMs <= latestAllowedMs) {
        return new Date(postedAtMs).toISOString();
      }
    }
    return null;
  },
});

export const listByHandlePaginated = query({
  args: {
    handle: v.string(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postedAtMs", (q) => q.eq("handle", args.handle))
      .order("desc")
      .paginate(buildScrapedPostPaginationOptions(args.paginationOpts));
  },
});

export const listAllHandlesPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle")
      .paginate(buildScrapedPostPaginationOptions(args.paginationOpts));
    return {
      ...result,
      page: result.page.map((post) => post.handle),
    };
  },
});

export const getManyByIds = query({
  args: {
    ids: v.array(v.id("scrapedPosts")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.ids.length > MAX_SCRAPED_POST_GET_MANY_SIZE) {
      throw new Error(
        `Scraped-post ID reads support at most ${MAX_SCRAPED_POST_GET_MANY_SIZE} IDs.`,
      );
    }
    const uniqueIds = [...new Set(args.ids)];
    if (uniqueIds.length !== args.ids.length) {
      throw new Error("Scraped-post ID reads require unique IDs.");
    }
    const posts = [];
    for (const id of uniqueIds) {
      const post = await ctx.db.get(id);
      if (post) {
        posts.push(post);
      }
    }
    return posts;
  },
});

export const getManyByHandleAndPostRefs = query({
  args: {
    refs: v.array(
      v.object({
        handle: v.string(),
        instagramPostUrl: v.optional(v.string()),
        postId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.refs.length > 100) {
      throw new Error("Discover scraped-post lookup supports at most 100 references.");
    }

    return Promise.all(
      args.refs.map(async (ref) => {
        if (ref.postId) {
          const byPostId = await ctx.db
            .query("scrapedPosts")
            .withIndex("by_postId", (q) => q.eq("postId", ref.postId as string))
            .first();
          if (byPostId) {
            return {
              caption: byPostId.caption,
              imageUrl: byPostId.imageStorageId ? byPostId.imageUrl : undefined,
              imageUrls: [],
              instagramPostUrl: byPostId.instagramPostUrl,
              postId: byPostId.postId,
            };
          }
        }

        if (ref.instagramPostUrl) {
          const byPostUrl = await ctx.db
            .query("scrapedPosts")
            .withIndex("by_instagramPostUrl", (q) =>
              q.eq("instagramPostUrl", ref.instagramPostUrl as string),
            )
            .first();
          const normalizedInstagramPostUrl = normalizeInstagramPostUrl(ref.instagramPostUrl);
          const canonicalSourceUrl = canonicalizeSourceUrlOrEmpty(
            "instagram",
            ref.instagramPostUrl,
          );
          const matchedPost =
            byPostUrl ??
            (normalizedInstagramPostUrl
              ? await ctx.db
                  .query("scrapedPosts")
                  .withIndex("by_normalizedInstagramPostUrl", (q) =>
                    q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
                  )
                  .first()
              : null) ??
            (canonicalSourceUrl
              ? await ctx.db
                  .query("scrapedPosts")
                  .withIndex("by_canonicalSourceUrl", (q) =>
                    q.eq("canonicalSourceUrl", canonicalSourceUrl),
                  )
                  .first()
              : null);
          if (matchedPost) {
            return {
              caption: matchedPost.caption,
              imageUrl: matchedPost.imageStorageId ? matchedPost.imageUrl : undefined,
              imageUrls: [],
              instagramPostUrl: matchedPost.instagramPostUrl,
              postId: matchedPost.postId,
            };
          }
        }

        return null;
      }),
    );
  },
});

export const getByHandleAndPostRef = query({
  args: {
    handle: v.string(),
    instagramPostUrl: v.optional(v.string()),
    postId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const postId = args.postId;
    if (postId) {
      const byPostId = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postId", (q) =>
          q.eq("handle", args.handle).eq("postId", postId),
        )
        .take(1);
      if (byPostId[0]) {
        return projectPublicScrapedPost(byPostId[0]);
      }
    }

    const instagramPostUrl = args.instagramPostUrl;
    if (instagramPostUrl) {
      const byPostUrl = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postUrl", (q) =>
          q.eq("handle", args.handle).eq("instagramPostUrl", instagramPostUrl),
        )
        .take(1);
      return byPostUrl[0] ? projectPublicScrapedPost(byPostUrl[0]) : null;
    }

    return null;
  },
});

export const upsertManyByHandle = mutation({
  args: {
    handle: v.string(),
    posts: v.array(v.object(scrapedPostRecord)),
    fetchLeaseOwner: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      scrapedPostId: v.id("scrapedPosts"),
      postId: v.string(),
      sourceRevision: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.posts.length > MAX_SCRAPED_POST_UPSERT_BATCH_SIZE) {
      throw new Error(
        `Scraped-post upsert batch exceeds the safe limit of ${MAX_SCRAPED_POST_UPSERT_BATCH_SIZE}.`,
      );
    }
    const normalizedHandle = normalizeHandle(args.handle);
    if (
      !normalizedHandle ||
      args.posts.some(
        (post) =>
          normalizeHandle(post.handle) !== normalizedHandle ||
          normalizeHandle(post.username) !== normalizedHandle,
      )
    ) {
      throw new Error("Scraped-post source identity must match the requested handle.");
    }
    const now = Date.now();
    const paidFetchControl = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    const activePaidFetchOwner =
      (paidFetchControl?.leaseExpiresAt ?? 0) > now ? paidFetchControl?.leaseOwner : undefined;
    const suppliedFetchOwner = args.fetchLeaseOwner?.trim().slice(0, 200);
    type PersistedPostResult = {
      scrapedPostId: Id<"scrapedPosts">;
      postId: string;
      sourceRevision: number;
    };
    const persistedPosts: PersistedPostResult[] = [];
    const preparedWrites: Array<() => Promise<PersistedPostResult>> = [];
    const revisionChangedSourceDocuments: Doc<"scrapedPosts">[] = [];
    const batchPostIds = new Set<string>();
    const batchUrlIdentities = new Set<string>();
    for (const post of args.posts) {
      const canonicalSource = canonicalizeSourceUrl(
        "instagram",
        post.instagramPostUrl,
      );
      if (!canonicalSource.ok) {
        throw new Error(
          "New scraped-post writes require a canonical Instagram post URL.",
        );
      }
      const urlIdentity = canonicalSource.value.canonicalUrl;
      if (
        batchPostIds.has(post.postId) ||
        (urlIdentity && batchUrlIdentities.has(urlIdentity))
      ) {
        throw new Error("Scraped-post upsert batch contains a duplicate durable identity.");
      }
      batchPostIds.add(post.postId);
      if (urlIdentity) batchUrlIdentities.add(urlIdentity);
    }
    if (activePaidFetchOwner) {
      if (
        suppliedFetchOwner !== activePaidFetchOwner ||
        paidFetchControl?.leaseHandle !== args.handle
      ) {
        throw new Error("Scraped-post persistence is fenced by an active paid-fetch lease.");
      }
    } else if (suppliedFetchOwner) {
      throw new Error("Paid-fetch persistence requires a current matching lease.");
    }

    for (const post of args.posts) {
      const existingByPostId = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_postId", (q) => q.eq("postId", post.postId))
        .take(2);
      if (existingByPostId.length > 1) {
        throw new Error(`Duplicate durable scraped-post identity for postId ${post.postId}.`);
      }

      const existingUrlMatches = existingByPostId[0]
        ? []
        : await ctx.db
          .query("scrapedPosts")
          .withIndex("by_instagramPostUrl", (q) =>
            q.eq("instagramPostUrl", post.instagramPostUrl),
          )
          .take(2);
      if (existingUrlMatches.length > 1) {
        throw new Error(`Duplicate durable scraped-post identity for URL ${post.instagramPostUrl}.`);
      }
      const existingByUrl = existingByPostId[0] ?? existingUrlMatches[0];

      const canonicalSource = canonicalizeSourceUrl(
        "instagram",
        post.instagramPostUrl,
      );
      if (!canonicalSource.ok) {
        throw new Error(
          "New scraped-post writes require a canonical Instagram post URL.",
        );
      }
      const canonicalSourceUrl = canonicalSource.value.canonicalUrl;
      const normalizedInstagramPostUrl = canonicalSourceUrl;
      const existingByNormalizedUrl =
        existingByPostId[0] || existingByUrl || !normalizedInstagramPostUrl
          ? []
          : await ctx.db
              .query("scrapedPosts")
              .withIndex("by_normalizedInstagramPostUrl", (q) =>
                q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
              )
              .take(2);
      if (existingByNormalizedUrl.length > 1) {
        throw new Error(
          `Duplicate durable scraped-post identity for normalized URL ${normalizedInstagramPostUrl}.`,
        );
      }

      const existingByCanonicalUrl =
        existingByPostId[0] ||
        existingByUrl ||
        existingByNormalizedUrl[0] ||
        !canonicalSourceUrl
          ? []
          : await ctx.db
              .query("scrapedPosts")
              .withIndex("by_canonicalSourceUrl", (q) =>
                q.eq("canonicalSourceUrl", canonicalSourceUrl),
              )
              .take(2);
      if (existingByCanonicalUrl.length > 1) {
        throw new Error(
          `Duplicate durable scraped-post identity for canonical URL ${canonicalSourceUrl}.`,
        );
      }

      const existing =
        existingByUrl ?? existingByNormalizedUrl[0] ?? existingByCanonicalUrl[0];
      if (
        existing &&
        (normalizeHandle(existing.handle) !== normalizedHandle ||
          normalizeHandle(existing.username) !== normalizedHandle ||
          existing.postId !== post.postId ||
          canonicalizeSourceUrlOrEmpty("instagram", existing.instagramPostUrl) !==
            canonicalSourceUrl)
      ) {
        throw new Error(
          "Scraped-post durable identity cannot change its post ID or normalized Instagram URL.",
        );
      }
      const rawImageUrl = post.imageUrl?.trim();
      const imageUrls = [...new Set([rawImageUrl, ...post.imageUrls].filter(Boolean))] as string[];
      const hasDurableImage = Boolean(existing?.imageStorageId && existing.imageUrl);
      const {
        imageUrl: _rawImageUrl,
        imageUrls: _rawImageUrls,
        postedAt: _rawPostedAt,
        ...postWithoutPrimaryImage
      } = post;
      void _rawImageUrl;
      void _rawImageUrls;
      void _rawPostedAt;
      const parsedPostedAtMs = parsePostedAtMs(post.postedAt);
      const effectivePostedAtMs = parsedPostedAtMs ?? existing?.postedAtMs;
      const effectivePostedAt =
        parsedPostedAtMs !== undefined ? post.postedAt : existing?.postedAt;
      const effectiveHandle = existing?.handle ?? args.handle;
      const nextRecord = {
        ...postWithoutPrimaryImage,
        ...(effectivePostedAt && effectivePostedAtMs !== undefined
          ? { postedAt: effectivePostedAt, postedAtMs: effectivePostedAtMs }
          : {}),
        imageUrls,
        handle: effectiveHandle,
        sourceKey: getSourceKey({ ...post, handle: effectiveHandle }),
        normalizedInstagramPostUrl,
        ...(canonicalSourceUrl ? { canonicalSourceUrl } : {}),
        updatedAt: now,
      };

      if (existing) {
        const hasSourceContentChanged =
          (post.caption !== undefined && post.caption !== existing.caption) ||
          (post.altText !== undefined && post.altText !== existing.altText) ||
          (post.postType !== undefined && post.postType !== existing.postType) ||
          (post.locationName !== undefined && post.locationName !== existing.locationName) ||
          (effectivePostedAt !== undefined && effectivePostedAt !== existing.postedAt);
        const hasImageCandidatesChanged = !stringArraysEqual(
          imageUrls,
          existing.imageUrls ?? [],
        );
        const shouldReprocessForNewMedia =
          hasImageCandidatesChanged &&
          (existing.processingStatus === "retryable_failure" ||
            (existing.processingStatus === "completed" &&
              existing.processingOutcome === "terminal_permanent_failure"));
        const shouldResetProcessing = hasSourceContentChanged || shouldReprocessForNewMedia;
        const sourceRevision = shouldResetProcessing
          ? (existing.sourceRevision ?? 1) + 1
          : (existing.sourceRevision ?? 1);
        const patch = {
          ...nextRecord,
          sourceRevision,
          blocksPaidFetch: shouldResetProcessing ? true : (existing.blocksPaidFetch ?? true),
          imageUrl: hasDurableImage ? existing.imageUrl : undefined,
          imageStorageId: hasDurableImage ? existing.imageStorageId : undefined,
          ...(shouldResetProcessing
            ? {
                processingStatus: "pending" as const,
                processingOutcome: undefined,
                processingError: undefined,
                processingRetryAt: undefined,
                analysisAttemptRevision: undefined,
                analysisAttemptStartedAt: undefined,
                analysisAttemptOwner: undefined,
                analysisAttemptProtocol: undefined,
                analysisAttemptBudgetDayKey: undefined,
                analysisRevision: undefined,
                analysisResultJson: undefined,
                analysisCompletedAt: undefined,
                analysisModel: undefined,
                analysisImageSourceUrl: undefined,
                analysisImageChecksumSha256: undefined,
                analysisContractVersion: undefined,
                analysisIsEvent: undefined,
                analysisNonEventReason: undefined,
                analysisInputTokens: undefined,
                analysisOutputTokens: undefined,
                analysisReasoningTokens: undefined,
                analysisTotalTokens: undefined,
                analysisDefinitiveOutputFailureRevision: undefined,
                analysisDefinitiveOutputFailureProtocol: undefined,
                analysisDefinitiveOutputFailureAttemptStartedAt: undefined,
                analysisDefinitiveOutputFailureOwner: undefined,
                analysisDefinitiveOutputFailureKind: undefined,
                analysisDefinitiveOutputFailureMessage: undefined,
                analysisDefinitiveOutputFailureAt: undefined,
                analysisDefinitiveOutputFailureModel: undefined,
                analysisDefinitiveOutputFailureInputTokens: undefined,
                analysisDefinitiveOutputFailureOutputTokens: undefined,
                analysisDefinitiveOutputFailureReasoningTokens: undefined,
                analysisDefinitiveOutputFailureTotalTokens: undefined,
                analysisDefinitiveOutputRecoveryRevision: undefined,
                analysisDefinitiveOutputRecoveryFromProtocol: undefined,
                analysisDefinitiveOutputRecoveryProtocol: undefined,
                analysisDefinitiveOutputRecoveryEvidenceSha256: undefined,
                analysisDefinitiveOutputRecoveredAt: undefined,
                processingLeaseOwner: undefined,
                processingLeaseExpiresAt: undefined,
              }
            : {}),
        };
        if (shouldResetProcessing) {
          revisionChangedSourceDocuments.push(existing);
        }
        preparedWrites.push(async () => {
          await ctx.db.patch(existing._id, patch);
          return {
            scrapedPostId: existing._id,
            postId: post.postId,
            sourceRevision,
          };
        });
      } else {
        preparedWrites.push(async () => {
          const scrapedPostId = await ctx.db.insert("scrapedPosts", {
            ...nextRecord,
            sourceRevision: 1,
            blocksPaidFetch: true,
            processingStatus: "pending",
            processingAttempts: 0,
            createdAt: now,
          });
          return { scrapedPostId, postId: post.postId, sourceRevision: 1 };
        });
      }
    }

    const eventsToInvalidate =
      await preflightSourceRevisionPublicationInvalidation(
        ctx,
        revisionChangedSourceDocuments,
      );
    for (const event of eventsToInvalidate) {
      await ctx.db.patch(event._id, {
        publicationEvaluatedAt: now,
        publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
        publicationReason: SOURCE_REVISION_PUBLICATION_INVALIDATION_REASON,
        publicationState: "pending_verification",
      });
    }
    for (const write of preparedWrites) {
      persistedPosts.push(await write());
    }
    return persistedPosts;
  },
});

async function resolveScrapedPostForProcessingFence(ctx: { db: any }, args: any) {
  if (args.scrapedPostId) {
    const exact = await ctx.db.get(args.scrapedPostId);
    if (
      !exact ||
      exact.handle !== args.handle ||
      (args.postId && exact.postId !== args.postId) ||
      (args.instagramPostUrl && exact.instagramPostUrl !== args.instagramPostUrl)
    ) {
      throw new Error("Exact scraped-post processing fence identity mismatch.");
    }
    return exact;
  }
  const existingByPostId = args.postId
    ? (
        await ctx.db
          .query("scrapedPosts")
          .withIndex("by_handle_postId", (q: any) =>
            q.eq("handle", args.handle).eq("postId", args.postId as string),
          )
          .take(1)
      )[0] ?? null
    : null;
  return (
    existingByPostId ??
    (args.instagramPostUrl
      ? (
          await ctx.db
            .query("scrapedPosts")
            .withIndex("by_handle_postUrl", (q: any) =>
              q
                .eq("handle", args.handle)
                .eq("instagramPostUrl", args.instagramPostUrl as string),
            )
            .take(1)
        )[0] ?? null
      : null)
  );
}

export const claimProcessing = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    expectedSourceRevision: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) {
      throw new Error("Cannot claim processing for an unknown scraped post.");
    }
    if (
      existing.processingStatus === "completed" &&
      ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(existing.processingOutcome ?? "")
    ) {
      return { claimed: false, reason: "terminal" as const };
    }
    const now = Date.now();
    const sourceRevision = existing.sourceRevision ?? 1;
    if (
      args.expectedSourceRevision !== undefined &&
      (!Number.isInteger(args.expectedSourceRevision) || args.expectedSourceRevision < 1)
    ) {
      throw new Error("Expected source revision must be a positive integer.");
    }
    if (
      args.expectedSourceRevision !== undefined &&
      sourceRevision !== args.expectedSourceRevision
    ) {
      return {
        claimed: false,
        reason: "source_revision_mismatch" as const,
        sourceRevision,
      };
    }
    if (
      existing.analysisAttemptRevision === sourceRevision &&
      !(
        existing.analysisRevision === sourceRevision &&
        existing.analysisResultJson
      )
    ) {
      const hasDefinitiveOutputFailure =
        existing.analysisDefinitiveOutputFailureRevision === sourceRevision &&
        existing.analysisDefinitiveOutputFailureProtocol ===
          existing.analysisAttemptProtocol &&
        existing.analysisDefinitiveOutputFailureAttemptStartedAt ===
          existing.analysisAttemptStartedAt &&
        existing.analysisDefinitiveOutputFailureOwner ===
          existing.analysisAttemptOwner &&
        Boolean(existing.analysisDefinitiveOutputFailureKind);
      await ctx.db.patch(existing._id, {
        processingStatus: hasDefinitiveOutputFailure
          ? "completed"
          : "retryable_failure",
        blocksPaidFetch: false,
        processingOutcome: hasDefinitiveOutputFailure
          ? "terminal_permanent_failure"
          : "openai_transport_ambiguous",
        processingError: hasDefinitiveOutputFailure
          ? existing.analysisDefinitiveOutputFailureMessage ??
            "OpenAI returned a definitive but unusable output; version-fenced recovery is required."
          : "A paid OpenAI request may have started for this source revision; automatic replay is blocked.",
        processingLeaseOwner: undefined,
        processingLeaseExpiresAt: undefined,
        processingRetryAt: undefined,
        lastProcessedAt: now,
        updatedAt: now,
      });
      return {
        claimed: false,
        reason: hasDefinitiveOutputFailure
          ? ("analysis_output_definitive" as const)
          : ("analysis_attempt_ambiguous" as const),
        sourceRevision,
        analysisAttemptStartedAt: existing.analysisAttemptStartedAt,
      };
    }
    if (
      existing.processingStatus === "retryable_failure" &&
      (existing.processingRetryAt ?? 0) > now
    ) {
      return {
        claimed: false,
        reason: "deferred" as const,
        retryAt: existing.processingRetryAt,
      };
    }
    if (
      existing.processingStatus === "processing" &&
      (existing.processingLeaseExpiresAt ?? 0) > now &&
      existing.processingLeaseOwner !== args.owner
    ) {
      return { claimed: false, reason: "busy" as const };
    }
    const leaseMs = Math.max(30_000, Math.min(15 * 60_000, Math.trunc(args.leaseMs ?? 180_000)));
    await ctx.db.patch(existing._id, {
      processingStatus: "processing",
      blocksPaidFetch: true,
      processingAttempts: (existing.processingAttempts ?? 0) + 1,
      processingLeaseOwner: args.owner.slice(0, 200),
      processingLeaseExpiresAt: now + leaseMs,
      processingOutcome: "processing",
      processingError: undefined,
      processingRetryAt: undefined,
      lastProcessedAt: now,
    });
    return {
      claimed: true,
      reason: "claimed" as const,
      sourceRevision,
      analysisResultJson:
        existing.analysisRevision === sourceRevision
          ? existing.analysisResultJson
          : undefined,
      analysisContractVersion:
        existing.analysisRevision === sourceRevision
          ? existing.analysisContractVersion
          : undefined,
      analysisImageSourceUrl:
        existing.analysisRevision === sourceRevision
          ? existing.analysisImageSourceUrl
          : undefined,
      analysisImageChecksumSha256:
        existing.analysisRevision === sourceRevision
          ? existing.analysisImageChecksumSha256
          : undefined,
    };
  },
});

export const markOpenAiAnalysisAttemptStarted = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    sourceRevision: v.number(),
    protocol: v.string(),
    budgetDayKey: v.string(),
    dailyRequestLimit: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) throw new Error("Cannot start analysis for an unknown scraped post.");
    const now = Date.now();
    if (
      existing.processingStatus !== "processing" ||
      existing.processingLeaseOwner !== args.owner ||
      (existing.processingLeaseExpiresAt ?? 0) <= now ||
      (existing.sourceRevision ?? 1) !== args.sourceRevision
    ) {
      throw new Error("Cannot start analysis from a stale processing fence.");
    }
    const hasCurrentAnalysis =
      existing.analysisRevision === args.sourceRevision && Boolean(existing.analysisResultJson);
    if (hasCurrentAnalysis && existing.analysisContractVersion === "event_evidence_v2") {
      return { recorded: false, reason: "already_completed" as const };
    }
    if (existing.analysisAttemptRevision === args.sourceRevision && !hasCurrentAnalysis) {
      return { recorded: false, reason: "already_started" as const };
    }

    const dayKey = args.budgetDayKey.trim();
    const dailyLimit = Math.max(0, Math.trunc(args.dailyRequestLimit));
    const budgetKey = `openai:${dayKey}`;
    const budget = await ctx.db
      .query("ingestionDailyBudgets")
      .withIndex("by_key", (q) => q.eq("key", budgetKey))
      .unique();
    const used = (budget?.chargedMicros ?? 0) + (budget?.reservedMicros ?? 0);
    if (!dayKey || dailyLimit <= 0 || used >= dailyLimit) {
      return { recorded: false, reason: "budget_exhausted" as const, used, dailyLimit };
    }
    if (budget) {
      await ctx.db.patch(budget._id, {
        limitMicros: dailyLimit,
        chargedMicros: budget.chargedMicros + 1,
        reconciledCount: budget.reconciledCount + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("ingestionDailyBudgets", {
        key: budgetKey,
        provider: "openai",
        dayKey,
        limitMicros: dailyLimit,
        reservedMicros: 0,
        chargedMicros: 1,
        releasedMicros: 0,
        reservationCount: 0,
        reconciledCount: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(existing._id, {
      ...(hasCurrentAnalysis
        ? {
            analysisRevision: undefined,
            analysisResultJson: undefined,
            analysisCompletedAt: undefined,
            analysisModel: undefined,
            analysisImageSourceUrl: undefined,
            analysisImageChecksumSha256: undefined,
            analysisContractVersion: undefined,
            analysisIsEvent: undefined,
            analysisNonEventReason: undefined,
            analysisInputTokens: undefined,
            analysisOutputTokens: undefined,
            analysisReasoningTokens: undefined,
            analysisTotalTokens: undefined,
          }
        : {}),
      analysisAttemptRevision: args.sourceRevision,
      analysisAttemptStartedAt: now,
      analysisAttemptOwner: args.owner.slice(0, 200),
      analysisAttemptProtocol: args.protocol.slice(0, 160),
      analysisAttemptBudgetDayKey: dayKey,
      updatedAt: now,
    });
    return { recorded: true, reason: "started" as const, startedAt: now };
  },
});

const definitiveOutputFailureRecordValidator = v.object({
  recorded: v.boolean(),
  reason: v.union(v.literal("recorded"), v.literal("already_recorded")),
});

/**
 * Attest only failures proven by a completed OpenAI HTTP response. Timeouts,
 * connection errors, and HTTP error responses never call this mutation, so a
 * future recovery cannot mistake transport ambiguity for a replayable output.
 */
export const recordOpenAiDefinitiveOutputFailure = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.id("scrapedPosts"),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    sourceRevision: v.number(),
    attemptProtocol: v.string(),
    failureKind: openAiDefinitiveOutputFailureKindValidator,
    message: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  returns: definitiveOutputFailureRecordValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) {
      throw new Error("Cannot attest definitive output failure for an unknown scraped post.");
    }
    const now = Date.now();
    const attemptProtocol = args.attemptProtocol.trim();
    const owner = args.owner.slice(0, 200);
    if (!openAiDefinitiveOutputFailureKinds.has(args.failureKind)) {
      throw new Error("Unknown OpenAI definitive output failure kind.");
    }
    if (
      !Number.isSafeInteger(args.sourceRevision) ||
      args.sourceRevision < 1 ||
      existing.processingStatus !== "processing" ||
      existing.processingLeaseOwner !== owner ||
      (existing.processingLeaseExpiresAt ?? 0) <= now ||
      (existing.sourceRevision ?? 1) !== args.sourceRevision ||
      existing.analysisAttemptRevision !== args.sourceRevision ||
      existing.analysisAttemptOwner !== owner ||
      existing.analysisAttemptProtocol !== attemptProtocol ||
      (existing.analysisRevision === args.sourceRevision && Boolean(existing.analysisResultJson))
    ) {
      throw new Error("Cannot attest definitive output failure from a stale analysis fence.");
    }
    for (const tokenCount of [
      args.inputTokens,
      args.outputTokens,
      args.reasoningTokens,
      args.totalTokens,
    ]) {
      if (
        tokenCount !== undefined &&
        (!Number.isSafeInteger(tokenCount) || tokenCount < 0)
      ) {
        throw new Error("OpenAI definitive output token counts must be non-negative integers.");
      }
    }
    const model = args.model.trim().slice(0, 160);
    const failureMessage = args.message.trim().slice(0, 1_000);
    if (!owner.trim() || !attemptProtocol || !model || !failureMessage) {
      throw new Error("OpenAI definitive output failure requires protocol and model metadata.");
    }
    const hasExistingAttestation =
      existing.analysisDefinitiveOutputFailureRevision === args.sourceRevision &&
      existing.analysisDefinitiveOutputFailureProtocol === attemptProtocol &&
      existing.analysisDefinitiveOutputFailureAttemptStartedAt ===
        existing.analysisAttemptStartedAt &&
      existing.analysisDefinitiveOutputFailureOwner === owner;
    if (hasExistingAttestation) {
      if (
        existing.analysisDefinitiveOutputFailureKind !== args.failureKind ||
        existing.analysisDefinitiveOutputFailureMessage !== failureMessage ||
        existing.analysisDefinitiveOutputFailureModel !== model ||
        existing.analysisDefinitiveOutputFailureInputTokens !== args.inputTokens ||
        existing.analysisDefinitiveOutputFailureOutputTokens !== args.outputTokens ||
        existing.analysisDefinitiveOutputFailureReasoningTokens !==
          args.reasoningTokens ||
        existing.analysisDefinitiveOutputFailureTotalTokens !== args.totalTokens
      ) {
        throw new Error("A different definitive output failure is already attested for this attempt.");
      }
      return { recorded: false, reason: "already_recorded" as const };
    }
    await ctx.db.patch(existing._id, {
      analysisDefinitiveOutputFailureRevision: args.sourceRevision,
      analysisDefinitiveOutputFailureProtocol: attemptProtocol,
      analysisDefinitiveOutputFailureAttemptStartedAt:
        existing.analysisAttemptStartedAt,
      analysisDefinitiveOutputFailureOwner: owner,
      analysisDefinitiveOutputFailureKind: args.failureKind,
      analysisDefinitiveOutputFailureMessage: failureMessage,
      analysisDefinitiveOutputFailureAt: now,
      analysisDefinitiveOutputFailureModel: model,
      analysisDefinitiveOutputFailureInputTokens: args.inputTokens,
      analysisDefinitiveOutputFailureOutputTokens: args.outputTokens,
      analysisDefinitiveOutputFailureReasoningTokens: args.reasoningTokens,
      analysisDefinitiveOutputFailureTotalTokens: args.totalTokens,
      updatedAt: now,
    });
    return { recorded: true, reason: "recorded" as const };
  },
});

export const releaseOpenAiAnalysisAttempt = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    sourceRevision: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) return { released: false, reason: "missing" as const };
    const now = Date.now();
    if (
      existing.processingStatus !== "processing" ||
      existing.processingLeaseOwner !== args.owner ||
      (existing.processingLeaseExpiresAt ?? 0) <= now ||
      (existing.sourceRevision ?? 1) !== args.sourceRevision ||
      existing.analysisAttemptRevision !== args.sourceRevision ||
      existing.analysisAttemptOwner !== args.owner ||
      existing.analysisRevision === args.sourceRevision
    ) {
      return { released: false, reason: "stale_or_used" as const };
    }
    const dayKey = existing.analysisAttemptBudgetDayKey;
    if (dayKey) {
      const budget = await ctx.db
        .query("ingestionDailyBudgets")
        .withIndex("by_key", (q) => q.eq("key", `openai:${dayKey}`))
        .unique();
      if (budget && budget.chargedMicros > 0) {
        await ctx.db.patch(budget._id, {
          chargedMicros: budget.chargedMicros - 1,
          releasedMicros: budget.releasedMicros + 1,
          reconciledCount: budget.reconciledCount + 1,
          updatedAt: now,
        });
      }
    }
    await ctx.db.patch(existing._id, {
      analysisAttemptRevision: undefined,
      analysisAttemptStartedAt: undefined,
      analysisAttemptOwner: undefined,
      analysisAttemptProtocol: undefined,
      analysisAttemptBudgetDayKey: undefined,
      updatedAt: now,
    });
    return { released: true, reason: "definitely_unsent" as const };
  },
});

export const recordOpenAiAnalysis = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    sourceRevision: v.number(),
    resultJson: v.string(),
    imageSourceUrl: v.optional(v.string()),
    imageChecksumSha256: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    if (args.resultJson.length > 150_000) {
      throw new Error("OpenAI analysis result exceeds the durable cache limit.");
    }
    const parsedResult = JSON.parse(args.resultJson) as unknown;
    if (!parsedResult || typeof parsedResult !== "object" || Array.isArray(parsedResult)) {
      throw new Error("OpenAI analysis result must be a JSON object.");
    }
    const result = parsedResult as Record<string, unknown>;
    const contractVersion =
      typeof result.extraction_contract_version === "string"
        ? result.extraction_contract_version.trim()
        : undefined;
    const isEvent =
      typeof result.is_event === "boolean" ? result.is_event : undefined;
    const nonEventReason =
      typeof result.non_event_reason === "string"
        ? result.non_event_reason.trim().slice(0, 500)
        : undefined;
    if (
      contractVersion === "event_evidence_v2" &&
      (isEvent === undefined || nonEventReason === undefined || (isEvent && nonEventReason) || (!isEvent && !nonEventReason))
    ) {
      throw new Error("OpenAI event-evidence classification is invalid.");
    }
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) throw new Error("Cannot cache analysis for an unknown scraped post.");
    const imageSourceUrl = args.imageSourceUrl?.trim();
    const imageChecksumSha256 = args.imageChecksumSha256?.trim().toLocaleLowerCase();
    if (
      imageChecksumSha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(imageChecksumSha256)
    ) {
      throw new Error("OpenAI analysis image checksum must be a SHA-256 hex digest.");
    }
    if (Boolean(imageSourceUrl) !== Boolean(imageChecksumSha256)) {
      throw new Error("OpenAI analysis image URL and checksum must be recorded together.");
    }
    if (
      imageSourceUrl &&
      ![...(existing.imageUrls ?? []), existing.imageUrl].some(
        (candidate) => candidate?.trim() === imageSourceUrl,
      )
    ) {
      throw new Error("OpenAI analysis image does not match the current scraped-post source.");
    }
    const now = Date.now();
    if (
      existing.processingStatus !== "processing" ||
      existing.processingLeaseOwner !== args.owner ||
      (existing.processingLeaseExpiresAt ?? 0) <= now ||
      (existing.sourceRevision ?? 1) !== args.sourceRevision ||
      existing.analysisAttemptRevision !== args.sourceRevision ||
      existing.analysisAttemptOwner !== args.owner
    ) {
      throw new Error("Cannot cache analysis from a stale processing fence.");
    }
    if (
      existing.analysisRevision === args.sourceRevision &&
      existing.analysisResultJson
    ) {
      try {
        const cached = JSON.parse(existing.analysisResultJson) as unknown;
        if (cached && typeof cached === "object" && !Array.isArray(cached)) {
          return { recorded: false, reason: "already_recorded" as const };
        }
      } catch {
        // Replace a malformed same-revision cache while the caller still owns
        // the current processing fence. Otherwise every retry would pay for
        // another analysis without ever repairing the durable cache.
      }
    }
    await ctx.db.patch(existing._id, {
      analysisRevision: args.sourceRevision,
      analysisResultJson: args.resultJson,
      analysisCompletedAt: now,
      analysisModel: args.model?.slice(0, 160),
      analysisImageSourceUrl: imageSourceUrl,
      analysisImageChecksumSha256: imageChecksumSha256,
      analysisContractVersion: contractVersion?.slice(0, 80),
      analysisIsEvent: isEvent,
      analysisNonEventReason: nonEventReason,
      analysisInputTokens: args.inputTokens,
      analysisOutputTokens: args.outputTokens,
      analysisReasoningTokens: args.reasoningTokens,
      analysisTotalTokens: args.totalTokens,
    });
    return { recorded: true, reason: "recorded" as const };
  },
});

export const getBacklogStateByHandle = query({
  args: {
    handle: v.string(),
    horizonCutoffMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const posts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .take(MAX_SCRAPED_POST_BACKLOG_SCAN_SIZE + 1);
    if (posts.length > MAX_SCRAPED_POST_BACKLOG_SCAN_SIZE) {
      throw new Error(
        `Scraped-post backlog exceeds its safe exact-count bound of ${MAX_SCRAPED_POST_BACKLOG_SCAN_SIZE}; process paginated backlog pages before retrying.`,
      );
    }
    const now = Date.now();
    let actionable = 0;
    let busy = 0;
    for (const post of posts) {
      if (
        post.processingStatus === "completed" &&
        ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(post.processingOutcome ?? "")
      ) {
        continue;
      }
      if (
        post.processingStatus === "retryable_failure" &&
        (post.processingRetryAt ?? 0) > now
      ) {
        continue;
      }
      const postedAtMs = post.postedAtMs ?? parsePostedAtMs(post.postedAt);
      if (
        Number.isFinite(args.horizonCutoffMs) &&
        typeof postedAtMs === "number" &&
        postedAtMs < (args.horizonCutoffMs as number) &&
        post.processingStatus !== "processing"
      ) {
        continue;
      }
      if (
        post.processingStatus === "processing" &&
        (post.processingLeaseExpiresAt ?? 0) > now
      ) {
        busy += 1;
      } else {
        actionable += 1;
      }
    }
    return { actionable, busy, total: posts.length };
  },
});

export const getGlobalBacklogState = query({
  args: { serviceSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const blocker = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_blocksPaidFetch", (q) => q.eq("blocksPaidFetch", true))
      .first();
    if (!blocker) return { actionable: 0, busy: 0, hasBacklog: false };
    const busy =
      blocker.processingStatus === "processing" &&
      (blocker.processingLeaseExpiresAt ?? 0) > Date.now();
    return {
      actionable: busy ? 0 : 1,
      busy: busy ? 1 : 0,
      hasBacklog: true,
    };
  },
});

export const claimHandleFetchLease = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    leaseMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    if (!handle || !args.owner.trim()) return { claimed: false };
    const now = Date.now();
    const existing = await ctx.db
      .query("instagramHandleFetchLeases")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (existing && existing.expiresAt > now && existing.owner !== args.owner) {
      return { claimed: false };
    }
    const leaseMs = Math.max(30_000, Math.min(10 * 60_000, Math.trunc(args.leaseMs ?? 180_000)));
    if (existing) {
      await ctx.db.patch(existing._id, {
        owner: args.owner.slice(0, 200),
        expiresAt: now + leaseMs,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("instagramHandleFetchLeases", {
        handle,
        owner: args.owner.slice(0, 200),
        expiresAt: now + leaseMs,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { claimed: true };
  },
});

export const releaseHandleFetchLease = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const existing = await ctx.db
      .query("instagramHandleFetchLeases")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (existing && existing.owner === args.owner) {
      await ctx.db.delete(existing._id);
      return { released: true };
    }
    return { released: false };
  },
});

export const listPaidFetchMigrationPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const paginationOpts = assertOperationPaginationOptions(
      args.paginationOpts,
      MAX_PAID_FETCH_MIGRATION_BATCH_SIZE,
      "Paid-fetch migration page",
    );
    const result = await ctx.db.query("scrapedPosts").paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((post) => ({
        _id: post._id,
        missing: post.blocksPaidFetch === undefined,
      })),
    };
  },
});

export const backfillPaidFetchFlags = mutation({
  args: {
    ids: v.array(v.id("scrapedPosts")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    assertOperationBatchLength(args.ids.length, {
      allowEmpty: true,
      label: "Paid-fetch flag backfill batch",
      maxItems: MAX_PAID_FETCH_MIGRATION_BATCH_SIZE,
    });
    let updated = 0;
    for (const id of [...new Set(args.ids)]) {
      const post = await ctx.db.get(id);
      if (!post || post.blocksPaidFetch !== undefined) continue;
      const isTerminal =
        post.processingStatus === "completed" &&
        ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(post.processingOutcome ?? "");
      const isRetryable = post.processingStatus === "retryable_failure";
      await ctx.db.patch(id, {
        blocksPaidFetch: !isTerminal && !isRetryable,
        ...(isRetryable
          ? { processingRetryAt: getProcessingRetryAt(Date.now(), post.processingAttempts) }
          : {}),
      });
      updated += 1;
    }
    return { updated };
  },
});

export const reconcilePaidFetchFlags = mutation({
  args: {
    ids: v.array(v.id("scrapedPosts")),
    horizonCutoffMs: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    assertOperationBatchLength(args.ids.length, {
      allowEmpty: true,
      label: "Paid-fetch flag reconciliation batch",
      maxItems: MAX_PAID_FETCH_MIGRATION_BATCH_SIZE,
    });
    const now = Date.now();
    let scanned = 0;
    let releasedTerminal = 0;
    let releasedRetryable = 0;
    let releasedOutOfHorizon = 0;
    let releasedExpiredLease = 0;

    for (const id of [...new Set(args.ids)]) {
      const post = await ctx.db.get(id);
      if (!post || post.blocksPaidFetch !== true) continue;
      scanned += 1;
      const isTerminal =
        post.processingStatus === "completed" &&
        ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(
          post.processingOutcome ?? "",
        );
      if (isTerminal) {
        await ctx.db.patch(id, { blocksPaidFetch: false, processingRetryAt: undefined });
        releasedTerminal += 1;
        continue;
      }
      if (post.processingStatus === "retryable_failure") {
        await ctx.db.patch(id, {
          blocksPaidFetch: false,
          processingRetryAt: getProcessingRetryAt(now, post.processingAttempts),
        });
        releasedRetryable += 1;
        continue;
      }
      if (
        post.processingStatus === "processing" &&
        (post.processingLeaseExpiresAt ?? 0) <= now
      ) {
        await ctx.db.patch(id, {
          processingStatus: "retryable_failure",
          blocksPaidFetch: false,
          processingOutcome: "processing_lease_expired",
          processingError: post.processingError ?? "Processing lease expired before completion.",
          processingLeaseOwner: undefined,
          processingLeaseExpiresAt: undefined,
          processingRetryAt: getProcessingRetryAt(now, post.processingAttempts),
          lastProcessedAt: now,
        });
        releasedExpiredLease += 1;
        continue;
      }
      const postedAtMs = post.postedAtMs ?? parsePostedAtMs(post.postedAt);
      if (
        post.processingStatus !== "processing" &&
        postedAtMs !== undefined &&
        postedAtMs < args.horizonCutoffMs
      ) {
        await ctx.db.patch(id, { blocksPaidFetch: false });
        releasedOutOfHorizon += 1;
      }
    }

    return {
      scanned,
      releasedTerminal,
      releasedRetryable,
      releasedOutOfHorizon,
      releasedExpiredLease,
    };
  },
});

export const markPaidFetchBacklogIndexReady = mutation({
  args: { serviceSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const missingFlag = await ctx.db
      .query("scrapedPosts")
      .filter((q) => q.eq(q.field("blocksPaidFetch"), undefined))
      .first();
    if (missingFlag) {
      return { ready: false, reason: "unmigrated_scraped_posts" as const };
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { backlogIndexReady: true, updatedAt: now });
    } else {
      await ctx.db.insert("instagramPaidFetchControl", {
        key: "apify",
        backlogIndexReady: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { ready: true };
  },
});

export const claimPaidFetchLease = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    leaseMs: v.optional(v.number()),
    requestedResultsLimit: v.optional(v.number()),
    fetchStartedAt: v.optional(v.number()),
    bootstrapDays: v.optional(v.number()),
    paidEnabled: v.optional(v.boolean()),
    dayKey: v.optional(v.string()),
    dailyBudgetUsd: v.optional(v.number()),
    maxChargeUsd: v.optional(v.number()),
    horizonCutoffMs: v.optional(v.number()),
    attemptCooldownMs: v.optional(v.number()),
    ignoreCheckpoint: v.optional(v.boolean()),
    requestBoundaryVersion: v.optional(v.literal(1)),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    if (!handle || !owner) return { claimed: false, reason: "invalid" as const };
    if (args.paidEnabled === false) {
      return { claimed: false, reason: "paid_disabled" as const };
    }

    const now = Date.now();
    const attemptCooldownMs = Math.max(
      0,
      Math.min(
        30 * 24 * 60 * 60_000,
        Math.trunc(args.attemptCooldownMs ?? 23 * 60 * 60_000),
      ),
    );
    const recentAttemptCutoff = now - attemptCooldownMs;
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (!control?.backlogIndexReady) {
      return { claimed: false, reason: "backlog_index_not_ready" as const };
    }
    const horizonCutoffMs = Number.isFinite(args.horizonCutoffMs)
      ? Math.trunc(args.horizonCutoffMs as number)
      : null;
    // Backlog admission is source-scoped. A saved post from an inactive or
    // unrelated handle must not starve fresh acquisition for every venue.
    const findBlocker = () =>
      ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_blocksPaidFetch", (q) =>
          q.eq("handle", handle).eq("blocksPaidFetch", true),
        )
        .first();
    let blocker = await findBlocker();
    let reconciledBlockers = 0;
    while (blocker && reconciledBlockers < 100) {
      const isTerminal =
        blocker.processingStatus === "completed" &&
        ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(
          blocker.processingOutcome ?? "",
        );
      const isRetryable = blocker.processingStatus === "retryable_failure";
      const isExpiredProcessing =
        blocker.processingStatus === "processing" &&
        (blocker.processingLeaseExpiresAt ?? 0) <= now;
      const postedAtMs = blocker.postedAtMs ?? parsePostedAtMs(blocker.postedAt);
      const isOutOfHorizon =
        horizonCutoffMs !== null &&
        typeof postedAtMs === "number" &&
        postedAtMs < horizonCutoffMs &&
        blocker.processingStatus !== "processing";

      if (!isTerminal && !isRetryable && !isExpiredProcessing && !isOutOfHorizon) {
        break;
      }

      if (isExpiredProcessing) {
        await ctx.db.patch(blocker._id, {
          processingStatus: "retryable_failure",
          blocksPaidFetch: false,
          processingOutcome: "processing_lease_expired",
          processingError:
            blocker.processingError ?? "Processing lease expired before completion.",
          processingLeaseOwner: undefined,
          processingLeaseExpiresAt: undefined,
          processingRetryAt: getProcessingRetryAt(now, blocker.processingAttempts),
          lastProcessedAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(blocker._id, {
          blocksPaidFetch: false,
          ...(isRetryable
            ? { processingRetryAt: getProcessingRetryAt(now, blocker.processingAttempts) }
            : { processingRetryAt: undefined }),
          ...(isOutOfHorizon && !isTerminal
            ? { processingOutcome: blocker.processingOutcome ?? "outside_ingestion_horizon" }
            : {}),
          updatedAt: now,
        });
      }
      reconciledBlockers += 1;
      blocker = await findBlocker();
    }
    if (blocker) {
      return {
        claimed: false,
        reason:
          reconciledBlockers >= 100
            ? ("backlog_maintenance_incomplete" as const)
            : ("saved_backlog_present" as const),
        reconciledBlockers,
      };
    }

    if (
      (control.leaseExpiresAt ?? 0) > now &&
      control.leaseOwner
    ) {
      if (control.leaseOwner !== owner || control.leaseHandle !== handle) {
        return { claimed: false, reason: "busy" as const };
      }
      const activeSource = await ctx.db
        .query("instagramSources")
        .withIndex("by_handle", (q) => q.eq("handle", handle))
        .unique();
      if (
        attemptCooldownMs > 0 &&
        typeof activeSource?.lastFetchAttemptAt === "number" &&
        activeSource.lastFetchAttemptAt >= recentAttemptCutoff
      ) {
        return {
          claimed: false,
          reason: "recent_provider_attempt" as const,
          lastFetchAttemptAt: activeSource.lastFetchAttemptAt,
        };
      }
      const resumedFetchStartedAt = control.leaseFetchStartedAt ?? now;
      const resumedBoundary = getFetchBoundary({
        successfulFetchThroughAt: activeSource?.lastSuccessfulFetchThroughAt,
        fetchStartedAt: resumedFetchStartedAt,
        bootstrapDays: Math.max(
          1,
          Math.min(90, Math.trunc(args.bootstrapDays ?? DEFAULT_INGESTION_BOOTSTRAP_DAYS)),
        ),
      });
      return {
        claimed: true,
        reason: "resumed_claim" as const,
        onlyPostsNewerThan: new Date(resumedBoundary.requestNewerThanAt).toISOString(),
        boundaryKey: control.leaseBoundaryKey,
        checkpointAt: control.leaseCheckpointAt ?? null,
        fetchStartedAt: resumedFetchStartedAt,
        resultsLimit: control.leaseResultsLimit,
        reservationId: control.leaseReservationId,
        reservedMicros: control.leaseReservedMicros,
        expiresAt: control.leaseExpiresAt,
      };
    }

    // A crashed owner cannot strand reserved budget forever. The reservation's
    // durable request-start receipt separates a pre-boundary crash (release) from
    // a transport-ambiguous post-boundary crash (charge).
    if (
      (control.leaseExpiresAt ?? 0) <= now &&
      control.leaseReservationId &&
      (control.leaseReservedMicros ?? 0) > 0
    ) {
      const oldReservation = await ctx.db
        .query("ingestionCostReservations")
        .withIndex("by_reservationId", (q) =>
          q.eq("reservationId", control.leaseReservationId as string),
        )
        .unique();
      if (oldReservation?.status === "active") {
        const oldBudget = await ctx.db
          .query("ingestionDailyBudgets")
          .withIndex("by_key", (q) =>
            q.eq("key", `${oldReservation.provider}:${oldReservation.dayKey}`),
          )
          .unique();
        const requestStarted =
          typeof oldReservation.requestStartedAt === "number" &&
          Number.isFinite(oldReservation.requestStartedAt);
        const chargedMicros = requestStarted ? oldReservation.reservedMicros : 0;
        const releasedMicros = Math.max(0, oldReservation.reservedMicros - chargedMicros);
        if (oldBudget) {
          await ctx.db.patch(oldBudget._id, {
            reservedMicros: Math.max(
              0,
              oldBudget.reservedMicros - oldReservation.reservedMicros,
            ),
            chargedMicros: oldBudget.chargedMicros + chargedMicros,
            releasedMicros: oldBudget.releasedMicros + releasedMicros,
            reconciledCount: oldBudget.reconciledCount + 1,
            updatedAt: now,
          });
        }
        await ctx.db.patch(oldReservation._id, {
          chargedMicros,
          releasedMicros,
          status: requestStarted ? "reconciled" : "released",
          updatedAt: now,
        });
      }
    }

    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (source && !source.active) {
      return { claimed: false, reason: "source_inactive" as const };
    }
    if (
      attemptCooldownMs > 0 &&
      typeof source?.lastFetchAttemptAt === "number" &&
      source.lastFetchAttemptAt >= recentAttemptCutoff
    ) {
      return {
        claimed: false,
        reason: "recent_provider_attempt" as const,
        lastFetchAttemptAt: source.lastFetchAttemptAt,
      };
    }
    const fetchStartedAt = Math.max(
      1,
      Math.min(now + 60_000, Math.trunc(args.fetchStartedAt ?? now)),
    );
    const checkpointAt = args.ignoreCheckpoint ? undefined : source?.lastSuccessfulFetchThroughAt;
    const bootstrapDays = Math.max(
      1,
      Math.min(90, Math.trunc(args.bootstrapDays ?? DEFAULT_INGESTION_BOOTSTRAP_DAYS)),
    );
    const lowerBoundMs = getFetchBoundary({
      successfulFetchThroughAt: checkpointAt,
      fetchStartedAt,
      bootstrapDays,
    }).requestNewerThanAt;
    const onlyPostsNewerThan = new Date(lowerBoundMs).toISOString();
    const boundaryKey = checkpointAt ? String(checkpointAt) : `bootstrap:${lowerBoundMs}`;

    let fetchState = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (fetchState && fetchState.boundaryKey !== boundaryKey) {
      await ctx.db.delete(fetchState._id);
      fetchState = null;
    }
    if (fetchState?.hardBlocked) {
      if (source) {
        await ctx.db.patch(source._id, {
          deferredAt: source.deferredAt ?? now,
          lastFetchStatus: "continuation_max_saturated",
          updatedAt: now,
        });
      }
      return {
        claimed: false,
        reason: "hard_cap_saturated" as const,
        boundaryKey,
        resultsLimit: fetchState.nextResultsLimit,
      };
    }

    const requestedResultsLimit = Math.max(
      1,
      Math.min(
        DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
        Math.trunc(args.requestedResultsLimit ?? DEFAULT_INGESTION_FETCH_PAGE_SIZE),
      ),
    );
    const resultsLimit = Math.max(requestedResultsLimit, fetchState?.nextResultsLimit ?? 0);
    const dayKey = (args.dayKey ?? new Date(now).toISOString().slice(0, 10)).trim();
    const limitMicros = usdToMicros(
      args.dailyBudgetUsd,
      DEFAULT_APIFY_DAILY_BUDGET_USD,
    );
    const reserveMicros = usdToMicros(
      args.maxChargeUsd,
      DEFAULT_APIFY_MAX_CHARGE_PER_HANDLE_USD,
    );
    if (!dayKey || limitMicros <= 0 || reserveMicros <= 0) {
      return { claimed: false, reason: "invalid_budget" as const };
    }
    const budgetKey = `apify:${dayKey}`;
    const budget = await ctx.db
      .query("ingestionDailyBudgets")
      .withIndex("by_key", (q) => q.eq("key", budgetKey))
      .unique();
    const budgetReserved = budget?.reservedMicros ?? 0;
    const budgetCharged = budget?.chargedMicros ?? 0;
    if (budgetReserved + budgetCharged + reserveMicros > limitMicros) {
      if (source) {
        await ctx.db.patch(source._id, {
          deferredAt: source.deferredAt ?? now,
          lastFetchStatus: "budget_deferred",
          updatedAt: now,
        });
      }
      return {
        claimed: false,
        reason: "budget_exhausted" as const,
        remainingMicros: Math.max(0, limitMicros - budgetReserved - budgetCharged),
      };
    }

    const reservationId = `${owner}:${handle}:${fetchStartedAt}`.slice(0, 500);
    await ctx.db.insert("ingestionCostReservations", {
      reservationId,
      provider: "apify",
      dayKey,
      owner,
      handle,
      reservedMicros: reserveMicros,
      requestStartedAt: args.requestBoundaryVersion === 1 ? undefined : now,
      requestBoundaryVersion: args.requestBoundaryVersion,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    if (budget) {
      await ctx.db.patch(budget._id, {
        limitMicros,
        reservedMicros: budget.reservedMicros + reserveMicros,
        reservationCount: budget.reservationCount + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("ingestionDailyBudgets", {
        key: budgetKey,
        provider: "apify",
        dayKey,
        limitMicros,
        reservedMicros: reserveMicros,
        chargedMicros: 0,
        releasedMicros: 0,
        reservationCount: 1,
        reconciledCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const leaseMs = Math.max(
      60_000,
      Math.min(12 * 60_000, Math.trunc(args.leaseMs ?? 10 * 60_000)),
    );
    const leaseExpiresAt = now + leaseMs;
    await ctx.db.patch(control._id, {
      leaseOwner: owner,
      leaseHandle: handle,
      leaseExpiresAt,
      leaseBoundaryKey: boundaryKey,
      leaseResultsLimit: resultsLimit,
      leaseFetchStartedAt: fetchStartedAt,
      leaseCheckpointAt: checkpointAt,
      leaseBudgetDayKey: dayKey,
      leaseReservationId: reservationId,
      leaseReservedMicros: reserveMicros,
      leaseWindowStatus: "active",
      updatedAt: now,
    });
    // During backend-first rollout or rollback, older web images do not know
    // about the explicit request-boundary mutation. Preserve their conservative
    // claim-time receipt, while boundary-aware callers defer it until fetch.
    if (args.requestBoundaryVersion !== 1) {
      const compatibilityPatch = {
        lastFetchAttemptAt: now,
        lastFetchStatus: "fetching",
        lastFetchError: undefined,
        deferredAt: undefined,
        updatedAt: now,
      };
      if (source) {
        await ctx.db.patch(source._id, compatibilityPatch);
      } else {
        await ctx.db.insert("instagramSources", {
          handle,
          role: "unknown",
          active: true,
          discoveredAt: now,
          activatedAt: now,
          ...compatibilityPatch,
          createdAt: now,
        });
      }
    }
    return {
      claimed: true,
      reason: "claimed" as const,
      onlyPostsNewerThan,
      boundaryKey,
      checkpointAt: checkpointAt ?? null,
      fetchStartedAt,
      resultsLimit,
      reservationId,
      reservedMicros: reserveMicros,
      remainingMicros: Math.max(0, limitMicros - budgetReserved - budgetCharged - reserveMicros),
      expiresAt: leaseExpiresAt,
    };
  },
});

export const markPaidFetchRequestStarted = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    const now = Date.now();
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (
      !control ||
      control.leaseOwner !== owner ||
      control.leaseHandle !== handle ||
      (control.leaseExpiresAt ?? 0) <= now ||
      control.leaseWindowStatus !== "active"
    ) {
      throw new Error("Cannot mark provider request from a stale paid-fetch lease.");
    }

    if (!control.leaseReservationId) {
      throw new Error("Cannot mark provider request without an active budget reservation.");
    }
    const reservation = await ctx.db
      .query("ingestionCostReservations")
      .withIndex("by_reservationId", (q) =>
        q.eq("reservationId", control.leaseReservationId as string),
      )
      .unique();
    if (
      !reservation ||
      reservation.status !== "active" ||
      reservation.owner !== owner ||
      reservation.handle !== handle
    ) {
      throw new Error("Cannot mark provider request against a stale budget reservation.");
    }
    const requestStartedAt = reservation.requestStartedAt ?? now;
    if (reservation.requestStartedAt === undefined) {
      await ctx.db.patch(reservation._id, { requestStartedAt, updatedAt: now });
    }

    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    const patch = {
      lastFetchAttemptAt: requestStartedAt,
      lastFetchStatus: "fetching",
      lastFetchError: undefined,
      deferredAt: undefined,
      updatedAt: now,
    };
    if (source) {
      await ctx.db.patch(source._id, patch);
    } else {
      await ctx.db.insert("instagramSources", {
        handle,
        role: "unknown",
        active: true,
        discoveredAt: now,
        activatedAt: now,
        ...patch,
        createdAt: now,
      });
    }
    return { marked: true, requestStartedAt };
  },
});

export const recordPaidFetchWindowSaturation = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    rawItemCount: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (
      !control ||
      control.leaseOwner !== owner ||
      control.leaseHandle !== handle ||
      (control.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      throw new Error("Cannot record saturation from a stale paid-fetch lease.");
    }
    const requested = control.leaseResultsLimit ?? DEFAULT_INGESTION_FETCH_PAGE_SIZE;
    if (args.rawItemCount < requested) {
      throw new Error("Raw result count does not saturate the claimed fetch window.");
    }
    const nextResultsLimit = nextContinuationResultsLimit(
      requested,
      DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
    );
    const hardBlocked = requested >= DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN;
    const now = Date.now();
    await ctx.db.patch(control._id, {
      leaseWindowStatus: "saturated",
      updatedAt: now,
    });
    const existing = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    const state = {
      handle,
      boundaryKey: control.leaseBoundaryKey ?? "__none__",
      nextResultsLimit,
      hardBlocked,
      lastRequestedMaxItems: requested,
      lastRawItemCount: Math.max(0, Math.trunc(args.rawItemCount)),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, state);
    } else {
      await ctx.db.insert("instagramHandleFetchStates", { ...state, createdAt: now });
    }
    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (source) {
      await ctx.db.patch(source._id, {
        continuationActive: true,
        continuationBoundaryAt: control.leaseCheckpointAt,
        continuationResultsLimit: nextResultsLimit,
        continuationReason: hardBlocked
          ? "provider_result_cap_at_configured_max"
          : "provider_result_cap",
        deferredAt: source.deferredAt ?? now,
        lastFetchStatus: "incomplete_capped",
        updatedAt: now,
      });
    }
    return { recorded: true, nextResultsLimit, hardBlocked, checkpointAdvanced: false };
  },
});

export const recordPaidFetchWindowSuccess = mutation({
  args: {
    handle: v.string(),
    owner: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    const now = Date.now();
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (
      !control ||
      control.leaseOwner !== owner ||
      control.leaseHandle !== handle ||
      (control.leaseExpiresAt ?? 0) <= now ||
      !control.leaseFetchStartedAt ||
      control.leaseWindowStatus !== "active"
    ) {
      throw new Error("Cannot record success from a stale paid-fetch lease.");
    }
    const existing = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (existing && existing.boundaryKey === (control.leaseBoundaryKey ?? "__none__")) {
      await ctx.db.delete(existing._id);
    }
    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (source) {
      await ctx.db.patch(source._id, {
        lastSuccessfulFetchThroughAt: control.leaseFetchStartedAt,
        lastFetchCompletedAt: now,
        lastFetchStatus: "completed",
        lastFetchError: undefined,
        continuationActive: false,
        continuationBoundaryAt: undefined,
        continuationResultsLimit: undefined,
        continuationReason: undefined,
        deferredAt: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("instagramSources", {
        handle,
        role: "unknown",
        active: true,
        discoveredAt: now,
        activatedAt: now,
        lastFetchAttemptAt: now,
        lastSuccessfulFetchThroughAt: control.leaseFetchStartedAt,
        lastFetchCompletedAt: now,
        lastFetchStatus: "completed",
        continuationActive: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      recorded: true,
      checkpointAdvanced: true,
      checkpointAt: control.leaseFetchStartedAt,
    };
  },
});

export const resetPaidFetchWindow = mutation({
  args: { handle: v.string(), serviceSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const existing = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!existing) return { reset: false };
    await ctx.db.delete(existing._id);
    return { reset: true };
  },
});

export const releasePaidFetchLease = mutation({
  args: {
    owner: v.string(),
    requestStarted: v.optional(v.boolean()),
    actualChargeUsd: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const owner = args.owner.trim().slice(0, 200);
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (!control || control.leaseOwner !== owner) {
      return { released: false };
    }
    const now = Date.now();
    let chargedMicros = 0;
    let releasedMicros = 0;
    if (control.leaseReservationId) {
      const reservation = await ctx.db
        .query("ingestionCostReservations")
        .withIndex("by_reservationId", (q) =>
          q.eq("reservationId", control.leaseReservationId as string),
        )
        .unique();
      if (reservation?.status === "active") {
        const durableRequestStarted = typeof reservation.requestStartedAt === "number";
        // Boundary-aware callers distinguish the crash-safe marker from actual
        // transport invocation. An explicit false from the still-owning worker
        // proves that fetch was never called and may retract the marker. If the
        // worker crashes, no release arrives and stale reconciliation continues
        // to treat the durable marker conservatively as chargeable.
        const requestStarted = args.requestStarted ?? durableRequestStarted;
        chargedMicros = requestStarted
          ? args.actualChargeUsd === undefined
            ? reservation.reservedMicros
            : Math.min(
                reservation.reservedMicros,
                usdToMicros(args.actualChargeUsd, 0),
              )
          : 0;
        releasedMicros = Math.max(0, reservation.reservedMicros - chargedMicros);
        const budget = await ctx.db
          .query("ingestionDailyBudgets")
          .withIndex("by_key", (q) => q.eq("key", `${reservation.provider}:${reservation.dayKey}`))
          .unique();
        if (budget) {
          await ctx.db.patch(budget._id, {
            reservedMicros: Math.max(0, budget.reservedMicros - reservation.reservedMicros),
            chargedMicros: budget.chargedMicros + chargedMicros,
            releasedMicros: budget.releasedMicros + releasedMicros,
            reconciledCount: budget.reconciledCount + 1,
            updatedAt: now,
          });
        }
        await ctx.db.patch(reservation._id, {
          chargedMicros,
          releasedMicros,
          status: chargedMicros > 0 ? "reconciled" : "released",
          updatedAt: now,
        });
        if (
          !requestStarted &&
          reservation.handle &&
          typeof reservation.requestStartedAt === "number"
        ) {
          const source = await ctx.db
            .query("instagramSources")
            .withIndex("by_handle", (q) => q.eq("handle", reservation.handle as string))
            .unique();
          if (
            source?.lastFetchAttemptAt === reservation.requestStartedAt &&
            source.lastFetchStatus === "fetching"
          ) {
            await ctx.db.patch(source._id, {
              lastFetchAttemptAt: undefined,
              lastFetchStatus: "preflight_released",
              updatedAt: now,
            });
          }
        }
      }
    }
    await ctx.db.patch(control._id, {
      leaseOwner: undefined,
      leaseHandle: undefined,
      leaseExpiresAt: undefined,
      leaseBoundaryKey: undefined,
      leaseResultsLimit: undefined,
      leaseFetchStartedAt: undefined,
      leaseCheckpointAt: undefined,
      leaseBudgetDayKey: undefined,
      leaseReservationId: undefined,
      leaseReservedMicros: undefined,
      leaseWindowStatus: undefined,
      updatedAt: now,
    });
    return { released: true, chargedMicros, releasedMicros };
  },
});

export const claimProviderLease = mutation({
  args: {
    provider: v.string(),
    owner: v.string(),
    leaseMs: v.optional(v.number()),
    budgetDayKey: v.optional(v.string()),
    dailyRequestLimit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const provider = args.provider.trim().toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    if (!provider || !owner) return { claimed: false, reason: "invalid" as const };
    const now = Date.now();
    const existing = await ctx.db
      .query("ingestionProviderLeases")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (existing?.blockedAt && (existing.cooldownUntil ?? Number.POSITIVE_INFINITY) > now) {
      return {
        claimed: false,
        reason: "provider_blocked" as const,
        blockedStatus: existing.blockedStatus,
        blockedCode: existing.blockedCode,
        cooldownUntil: existing.cooldownUntil,
      };
    }
    if (existing && existing.leaseExpiresAt > now && existing.owner !== owner) {
      return { claimed: false, reason: "busy" as const };
    }
    if (provider === "openai" && args.budgetDayKey && args.dailyRequestLimit !== undefined) {
      const dayKey = args.budgetDayKey.trim();
      const dailyLimit = Math.max(0, Math.trunc(args.dailyRequestLimit));
      const budget = await ctx.db
        .query("ingestionDailyBudgets")
        .withIndex("by_key", (q) => q.eq("key", `${provider}:${dayKey}`))
        .unique();
      const used = (budget?.chargedMicros ?? 0) + (budget?.reservedMicros ?? 0);
      if (!dayKey || dailyLimit <= 0 || used >= dailyLimit) {
        return { claimed: false, reason: "budget_exhausted" as const, used, dailyLimit };
      }
      // This is only a capacity preflight. The daily counter is charged by
      // markOpenAiAnalysisAttemptStarted at the durable pre-transport boundary.
      // A lease that is released before that marker therefore costs nothing.
    }
    const leaseMs = Math.max(
      30_000,
      Math.min(10 * 60_000, Math.trunc(args.leaseMs ?? 180_000)),
    );
    const halfOpen = Boolean(existing?.blockedAt);
    if (existing) {
      await ctx.db.patch(existing._id, {
        owner,
        leaseExpiresAt: now + leaseMs,
        circuitState: halfOpen ? "half_open" : "closed",
        ...(halfOpen ? { blockedAt: undefined } : {}),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("ingestionProviderLeases", {
        provider,
        owner,
        leaseExpiresAt: now + leaseMs,
        circuitState: "closed",
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      claimed: true,
      reason: halfOpen ? ("half_open" as const) : ("claimed" as const),
    };
  },
});

export const blockProvider = mutation({
  args: {
    provider: v.string(),
    owner: v.string(),
    status: v.number(),
    code: v.optional(v.string()),
    cooldownMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const provider = args.provider.trim().toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    const existing = await ctx.db
      .query("ingestionProviderLeases")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    const now = Date.now();
    if (!existing || existing.owner !== owner || existing.leaseExpiresAt <= now) {
      throw new Error("Cannot block a provider from a stale execution lease.");
    }
    const cooldownMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60_000, Math.trunc(args.cooldownMs ?? 60 * 60_000)),
    );
    await ctx.db.patch(existing._id, {
      blockedAt: now,
      blockedStatus: Math.trunc(args.status),
      blockedCode: args.code?.slice(0, 160),
      circuitState: "open",
      cooldownUntil: now + cooldownMs,
      failureCount: (existing.failureCount ?? 0) + 1,
      leaseExpiresAt: now,
      updatedAt: now,
    });
    return { blocked: true, cooldownUntil: now + cooldownMs };
  },
});

export const releaseProviderLease = mutation({
  args: {
    provider: v.string(),
    owner: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const provider = args.provider.trim().toLocaleLowerCase();
    const existing = await ctx.db
      .query("ingestionProviderLeases")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (
      existing &&
      existing.owner === args.owner.trim().slice(0, 200) &&
      existing.leaseExpiresAt > Date.now() &&
      !existing.blockedAt
    ) {
      const now = Date.now();
      await ctx.db.patch(existing._id, {
        circuitState: "closed",
        cooldownUntil: undefined,
        blockedStatus: undefined,
        blockedCode: undefined,
        leaseExpiresAt: now,
        updatedAt: now,
      });
      return { released: true };
    }
    return { released: false };
  },
});

export const clearProviderBlock = mutation({
  args: {
    provider: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const provider = args.provider.trim().toLocaleLowerCase();
    const existing = await ctx.db
      .query("ingestionProviderLeases")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { cleared: Boolean(existing) };
  },
});

export const recordProcessingResult = mutation({
  args: {
    handle: v.string(),
    scrapedPostId: v.optional(v.id("scrapedPosts")),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    status: processingStatusValidator,
    outcome: v.string(),
    error: v.optional(v.string()),
    owner: v.string(),
    sourceRevision: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existing = await resolveScrapedPostForProcessingFence(ctx, args);
    if (!existing) {
      throw new Error("Cannot record processing state for an unknown scraped post.");
    }
    const now = Date.now();
    if (
      existing.processingStatus !== "processing" ||
      existing.processingLeaseOwner !== args.owner ||
      (existing.processingLeaseExpiresAt ?? 0) <= now ||
      !Number.isSafeInteger(args.sourceRevision) ||
      (existing.sourceRevision ?? 1) !== args.sourceRevision
    ) {
      throw new Error("Cannot record processing result from a stale processing fence.");
    }
    const isExplicitTerminal =
      args.status === "completed" &&
      ["terminal_no_event", "terminal_permanent_failure", "receipt_complete"].includes(args.outcome);
    if (args.status === "completed" && !isExplicitTerminal) {
      throw new Error("Completed scraped-post processing requires an explicit terminal outcome.");
    }

    const isRetryable = args.status === "retryable_failure";
    await ctx.db.patch(existing._id, {
      processingStatus: args.status,
      // Retryable work remains durable but is circuit-delayed instead of
      // globally deadlocking every subsequent paid source fetch.
      blocksPaidFetch: false,
      processingOutcome: args.outcome.slice(0, 160),
      processingError: args.error?.slice(0, 1_000),
      processingLeaseOwner: undefined,
      processingLeaseExpiresAt: undefined,
      processingRetryAt: isRetryable
        ? getProcessingRetryAt(now, existing.processingAttempts)
        : undefined,
      lastProcessedAt: now,
    });
  },
});

const SCRAPED_POST_RETENTION_CURSOR_KEY = "scraped-post-retention-v1";

export const deleteOlderThan = internalMutation({
  args: {
    cutoffUpdatedAt: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    continueCursor: v.string(),
    cutoffUpdatedAt: v.number(),
    deletedCount: v.number(),
    deletedIds: v.array(v.id("scrapedPosts")),
    hasMore: v.boolean(),
    retainedReferencedCount: v.number(),
    scannedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.cutoffUpdatedAt)) {
      throw new Error("Scraped-post retention cutoff must be a safe integer timestamp.");
    }
    const limit = resolveOperationLimit(args.limit, {
      defaultValue: DEFAULT_SCRAPED_POST_RETENTION_BATCH_SIZE,
      label: "Scraped-post retention batch size",
      maxValue: MAX_SCRAPED_POST_RETENTION_BATCH_SIZE,
    });
    const persistedCursor = await ctx.db
      .query("scrapedPostRetentionCursors")
      .withIndex("by_key", (q) => q.eq("key", SCRAPED_POST_RETENTION_CURSOR_KEY))
      .unique();
    if (
      persistedCursor &&
      (!Number.isSafeInteger(persistedCursor.cutoffUpdatedAt) || !persistedCursor.cursor)
    ) {
      throw new Error("Persisted scraped-post retention cursor is invalid.");
    }
    const cutoffUpdatedAt = persistedCursor?.cutoffUpdatedAt ?? args.cutoffUpdatedAt;
    const cursor = persistedCursor?.cursor ?? args.cursor ?? null;
    const page = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", cutoffUpdatedAt))
      .paginate({ cursor, numItems: limit });
    const deletedIds: Id<"scrapedPosts">[] = [];
    let retainedReferencedCount = 0;

    for (const post of page.page) {
      const canonicalSourceUrl = canonicalizeSourceUrlOrEmpty(
        "instagram",
        post.instagramPostUrl,
      );
      const persistedCanonicalSourceUrl = post.canonicalSourceUrl
        ? canonicalizeSourceUrlOrEmpty("instagram", post.canonicalSourceUrl)
        : canonicalSourceUrl;
      if (
        !canonicalSourceUrl ||
        !persistedCanonicalSourceUrl ||
        persistedCanonicalSourceUrl !== canonicalSourceUrl
      ) {
        // Retention is destructive. A malformed or contradictory source URL
        // cannot prove that no canonical provenance link exists, so preserve
        // the source document until its identity has been repaired.
        retainedReferencedCount += 1;
        continue;
      }

      const [
        firstClassOccurrence,
        legacyPostIdLink,
        legacyPostUrlLink,
        legacyCanonicalSourceUrlLink,
      ] =
        await Promise.all([
          ctx.db
            .query("sourceOccurrences")
            .withIndex("by_document_occurrence", (q) =>
              q.eq("sourceDocumentId", post._id),
            )
            .take(1),
          ctx.db
            .query("instagramEventSources")
            .withIndex("by_post_id", (q) => q.eq("instagramPostId", post.postId))
            .take(1),
          ctx.db
            .query("instagramEventSources")
            .withIndex("by_post_url", (q) =>
              q.eq("instagramPostUrl", post.instagramPostUrl),
            )
            .take(1),
          ctx.db
            .query("instagramEventSources")
            .withIndex("by_canonical_source_url", (q) =>
              q.eq("canonicalSourceUrl", canonicalSourceUrl),
            )
            .take(1),
        ]);
      if (
        firstClassOccurrence.length > 0 ||
        legacyPostIdLink.length > 0 ||
        legacyPostUrlLink.length > 0 ||
        legacyCanonicalSourceUrlLink.length > 0
      ) {
        retainedReferencedCount += 1;
        continue;
      }
      await ctx.db.delete(post._id);
      deletedIds.push(post._id);
    }

    if (!page.isDone) {
      if (!page.continueCursor) {
        throw new Error("Scraped-post retention pagination did not advance.");
      }
      const now = Date.now();
      const nextCursorState = {
        key: SCRAPED_POST_RETENTION_CURSOR_KEY,
        cutoffUpdatedAt,
        cursor: page.continueCursor,
        updatedAt: now,
      };
      if (persistedCursor) {
        await ctx.db.patch(persistedCursor._id, nextCursorState);
      } else {
        await ctx.db.insert("scrapedPostRetentionCursors", {
          ...nextCursorState,
          createdAt: now,
        });
      }
    } else if (persistedCursor) {
      await ctx.db.delete(persistedCursor._id);
    }

    return {
      continueCursor: page.continueCursor,
      cutoffUpdatedAt,
      deletedCount: deletedIds.length,
      deletedIds,
      hasMore: !page.isDone,
      retainedReferencedCount,
      scannedCount: page.page.length,
    };
  },
});
