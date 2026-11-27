import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { schedulePublishedDiscovery } from "./internal/schedulePublishedDiscovery";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import {
  performerBackfillPhase,
  performerEvidence,
} from "./performerRegistryValues";
import { musicGenre } from "./eventDiscoveryValues";
import {
  canonicalProfile,
  evidenceForCredits,
  profileKey,
  registryCredits,
  type Credit,
  type RegistryEvidence,
} from "./performerRegistryEvidence";
import {
  EVENT_DISCOVERY_VERSION,
  getEventDiscoveryTaxonomy,
  MUSIC_GENRES,
  type MusicGenre,
} from "../lib/taxonomy/event-discovery";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key";
import { categoryWindow } from "../lib/taxonomy/priority-event-discovery";
import { summaryCancelsEvent } from "../lib/taxonomy/explicit-event-discovery";
import { titleContainsOnlyBilledArtists } from "../lib/events/nightlife-lineup-coalescing";
import type { PerformerGenreMatch } from "../lib/taxonomy/performer-genre-research";
import { PUBLICATION_POLICY_VERSION } from "../lib/domain/publication/policy";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import { exactJsonValue } from "../lib/events/exact-json-value";

type ReadCtx = Pick<QueryCtx, "db">;
type Event = Doc<"events">;
type Profile = Doc<"performerRegistryProfiles">;
type Appearance = Doc<"performerRegistryAppearances">;
type AppearanceFields = Omit<Appearance, "_id" | "_creationTime">;
const MAX_SOURCES = 8;
const MAX_CREDITS = 128;
const BACKFILL_PAGE = 4;
const stateQuery = (ctx: ReadCtx) =>
  ctx.db
    .query("performerRegistryBackfill")
    .withIndex("by_key", (q) => q.eq("key", "v1"))
    .unique();

async function evidenceInputs(ctx: ReadCtx, id: Id<"events">) {
  const [row, label] = await Promise.all([
    ctx.db
      .query("eventPerformerGenreResearch")
      .withIndex("by_eventId", (q) => q.eq("eventId", id))
      .unique(),
    ctx.db
      .query("eventDiscoveryLabels")
      .withIndex("by_eventId", (q) => q.eq("eventId", id))
      .unique(),
  ]);
  return { row, label };
}

async function eligible(ctx: ReadCtx, event: Event) {
  if (
    event.status !== "approved" ||
    event.publicationState !== "publishable" ||
    event.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION ||
    event.publicationReason !== "canonical_source_grounding_verified" ||
    !event.venueId ||
    summaryCancelsEvent(event.title, event.description)
  )
    return false;
  const venue = await ctx.db.get(event.venueId);
  return !!venue && isVenuePublic(venue);
}

function musicCompatible(
  event: Event,
  label: Doc<"eventDiscoveryLabels"> | null,
) {
  const current =
    label?.version === EVENT_DISCOVERY_VERSION &&
    label.eventUpdatedAt === event.updatedAt
      ? label.taxonomy
      : undefined;
  return (current ?? getEventDiscoveryTaxonomy(event)).categories.every(
    (c) => c === "other" || c === "live" || c === "party",
  );
}
function profileByKey(ctx: ReadCtx, key: string) {
  return ctx.db
    .query("performerRegistryProfiles")
    .withIndex("by_identity", (q) => q.eq("identityKey", key))
    .unique();
}
function profileSources(
  ctx: ReadCtx,
  id: Id<"performerRegistryProfiles">,
  venueId?: Id<"venues">,
) {
  return venueId
    ? ctx.db
        .query("performerRegistryAppearances")
        .withIndex("by_profile_venue_evidence", (q) =>
          q.eq("profileId", id).eq("venueId", venueId).eq("independent", true),
        )
        .order("desc")
        .take(MAX_SOURCES)
    : ctx.db
        .query("performerRegistryAppearances")
        .withIndex("by_profile_evidence", (q) =>
          q.eq("profileId", id).eq("independent", true),
        )
        .order("desc")
        .take(MAX_SOURCES);
}
type SourceCache = Map<
  Id<"events">,
  Promise<ReturnType<typeof evidenceForCredits>>
>;
async function liveEvidence(ctx: ReadCtx, a: Appearance, cache: SourceCache) {
  if (!a.independent || !a.evidence) return;
  let pending = cache.get(a.eventId);
  if (!pending) {
    // Limit origin-document reads across the whole lineup, even for long bills.
    if (cache.size >= MAX_SOURCES) return;
    pending = (async () => {
      const e = await ctx.db.get(a.eventId);
      if (
        !e ||
        e.updatedAt !== a.eventUpdatedAt ||
        e.venueId !== a.venueId ||
        e.date !== a.date ||
        !(await eligible(ctx, e))
      )
        return [];
      const { row, label } = await evidenceInputs(ctx, e._id);
      if (!musicCompatible(e, label)) return [];
      return evidenceForCredits(e, row, label);
    })();
    cache.set(a.eventId, pending);
  }
  const entry = (await pending).find(
    (c) => c.credit.key === a.nameKey && c.credit.handle === a.handle,
  );
  // Revisions may change metadata, remove an appearance or replace its underlying
  // proof. A stale registration never republishes the previous quote or identity.
  if (entry?.proof && exactJsonValue(entry.proof, a.evidence))
    return entry.proof;
}
function family(url: string) {
  const parts = new URL(url).hostname.split(".");
  const suffix = parts.slice(-2).join(".");
  return parts
    .slice(/^(?:co|com|org|net)\.[a-z]{2}$/.test(suffix) ? -3 : -2)
    .join(".");
}
function independentSources(proof: RegistryEvidence) {
  return (
    new Set(
      [
        proof.identity,
        ...(proof.corroboration ? [proof.corroboration] : []),
        ...proof.genres,
      ].map((s) => family(s.url)),
    ).size >= 2
  );
}
function localName(credit: Credit) {
  const words = credit.key.split(" ");
  return (
    words.length >= 2 &&
    words.length <= 5 &&
    words.every((w) => w.length >= 3) &&
    credit.key.length >= 9 &&
    !/\b(?:dj|band|bend|trio|quartet|orchestra|orkestar|all stars|cover|tribute|resident|guests?|live|night|session|collective|project|crew|brothers|sisters|festival)\b/.test(
      credit.key,
    )
  );
}
function urlsInSummary(event: Event) {
  return new Set(
    (event.description?.match(/https:\/\/[^\s<>()]+/gi) ?? []).flatMap(
      (value) => {
        try {
          return [canonicalProfile(value.replace(/[.,!]+$/, ""))];
        } catch {
          return [];
        }
      },
    ),
  );
}
async function resolveCredit(
  ctx: ReadCtx,
  event: Event,
  credit: Credit,
  cache: SourceCache,
) {
  const urls = urlsInSummary(event);
  if (!credit.handle && !urls.size && !localName(credit)) return;
  const byHandle = credit.handle
    ? await profileByKey(ctx, "handle:" + credit.handle)
    : null;
  const profiles = byHandle
    ? [byHandle]
    : await ctx.db
        .query("performerRegistryProfiles")
        .withIndex("by_name", (q) =>
          q.eq("nameKey", credit.key).gt("independentAppearances", 0),
        )
        .take(2);
  if (profiles.length !== 1) return;
  const p = profiles[0];
  const context = getEventDiscoveryTaxonomy(event);
  const mayRepeat =
    !credit.handle &&
    !urls.size &&
    localName(credit) &&
    !!event.venueId &&
    (context.primaryCategory === "live" || context.primaryCategory === "party");
  if (!credit.handle && !urls.size && !mayRepeat) return;
  const rows = await profileSources(
    ctx,
    p._id,
    mayRepeat ? event.venueId : undefined,
  );
  const supported: RegistryEvidence[] = [];
  for (const a of rows) {
    if (a.eventId === event._id) continue;
    const proof = await liveEvidence(ctx, a, cache);
    if (
      !proof ||
      (credit.handle &&
        proof.verifiedHandle &&
        proof.verifiedHandle !== credit.handle)
    )
      continue;
    const handle = credit.handle && proof.verifiedHandle === credit.handle;
    const linked =
      proof.profileUrl && urls.has(canonicalProfile(proof.profileUrl));
    const recurring =
      mayRepeat &&
      a.name.trim().normalize("NFC").toLowerCase() ===
        credit.name.trim().normalize("NFC").toLowerCase() &&
      a.date < event.date &&
      a.date < getBelgradeDayKey() &&
      a.venueId === event.venueId &&
      proof.profileUrl &&
      independentSources(proof) &&
      proof.role?.category === context.primaryCategory;
    if (handle || linked || recurring) supported.push(proof);
  }
  if (supported.length)
    return { profileId: p._id, supported, primaryGenre: p.primaryGenre };
}

/** Match earlier independent sources only. Returning [] lets ordinary research continue. */
export async function lookupPerformerRegistryProgramme(
  ctx: ReadCtx,
  event: Event,
): Promise<{
  matches: PerformerGenreMatch[];
  category?: "party" | "live";
}> {
  const empty = { matches: [] };
  if (
    !event.artists.length ||
    event.artists.length > 8 ||
    !(await eligible(ctx, event))
  )
    return empty;
  const credits = registryCredits(event.artists);
  if (credits.length !== event.artists.length || !credits.length) return empty;
  const context = getEventDiscoveryTaxonomy(event);
  if (
    context.categories.some(
      (c) => c !== "party" && c !== "live" && c !== "other",
    )
  )
    return empty;
  const cache: SourceCache = new Map();
  const resolved = await Promise.all(
    credits.map((credit) => resolveCredit(ctx, event, credit, cache)),
  );
  if (resolved.some((p) => !p)) return empty;
  const roles: ("party" | "live")[] = [];
  const matches: PerformerGenreMatch[] = [];
  let allGenres = true;
  for (let i = 0; i < credits.length; i++) {
    const proofs = resolved[i]!.supported;
    const rolesForAct = new Set(
      proofs.flatMap((p) => (p.role ? [p.role.category] : [])),
    );
    if (rolesForAct.size === 1) roles.push([...rolesForAct][0]);
    const dominant = resolved[i]!.primaryGenre;
    const prefer =
      dominant &&
      proofs.some((p) =>
        p.genres.some((g) => g.genre === dominant && g.dominant),
      );
    const seen = new Set<MusicGenre>();
    for (const proof of proofs)
      for (const g of proof.genres) {
        if ((prefer && g.genre !== dominant) || seen.has(g.genre)) continue;
        seen.add(g.genre);
        matches.push({
          performer: credits[i].name,
          genre: g.genre,
          url: g.url,
          identityUrl: proof.identity.url,
        });
      }
    if (!seen.size) allGenres = false;
  }
  const category =
    roles.length === credits.length &&
    roles.every((r) => r === roles[0]) &&
    titleContainsOnlyBilledArtists(
      event.title,
      credits.map((c) => c.name),
    )
      ? roles[0]
      : undefined;
  return {
    matches: allGenres && matches.length <= 8 ? matches : [],
    ...(category ? { category } : {}),
  };
}
export async function lookupPerformerRegistryForEvent(
  ctx: ReadCtx,
  event: Event,
) {
  return (await lookupPerformerRegistryProgramme(ctx, event)).matches;
}

/** A lead for an external identity check; it cannot on its own authorize a genre. */
export async function lookupPerformerRegistrySearchHints(
  ctx: ReadCtx,
  event: Event,
): Promise<{ performer: string; profileUrl: string }[]> {
  if (
    !event.artists.length ||
    event.artists.length > 8 ||
    !(await eligible(ctx, event))
  )
    return [];
  const credits = registryCredits(event.artists);
  if (credits.length !== event.artists.length) return [];
  const cache: SourceCache = new Map();
  const hints: { performer: string; profileUrl: string }[] = [];
  for (const credit of credits) {
    const candidates = await ctx.db
      .query("performerRegistryProfiles")
      .withIndex("by_name", (q) =>
        q.eq("nameKey", credit.key).gt("independentAppearances", 0),
      )
      .take(2);
    if (candidates.length !== 1) continue;
    const sources = await profileSources(ctx, candidates[0]._id);
    for (const a of sources) {
      if (a.eventId === event._id) continue;
      const current = await liveEvidence(ctx, a, cache);
      if (
        current?.profileUrl &&
        (!credit.handle ||
          !current.verifiedHandle ||
          credit.handle === current.verifiedHandle)
      ) {
        hints.push({ performer: credit.name, profileUrl: current.profileUrl });
        break;
      }
    }
  }
  return hints;
}

async function updateSupport(
  ctx: MutationCtx,
  profileId: Profile["_id"],
  oldProof?: RegistryEvidence,
  newProof?: RegistryEvidence,
) {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new Error("Missing performer profile.");
  const counts = new Map(profile.support.map((s) => [s.genre, { ...s }]));
  for (const [proof, sign] of [
    [oldProof, -1],
    [newProof, 1],
  ] as const) {
    for (const claim of proof?.genres ?? []) {
      const item = counts.get(claim.genre) ?? {
        genre: claim.genre,
        appearances: 0,
        dominant: 0,
      };
      item.appearances += sign;
      item.dominant += claim.dominant ? sign : 0;
      if (item.appearances > 0) counts.set(claim.genre, item);
      else counts.delete(claim.genre);
    }
  }
  const independentAppearances =
    profile.independentAppearances + (newProof ? 1 : 0) - (oldProof ? 1 : 0);
  const support = MUSIC_GENRES.flatMap(({ key }) => counts.get(key) ?? []);
  const primary = support.filter((s) => s.dominant > 0);
  await ctx.db.patch(profileId, {
    support,
    independentAppearances,
    primaryGenre: primary.length === 1 ? primary[0].genre : undefined,
  });
}
async function ensureProfile(
  ctx: MutationCtx,
  event: Event,
  credit: Credit,
  proof: RegistryEvidence,
) {
  const identityKey = profileKey(event._id, credit, proof),
    profile = await profileByKey(ctx, identityKey);
  return (
    profile?._id ??
    ctx.db.insert("performerRegistryProfiles", {
      identityKey,
      name: credit.name,
      nameKey: credit.key,
      independentAppearances: 0,
      support: [],
    })
  );
}

type WakeKey = { kind: "name" | "handle"; value: string };
function wakeKeys(
  keys: Map<string, WakeKey>,
  nameKey: string,
  proof?: RegistryEvidence,
) {
  if (!proof) return;
  keys.set("name:" + nameKey, { kind: "name", value: nameKey });
  if (proof.verifiedHandle)
    keys.set("handle:" + proof.verifiedHandle, {
      kind: "handle",
      value: proof.verifiedHandle,
    });
}

export async function syncPerformerRegistryForEvent(
  ctx: MutationCtx,
  eventId: Id<"events">,
  wakeBackfilledLink = false,
): Promise<void> {
  const [event, previous] = await Promise.all([
    ctx.db.get(eventId),
    ctx.db
      .query("performerRegistryAppearances")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(MAX_CREDITS + 1),
  ]);
  if (previous.length > MAX_CREDITS)
    throw new Error("Too many performer records for one event.");
  let linkedDuringBackfill = false;
  const wakes = new Map<string, WakeKey>();
  const pending = new Map(
    previous.map((a) => [JSON.stringify([a.nameKey, a.handle ?? null]), a]),
  );
  if (event && event.artists.length && (await eligible(ctx, event))) {
    const { row, label } = await evidenceInputs(ctx, eventId);
    const entries = musicCompatible(event, label)
      ? evidenceForCredits(event, row, label)
      : [];
    if (entries.length > MAX_CREDITS)
      throw new Error(
        "Performer billing requires a larger bounded reconciliation.",
      );
    const cache: SourceCache = new Map();
    for (const { credit, proof } of entries) {
      const key = JSON.stringify([credit.key, credit.handle ?? null]),
        old = pending.get(key);
      pending.delete(key);
      const profileId = proof
        ? await ensureProfile(ctx, event, credit, proof)
        : (await resolveCredit(ctx, event, credit, cache))?.profileId;
      const data: AppearanceFields = {
        eventId,
        eventUpdatedAt: event.updatedAt,
        name: credit.name,
        nameKey: credit.key,
        ...(credit.handle ? { handle: credit.handle } : {}),
        ...(profileId ? { profileId } : {}),
        venue: event.venue,
        ...(event.venueId ? { venueId: event.venueId } : {}),
        date: event.date,
        status: "announced",
        ...(event.instagramPostUrl
          ? { listingUrl: event.instagramPostUrl }
          : {}),
        independent: !!proof,
        ...(proof ? { evidence: proof } : {}),
      };
      if (old) {
        const { _id, _creationTime, ...fields } = old;
        void _creationTime;
        if (exactJsonValue(fields, data)) continue;
        await ctx.db.replace(_id, data);
      } else await ctx.db.insert("performerRegistryAppearances", data);
      if (
        wakeBackfilledLink &&
        !proof &&
        old?.profileId !== profileId &&
        event.date >= getBelgradeDayKey()
      )
        linkedDuringBackfill = true;
      if (
        !old ||
        old.venueId !== data.venueId ||
        old.date !== data.date ||
        old.profileId !== profileId ||
        !exactJsonValue(old.evidence, proof)
      ) {
        wakeKeys(wakes, credit.key, old?.evidence);
        wakeKeys(wakes, credit.key, proof);
      }
      if (old?.profileId && old.evidence && old.profileId !== profileId)
        await updateSupport(ctx, old.profileId, old.evidence);
      if (
        profileId &&
        (proof || (old?.evidence && old.profileId === profileId))
      )
        await updateSupport(
          ctx,
          profileId,
          old?.profileId === profileId ? old.evidence : undefined,
          proof,
        );
    }
  }
  for (const old of pending.values()) {
    wakeKeys(wakes, old.nameKey, old.evidence);
    await ctx.db.delete(old._id);
    if (old.profileId && old.evidence)
      await updateSupport(ctx, old.profileId, old.evidence);
  }
  if (linkedDuringBackfill) await schedulePublishedDiscovery(ctx, eventId);
  for (const key of wakes.values()) {
    await ctx.scheduler.runAfter(
      0,
      internal.performerRegistry.wakeAffectedAppearances,
      {
        ...key,
        sourceEventId: eventId,
        fromDate: getBelgradeDayKey(),
        cursor: null,
      },
    );
  }
}

const phaseOrder = [
  "priority",
  "sources",
  "calendar",
  "reconcile",
  "done",
] as const;
const backfillStatus = v.object({
  phase: performerBackfillPhase,
  examined: v.number(),
  generation: v.number(),
  step: v.number(),
  updatedAt: v.number(),
});
function status(row: Doc<"performerRegistryBackfill">) {
  return {
    phase: row.phase,
    examined: row.examined,
    generation: row.generation,
    step: row.step,
    updatedAt: row.updatedAt,
  };
}
export const getBackfillStatus = internalQuery({
  args: {},
  returns: v.union(backfillStatus, v.null()),
  handler: async (ctx) => {
    const row = await stateQuery(ctx);
    return row ? status(row) : null;
  },
});
export const kickBackfill = internalMutation({
  args: { restart: v.optional(v.boolean()) },
  returns: backfillStatus,
  handler: async (ctx, args) => {
    const previous = await stateQuery(ctx),
      now = Date.now();
    if (previous && !(args.restart && previous.phase === "done")) {
      // A failed scheduled mutation rolls back its cursor. A manual kick can
      // safely requeue that exact step, including if the old job also wakes.
      if (previous.phase !== "done" && now - previous.updatedAt >= 60_000) {
        await ctx.scheduler.runAfter(
          0,
          internal.performerRegistry.advanceBackfill,
          { generation: previous.generation, step: previous.step },
        );
        await ctx.db.patch(previous._id, { updatedAt: now });
        return { ...status(previous), updatedAt: now };
      }
      return status(previous);
    }
    const window = categoryWindow(now);
    const data = {
      key: "v1" as const,
      phase: "priority" as const,
      fromDate: window.fromDate,
      throughDate: window.throughDate,
      cursor: null,
      examined: 0,
      startedAt: now,
      updatedAt: now,
      step: 0,
      generation: (previous?.generation ?? 0) + 1,
    };
    if (previous) await ctx.db.replace(previous._id, data);
    else await ctx.db.insert("performerRegistryBackfill", data);
    await ctx.scheduler.runAfter(
      0,
      internal.performerRegistry.advanceBackfill,
      { generation: data.generation, step: 0 },
    );
    return {
      phase: data.phase,
      examined: 0,
      generation: data.generation,
      step: 0,
      updatedAt: now,
    };
  },
});
export const advanceBackfill = internalMutation({
  args: { generation: v.number(), step: v.number() },
  returns: v.null(),
  handler: async (ctx, { generation, step }) => {
    const state = await stateQuery(ctx);
    if (
      !state ||
      state.generation !== generation ||
      state.step !== step ||
      state.phase === "done"
    )
      return null;
    const opts = {
      cursor: state.cursor,
      numItems: BACKFILL_PAGE,
      maximumBytesRead: 1_500_000,
    };
    let page;
    if (state.phase === "sources") {
      const result = await ctx.db
        .query("eventPerformerGenreResearch")
        .paginate(opts);
      page = { ...result, ids: result.page.map((r) => r.eventId) };
    } else if (state.phase === "reconcile") {
      const result = await ctx.db
        .query("performerRegistryAppearances")
        .paginate(opts);
      page = {
        ...result,
        ids: [...new Set(result.page.map((r) => r.eventId))],
      };
    } else {
      const priority = state.phase === "priority",
        window = categoryWindow(state.startedAt);
      const result = await ctx.db
        .query("events")
        .withIndex("by_status_date", (q) => {
          const approved = q.eq("status", "approved");
          return priority
            ? approved
                .gte("date", state.fromDate)
                .lte("date", state.throughDate)
            : approved;
        })
        .paginate(opts);
      page = {
        ...result,
        ids: result.page
          .filter(
            (e) =>
              !priority ||
              (window.includes(e) && window.tier(e) !== "local-only"),
          )
          .map((e) => e._id),
      };
    }
    for (const id of page.ids)
      await syncPerformerRegistryForEvent(ctx, id, true);
    const phase = page.isDone
      ? phaseOrder[phaseOrder.indexOf(state.phase) + 1]
      : state.phase;
    await ctx.db.patch(state._id, {
      phase,
      cursor: page.isDone ? null : page.continueCursor,
      step: step + 1,
      updatedAt: Date.now(),
      examined: state.examined + page.page.length,
    });
    if (phase !== "done")
      await ctx.scheduler.runAfter(
        1000,
        internal.performerRegistry.advanceBackfill,
        { generation, step: step + 1 },
      );
    return null;
  },
});

export const findProfiles = internalQuery({
  args: { name: v.string() },
  returns: v.object({
    profiles: v.array(
      v.object({
        profileId: v.id("performerRegistryProfiles"),
        name: v.string(),
      }),
    ),
    more: v.boolean(),
  }),
  handler: async (ctx, { name }) => {
    if (!name.trim() || name.length > 100) return { profiles: [], more: false };
    const rows = await ctx.db
      .query("performerRegistryProfiles")
      .withIndex("by_name", (q) =>
        q
          .eq("nameKey", normalizeTaxonomyText(name))
          .gt("independentAppearances", 0),
      )
      .take(9);
    return {
      profiles: rows
        .slice(0, 8)
        .map((p) => ({ profileId: p._id, name: p.name })),
      more: rows.length > 8,
    };
  },
});

export const readProfile = internalQuery({
  args: { profileId: v.id("performerRegistryProfiles") },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      genres: v.array(musicGenre),
      primaryGenre: v.union(musicGenre, v.null()),
      sources: v.array(
        v.object({
          eventId: v.id("events"),
          venue: v.string(),
          date: v.string(),
          evidence: performerEvidence,
        }),
      ),
      moreSources: v.boolean(),
    }),
  ),
  handler: async (ctx, { profileId }) => {
    const p = await ctx.db.get(profileId);
    if (!p) return null;
    const recent = await ctx.db
      .query("performerRegistryAppearances")
      .withIndex("by_profile_evidence", (q) =>
        q.eq("profileId", p._id).eq("independent", true),
      )
      .order("desc")
      .take(MAX_SOURCES + 1);
    const cache: SourceCache = new Map();
    const sources = [];
    for (const a of recent.slice(0, MAX_SOURCES)) {
      const evidence = await liveEvidence(ctx, a, cache);
      if (evidence)
        sources.push({
          eventId: a.eventId,
          venue: a.venue,
          date: a.date,
          evidence,
        });
    }
    const genres = [
      ...new Set(sources.flatMap((s) => s.evidence.genres.map((g) => g.genre))),
    ];
    const dominant = new Set(
      sources.flatMap((s) =>
        s.evidence.genres.filter((g) => g.dominant).map((g) => g.genre),
      ),
    );
    return {
      name: p.name,
      genres,
      primaryGenre:
        p.primaryGenre && dominant.has(p.primaryGenre) && dominant.size === 1
          ? p.primaryGenre
          : null,
      sources,
      moreSources: recent.length > MAX_SOURCES,
    };
  },
});
export const listAppearances = internalQuery({
  args: {
    profileId: v.id("performerRegistryProfiles"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    page: v.array(
      v.object({
        eventId: v.id("events"),
        name: v.string(),
        venue: v.string(),
        date: v.string(),
        status: v.literal("announced"),
      }),
    ),
  }),
  handler: async (ctx, { profileId, cursor }) => {
    const page = await ctx.db
      .query("performerRegistryAppearances")
      .withIndex("by_profile_date", (q) => q.eq("profileId", profileId))
      .order("desc")
      .paginate({ cursor, numItems: 4 });
    const visible = [];
    const cache: SourceCache = new Map();
    for (const a of page.page) {
      const e = await ctx.db.get(a.eventId);
      if (!e || e.updatedAt !== a.eventUpdatedAt || !(await eligible(ctx, e)))
        continue;
      const verified = a.independent
        ? !!(await liveEvidence(ctx, a, cache))
        : (
            await resolveCredit(
              ctx,
              e,
              { name: a.name, key: a.nameKey, handle: a.handle },
              cache,
            )
          )?.profileId === profileId;
      if (verified)
        visible.push({
          eventId: a.eventId,
          name: a.name,
          venue: a.venue,
          date: a.date,
          status: a.status,
        });
    }
    return {
      page: visible,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const wakeAffectedAppearances = internalMutation({
  args: {
    kind: v.union(v.literal("name"), v.literal("handle")),
    value: v.string(),
    sourceEventId: v.id("events"),
    fromDate: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const options = { cursor: args.cursor, numItems: 4 };
    const rows = ctx.db.query("performerRegistryAppearances");
    const page = await (
      args.kind === "handle"
        ? rows.withIndex("by_handle_date", (q) =>
            q.eq("handle", args.value).gte("date", args.fromDate),
          )
        : rows.withIndex("by_name_date", (q) =>
            q.eq("nameKey", args.value).gte("date", args.fromDate),
          )
    ).paginate(options);
    for (const id of new Set(page.page.map((row) => row.eventId))) {
      if (id === args.sourceEventId) continue;
      const event = await ctx.db.get(id);
      if (
        !event ||
        event.date < getBelgradeDayKey() ||
        !(await eligible(ctx, event))
      )
        continue;
      const { row, label } = await evidenceInputs(ctx, id);
      const cachedGenre =
        row?.model === "performer-registry-v1" &&
        row.eventUpdatedAt === event.updatedAt;
      const cachedRole =
        label?.eventUpdatedAt === event.updatedAt &&
        (label.model === "performer-registry-v1" ||
          readEventEvidenceRecord(label.auditJson).performerRegistryCategory ===
            true);
      const own =
        label?.eventUpdatedAt === event.updatedAt ? label.taxonomy : null;
      if (
        !cachedGenre &&
        !cachedRole &&
        ((row?.eventUpdatedAt === event.updatedAt && row.matches.length) ||
          own?.genres.length)
      )
        continue;
      const programme = await lookupPerformerRegistryProgramme(ctx, event);
      const previousGenre = cachedGenre ? row.matches : [];
      const newRole = (!own || cachedRole) && programme.category;
      if (
        !exactJsonValue(previousGenre, programme.matches) ||
        (cachedRole ? own?.primaryCategory !== programme.category : !!newRole)
      ) {
        await schedulePublishedDiscovery(ctx, id);
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        1000,
        internal.performerRegistry.wakeAffectedAppearances,
        { ...args, cursor: page.continueCursor },
      );
    return null;
  },
});
