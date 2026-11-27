import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { accountEvidence } from "./performerRegistryValues";
import {
  validateAccountEvidence,
  type AccountEvidence,
} from "./performerAccountEvidence";
import { invalidateAccountRank } from "./performerAccountQueue";
import {
  primaryGenreForProfile,
  visibleInstagramHandle,
  currentAccountAppearance,
} from "./performerRegistry";
import { registryInstagramHandle } from "./performerRegistryEvidence";
import { requireAdminOrServiceSecret } from "./authz";
import {
  categoryWindow,
  discoveryBudgets,
} from "../lib/taxonomy/priority-event-discovery";
import { EMPTY_RESEARCH_RETRY_MS } from "../lib/taxonomy/performer-genre-research";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types";
import {
  createBelgradeInstantResolver,
  getBelgradeNow,
} from "../lib/venues/venue-open-now";
import { normalizeEventTime } from "../lib/events/event-time";
import { addDaysToDateKey } from "../lib/events/nightlife-date";
import { exactJsonValue } from "../lib/events/exact-json-value";

type Profile = Doc<"performerRegistryProfiles">;
const HOUR = 3_600_000;
const phase = v.union(v.literal("instagram"), v.literal("web"));
const claimArgs = { serviceSecret: v.string(), owner: v.string() };
function ownerGuard(value: string) {
  if (!/^[0-9a-f-]{36}$/iu.test(value))
    throw new Error("Invalid account worker.");
}
async function currentAccount(ctx: MutationCtx, p: Profile, handle: string) {
  if (p.instagramHandle !== handle) return false;
  const accounts = await ctx.db
    .query("performerRegistryProfiles")
    .withIndex("by_instagram_handle", (q) => q.eq("instagramHandle", handle))
    .take(2);
  if (accounts.length !== 1 || accounts[0]._id !== p._id) return false;
  const verified = await ctx.db
    .query("performerRegistryAppearances")
    .withIndex("by_profile_verified_handle", (q) =>
      q.eq("profileId", p._id).eq("evidence.verifiedHandle", handle),
    )
    .take(2);
  const proofs = [];
  for (const a of verified) {
    if (a.evidence && (await currentAccountAppearance(ctx, a, handle)))
      proofs.push(a.evidence);
  }
  return (await visibleInstagramHandle(ctx, p, proofs)) === handle;
}

export const advanceRank = internalMutation({
  args: {
    id: v.id("performerRegistryProfiles"),
    generation: v.number(),
    at: v.number(),
    from: v.string(),
    cursor: v.union(v.string(), v.null()),
    count: v.number(),
    urgent: v.boolean(),
    previous: v.optional(v.id("events")),
    next: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const p = await ctx.db.get(args.id);
    if (
      !p?.instagramHandle ||
      p.accountRank?.generation !== args.generation ||
      p.accountRank.ready
    )
      return null;
    const page = await ctx.db
      .query("performerRegistryAppearances")
      .withIndex("by_profile_date_event", (q) =>
        q.eq("profileId", p._id).gte("date", args.from),
      )
      .paginate({ cursor: args.cursor, numItems: 12 });
    const window = categoryWindow(args.at),
      today = getBelgradeNow(args.at).date,
      instant = createBelgradeInstantResolver();
    let { count, urgent, previous, next } = args;
    function consider(at: number | null) {
      if (at !== null && at > args.at && (next === undefined || at < next))
        next = at;
    }
    for (const a of page.page) {
      if (
        a.eventId === previous ||
        !(
          (a.confirmedBilling && a.handle === p.instagramHandle) ||
          a.evidence?.verifiedHandle === p.instagramHandle
        )
      )
        continue;
      const e = await ctx.db.get(a.eventId);
      if (
        !e ||
        e.updatedAt !== a.eventUpdatedAt ||
        e.status !== "approved" ||
        e.publicationState !== "publishable" ||
        e.date !== a.date ||
        !(await currentAccountAppearance(ctx, a, p.instagramHandle, e))
      )
        continue;
      previous = a.eventId;
      const time = normalizeEventTime(
        e.timeStatus === "confirmed" ? e.time : undefined,
      );
      const wall = (d: string, t: string) =>
        Date.parse(d + "T" + t + ":00Z") / 60000;
      const start = time.startLabel
        ? instant(wall(e.date, time.startLabel), "start")
        : null;
      const firstDay = instant(wall(e.date, "00:00"), "start");
      const endDay = instant(wall(addDaysToDateKey(e.date, 1), "00:00"), "end");
      const tier = window.tier(e);
      if (
        start !== null
          ? start < args.at && tier !== "confirmed"
          : e.date < today
      )
        continue;
      count++;
      const whollyInside =
        start === null &&
        firstDay !== null &&
        endDay !== null &&
        firstDay >= args.at &&
        endDay <= args.at + 48 * HOUR;
      urgent ||= tier === "confirmed" || whollyInside;
      if (start !== null) {
        consider(start - 48 * HOUR + 1);
        const end =
          time.startLabel && time.endLabel
            ? instant(
                wall(
                  time.endLabel <= time.startLabel
                    ? addDaysToDateKey(e.date, 1)
                    : e.date,
                  time.endLabel,
                ),
                "end",
              )
            : null;
        consider(end ?? start + 60_000);
      } else {
        consider(firstDay);
        consider(endDay);
        if (endDay !== null) consider(endDay - 48 * HOUR);
      }
    }
    if (!page.isDone) {
      // If a scheduled page is interrupted, the next maintenance tick can restart this profile.
      await ctx.db.patch(p._id, {
        accountRank: { ...p.accountRank, refreshAt: Date.now() + 15 * 60_000 },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.performerAccountResearch.advanceRank,
        {
          ...args,
          cursor: page.continueCursor,
          count,
          urgent,
          ...(previous ? { previous } : {}),
          ...(next ? { next } : {}),
        },
      );
    } else {
      await ctx.db.patch(p._id, {
        accountRank: {
          generation: args.generation,
          ready: true,
          tier: urgent ? 0 : count ? 1 : 2,
          order: -count,
          ...(next !== undefined ? { refreshAt: next } : {}),
        },
      });
    }
    return null;
  },
});

/** Seed pre-existing profiles automatically, then expire leases/cooldowns and ranks at their real clock boundaries. */
export const prepare = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now(),
      limit = 8;
    const [unseen, stale, retries] = await Promise.all([
      ctx.db
        .query("performerRegistryProfiles")
        .withIndex("by_account_pending", (q) =>
          q.eq("accountRank.ready", undefined),
        )
        .take(limit),
      ctx.db
        .query("performerRegistryProfiles")
        .withIndex("by_account_refresh", (q) =>
          q.gt("accountRank.refreshAt", 0).lte("accountRank.refreshAt", now),
        )
        .take(limit),
      ctx.db
        .query("performerRegistryProfiles")
        .withIndex("by_account_retry", (q) =>
          q.gt("accountWork.retryAt", 0).lte("accountWork.retryAt", now),
        )
        .take(limit),
    ]);
    for (const p of [...unseen, ...stale])
      await invalidateAccountRank(ctx, p._id);
    for (const p of retries) {
      const old = p.accountWork;
      if (!old || !p.instagramHandle) continue;
      const resolved = !!(p.accountEvidence?.genres.length || p.support.length);
      const nextStage =
        old.stage === "running" && old.phase === "web" && !old.debited
          ? "web"
          : "instagram";
      const waiting = old.stage === "running" && !!old.debited;
      await ctx.db.patch(p._id, {
        accountWork:
          resolved && p.accountEvidence?.displayName
            ? { stage: "complete" }
            : waiting
              ? { stage: "waiting", retryAt: now + HOUR }
              : { stage: nextStage },
      });
    }
    if ([unseen, stale, retries].some((rows) => rows.length === limit))
      await ctx.scheduler.runAfter(
        1000,
        internal.performerAccountResearch.prepare,
        {},
      );
    return null;
  },
});

const stateRow = (ctx: MutationCtx) =>
  ctx.db
    .query("eventDiscoveryEnrichmentState")
    .withIndex("by_key", (q) => q.eq("key", "upcoming"))
    .unique();
function available(
  now: number,
  state: Doc<"eventDiscoveryEnrichmentState"> | null,
) {
  const b = discoveryBudgets(now, state);
  return (
    b.general > 0 &&
    !(
      b.urgent > 0 &&
      b.remaining <= 12 &&
      (state?.categoryScan?.reserveUntil ?? 0) > now
    )
  );
}
export const claim = mutation({
  args: { ...claimArgs, phase },
  returns: v.union(
    v.null(),
    v.object({
      profileId: v.id("performerRegistryProfiles"),
      handle: v.string(),
      knownName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    ownerGuard(args.owner);
    const now = Date.now();
    if (args.phase === "web" && !available(now, await stateRow(ctx)))
      return null;
    // Restrict the hot path to the completed 48h rows. During bootstrap,
    // hundreds of unrelated profile/rank changes used to invalidate this claim.
    const ranked = () => ctx.db.query("performerRegistryProfiles");
    const imminent = await ranked()
      .withIndex("by_account_priority", (q) =>
        q
          .eq("accountRank.ready", true)
          .eq("accountWork.stage", args.phase)
          .eq("accountRank.tier", 0),
      )
      .take(4);
    let candidates = imminent;
    if (!imminent.length) {
      // Lower tiers can consume the last slot only once all pages and crossed
      // boundaries have been ranked. Preserve the global order for that lane.
      const missing = await ranked()
        .withIndex("by_account_pending", (q) =>
          q.eq("accountRank.ready", undefined),
        )
        .take(1);
      if (missing.length) return null;
      const pending = await ranked()
        .withIndex("by_account_pending", (q) =>
          q.eq("accountRank.ready", false),
        )
        .take(1);
      if (pending.length) return null;
      const expired = await ranked()
        .withIndex("by_account_refresh", (q) =>
          q.gt("accountRank.refreshAt", 0).lte("accountRank.refreshAt", now),
        )
        .take(1);
      if (expired.length) return null;
      candidates = await ranked()
        .withIndex("by_account_priority", (q) =>
          q
            .eq("accountRank.ready", true)
            .eq("accountWork.stage", args.phase)
            .gt("accountRank.tier", 0),
        )
        .take(4);
    }
    if (args.phase === "web" && candidates[0]?.accountRank) {
      const first = candidates[0].accountRank;
      const [free] = await ranked()
        .withIndex("by_account_priority", (q) => {
          const lane = q
            .eq("accountRank.ready", true)
            .eq("accountWork.stage", "instagram");
          return first.tier === 0 ? lane.eq("accountRank.tier", 0) : lane;
        })
        .take(1);
      const waiting = free?.accountRank;
      if (
        waiting &&
        (waiting.tier < first.tier ||
          (waiting.tier === first.tier && waiting.order < first.order))
      )
        return null;
    }
    for (const p of candidates) {
      if (
        !p.accountRank ||
        (p.accountRank.refreshAt !== undefined &&
          p.accountRank.refreshAt <= now)
      )
        continue;
      if (
        !p.instagramHandle ||
        !(await currentAccount(ctx, p, p.instagramHandle)) ||
        (args.phase === "web" &&
          !!(p.accountEvidence?.genres.length || p.support.length))
      ) {
        await ctx.db.patch(p._id, { accountWork: { stage: "complete" } });
        continue;
      }
      await ctx.db.patch(p._id, {
        accountWork: {
          stage: "running",
          owner: args.owner,
          phase: args.phase,
          retryAt: now + 5 * 60_000,
        },
      });
      return { profileId: p._id, handle: p.instagramHandle, knownName: p.name };
    }
    return null;
  },
});
const leased = (
  p: Profile | null,
  owner: string,
  handle: string,
  now: number,
) =>
  p?.instagramHandle === handle &&
  p.accountWork?.stage === "running" &&
  p.accountWork.owner === owner &&
  (p.accountWork.retryAt ?? 0) > now;

/** Called only immediately before a paid provider request, once per unique active lease. */
export const reserveSearch = mutation({
  args: {
    ...claimArgs,
    profileId: v.id("performerRegistryProfiles"),
    handle: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    ownerGuard(args.owner);
    const p = await ctx.db.get(args.profileId),
      now = Date.now(),
      state = await stateRow(ctx);
    if (
      !p ||
      !leased(p, args.owner, args.handle, now) ||
      p.accountWork?.phase !== "web" ||
      p.accountWork.debited ||
      !available(now, state) ||
      !(await currentAccount(ctx, p, args.handle))
    )
      return false;
    const b = discoveryBudgets(now, state);
    if (state)
      await ctx.db.patch(state._id, {
        dayKey: b.dayKey,
        attempted: b.total + 1,
      });
    else
      await ctx.db.insert("eventDiscoveryEnrichmentState", {
        key: "upcoming",
        fromDate: getBelgradeNow(now).date,
        cursor: null,
        dayKey: b.dayKey,
        attempted: 1,
      });
    await ctx.db.patch(p._id, {
      accountWork: { ...p.accountWork, debited: true },
    });
    return true;
  },
});

const resultShape = v.object({
  status: v.union(
    v.literal("written"),
    v.literal("unchanged"),
    v.literal("stale"),
    v.literal("no_evidence"),
  ),
  name: v.boolean(),
  genres: v.number(),
});
async function record(
  ctx: MutationCtx,
  p: Profile,
  input: AccountEvidence,
  apply: boolean,
) {
  const clean = validateAccountEvidence(input, input.handle, p.name);
  if (!clean.displayName && !clean.genres.length)
    return { status: "no_evidence" as const, name: false, genres: 0 };
  const prior =
    p.accountEvidence?.handle === input.handle ? p.accountEvidence : undefined;
  // Do not silently replace an established self-reported name with a contradictory second identity.
  if (
    prior?.displayName &&
    clean.displayName &&
    normalizeTaxonomyText(prior.displayName.value) !==
      normalizeTaxonomyText(clean.displayName.value)
  ) {
    return { status: "stale" as const, name: false, genres: 0 };
  }
  const displayName = prior?.displayName ?? clean.displayName;
  const genres = (prior?.genres ?? []).map((g) => ({ ...g }));
  for (const g of clean.genres) {
    const existing = genres.find((a) => a.genre === g.genre && a.url === g.url);
    if (!existing && genres.length < 20) genres.push(g);
    else if (existing && g.dominant && !existing.dominant)
      Object.assign(existing, g);
  }
  const merged: AccountEvidence = {
    handle: input.handle,
    genres,
    ...(displayName ? { displayName } : {}),
  };
  const changed = !exactJsonValue(prior, merged);
  if (changed && apply) {
    const rename =
      displayName &&
      (p.name.toLowerCase() === "@" + input.handle ||
        normalizeTaxonomyText(displayName.value) === p.nameKey);
    await ctx.db.patch(p._id, {
      accountEvidence: merged,
      primaryGenre: primaryGenreForProfile(p.support, genres),
      ...(rename
        ? {
            name: displayName.value,
            nameKey: normalizeTaxonomyText(displayName.value),
          }
        : {}),
    });
    if (!exactJsonValue(prior?.genres ?? [], genres))
      await ctx.scheduler.runAfter(
        0,
        internal.performerRegistry.wakeAffectedAppearances,
        {
          kind: "handle",
          value: input.handle,
          fromDate: addDaysToDateKey(getBelgradeNow(Date.now()).date, -1),
          cursor: null,
        },
      );
  }
  return {
    status: changed ? ("written" as const) : ("unchanged" as const),
    name: !!displayName,
    genres: genres.length,
  };
}
export const recordReviewedEvidence = internalMutation({
  args: { evidence: accountEvidence, apply: v.boolean() },
  returns: resultShape,
  handler: async (ctx, args) => {
    const handle = registryInstagramHandle(args.evidence.handle);
    if (!handle || handle !== args.evidence.handle)
      throw new Error("Invalid reviewed account handle.");
    const profiles = await ctx.db
      .query("performerRegistryProfiles")
      .withIndex("by_instagram_handle", (q) => q.eq("instagramHandle", handle))
      .take(2);
    const p = profiles.length === 1 ? profiles[0] : null;
    if (!p || !(await currentAccount(ctx, p, handle)))
      return { status: "stale" as const, name: false, genres: 0 };
    const result = await record(ctx, p, args.evidence, args.apply);
    if (
      args.apply &&
      result.genres &&
      p.accountWork?.stage !== "complete" &&
      result.name
    )
      await ctx.db.patch(p._id, { accountWork: { stage: "complete" } });
    return result;
  },
});
export const complete = mutation({
  args: {
    ...claimArgs,
    profileId: v.id("performerRegistryProfiles"),
    handle: v.string(),
    evidence: v.optional(accountEvidence),
    outcome: v.union(
      v.literal("success"),
      v.literal("unavailable"),
      v.literal("budget"),
    ),
  },
  returns: resultShape,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    ownerGuard(args.owner);
    const p = await ctx.db.get(args.profileId),
      now = Date.now();
    if (
      !p ||
      !leased(p, args.owner, args.handle, now) ||
      (args.evidence && args.evidence.handle !== args.handle) ||
      !(await currentAccount(ctx, p, args.handle))
    ) {
      return { status: "stale" as const, name: false, genres: 0 };
    }
    let evidence = args.outcome === "success" ? args.evidence : undefined;
    if (!evidence?.displayName && !p.accountEvidence?.displayName) {
      // The following snapshot already contains Instagram's exact full_name
      // field. Reuse the indexed observation even when the public page needs login.
      const source = await ctx.db
        .query("instagramSources")
        .withIndex("by_handle", (q) => q.eq("handle", args.handle))
        .unique();
      const observed = source?.observedDisplayName;
      const at = source?.observedDisplayNameUpdatedAt;
      if (observed && at && at <= now && at >= now - 30 * 24 * HOUR) {
        evidence = {
          ...(evidence ?? { handle: args.handle, genres: [] }),
          displayName: {
            value: observed,
            quote: observed,
            url: "https://www.instagram.com/" + args.handle + "/",
          },
        };
      }
    }
    const result = evidence
      ? await record(ctx, p, evidence, true)
      : { status: "no_evidence" as const, name: false, genres: 0 };
    const hasGenre = !!(
      result.genres ||
      p.accountEvidence?.genres.length ||
      p.support.length
    );
    const name = !!(result.name || p.accountEvidence?.displayName);
    const work: NonNullable<Profile["accountWork"]> =
      hasGenre && name
        ? { stage: "complete" }
        : args.outcome === "budget" && !p.accountWork?.debited
          ? { stage: "web" }
          : p.accountWork?.phase === "instagram" && !hasGenre
            ? { stage: "web" }
            : {
                stage: "waiting",
                retryAt:
                  now +
                  (args.outcome === "unavailable"
                    ? HOUR
                    : EMPTY_RESEARCH_RETRY_MS),
              };
    await ctx.db.patch(p._id, { accountWork: work });
    return result;
  },
});
