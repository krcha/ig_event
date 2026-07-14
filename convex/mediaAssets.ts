import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { fetchTrustedEventImage } from "../lib/images/trusted-event-images";

const MAX_SOURCE_KEY_LENGTH = 512;
const MAX_CANDIDATES = 10;

type StoredMediaAsset = {
  storageId: Id<"_storage">;
  url: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  sourceHost: string;
};

function normalizeSourceKey(value: string): string {
  const sourceKey = value.trim();
  if (!sourceKey || sourceKey.length > MAX_SOURCE_KEY_LENGTH) {
    throw new Error(`Media source key must be 1-${MAX_SOURCE_KEY_LENGTH} characters.`);
  }
  return sourceKey;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const getBySourceKey = internalQuery({
  args: { sourceKey: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("mediaAssets")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", args.sourceKey))
      .first(),
});

export const recordStoredAsset = internalMutation({
  args: {
    sourceKey: v.string(),
    storageId: v.id("_storage"),
    url: v.string(),
    contentType: v.string(),
    byteLength: v.number(),
    sha256: v.string(),
    sourceHost: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mediaAssets")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", args.sourceKey))
      .first();
    if (existing) return existing;

    const now = Date.now();
    const id = await ctx.db.insert("mediaAssets", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.get(id);
  },
});

export const refreshStoredAssetUrl = internalMutation({
  args: {
    id: v.id("mediaAssets"),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;
    await ctx.db.patch(args.id, { url: args.url, updatedAt: Date.now() });
    return { ...existing, url: args.url };
  },
});

export const deleteStoredAssetMetadata = internalMutation({
  args: { id: v.id("mediaAssets") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (existing) await ctx.db.delete(args.id);
  },
});

async function attachStoredAsset(
  ctx: ActionCtx,
  args: {
    handle: string;
    instagramPostId?: string;
    instagramPostUrl: string;
  },
  asset: StoredMediaAsset,
): Promise<void> {
  const attachment = {
    imageStorageId: asset.storageId,
    imageUrl: asset.url,
    ...(args.instagramPostId ? { instagramPostId: args.instagramPostId } : {}),
    instagramPostUrl: args.instagramPostUrl,
  };
  await Promise.all([
    ctx.runMutation(internal.events.attachStoredImageToSource, attachment),
    ctx.runMutation(internal.scrapedPosts.attachStoredImageToSource, {
      ...attachment,
      handle: args.handle,
    }),
  ]);
}

export const pruneOrphanedAssets = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
    minAgeMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(50, Math.floor(args.batchSize ?? 25)));
    const minAgeMs = Math.max(24 * 60 * 60 * 1_000, args.minAgeMs ?? 7 * 24 * 60 * 60 * 1_000);
    const cutoff = Date.now() - minAgeMs;
    const candidates = await ctx.db
      .query("mediaAssets")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", cutoff))
      .take(batchSize);

    let deletedCount = 0;
    for (const asset of candidates) {
      const [eventReference, scrapedPostReference] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_imageStorageId", (q) => q.eq("imageStorageId", asset.storageId))
          .first(),
        ctx.db
          .query("scrapedPosts")
          .withIndex("by_imageStorageId", (q) => q.eq("imageStorageId", asset.storageId))
          .first(),
      ]);
      if (eventReference || scrapedPostReference) {
        await ctx.db.patch(asset._id, { updatedAt: Date.now() });
        continue;
      }

      await ctx.storage.delete(asset.storageId);
      await ctx.db.delete(asset._id);
      deletedCount += 1;
    }

    return { checkedCount: candidates.length, deletedCount };
  },
});

export const persistInstagramImage = action({
  args: {
    candidates: v.array(v.string()),
    handle: v.string(),
    instagramPostId: v.optional(v.string()),
    instagramPostUrl: v.string(),
    serviceSecret: v.optional(v.string()),
    sourceKey: v.string(),
  },
  handler: async (ctx, args): Promise<StoredMediaAsset> => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const sourceKey = normalizeSourceKey(args.sourceKey);
    const handle = args.handle.trim().replace(/^@+/, "").toLowerCase();
    if (!handle) throw new Error("Instagram handle is required for media persistence.");

    const existing = await ctx.runQuery(internal.mediaAssets.getBySourceKey, { sourceKey });
    if (existing) {
      const currentUrl = await ctx.storage.getUrl(existing.storageId);
      if (currentUrl) {
        const refreshed = currentUrl === existing.url
          ? existing
          : await ctx.runMutation(internal.mediaAssets.refreshStoredAssetUrl, {
              id: existing._id,
              url: currentUrl,
            });
        if (!refreshed) throw new Error("Stored image metadata could not be refreshed.");
        const asset: StoredMediaAsset = {
          storageId: refreshed.storageId,
          url: refreshed.url,
          contentType: refreshed.contentType,
          byteLength: refreshed.byteLength,
          sha256: refreshed.sha256,
          sourceHost: refreshed.sourceHost,
        };
        await attachStoredAsset(ctx, { ...args, handle }, asset);
        return asset;
      }
      await ctx.runMutation(internal.mediaAssets.deleteStoredAssetMetadata, {
        id: existing._id,
      });
    }

    const candidates = [...new Set(args.candidates.map((value) => value.trim()).filter(Boolean))]
      .slice(0, MAX_CANDIDATES);
    let lastError = "No image candidates were supplied.";

    for (const candidate of candidates) {
      try {
        const fetched = await fetchTrustedEventImage(candidate);
        const sha256 = await sha256Hex(fetched.bytes);
        const storageId = await ctx.storage.store(
          new Blob([toArrayBuffer(fetched.bytes)], { type: fetched.contentType }),
        );
        const url = await ctx.storage.getUrl(storageId);
        if (!url) {
          await ctx.storage.delete(storageId);
          throw new Error("Stored image URL could not be generated.");
        }

        const recorded = await ctx.runMutation(internal.mediaAssets.recordStoredAsset, {
          sourceKey,
          storageId,
          url,
          contentType: fetched.contentType,
          byteLength: fetched.bytes.byteLength,
          sha256,
          sourceHost: new URL(fetched.finalUrl).hostname.toLowerCase(),
        });
        if (!recorded) {
          await ctx.storage.delete(storageId);
          throw new Error("Stored image metadata could not be recorded.");
        }
        if (recorded.storageId !== storageId) {
          await ctx.storage.delete(storageId);
        }

        const asset: StoredMediaAsset = {
          storageId: recorded.storageId,
          url: recorded.url,
          contentType: recorded.contentType,
          byteLength: recorded.byteLength,
          sha256: recorded.sha256,
          sourceHost: recorded.sourceHost,
        };
        await attachStoredAsset(ctx, { ...args, handle }, asset);
        return asset;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Image persistence failed.";
      }
    }

    throw new Error(`No trusted image candidate could be persisted: ${lastError}`);
  },
});
