import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const scrapedPostRecord = {
  handle: v.string(),
  postId: v.string(),
  caption: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageUrls: v.array(v.string()),
  postType: v.optional(v.string()),
  locationName: v.optional(v.string()),
  instagramPostUrl: v.string(),
  postedAt: v.optional(v.string()),
  username: v.string(),
};

export const listByHandle = query({
  args: {
    handle: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .collect();
  },
});

export const upsertManyByHandle = mutation({
  args: {
    handle: v.string(),
    posts: v.array(v.object(scrapedPostRecord)),
  },
  handler: async (ctx, args) => {
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
