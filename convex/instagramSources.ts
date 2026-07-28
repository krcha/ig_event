import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import {
  isCompleteFollowingSnapshot,
  normalizeInstagramHandle,
  selectSourcesFairly,
  type InstagramSourceRole,
} from "../lib/pipeline/instagram-ingestion-durability";

const sourceRoleValidator = v.union(
  v.literal("venue"),
  v.literal("promoter"),
  v.literal("unknown"),
);

const followingAccountValidator = v.object({
  handle: v.string(),
  displayName: v.optional(v.string()),
  profileUrl: v.optional(v.string()),
  externalUrl: v.optional(v.string()),
  rawId: v.optional(v.string()),
});

function roleForLegacyVenue(venue: Doc<"venues">): InstagramSourceRole {
  return venue.publicStatus === "published" ? "venue" : "unknown";
}

function toSourceView(source: Doc<"instagramSources">, venue?: Doc<"venues"> | null) {
  return {
    _id: source._id as string | undefined,
    handle: source.handle,
    role: source.role,
    venueId: source.venueId,
    venueName: source.role === "venue" ? venue?.name : undefined,
    active: source.active,
    lastSeenFollowingAt: source.lastSeenFollowingAt,
    lastFetchAttemptAt: source.lastFetchAttemptAt,
    lastSuccessfulFetchThroughAt: source.lastSuccessfulFetchThroughAt,
    lastFetchCompletedAt: source.lastFetchCompletedAt,
    lastFetchStatus: source.lastFetchStatus,
    continuationActive: source.continuationActive,
    continuationBoundaryAt: source.continuationBoundaryAt,
    continuationResultsLimit: source.continuationResultsLimit,
    continuationReason: source.continuationReason,
    deferredAt: source.deferredAt,
  };
}

export const listActive = query({
  args: {
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const explicitSources = await ctx.db
      .query("instagramSources")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const sourcesByHandle = new Map(explicitSources.map((source) => [source.handle, source]));
    const legacyVenues = await ctx.db
      .query("venues")
      .withIndex("by_scrapeActive", (q) => q.eq("scrapeActive", true))
      .collect();
    const venueById = new Map(legacyVenues.map((venue) => [venue._id, venue]));
    const views = await Promise.all(
      explicitSources.map(async (source) => {
        const venue = source.venueId
          ? venueById.get(source.venueId) ?? (await ctx.db.get(source.venueId))
          : null;
        return toSourceView(source, venue);
      }),
    );
    for (const venue of legacyVenues) {
      for (const rawHandle of [venue.instagramHandle]) {
        const handle = normalizeInstagramHandle(rawHandle);
        if (!handle || sourcesByHandle.has(handle)) continue;
        const role = roleForLegacyVenue(venue);
        views.push({
          _id: undefined,
          handle,
          role,
          venueId: role === "venue" ? venue._id : undefined,
          venueName: role === "venue" ? venue.name : undefined,
          active: true,
          lastSeenFollowingAt: undefined,
          lastFetchAttemptAt: undefined,
          lastSuccessfulFetchThroughAt: undefined,
          lastFetchCompletedAt: undefined,
          lastFetchStatus: "legacy_fallback",
          continuationActive: undefined,
          continuationBoundaryAt: undefined,
          continuationResultsLimit: undefined,
          continuationReason: undefined,
          deferredAt: undefined,
        });
      }
    }
    return selectSourcesFairly(views, Math.max(1, Math.min(5_000, Math.trunc(args.limit ?? 5_000))));
  },
});

export const getByHandle = query({
  args: { handle: v.string(), serviceSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = normalizeInstagramHandle(args.handle);
    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!source) return null;
    return toSourceView(source, source.venueId ? await ctx.db.get(source.venueId) : null);
  },
});

export const syncFollowingSnapshot = mutation({
  args: {
    sourceHandle: v.string(),
    accounts: v.array(followingAccountValidator),
    providerSucceeded: v.boolean(),
    snapshotComplete: v.boolean(),
    rawItemCount: v.number(),
    malformedItemCount: v.number(),
    maxItems: v.number(),
    startedAt: v.number(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const sourceHandle = normalizeInstagramHandle(args.sourceHandle);
    const handles = [
      ...new Set(args.accounts.map((account) => normalizeInstagramHandle(account.handle)).filter(Boolean)),
    ];
    const validItemCount = handles.length;
    const complete =
      args.snapshotComplete &&
      isCompleteFollowingSnapshot({
        providerSucceeded: args.providerSucceeded,
        rawItemCount: Math.max(0, Math.trunc(args.rawItemCount)),
        validItemCount,
        malformedItemCount: Math.max(0, Math.trunc(args.malformedItemCount)),
        maxItems: Math.max(1, Math.trunc(args.maxItems)),
      });
    let discoveredCount = 0;
    let activatedCount = 0;
    let deactivatedCount = 0;
    const activatedHandles: string[] = [];
    const presentHandles = new Set(handles);

    for (const handle of handles) {
      const existing = await ctx.db
        .query("instagramSources")
        .withIndex("by_handle", (q) => q.eq("handle", handle))
        .unique();
      if (existing) {
        const reactivated = !existing.active;
        await ctx.db.patch(existing._id, {
          active: true,
          ...(reactivated ? { activatedAt: now, deactivatedAt: undefined } : {}),
          lastSeenFollowingAt: now,
          updatedAt: now,
        });
        if (reactivated) activatedCount += 1;
        if (reactivated) activatedHandles.push(handle);
      } else {
        await ctx.db.insert("instagramSources", {
          handle,
          role: "unknown",
          active: true,
          discoveredAt: now,
          activatedAt: now,
          lastSeenFollowingAt: now,
          createdAt: now,
          updatedAt: now,
        });
        discoveredCount += 1;
        activatedCount += 1;
        activatedHandles.push(handle);
      }
    }

    if (complete) {
      const activeSources = await ctx.db
        .query("instagramSources")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect();
      for (const source of activeSources) {
        if (presentHandles.has(source.handle)) continue;
        await ctx.db.patch(source._id, {
          active: false,
          deactivatedAt: now,
          lastFetchStatus: "deactivated_confirmed_unfollow",
          updatedAt: now,
        });
        deactivatedCount += 1;
      }
    }

    const key = `following:${sourceHandle}`;
    const existingState = await ctx.db
      .query("instagramFollowingSyncState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const state = {
      key,
      sourceHandle,
      status: complete ? ("completed" as const) : ("partial" as const),
      startedAt: args.startedAt,
      completedAt: now,
      ...(complete
        ? { lastCompleteSyncAt: now }
        : existingState?.lastCompleteSyncAt
          ? { lastCompleteSyncAt: existingState.lastCompleteSyncAt }
          : {}),
      snapshotComplete: complete,
      capped: args.rawItemCount >= args.maxItems,
      rawItemCount: Math.max(0, Math.trunc(args.rawItemCount)),
      validItemCount,
      malformedItemCount: Math.max(0, Math.trunc(args.malformedItemCount)),
      maxItems: Math.max(1, Math.trunc(args.maxItems)),
      discoveredCount,
      activatedCount,
      deactivatedCount,
      updatedAt: now,
    };
    if (existingState) {
      await ctx.db.patch(existingState._id, state);
    } else {
      await ctx.db.insert("instagramFollowingSyncState", { ...state, createdAt: now });
    }
    return {
      complete,
      capped: state.capped,
      discoveredCount,
      activatedCount,
      deactivatedCount,
      validItemCount,
      activatedHandles,
    };
  },
});

export const recordFollowingFailure = mutation({
  args: {
    sourceHandle: v.string(),
    startedAt: v.number(),
    error: v.string(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const now = Date.now();
    const sourceHandle = normalizeInstagramHandle(args.sourceHandle);
    const key = `following:${sourceHandle}`;
    const existing = await ctx.db
      .query("instagramFollowingSyncState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const state = {
      key,
      sourceHandle,
      status: "failed" as const,
      startedAt: args.startedAt,
      completedAt: now,
      ...(existing?.lastCompleteSyncAt
        ? { lastCompleteSyncAt: existing.lastCompleteSyncAt }
        : {}),
      snapshotComplete: false,
      capped: false,
      rawItemCount: 0,
      validItemCount: 0,
      malformedItemCount: 0,
      maxItems: 0,
      error: args.error.slice(0, 1_000),
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, state);
    else await ctx.db.insert("instagramFollowingSyncState", { ...state, createdAt: now });
    return { recorded: true };
  },
});

export const setRole = mutation({
  args: {
    handle: v.string(),
    role: sourceRoleValidator,
    venueId: v.optional(v.id("venues")),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = normalizeInstagramHandle(args.handle);
    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!source) throw new Error("Instagram source not found.");
    if (args.role === "venue" && !args.venueId) {
      throw new Error("A venue source requires a canonical venue mapping.");
    }
    await ctx.db.patch(source._id, {
      role: args.role,
      venueId: args.role === "venue" ? args.venueId : undefined,
      updatedAt: Date.now(),
    });
    return { updated: true };
  },
});

export const backfillFromVenues = mutation({
  args: {
    paginationOpts: paginationOptsValidator,
    dryRun: v.boolean(),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const page = await ctx.db.query("venues").paginate(args.paginationOpts);
    const now = Date.now();
    let examined = 0;
    let inserted = 0;
    let alreadyPresent = 0;
    const proposals: Array<{
      handle: string;
      role: InstagramSourceRole;
      venueId?: Id<"venues">;
    }> = [];
    for (const venue of page.page) {
      for (const rawHandle of [venue.instagramHandle]) {
        const handle = normalizeInstagramHandle(rawHandle);
        if (!handle) continue;
        examined += 1;
        const existing = await ctx.db
          .query("instagramSources")
          .withIndex("by_handle", (q) => q.eq("handle", handle))
          .unique();
        if (existing) {
          alreadyPresent += 1;
          continue;
        }
        const role = roleForLegacyVenue(venue);
        const proposal = {
          handle,
          role,
          ...(role === "venue" ? { venueId: venue._id } : {}),
        };
        proposals.push(proposal);
        if (!args.dryRun) {
          await ctx.db.insert("instagramSources", {
            ...proposal,
            active: venue.scrapeActive === true,
            discoveredAt: now,
            activatedAt: now,
            ...(venue.scrapeActive === true ? {} : { deactivatedAt: now }),
            createdAt: now,
            updatedAt: now,
          });
          inserted += 1;
        }
      }
    }
    return {
      dryRun: args.dryRun,
      examined,
      inserted,
      alreadyPresent,
      proposals: proposals.slice(0, 100),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
