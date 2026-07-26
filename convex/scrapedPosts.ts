import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireAdminOrServiceSecret } from "./authz";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";

const DEFAULT_PUBLIC_RECENT_POST_LIMIT = 6;
const MAX_PUBLIC_RECENT_POST_LIMIT = 12;
const processingStatusValidator = v.union(
  v.literal("completed"),
  v.literal("retryable_failure"),
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
      .paginate(args.paginationOpts);
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
      .paginate(args.paginationOpts);
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
            .withIndex("by_handle_postUrl", (q) =>
              q
                .eq("handle", ref.handle)
                .eq("instagramPostUrl", ref.instagramPostUrl as string),
            )
            .first();
          const normalizedInstagramPostUrl = normalizeInstagramPostUrl(ref.instagramPostUrl);
          const matchedPost =
            byPostUrl ??
            (normalizedInstagramPostUrl
              ? await ctx.db
                  .query("scrapedPosts")
                  .withIndex("by_normalizedInstagramPostUrl", (q) =>
                    q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
                  )
                  .filter((q) => q.eq(q.field("handle"), ref.handle))
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
        return {
          ...byPostId[0],
          imageUrl: byPostId[0].imageStorageId ? byPostId[0].imageUrl : undefined,
          imageUrls: byPostId[0].imageStorageId ? byPostId[0].imageUrls : [],
        };
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
      return byPostUrl[0]
        ? {
            ...byPostUrl[0],
            imageUrl: byPostUrl[0].imageStorageId ? byPostUrl[0].imageUrl : undefined,
            imageUrls: byPostUrl[0].imageStorageId ? byPostUrl[0].imageUrls : [],
          }
        : null;
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
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const paidFetchControl = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    const activePaidFetchOwner =
      (paidFetchControl?.leaseExpiresAt ?? 0) > now ? paidFetchControl?.leaseOwner : undefined;
    const suppliedFetchOwner = args.fetchLeaseOwner?.trim().slice(0, 200);
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

      const normalizedInstagramPostUrl = normalizeInstagramPostUrl(post.instagramPostUrl);
      const existingByNormalizedUrl =
        existingByPostId[0] || existingByUrl || !normalizedInstagramPostUrl
          ? null
          : await ctx.db
              .query("scrapedPosts")
              .withIndex("by_normalizedInstagramPostUrl", (q) =>
                q.eq("normalizedInstagramPostUrl", normalizedInstagramPostUrl),
              )
              .filter((q) => q.eq(q.field("handle"), args.handle))
              .first();

      const existing = existingByUrl ?? existingByNormalizedUrl;
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
      const nextRecord = {
        ...postWithoutPrimaryImage,
        ...(effectivePostedAt && effectivePostedAtMs !== undefined
          ? { postedAt: effectivePostedAt, postedAtMs: effectivePostedAtMs }
          : {}),
        imageUrls,
        handle: args.handle,
        sourceKey: getSourceKey({ ...post, handle: args.handle }),
        normalizedInstagramPostUrl,
        updatedAt: now,
      };

      if (existing) {
        const hasSourceContentChanged =
          (post.caption !== undefined && post.caption !== existing.caption) ||
          (post.altText !== undefined && post.altText !== existing.altText) ||
          (post.postType !== undefined && post.postType !== existing.postType) ||
          (post.locationName !== undefined && post.locationName !== existing.locationName) ||
          (effectivePostedAt !== undefined && effectivePostedAt !== existing.postedAt);
        await ctx.db.patch(existing._id, {
          ...nextRecord,
          sourceRevision: hasSourceContentChanged
            ? (existing.sourceRevision ?? 1) + 1
            : (existing.sourceRevision ?? 1),
          blocksPaidFetch: hasSourceContentChanged ? true : (existing.blocksPaidFetch ?? true),
          imageUrl: hasDurableImage ? existing.imageUrl : undefined,
          imageStorageId: hasDurableImage ? existing.imageStorageId : undefined,
          ...(hasSourceContentChanged
            ? {
                processingStatus: "pending" as const,
                processingOutcome: undefined,
                processingError: undefined,
                processingLeaseOwner: undefined,
                processingLeaseExpiresAt: undefined,
              }
            : {}),
        });
      } else {
        await ctx.db.insert("scrapedPosts", {
          ...nextRecord,
          sourceRevision: 1,
          blocksPaidFetch: true,
          processingStatus: "pending",
          processingAttempts: 0,
          createdAt: now,
        });
      }
    }
  },
});

export const claimProcessing = mutation({
  args: {
    handle: v.string(),
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    owner: v.string(),
    leaseMs: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existingByPostId = args.postId
      ? await ctx.db
          .query("scrapedPosts")
          .withIndex("by_handle_postId", (q) =>
            q.eq("handle", args.handle).eq("postId", args.postId as string),
          )
          .first()
      : null;
    const existing =
      existingByPostId ??
      (args.instagramPostUrl
        ? await ctx.db
            .query("scrapedPosts")
            .withIndex("by_handle_postUrl", (q) =>
              q
                .eq("handle", args.handle)
                .eq("instagramPostUrl", args.instagramPostUrl as string),
            )
            .first()
        : null);
    if (!existing) {
      throw new Error("Cannot claim processing for an unknown scraped post.");
    }
    if (
      existing.processingStatus === "completed" &&
      ["terminal_no_event", "receipt_complete"].includes(existing.processingOutcome ?? "")
    ) {
      return { claimed: false, reason: "terminal" as const };
    }
    const now = Date.now();
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
      lastProcessedAt: now,
    });
    return {
      claimed: true,
      reason: "claimed" as const,
      sourceRevision: existing.sourceRevision ?? 1,
    };
  },
});

export const getBacklogStateByHandle = query({
  args: {
    handle: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const posts = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .collect();
    const now = Date.now();
    let actionable = 0;
    let busy = 0;
    for (const post of posts) {
      if (
        post.processingStatus === "completed" &&
        ["terminal_no_event", "receipt_complete"].includes(post.processingOutcome ?? "")
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
    const result = await ctx.db.query("scrapedPosts").paginate(args.paginationOpts);
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
    let updated = 0;
    for (const id of [...new Set(args.ids)].slice(0, 100)) {
      const post = await ctx.db.get(id);
      if (!post || post.blocksPaidFetch !== undefined) continue;
      const isTerminal =
        post.processingStatus === "completed" &&
        ["terminal_no_event", "receipt_complete"].includes(post.processingOutcome ?? "");
      await ctx.db.patch(id, { blocksPaidFetch: !isTerminal });
      updated += 1;
    }
    return { updated };
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
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = args.handle.trim().replace(/^@+/, "").toLocaleLowerCase();
    const owner = args.owner.trim().slice(0, 200);
    if (!handle || !owner) return { claimed: false, reason: "invalid" as const };
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (!control?.backlogIndexReady) {
      return { claimed: false, reason: "backlog_index_not_ready" as const };
    }
    const blocker = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_blocksPaidFetch", (q) => q.eq("blocksPaidFetch", true))
      .first();
    if (blocker) {
      return { claimed: false, reason: "saved_backlog_present" as const };
    }
    const now = Date.now();
    if (
      (control.leaseExpiresAt ?? 0) > now &&
      control.leaseOwner &&
      control.leaseOwner !== owner
    ) {
      return { claimed: false, reason: "busy" as const };
    }
    const boundaryCandidates = await ctx.db
      .query("scrapedPosts")
      .withIndex("by_handle_postedAtMs", (q) => q.eq("handle", handle))
      .order("desc")
      .take(25);
    const latestAllowedMs = now + 5 * 60_000;
    const boundaryPost = boundaryCandidates.find(
      (post) =>
        typeof post.postedAtMs === "number" &&
        post.postedAtMs > 0 &&
        post.postedAtMs <= latestAllowedMs,
    );
    const onlyPostsNewerThan = boundaryPost
      ? new Date(boundaryPost.postedAtMs as number).toISOString()
      : null;
    const boundaryKey = onlyPostsNewerThan ?? "__none__";
    let fetchState = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (fetchState && fetchState.boundaryKey !== boundaryKey) {
      await ctx.db.delete(fetchState._id);
      fetchState = null;
    }
    if (fetchState?.hardBlocked) {
      return {
        claimed: false,
        reason: "hard_cap_saturated" as const,
        boundaryKey,
        resultsLimit: fetchState.nextResultsLimit,
      };
    }
    const requestedResultsLimit = Math.max(
      1,
      Math.min(20, Math.trunc(args.requestedResultsLimit ?? 3)),
    );
    const resultsLimit = Math.max(requestedResultsLimit, fetchState?.nextResultsLimit ?? 0);
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
      updatedAt: now,
    });
    return {
      claimed: true,
      reason: "claimed" as const,
      onlyPostsNewerThan,
      boundaryKey,
      resultsLimit,
      expiresAt: leaseExpiresAt,
    };
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
    const requested = control.leaseResultsLimit ?? 3;
    if (args.rawItemCount < requested) {
      throw new Error("Raw result count does not saturate the claimed fetch window.");
    }
    const nextResultsLimit = requested >= 20 ? 20 : requested < 6 ? 6 : requested < 12 ? 12 : 20;
    const hardBlocked = requested >= 20;
    const now = Date.now();
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
    return { recorded: true, nextResultsLimit, hardBlocked };
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
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (!control || control.leaseOwner !== owner || control.leaseHandle !== handle) {
      throw new Error("Cannot record success from a stale paid-fetch lease.");
    }
    const existing = await ctx.db
      .query("instagramHandleFetchStates")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (existing && existing.boundaryKey === (control.leaseBoundaryKey ?? "__none__")) {
      await ctx.db.delete(existing._id);
    }
    return { recorded: true };
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
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const control = await ctx.db
      .query("instagramPaidFetchControl")
      .withIndex("by_key", (q) => q.eq("key", "apify"))
      .unique();
    if (!control || control.leaseOwner !== args.owner.trim().slice(0, 200)) {
      return { released: false };
    }
    await ctx.db.patch(control._id, {
      leaseOwner: undefined,
      leaseHandle: undefined,
      leaseExpiresAt: undefined,
      leaseBoundaryKey: undefined,
      leaseResultsLimit: undefined,
      updatedAt: Date.now(),
    });
    return { released: true };
  },
});

export const claimProviderLease = mutation({
  args: {
    provider: v.string(),
    owner: v.string(),
    leaseMs: v.optional(v.number()),
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
    if (existing?.blockedAt) {
      return {
        claimed: false,
        reason: "provider_blocked" as const,
        blockedStatus: existing.blockedStatus,
        blockedCode: existing.blockedCode,
      };
    }
    if (existing && existing.leaseExpiresAt > now && existing.owner !== owner) {
      return { claimed: false, reason: "busy" as const };
    }
    const leaseMs = Math.max(30_000, Math.min(10 * 60_000, Math.trunc(args.leaseMs ?? 180_000)));
    if (existing) {
      await ctx.db.patch(existing._id, {
        owner,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("ingestionProviderLeases", {
        provider,
        owner,
        leaseExpiresAt: now + leaseMs,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { claimed: true, reason: "claimed" as const };
  },
});

export const blockProvider = mutation({
  args: {
    provider: v.string(),
    owner: v.string(),
    status: v.number(),
    code: v.optional(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const provider = args.provider.trim().toLocaleLowerCase();
    const existing = await ctx.db
      .query("ingestionProviderLeases")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (!existing || existing.owner !== args.owner.trim().slice(0, 200)) {
      throw new Error("Cannot block a provider from a stale execution lease.");
    }
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      blockedAt: now,
      blockedStatus: Math.trunc(args.status),
      blockedCode: args.code?.slice(0, 160),
      leaseExpiresAt: now,
      updatedAt: now,
    });
    return { blocked: true };
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
    if (existing && existing.owner === args.owner.trim().slice(0, 200) && !existing.blockedAt) {
      await ctx.db.delete(existing._id);
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
    postId: v.optional(v.string()),
    instagramPostUrl: v.optional(v.string()),
    status: processingStatusValidator,
    outcome: v.string(),
    error: v.optional(v.string()),
    owner: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const existingByPostId = args.postId
      ? await ctx.db
          .query("scrapedPosts")
          .withIndex("by_handle_postId", (q) =>
            q.eq("handle", args.handle).eq("postId", args.postId as string),
          )
          .first()
      : null;
    const existing =
      existingByPostId ??
      (args.instagramPostUrl
        ? await ctx.db
            .query("scrapedPosts")
            .withIndex("by_handle_postUrl", (q) =>
              q
                .eq("handle", args.handle)
                .eq("instagramPostUrl", args.instagramPostUrl as string),
            )
            .first()
        : null);
    if (!existing) {
      throw new Error("Cannot record processing state for an unknown scraped post.");
    }
    if (existing.processingLeaseOwner !== args.owner) {
      throw new Error("Cannot record processing result from a stale lease owner.");
    }
    const isExplicitTerminal =
      args.status === "completed" &&
      ["terminal_no_event", "receipt_complete"].includes(args.outcome);
    if (args.status === "completed" && !isExplicitTerminal) {
      throw new Error("Completed scraped-post processing requires an explicit terminal outcome.");
    }

    await ctx.db.patch(existing._id, {
      processingStatus: args.status,
      blocksPaidFetch: !isExplicitTerminal,
      processingOutcome: args.outcome.slice(0, 160),
      processingError: args.error?.slice(0, 1_000),
      processingLeaseOwner: undefined,
      processingLeaseExpiresAt: undefined,
      lastProcessedAt: Date.now(),
    });
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
