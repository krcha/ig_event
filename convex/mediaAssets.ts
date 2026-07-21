import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { normalizeInstagramMediaSourceIdentity } from "../lib/images/media-source-identity";
import { isAllowedRemoteImageUrl } from "../lib/images/remote-image-policy";

const sourceIdentityArgs = {
  postId: v.optional(v.string()),
  instagramPostUrl: v.optional(v.string()),
};

type SourceIdentity = {
  postId?: string;
  instagramPostUrl?: string;
};

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
    const byPostId = await ctx.db
      .query("mediaAssets")
      .withIndex("by_instagramPostId", (q) => q.eq("instagramPostId", normalized.postId))
      .first();
    if (byPostId) return byPostId;
  }
  if (normalized.normalizedInstagramPostUrl) {
    const byPostUrl = await ctx.db
      .query("mediaAssets")
      .withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
      )
      .first();
    if (byPostUrl) return byPostUrl;
  }
  return ctx.db
    .query("mediaAssets")
    .withIndex("by_sourceKey", (q) => q.eq("sourceKey", normalized.sourceKey))
    .first();
}

async function collectEventsByIdentity(
  ctx: QueryCtx | MutationCtx,
  identity: SourceIdentity,
): Promise<Doc<"events">[]> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  const events = new Map<string, Doc<"events">>();
  if (normalized.postId) {
    for (const event of await ctx.db
      .query("events")
      .withIndex("by_instagramPostId", (q) => q.eq("instagramPostId", normalized.postId))
      .collect()) {
      events.set(event._id, event);
    }
  }
  if (normalized.normalizedInstagramPostUrl) {
    for (const event of await ctx.db
      .query("events")
      .withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
      )
      .collect()) {
      events.set(event._id, event);
    }
    for (const event of await ctx.db
      .query("events")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", normalized.normalizedInstagramPostUrl),
      )
      .collect()) {
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
    for (const post of await ctx.db
      .query("scrapedPosts")
      .withIndex("by_postId", (q) => q.eq("postId", normalized.postId))
      .collect()) {
      posts.set(post._id, post);
    }
  }
  if (normalized.normalizedInstagramPostUrl) {
    for (const post of await ctx.db
      .query("scrapedPosts")
      .withIndex("by_normalizedInstagramPostUrl", (q) =>
        q.eq("normalizedInstagramPostUrl", normalized.normalizedInstagramPostUrl),
      )
      .collect()) {
      posts.set(post._id, post);
    }
    for (const post of await ctx.db
      .query("scrapedPosts")
      .withIndex("by_instagramPostUrl", (q) =>
        q.eq("instagramPostUrl", normalized.normalizedInstagramPostUrl),
      )
      .collect()) {
      posts.set(post._id, post);
    }
  }
  return [...posts.values()];
}

async function attachAssetToSourceRecords(
  ctx: MutationCtx,
  identity: SourceIdentity,
  attachment: AssetAttachment,
  actor: string,
): Promise<{ attachedEventCount: number; attachedScrapedPostCount: number }> {
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  const [events, posts] = await Promise.all([
    collectEventsByIdentity(ctx, identity),
    collectScrapedPostsByIdentity(ctx, identity),
  ]);
  if (events.length === 0 && posts.length === 0) {
    throw new Error("No event or scraped-post record matches the Instagram source identity.");
  }

  let attachedEventCount = 0;
  for (const event of events) {
    const needsPatch =
      event.imageStorageId !== attachment.storageId ||
      event.imageUrl !== attachment.url ||
      (normalized.normalizedInstagramPostUrl &&
        event.normalizedInstagramPostUrl !== normalized.normalizedInstagramPostUrl);
    if (!needsPatch) continue;
    const patch = {
      imageStorageId: attachment.storageId,
      imageUrl: attachment.url,
      ...(normalized.normalizedInstagramPostUrl
        ? { normalizedInstagramPostUrl: normalized.normalizedInstagramPostUrl }
        : {}),
      updatedAt: Date.now(),
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
    const needsPatch =
      post.imageStorageId !== attachment.storageId ||
      post.imageUrl !== attachment.url ||
      (normalized.normalizedInstagramPostUrl &&
        post.normalizedInstagramPostUrl !== normalized.normalizedInstagramPostUrl);
    if (!needsPatch) continue;
    await ctx.db.patch(post._id, {
      imageStorageId: attachment.storageId,
      imageUrl: attachment.url,
      ...(normalized.normalizedInstagramPostUrl
        ? { normalizedInstagramPostUrl: normalized.normalizedInstagramPostUrl }
        : {}),
      updatedAt: Date.now(),
    });
    attachedScrapedPostCount += 1;
  }

  return { attachedEventCount, attachedScrapedPostCount };
}

export const findBySourceIdentity = internalQuery({
  args: sourceIdentityArgs,
  handler: async (ctx, args) => findAssetByIdentity(ctx, args),
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
    actor: v.string(),
  },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.storageId !== args.expectedStorageId) return false;
    const [events, posts] = await Promise.all([
      collectEventsByIdentity(ctx, args),
      collectScrapedPostsByIdentity(ctx, args),
    ]);
    for (const event of events) {
      if (event.imageStorageId !== args.expectedStorageId) continue;
      await ctx.db.patch(event._id, {
        imageStorageId: undefined,
        imageUrl: undefined,
        updatedAt: Date.now(),
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
    return true;
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
    if (!event || event.status !== "approved") {
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
