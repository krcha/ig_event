"use node";

import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";
import { normalizeInstagramMediaSourceIdentity } from "../lib/images/media-source-identity";
import { computeSha256Hex } from "../lib/images/media-checksum";
import { fetchAllowedRemoteRasterImage } from "../lib/images/remote-image-fetch";

type SourceIdentityArgs = {
  postId?: string;
  instagramPostUrl?: string;
};

type MediaAssetLookup = {
  _id: Id<"mediaAssets">;
  storageId: Id<"_storage">;
  checksumSha256: string;
};

type AttachmentCounts = {
  attachedEventCount: number;
  attachedScrapedPostCount: number;
};

type ClaimedAsset = AttachmentCounts & {
  assetId: Id<"mediaAssets">;
  storageId: Id<"_storage">;
  checksumSha256: string;
  created: boolean;
};

const findBySourceIdentity =
  "mediaAssets:findBySourceIdentity" as unknown as FunctionReference<
    "query",
    "internal",
    SourceIdentityArgs,
    MediaAssetLookup | null
  >;
const refreshAndAttach =
  "mediaAssets:refreshAndAttach" as unknown as FunctionReference<
    "mutation",
    "internal",
    SourceIdentityArgs & {
      assetId: Id<"mediaAssets">;
      storageId: Id<"_storage">;
      url: string;
      actor: string;
    },
    AttachmentCounts
  >;
const removeMissingAsset =
  "mediaAssets:removeMissingAsset" as unknown as FunctionReference<
    "mutation",
    "internal",
    SourceIdentityArgs & {
      assetId: Id<"mediaAssets">;
      expectedStorageId: Id<"_storage">;
      actor: string;
    },
    boolean
  >;
const claimAndAttach =
  "mediaAssets:claimAndAttach" as unknown as FunctionReference<
    "mutation",
    "internal",
    SourceIdentityArgs & {
      storageId: Id<"_storage">;
      url: string;
      upstreamUrl: string;
      mimeType: string;
      byteLength: number;
      checksumSha256: string;
      actor: string;
    },
    ClaimedAsset
  >;
const replaceMissingAndAttach =
  "mediaAssets:replaceMissingAndAttach" as unknown as FunctionReference<
    "mutation",
    "internal",
    SourceIdentityArgs & {
      assetId: Id<"mediaAssets">;
      expectedStorageId: Id<"_storage">;
      storageId: Id<"_storage">;
      url: string;
      upstreamUrl: string;
      mimeType: string;
      byteLength: number;
      checksumSha256: string;
      actor: string;
    },
    AttachmentCounts & { assetId: Id<"mediaAssets">; checksumSha256: string }
  >;

export const persistInstagramImage = action({
  args: {
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    upstreamUrl: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const identity = normalizeInstagramMediaSourceIdentity(args);
    const sourceArgs = {
      ...(identity.postId ? { postId: identity.postId } : {}),
      ...(identity.normalizedInstagramPostUrl
        ? { instagramPostUrl: identity.normalizedInstagramPostUrl }
        : {}),
    };

    const existing = await ctx.runQuery(findBySourceIdentity, sourceArgs);
    if (existing) {
      const currentUrl = await ctx.storage.getUrl(existing.storageId);
      if (currentUrl) {
        const counts = await ctx.runMutation(refreshAndAttach, {
          ...sourceArgs,
          assetId: existing._id,
          storageId: existing.storageId,
          url: currentUrl,
          actor: authorization.actor,
        });
        return {
          ...counts,
          assetId: existing._id,
          storageId: existing.storageId,
          url: currentUrl,
          checksumSha256: existing.checksumSha256,
          reused: true,
        };
      }
      await ctx.runMutation(removeMissingAsset, {
        ...sourceArgs,
        assetId: existing._id,
        expectedStorageId: existing.storageId,
        actor: authorization.actor,
      });
    }

    const image = await fetchAllowedRemoteRasterImage(args.upstreamUrl);
    const checksumSha256 = computeSha256Hex(image.bytes);
    const storageBytes = new Uint8Array(image.bytes.byteLength);
    storageBytes.set(image.bytes);
    let provisionalStorageId: Id<"_storage"> | null = null;
    try {
      provisionalStorageId = await ctx.storage.store(
        new Blob([storageBytes.buffer], { type: image.contentType }),
      );
      const provisionalUrl = await ctx.storage.getUrl(provisionalStorageId);
      if (!provisionalUrl) {
        throw new Error("Convex storage did not generate an image URL.");
      }

      const claim = await ctx.runMutation(claimAndAttach, {
        ...sourceArgs,
        storageId: provisionalStorageId,
        url: provisionalUrl,
        upstreamUrl: image.finalUrl,
        mimeType: image.contentType,
        byteLength: image.bytes.byteLength,
        checksumSha256,
        actor: authorization.actor,
      });

      if (claim.storageId === provisionalStorageId) {
        provisionalStorageId = null;
        return {
          attachedEventCount: claim.attachedEventCount,
          attachedScrapedPostCount: claim.attachedScrapedPostCount,
          assetId: claim.assetId,
          storageId: claim.storageId,
          url: provisionalUrl,
          checksumSha256,
          reused: false,
        };
      }

      const winnerUrl = await ctx.storage.getUrl(claim.storageId);
      if (winnerUrl) {
        await ctx.storage.delete(provisionalStorageId);
        provisionalStorageId = null;
        const counts = await ctx.runMutation(refreshAndAttach, {
          ...sourceArgs,
          assetId: claim.assetId,
          storageId: claim.storageId,
          url: winnerUrl,
          actor: authorization.actor,
        });
        return {
          ...counts,
          assetId: claim.assetId,
          storageId: claim.storageId,
          url: winnerUrl,
          checksumSha256: claim.checksumSha256,
          reused: true,
        };
      }

      const replacement = await ctx.runMutation(replaceMissingAndAttach, {
        ...sourceArgs,
        assetId: claim.assetId,
        expectedStorageId: claim.storageId,
        storageId: provisionalStorageId,
        url: provisionalUrl,
        upstreamUrl: image.finalUrl,
        mimeType: image.contentType,
        byteLength: image.bytes.byteLength,
        checksumSha256,
        actor: authorization.actor,
      });
      const replacementStorageId = provisionalStorageId;
      await ctx.storage.delete(claim.storageId).catch(() => undefined);
      provisionalStorageId = null;
      return {
        attachedEventCount: replacement.attachedEventCount,
        attachedScrapedPostCount: replacement.attachedScrapedPostCount,
        assetId: replacement.assetId,
        storageId: replacementStorageId,
        url: provisionalUrl,
        checksumSha256,
        reused: false,
      };
    } catch (error) {
      if (provisionalStorageId) {
        await ctx.storage.delete(provisionalStorageId).catch(() => undefined);
      }
      throw error;
    }
  },
});
