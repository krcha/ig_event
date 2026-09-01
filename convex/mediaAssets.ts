import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  hasCoherentInstagramMediaSourceRecord,
  normalizeInstagramMediaSourceIdentity,
} from "../lib/images/media-source-identity";
import { isAllowedRemoteImageUrl } from "../lib/images/remote-image-policy";
import { nextEventUpdatedAt } from "../lib/events/event-update-precondition";
import { isCrossPostCampaignLineageEvent } from "../lib/events/cross-post-campaign-aggregate-attestation";
import {
  isEventPubliclyVisible,
  refreshEventPublicationStates,
} from "./publicationPolicy";
import { assertOperationPaginationOptions } from "./internal/requestBounds";

const MAX_MEDIA_SOURCE_MATCHES = 25;
const MAX_ORPHANED_MEDIA_CLEANUP_PAGE_SIZE = 500;

const sourceIdentityArgs = {
  postId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
};

const sourceProcessingFenceValidator = v.object({
  handle: v.string(),
  scrapedPostId: v.optional(v.id("scrapedPosts")),
  postId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
  owner: v.string(),
  sourceRevision: v.number(),
});

type SourceProcessingFence = {
  handle: string;
  scrapedPostId?: Id<"scrapedPosts">;
  postId?: string;
  instagramPostUrl?: string;
  owner: string;
  sourceRevision: number;
};

type SourceIdentity = {
  postId?: string;
  instagramPostUrl?: string;
};

async function boundedIdentityRows<T>(
  rowsPromise: Promise<T[]>,
  label: string,
): Promise<T[]> {
  const rows = await rowsPromise;
  if (rows.length > MAX_MEDIA_SOURCE_MATCHES) {
    throw new Error(`${label} exceeds the bounded source-identity limit.`);
  }
  return rows;
}

async function uniqueIdentityRow<T>(
  rowsPromise: Promise<T[]>,
  label: string,
): Promise<T | null> {
  const rows = await rowsPromise;
  if (rows.length > 1) {
    throw new Error(`${label} is ambiguous.`);
  }
  return rows[0] ?? null;
}

async function assertCoherentPersistedSourceIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: SourceIdentity,
): Promise<void> {
  if (!identity.postId?.trim() || !identity.instagramPostUrl?.trim()) {
    return;
  }
  const [matchingPosts, matchingEvents] = await Promise.all([
    collectScrapedPostsByIdentity(ctx, identity),
    collectEventsByIdentity(ctx, identity),
  ]);
  const coherent = hasCoherentInstagramMediaSourceRecord(
    identity,
    [
      ...matchingPosts.map((post) => ({
        postId: post.postId,
        instagramPostUrl: post.instagramPostUrl,
      })),
      ...matchingEvents.map((event) => ({
        postId: event.instagramPostId,
        instagramPostUrl: event.instagramPostUrl,
      })),
    ],
  );
  if (!coherent) {
    throw new Error(
      "Instagram post ID and URL must identify the same persisted source record.",
    );
  }
}

type AssetAttachment = {
  assetId: Id<"mediaAssets">;
  storageId: Id<"_storage">;
  url: string;
  checksumSha256: string;
};

async function findAssetByIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: SourceIdentity,
): Promise<Doc<"mediaAssets"> | null> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  if (normalized.postId) {
    const byPostId = await uniqueIdentityRow(
      ctx.db
        .query("mediaAssets")
        .withIndex("by_instagramPostId", (q) =>
          q.eq("instagramPostId", normalized.postId),
        )
        .take(2),
      "Instagram post media asset",
    );
    if (byPostId) return byPostId;
  }
  if (normalized.normalizedInstagramPostUrl) {
    const byPostUrl = await uniqueIdentityRow(
      ctx.db
        .query("mediaAssets")
        .withIndex("by_normalizedInstagramPostUrl", (q) =>
          q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
        )
        .take(2),
      "Normalized Instagram URL media asset",
    );
    if (byPostUrl) return byPostUrl;
  }
  if (normalized.canonicalSourceUrl) {
    const byCanonicalSourceUrl = await uniqueIdentityRow(
      ctx.db
        .query("mediaAssets")
        .withIndex("by_canonicalSourceUrl", (q) =>
          q.eq("canonicalSourceUrl", normalized.canonicalSourceUrl),
        )
        .take(2),
      "Canonical Instagram URL media asset",
    );
    if (byCanonicalSourceUrl) return byCanonicalSourceUrl;
  }
  return uniqueIdentityRow(
    ctx.db
      .query("mediaAssets")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", normalized.sourceKey))
      .take(2),
    "Media source key",
  );
}

async function collectEventsByIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: SourceIdentity,
): Promise<Doc<"events">[]> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  const events = new Map<string, Doc<"events">>();
  if (normalized.postId) {
    for (const event of await boundedIdentityRows(
      ctx.db
        .query("events")
        .withIndex("by_instagramPostId", (q) =>
          q.eq("instagramPostId", normalized.postId),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Instagram post event matches",
    )) {
      events.set(event._id, event);
    }
  }
  if (normalized.normalizedInstagramPostUrl) {
    for (const event of await boundedIdentityRows(
      ctx.db
        .query("events")
        .withIndex("by_normalizedInstagramPostUrl", (q) =>
          q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Normalized Instagram URL event matches",
    )) {
      events.set(event._id, event);
    }
    for (const event of await boundedIdentityRows(
      ctx.db
        .query("events")
        .withIndex("by_instagramPostUrl", (q) =>
          q.eq("instagramPostUrl", normalized.normalizedInstagramPostUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Legacy Instagram URL event matches",
    )) {
      events.set(event._id, event);
    }
  }
  if (normalized.canonicalSourceUrl) {
    for (const event of await boundedIdentityRows(
      ctx.db
        .query("events")
        .withIndex("by_canonicalSourceUrl", (q) =>
          q.eq("canonicalSourceUrl", normalized.canonicalSourceUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Canonical Instagram URL event matches",
    )) {
      events.set(event._id, event);
    }
  }
  return [...events.values()];
}

async function collectScrapedPostsByIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: SourceIdentity,
): Promise<Doc<"scrapedPosts">[]> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  const posts = new Map<string, Doc<"scrapedPosts">>();
  if (normalized.postId) {
    for (const post of await boundedIdentityRows(
      ctx.db
        .query("scrapedPosts")
        .withIndex("by_postId", (q) => q.eq("postId", normalized.postId))
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Instagram post source-document matches",
    )) {
      posts.set(post._id, post);
    }
  }
  if (normalized.normalizedInstagramPostUrl) {
    for (const post of await boundedIdentityRows(
      ctx.db
        .query("scrapedPosts")
        .withIndex("by_normalizedInstagramPostUrl", (q) =>
          q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Normalized Instagram URL source-document matches",
    )) {
      posts.set(post._id, post);
    }
    for (const post of await boundedIdentityRows(
      ctx.db
        .query("scrapedPosts")
        .withIndex("by_instagramPostUrl", (q) =>
          q.eq("instagramPostUrl", normalized.normalizedInstagramPostUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Legacy Instagram URL source-document matches",
    )) {
      posts.set(post._id, post);
    }
  }
  if (normalized.canonicalSourceUrl) {
    for (const post of await boundedIdentityRows(
      ctx.db
        .query("scrapedPosts")
        .withIndex("by_canonicalSourceUrl", (q) =>
          q.eq("canonicalSourceUrl", normalized.canonicalSourceUrl),
        )
        .take(MAX_MEDIA_SOURCE_MATCHES + 1),
      "Canonical Instagram URL source-document matches",
    )) {
      posts.set(post._id, post);
    }
  }
  return [...posts.values()];
}

async function assertSourceProcessingFence(
  ctx: MutationCtx,
  fence: SourceProcessingFence | undefined,
): Promise<void> {
  if (!fence) return;
  const exact = fence.scrapedPostId ? await ctx.db.get(fence.scrapedPostId) : null;
  if (
    fence.scrapedPostId &&
    (!exact ||
      exact.handle !== fence.handle ||
      (fence.postId && exact.postId !== fence.postId) ||
      (fence.instagramPostUrl && exact.instagramPostUrl !== fence.instagramPostUrl))
  ) {
    throw new Error("Exact Instagram media processing fence identity is absent or mismatched.");
  }
  const posts = exact
    ? [exact]
    : (await collectScrapedPostsByIdentity(ctx, fence)).filter(
        (post) => post.handle === fence.handle,
      );
  if (posts.length !== 1) {
    throw new Error("Instagram media processing fence identity is absent or ambiguous.");
  }
  const source = posts[0];
  if (
    source.processingStatus !== "processing" ||
    source.processingLeaseOwner !== fence.owner ||
    (source.processingLeaseExpiresAt ?? 0) <= Date.now() ||
    !Number.isSafeInteger(fence.sourceRevision) ||
    (source.sourceRevision ?? 1) !== fence.sourceRevision
  ) {
    throw new Error("Instagram media processing fence is stale.");
  }
}

async function attachAssetToSourceRecords(
  ctx: MutationCtx,
  identity: SourceIdentity & { processingFence?: SourceProcessingFence },
  attachment: AssetAttachment,
  actor: string,
): Promise<{ attachedEventCount: number; attachedScrapedPostCount: number }> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  const [events, identityPosts] = await Promise.all([
    collectEventsByIdentity(ctx, identity),
    collectScrapedPostsByIdentity(ctx, identity),
  ]);
  const exactPost = identity.processingFence?.scrapedPostId
    ? await ctx.db.get(identity.processingFence.scrapedPostId)
    : null;
  const posts = exactPost ? [exactPost] : identityPosts;
  if (events.length === 0 && posts.length === 0) {
    throw new Error("No event or scraped-post record matches the Instagram source identity.");
  }
  const eventNeedsPatch = (event: Doc<"events">) =>
    event.imageStorageId !== attachment.storageId ||
    event.imageUrl !== attachment.url ||
    Boolean(
      normalized.normalizedInstagramPostUrl &&
        event.normalizedInstagramPostUrl !== normalized.normalizedInstagramPostUrl,
    ) ||
    Boolean(
      normalized.canonicalSourceUrl &&
        event.canonicalSourceUrl !== normalized.canonicalSourceUrl,
    );
  const postNeedsPatch = (post: Doc<"scrapedPosts">) =>
    post.imageStorageId !== attachment.storageId ||
    post.imageUrl !== attachment.url ||
    Boolean(
      normalized.normalizedInstagramPostUrl &&
        post.normalizedInstagramPostUrl !== normalized.normalizedInstagramPostUrl,
    ) ||
    Boolean(
      normalized.canonicalSourceUrl &&
        post.canonicalSourceUrl !== normalized.canonicalSourceUrl,
    );
  if (
    events.some(isCrossPostCampaignLineageEvent) &&
    (events.some(eventNeedsPatch) || posts.some(postNeedsPatch))
  ) {
    throw new Error(
      "Campaign lineage media may only change through a dedicated re-attestation operation.",
    );
  }

  let attachedEventCount = 0;
  for (const event of events) {
    const needsPatch = eventNeedsPatch(event);
    if (!needsPatch) continue;
    const patch = {
      imageStorageId: attachment.storageId,
      imageUrl: attachment.url,
      ...(normalized.normalizedInstagramPostUrl
        ? { normalizedInstagramPostUrl: normalized.normalizedInstagramPostUrl }
        : {}),
      ...(normalized.canonicalSourceUrl
        ? { canonicalSourceUrl: normalized.canonicalSourceUrl }
        : {}),
      updatedAt: nextEventUpdatedAt(event.updatedAt),
    };
    await ctx.db.patch(event._id, patch);
    await ctx.db.insert("eventAuditLog", {
      eventId: event._id,
      action: "durable_image_attached",
      actor,
      patchJson: JSON.stringify({
        imageStorageId: attachment.storageId,
        imageUrl: attachment.url,
        mediaAssetId: attachment.assetId,
        checksumSha256: attachment.checksumSha256,
        sourceKey: normalized.sourceKey,
      }),
      createdAt: Date.now(),
    });
    attachedEventCount += 1;
  }

  let attachedScrapedPostCount = 0;
  for (const post of posts) {
    const needsPatch = postNeedsPatch(post);
    if (!needsPatch) continue;
    await ctx.db.patch(post._id, {
      imageStorageId: attachment.storageId,
      imageUrl: attachment.url,
      ...(normalized.normalizedInstagramPostUrl
        ? { normalizedInstagramPostUrl: normalized.normalizedInstagramPostUrl }
        : {}),
      ...(normalized.canonicalSourceUrl
        ? { canonicalSourceUrl: normalized.canonicalSourceUrl }
        : {}),
      updatedAt: Date.now(),
    });
    attachedScrapedPostCount += 1;
  }

  // Media/source fields participate in canonical grounding. Refresh every
  // bounded event matched by this source identity after event, post and asset
  // writes are visible. A poster-v2 event may intentionally have no event-side
  // image fields, so a source-post-only attachment can still change eligibility.
  if (events.length > 0) {
    await refreshEventPublicationStates(
      ctx,
      events.map((event) => event._id),
    );
  }

  return { attachedEventCount, attachedScrapedPostCount };
}

export const findBySourceIdentity = internalQuery({
  args: sourceIdentityArgs,
  handler: async (ctx, args) => {
    await assertCoherentPersistedSourceIdentity(ctx, args);
    return findAssetByIdentity(ctx, args);
  },
});

export const claimAndAttach = internalMutation({
  args: {
    ...sourceIdentityArgs,
    storageId: v.id("_storage"),
    url: v.string(),
    upstreamUrl: v.string(),
    mimeType: v.string(),
    byteLength: v.number(),
    checksumSha256: v.string(),
    expectedChecksumSha256: v.optional(v.string()),
    actor: v.string(),
    processingFence: v.optional(sourceProcessingFenceValidator),
  },
  handler: async (ctx, args) => {
    await assertCoherentPersistedSourceIdentity(ctx, args);
    await assertSourceProcessingFence(ctx, args.processingFence);
    const normalized = normalizeInstagramMediaSourceIdentity(args);
    const existing = await findAssetByIdentity(ctx, args);
    const now = Date.now();
    const assetId = existing?._id ?? (await ctx.db.insert("mediaAssets", {
      sourceKey: normalized.sourceKey,
      sourceKind: "instagram_post",
      ...(normalized.postId ? { instagramPostId: normalized.postId } : {}),
      ...(normalized.normalizedInstagramPostUrl
        ? { normalizedInstagramPostUrl: normalized.normalizedInstagramPostUrl }
        : {}),
      ...(normalized.canonicalSourceUrl
        ? { canonicalSourceUrl: normalized.canonicalSourceUrl }
        : {}),
      storageId: args.storageId,
      url: args.url,
      upstreamUrl: args.upstreamUrl,
      mimeType: args.mimeType,
      byteLength: args.byteLength,
      checksumSha256: args.checksumSha256,
      createdAt: now,
      updatedAt: now,
      lastAttachedAt: now,
    }));
    const winner = existing ?? (await ctx.db.get(assetId));
    if (!winner) throw new Error("Media asset claim failed.");
    if (
      args.expectedChecksumSha256 &&
      winner.checksumSha256 !== args.expectedChecksumSha256
    ) {
      throw new Error(
        "Persisted Instagram image checksum does not match the analyzed poster.",
      );
    }
    const counts = await attachAssetToSourceRecords(
      ctx,
      args,
      {
        assetId,
        storageId: winner.storageId,
        url: winner.url,
        checksumSha256: winner.checksumSha256,
      },
      args.actor,
    );
    await ctx.db.patch(assetId, { lastAttachedAt: now, updatedAt: now });
    return {
      ...counts,
      assetId,
      storageId: winner.storageId,
      checksumSha256: winner.checksumSha256,
      created: !existing,
    };
  },
});

export const refreshAndAttach = internalMutation({
  args: {
    ...sourceIdentityArgs,
    assetId: v.id("mediaAssets"),
    storageId: v.id("_storage"),
    url: v.string(),
    actor: v.string(),
    processingFence: v.optional(sourceProcessingFenceValidator),
  },
  handler: async (ctx, args) => {
    await assertCoherentPersistedSourceIdentity(ctx, args);
    await assertSourceProcessingFence(ctx, args.processingFence);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.storageId !== args.storageId) {
      throw new Error("Media asset changed before attachment refresh.");
    }
    const now = Date.now();
    await ctx.db.patch(asset._id, { url: args.url, updatedAt: now, lastAttachedAt: now });
    return attachAssetToSourceRecords(
      ctx,
      args,
      {
        assetId: asset._id,
        storageId: asset.storageId,
        url: args.url,
        checksumSha256: asset.checksumSha256,
      },
      args.actor,
    );
  },
});

export const replaceMissingAndAttach = internalMutation({
  args: {
    ...sourceIdentityArgs,
    assetId: v.id("mediaAssets"),
    expectedStorageId: v.id("_storage"),
    storageId: v.id("_storage"),
    url: v.string(),
    upstreamUrl: v.string(),
    mimeType: v.string(),
    byteLength: v.number(),
    checksumSha256: v.string(),
    actor: v.string(),
    processingFence: v.optional(sourceProcessingFenceValidator),
  },
  handler: async (ctx, args) => {
    await assertCoherentPersistedSourceIdentity(ctx, args);
    await assertSourceProcessingFence(ctx, args.processingFence);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.storageId !== args.expectedStorageId) {
      throw new Error("Media asset changed before missing storage replacement.");
    }
    const now = Date.now();
    await ctx.db.patch(asset._id, {
      storageId: args.storageId,
      url: args.url,
      upstreamUrl: args.upstreamUrl,
      mimeType: args.mimeType,
      byteLength: args.byteLength,
      checksumSha256: args.checksumSha256,
      updatedAt: now,
      lastAttachedAt: now,
    });
    const counts = await attachAssetToSourceRecords(
      ctx,
      args,
      {
        assetId: asset._id,
        storageId: args.storageId,
        url: args.url,
        checksumSha256: args.checksumSha256,
      },
      args.actor,
    );
    return {
      ...counts,
      assetId: asset._id,
      checksumSha256: args.checksumSha256,
    };
  },
});

export const removeMissingAsset = internalMutation({
  args: {
    ...sourceIdentityArgs,
    assetId: v.id("mediaAssets"),
    expectedStorageId: v.id("_storage"),
    actor: v.string(),
    processingFence: v.optional(sourceProcessingFenceValidator),
  },
  handler: async (ctx, args) => {
    await assertCoherentPersistedSourceIdentity(ctx, args);
    await assertSourceProcessingFence(ctx, args.processingFence);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.storageId !== args.expectedStorageId) return false;
    const [events, identityPosts] = await Promise.all([
      collectEventsByIdentity(ctx, args),
      collectScrapedPostsByIdentity(ctx, args),
    ]);
    const exactPost = args.processingFence?.scrapedPostId
      ? await ctx.db.get(args.processingFence.scrapedPostId)
      : null;
    const posts = exactPost ? [exactPost] : identityPosts;
    if (
      events.some(isCrossPostCampaignLineageEvent) &&
      (events.some((event) => event.imageStorageId === args.expectedStorageId) ||
        posts.some((post) => post.imageStorageId === args.expectedStorageId))
    ) {
      throw new Error(
        "Campaign lineage media may only change through a dedicated re-attestation operation.",
      );
    }
    for (const event of events) {
      if (event.imageStorageId !== args.expectedStorageId) continue;
      await ctx.db.patch(event._id, {
        imageStorageId: undefined,
        imageUrl: undefined,
        updatedAt: nextEventUpdatedAt(event.updatedAt),
      });
      await ctx.db.insert("eventAuditLog", {
        eventId: event._id,
        action: "missing_durable_image_cleared",
        actor: args.actor,
        patchJson: JSON.stringify({
          imageStorageId: null,
          imageUrl: null,
          mediaAssetId: asset._id,
        }),
        createdAt: Date.now(),
      });
    }
    for (const post of posts) {
      if (post.imageStorageId === args.expectedStorageId) {
        await ctx.db.patch(post._id, {
          imageStorageId: undefined,
          imageUrl: undefined,
          updatedAt: Date.now(),
        });
      }
    }
    await ctx.db.delete(asset._id);
    if (events.length > 0) {
      await refreshEventPublicationStates(
        ctx,
        events.map((event) => event._id),
      );
    }
    return true;
  },
});

export const deleteOrphanedPage = internalMutation({
  args: {
    cutoffUpdatedAt: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const paginationOpts = assertOperationPaginationOptions(
      args.paginationOpts,
      MAX_ORPHANED_MEDIA_CLEANUP_PAGE_SIZE,
      "Orphaned-media cleanup page",
    );
    const page = await ctx.db
      .query("mediaAssets")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", args.cutoffUpdatedAt))
      .paginate(paginationOpts);
    let deletedAssetCount = 0;
    let deletedStorageObjectCount = 0;

    for (const asset of page.page) {
      const [eventReference, scrapedPostReference] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_image_storage_id", (q) => q.eq("imageStorageId", asset.storageId))
          .first(),
        ctx.db
          .query("scrapedPosts")
          .withIndex("by_image_storage_id", (q) => q.eq("imageStorageId", asset.storageId))
          .first(),
      ]);
      if (eventReference || scrapedPostReference) {
        continue;
      }

      await ctx.storage.delete(asset.storageId);
      await ctx.db.delete(asset._id);
      deletedAssetCount += 1;
      deletedStorageObjectCount += 1;
    }

    return {
      continueCursor: page.continueCursor,
      deletedAssetCount,
      deletedStorageObjectCount,
      isDone: page.isDone,
      scannedAssetCount: page.page.length,
    };
  },
});

function upstreamPriority(url: string): number {
  return new URL(url).hostname.toLowerCase() === "images.apifyusercontent.com" ? 0 : 1;
}

export const getPublicEventImageSource = query({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const eventId = ctx.db.normalizeId("events", args.eventId);
    if (!eventId) return { eventExists: false as const, kind: "none" as const };
    const event = await ctx.db.get(eventId);
    if (
      !event ||
      !(await isEventPubliclyVisible(ctx, event))
    ) {
      return { eventExists: false as const, kind: "none" as const };
    }

    const identity = {
      postId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
    };
    let asset: Doc<"mediaAssets"> | null = null;
    let posts: Doc<"scrapedPosts">[] = [];
    if (identity.postId || identity.instagramPostUrl) {
      [asset, posts] = await Promise.all([
        findAssetByIdentity(ctx, identity),
        collectScrapedPostsByIdentity(ctx, identity),
      ]);
    }

    const storageIds = [
      event.imageStorageId,
      asset?.storageId,
      ...posts.map((post) => post.imageStorageId),
    ].filter((value): value is Id<"_storage"> => value !== undefined);
    for (const storageId of [...new Set(storageIds)]) {
      const url = await ctx.storage.getUrl(storageId);
      if (url) {
        return { eventExists: true as const, kind: "stored" as const, storageId, url };
      }
    }

    const upstreamCandidates = [
      event.imageUrl,
      ...posts.flatMap((post) => [post.imageUrl, ...post.imageUrls]),
    ]
      .filter(isAllowedRemoteImageUrl)
      .sort((left, right) => upstreamPriority(left) - upstreamPriority(right));
    const upstreamUrl = [...new Set(upstreamCandidates)][0];
    if (upstreamUrl) {
      return { eventExists: true as const, kind: "upstream" as const, url: upstreamUrl };
    }
    return { eventExists: true as const, kind: "none" as const };
  },
});
