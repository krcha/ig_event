import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";

const DEFAULT_PUBLIC_RECENT_POST_LIMIT = 6;
const MAX_PUBLIC_RECENT_POST_LIMIT = 12;

const scrapedPostRecord = {
  handle: v.string(),
  postId: v.string(),
  caption: v.optional(v.string()),
  altText: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageStorageId: v.optional(v.id("_storage")),
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

function parsePostedAtMs(postedAt: string | undefined): number | undefined {
  if (!postedAt) {
    return undefined;
  }

  const parsed = Date.parse(postedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePublicRecentPostLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PUBLIC_RECENT_POST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PUBLIC_RECENT_POST_LIMIT, Math.trunc(value as number)));
}

export const listByHandle = query({
  args: {
    handle: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .collect();
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
      imageUrl: post.imageUrl,
      instagramPostUrl: post.instagramPostUrl,
      locationName: post.locationName,
      postType: post.postType,
      postedAt: post.postedAt,
      postedAtMs: post.postedAtMs,
    }));
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
      .paginate(args.paginationOpts);
  },
});

export const getManyByIds = query({
  args: {
    ids: v.array(v.id("scrapedPosts")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const uniqueIds = [...new Set(args.ids)];
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
            .withIndex("by_handle_postId", (q) =>
              q.eq("handle", ref.handle).eq("postId", ref.postId as string),
            )
            .first();
          if (byPostId) {
            return {
              caption: byPostId.caption,
              imageUrl: byPostId.imageUrl,
              imageStorageId: byPostId.imageStorageId,
              imageUrls: byPostId.imageUrls,
              instagramPostUrl: byPostId.instagramPostUrl,
              postId: byPostId.postId,
            };
          }
        }

        if (ref.instagramPostUrl) {
          const byPostUrl = await ctx.db
            .query("scrapedPosts")
            .withIndex("by_handle_postUrl", (q) =>
              q
                .eq("handle", ref.handle)
                .eq("instagramPostUrl", ref.instagramPostUrl as string),
            )
            .first();
          if (byPostUrl) {
            return {
              caption: byPostUrl.caption,
              imageUrl: byPostUrl.imageUrl,
              imageStorageId: byPostUrl.imageStorageId,
              imageUrls: byPostUrl.imageUrls,
              instagramPostUrl: byPostUrl.instagramPostUrl,
              postId: byPostUrl.postId,
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
        return byPostId[0];
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
      return byPostUrl[0] ?? null;
    }

    return null;
  },
});

export const attachStoredImageToSource = internalMutation({
  args: {
    handle: v.string(),
    imageStorageId: v.id("_storage"),
    imageUrl: v.string(),
    instagramPostId: v.optional(v.string()),
    instagramPostUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const matches = new Map<Id<"scrapedPosts">, Doc<"scrapedPosts">>();
    if (args.instagramPostId) {
      const byPostId = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postId", (q) =>
          q.eq("handle", args.handle).eq("postId", args.instagramPostId as string),
        )
        .collect();
      for (const post of byPostId) matches.set(post._id, post);
    }
    const byUrl = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postUrl", (q) =>
        q.eq("handle", args.handle).eq("instagramPostUrl", args.instagramPostUrl),
      )
      .collect();
    for (const post of byUrl) matches.set(post._id, post);

    const now = Date.now();
    let updatedCount = 0;
    for (const post of matches.values()) {
      if (post.imageStorageId === args.imageStorageId && post.imageUrl === args.imageUrl) {
        continue;
      }
      await ctx.db.patch(post._id, {
        imageStorageId: args.imageStorageId,
        imageUrl: args.imageUrl,
        imageUrls: [args.imageUrl],
        updatedAt: now,
      });
      updatedCount += 1;
    }
    return { matchedCount: matches.size, updatedCount };
  },
});

export const upsertManyByHandle = mutation({
  args: {
    handle: v.string(),
    posts: v.array(v.object(scrapedPostRecord)),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();

    for (const post of args.posts) {
      const existingByPostId = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_handle_postId", (q) =>
          q.eq("handle", args.handle).eq("postId", post.postId),
        )
        .take(1);

      const existingByUrl =
        existingByPostId[0] ??
        (await ctx.db
          .query("scrapedPosts")
          .withIndex("by_handle_postUrl", (q) =>
            q.eq("handle", args.handle).eq("instagramPostUrl", post.instagramPostUrl),
          )
          .take(1))[0];

      const nextRecord = {
        ...post,
        handle: args.handle,
        postedAtMs: parsePostedAtMs(post.postedAt),
        sourceKey: getSourceKey({ ...post, handle: args.handle }),
        ...(post.imageUrl !== undefined && post.imageStorageId === undefined
          ? { imageStorageId: undefined }
          : {}),
        updatedAt: now,
      };

      if (existingByUrl) {
        await ctx.db.patch(existingByUrl._id, nextRecord);
      } else {
        await ctx.db.insert("scrapedPosts", {
          ...nextRecord,
          createdAt: now,
        });
      }
    }
  },
});

export const deleteOlderThan = internalMutation({
  args: {
    cutoffUpdatedAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 100)));
    const posts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", args.cutoffUpdatedAt))
      .take(limit);
    const deletedIds: Id<"scrapedPosts">[] = [];

    for (const post of posts) {
      await ctx.db.delete(post._id);
      deletedIds.push(post._id);
    }

    return {
      deletedCount: deletedIds.length,
      deletedIds,
      hasMore: posts.length === limit,
    };
  },
});
