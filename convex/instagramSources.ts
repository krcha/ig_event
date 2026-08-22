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
    updatedAt: source.updatedAt,
  };
}

export const listActive = query({
  args: {
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const limit = Math.max(1, Math.min(5_000, Math.trunc(args.limit ?? 5_000)));
    const explicitSources = await ctx.db
      .query("instagramSources")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(limit + 1);
    if (explicitSources.length > limit) {
      throw new Error(
        `Legacy active-source query exceeded its fail-closed limit of ${limit}; use paginated source queries.`,
      );
    }
    const sourcesByHandle = new Map(explicitSources.map((source) => [source.handle, source]));
    const legacyVenues = await ctx.db
      .query("venues")
      .withIndex("by_scrapeActive", (q) => q.eq("scrapeActive", true))
      .take(limit + 1);
    if (legacyVenues.length > limit) {
      throw new Error(
        `Legacy venue-source query exceeded its fail-closed limit of ${limit}; use paginated source queries.`,
      );
    }
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
          updatedAt: venue.updatedAt,
        });
      }
    }
    if (views.length > limit) {
      throw new Error(
        `Legacy combined active-source query exceeded its fail-closed limit of ${limit}; use paginated source queries.`,
      );
    }
    return selectSourcesFairly(views, limit);
  },
});

export const listActiveSourcesPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("instagramSources")
      .withIndex("by_active", (q) => q.eq("active", true))
      .paginate(args.paginationOpts);
    // This compatibility surface intentionally omits venue joins. Callers that
    // need venue context must use the bounded handle-targeted query below rather
    // than multiplying one document read per source on every pagination pass.
    const page = result.page.map((source) => toSourceView(source));
    return { ...result, page };
  },
});

export const listActiveSourceHandlesPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("instagramSources")
      .withIndex("by_active", (q) => q.eq("active", true))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((source) => source.handle),
    };
  },
});

export const listLegacyVenueSourcesPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("venues")
      .withIndex("by_scrapeActive", (q) => q.eq("scrapeActive", true))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.flatMap((venue) => {
        const handle = normalizeInstagramHandle(venue.instagramHandle);
        if (!handle) return [];
        const role = roleForLegacyVenue(venue);
        return [{
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
        }];
      }),
    };
  },
});

export const listLegacyVenueHandlesPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("venues")
      .withIndex("by_scrapeActive", (q) => q.eq("scrapeActive", true))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .map((venue) => normalizeInstagramHandle(venue.instagramHandle))
        .filter(Boolean),
    };
  },
});

export const listFreshFetchAttemptMetadataPage = query({
  args: {
    minAttemptAt: v.number(),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await ctx.db
      .query("instagramSources")
      .withIndex("by_active_lastFetchAttemptAt", (q) =>
        q.eq("active", true).gte("lastFetchAttemptAt", args.minAttemptAt),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((source) => ({
        handle: source.handle,
        lastFetchAttemptAt: source.lastFetchAttemptAt,
      })),
    };
  },
});

export const listFreshFetchAttemptMetadata = query({
  args: {
    minAttemptAt: v.number(),
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const limit = Math.max(1, Math.min(5_000, Math.trunc(args.limit ?? 5_000)));
    const sources = await ctx.db
      .query("instagramSources")
      .withIndex("by_active_lastFetchAttemptAt", (q) =>
        q.eq("active", true).gte("lastFetchAttemptAt", args.minAttemptAt),
      )
      .order("desc")
      .take(limit + 1);
    if (sources.length > limit) {
      throw new Error(
        `Legacy recent-attempt query exceeded its fail-closed limit of ${limit}; use paginated attempt queries.`,
      );
    }
    return sources.map((source) => ({
      handle: source.handle,
      lastFetchAttemptAt: source.lastFetchAttemptAt,
    }));
  },
});

export const getIngestionContextsByHandles = query({
  args: {
    handles: v.array(v.string()),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handles = [
      ...new Set(args.handles.map(normalizeInstagramHandle).filter(Boolean)),
    ];
    if (handles.length > 25) {
      throw new Error("Ingestion source context queries are limited to 25 handles.");
    }

    return Promise.all(
      handles.map(async (handle) => {
        const source = await ctx.db
          .query("instagramSources")
          .withIndex("by_handle", (q) => q.eq("handle", handle))
          .unique();
        const normalizedVenues = await ctx.db
          .query("venues")
          .withIndex("by_normalizedInstagramHandle", (q) =>
            q.eq("normalizedInstagramHandle", handle),
          )
          .take(2);
        if (normalizedVenues.length > 1) {
          throw new Error(`Multiple venues resolve to normalized Instagram handle ${handle}.`);
        }
        const legacyExactVenue = normalizedVenues[0]
          ? null
          : await ctx.db
              .query("venues")
              .withIndex("by_instagramHandle", (q) => q.eq("instagramHandle", handle))
              .first();
        const indexedVenue = normalizedVenues[0] ?? legacyExactVenue;
        const linkedVenue =
          !indexedVenue && source?.venueId ? await ctx.db.get(source.venueId) : null;
        const handleVenue =
          indexedVenue ??
          (linkedVenue && normalizeInstagramHandle(linkedVenue.instagramHandle) === handle
            ? linkedVenue
            : null);
        const activeLegacyVenue = handleVenue?.scrapeActive === true ? handleVenue : null;
        const role = source?.active
          ? source.role
          : activeLegacyVenue
            ? roleForLegacyVenue(activeLegacyVenue)
            : "unknown";
        return {
          handle,
          role,
          canonicalVenueName: handleVenue?.name,
        };
      }),
    );
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

    // A partial or capped provider response is observability only. It must not
    // alter the active source set: daily ingestion continues from its existing
    // durable source snapshot until a complete weekly reconciliation succeeds.
    if (complete) {
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
    expectedUpdatedAt: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const handle = normalizeInstagramHandle(args.handle);
    const source = await ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!source) throw new Error("Instagram source not found.");
    if (
      args.expectedUpdatedAt !== undefined &&
      source.updatedAt !== args.expectedUpdatedAt
    ) {
      throw new Error("Instagram source changed after it was reviewed.");
    }
    if (args.role === "venue" && !args.venueId) {
      throw new Error("A venue source requires a canonical venue mapping.");
    }
    const updatedAt = Math.max(Date.now(), source.updatedAt + 1);
    await ctx.db.patch(source._id, {
      role: args.role,
      venueId: args.role === "venue" ? args.venueId : undefined,
      updatedAt,
    });
    return { updated: true, updatedAt };
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
