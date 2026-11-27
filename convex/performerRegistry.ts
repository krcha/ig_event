import { v } from "convex/values";
import { invalidateAccountRank } from "./performerAccountQueue";
import { directoryCardByName, directoryCards, directoryConfirmsHandle, directoryGenres, reviewedDirectoryBooking, syncDirectoryEventSearch } from "./performerDirectory";
import { loadScopedPerformerHandles } from "./occurrencePerformerCredits";
import type { PerformerHandleCredit } from "../lib/taxonomy/performer-genre-research";
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
  accountEvidence,
  performerBackfillPhase,
  performerEvidence,
} from "./performerRegistryValues";
import { musicGenre } from "./eventDiscoveryValues";
import {
  canonicalProfile,
  confirmsBillingHandle,
  evidenceForCredits,
  profileKey,
  registryCredits,
  registryBilledArtists,
  registryInstagramHandle,
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
async function profilesByInstagram(ctx: ReadCtx, handle: string): Promise<Profile[]> {
  const [indexed, legacy] = await Promise.all([
    ctx.db.query("performerRegistryProfiles").withIndex("by_instagram_handle", q => q.eq("instagramHandle", handle)).take(2),
    profileByKey(ctx, "handle:" + handle),
  ]);
  return [...new Map([...indexed, ...(legacy ? [legacy] : [])].map(row => [row._id, row])).values()];
}
function namedProfiles(ctx: ReadCtx, nameKey: string, limit: number) {
  return ctx.db.query("performerRegistryProfiles").withIndex("by_name", q =>
    q.eq("nameKey", nameKey).gt("independentAppearances", 0)).take(limit);
}
async function currentBilling(ctx: ReadCtx, a: Appearance, handle: string, loaded?: Event): Promise<boolean> {
  if (a.handle !== handle) return false;
  const event = loaded ?? await ctx.db.get(a.eventId);
  if (!event || event.updatedAt !== a.eventUpdatedAt || !(await eligible(ctx, event))) return false;
  const { label } = await evidenceInputs(ctx, event._id);
  if (!musicCompatible(event, label)) return false;
  const scoped = await loadScopedPerformerHandles(ctx, event);
  const credit = registryCredits(registryBilledArtists(event), scoped).find(c => c.key === a.nameKey && c.handle === handle);
  return !!credit && confirmsBillingHandle(event, credit, scoped);
}
/** Scoped billing can reuse an artist's documented name or their confirmed billing alias on the very same account. */
async function matchesAccountName(ctx:ReadCtx, profile:Profile, credit:Credit, handle:string, verified:boolean) {
  if (credit.key===profile.nameKey || credit.name.toLowerCase()==="@"+handle || profile.name.toLowerCase()==="@"+handle) return true;
  if (!verified || profile.instagramHandle!==handle) return false;
  const display=profile.accountEvidence?.handle===handle ? profile.accountEvidence.displayName?.value : undefined;
  const compact=(v:string)=>normalizeTaxonomyText(v.normalize("NFKC")).replaceAll(" ","");
  if (display && (credit.key===normalizeTaxonomyText(display) || (compact(credit.name).length>=4 && compact(credit.name)===compact(display)))) return true;
  if ((await directoryCards(ctx, profile)).some(card => compact(card.artistName) === compact(credit.name))) return true;
  const aliases=await ctx.db.query("performerRegistryAppearances").withIndex("by_profile_billing_name",q=>
    q.eq("profileId",profile._id).eq("handle",handle).eq("nameKey",credit.key).eq("confirmedBilling",true)).order("desc").take(MAX_SOURCES);
  for (const a of aliases) if (await currentBilling(ctx,a,handle)) return true;
  return false;
}

export async function currentAccountAppearance(ctx:ReadCtx,a:Appearance,handle:string,event?:Event) {
  if (a.confirmedBilling && await currentBilling(ctx,a,handle,event)) return true;
  return a.evidence?.verifiedHandle===handle && (await liveEvidence(ctx,a,new Map()))?.verifiedHandle===handle;
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
export async function visibleInstagramHandle(ctx: ReadCtx, profile: Profile, sources: RegistryEvidence[]): Promise<string | null> {
  const handle = profile.instagramHandle ?? (profile.identityKey.startsWith("handle:") ? registryInstagramHandle(profile.identityKey.slice(7)) : undefined);
  if (!handle) return null;
  if (sources.some(s => s.verifiedHandle === handle) || (profile.accountEvidence?.handle===handle &&
      (profile.accountEvidence.displayName || profile.accountEvidence.genres.length))) return handle;
  const bills = await ctx.db.query("performerRegistryAppearances").withIndex("by_profile_billing", q =>
    q.eq("profileId", profile._id).eq("handle", handle).eq("confirmedBilling", true)).order("desc").take(MAX_SOURCES);
  for (const a of bills) if (await currentBilling(ctx, a, handle)) return handle;
  if (await directoryConfirmsHandle(ctx, profile, handle)) return handle;
  return null;
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
      const performerHandles = await loadScopedPerformerHandles(ctx, e);
      return evidenceForCredits(e, row, label, performerHandles);
    })();
    cache.set(a.eventId, pending);
  }
  const entry = (await pending).find(
    (c) =>
      c.credit.key === a.nameKey && (!a.handle || c.credit.handle === a.handle),
  );
  // Revisions may change metadata, remove an appearance or replace its underlying
  // proof. A stale registration never republishes the previous quote or identity.
  if (!entry?.proof) return;
  if (exactJsonValue(entry.proof, a.evidence)) return entry.proof;
  // A pre-handle profile can keep its independently checked facts until sync.
  // A newly discovered handle itself is published only after that sync.
  if (!a.handle && !a.evidence.verifiedHandle && entry.proof.verifiedHandle) {
    const { verifiedHandle, ...oldShape } = entry.proof;
    if (verifiedHandle && exactJsonValue(oldShape, a.evidence))
      return a.evidence;
  }
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
async function resolveRegistryCredit(
  ctx: ReadCtx,
  event: Event,
  credit: Credit,
  cache: SourceCache,
  targetBilling = false,
) {
  const urls = urlsInSummary(event);
  if (!credit.handle && !urls.size && !localName(credit)) return;
  const byHandle = credit.handle ? await profilesByInstagram(ctx, credit.handle) : [];
  const profiles = byHandle.length ? byHandle : await namedProfiles(ctx, credit.key, 2);
  if (profiles.length !== 1) return;
  const p = profiles[0];
  if (credit.handle && p.instagramHandle && credit.handle !== p.instagramHandle) return;
  if (credit.handle && !await matchesAccountName(ctx,p,credit,credit.handle,targetBilling)) return;
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
  const origins = [];
  for (const a of rows) {
    if (a.eventId !== event._id) origins.push({ a, proof: await liveEvidence(ctx, a, cache),
      billed: targetBilling && !!credit.handle && a.confirmedBilling === true && await currentBilling(ctx, a, credit.handle) });
  }
  const linkedAccounts = new Set(origins.flatMap(({ proof, billed }) =>
    credit.handle && proof && (billed || proof.verifiedHandle === credit.handle) && proof.profileUrl ? [canonicalProfile(proof.profileUrl)] : []));
  for (const { a, proof, billed } of origins) {
    if (
      !proof ||
      (credit.handle &&
        proof.verifiedHandle &&
        proof.verifiedHandle !== credit.handle)
    )
      continue;
    const handle = credit.handle && (billed || proof.verifiedHandle === credit.handle ||
      (proof.profileUrl && linkedAccounts.has(canonicalProfile(proof.profileUrl))));
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
  const account = p.accountEvidence;
  const specialProgramme = specialPerformerProgramme(event);
  const billedAccount = !specialProgramme && targetBilling && credit.handle && account?.handle === credit.handle && account.genres.length ? account : undefined;
  if (billedAccount) {
    const profileUrl = "https://www.instagram.com/" + billedAccount.handle + "/";
    const display = billedAccount.displayName;
    supported.push({ kind: "web", verifiedHandle: billedAccount.handle, profileUrl,
      identity: display ? { url: display.url, quote: display.quote } : { url: profileUrl, quote: "@" + billedAccount.handle },
      genres: billedAccount.genres.map(g => ({ genre: g.genre, url: g.url, quote: g.quote, dominant: g.dominant === true })) });
  }
  if (!specialProgramme && ((targetBilling && credit.handle && credit.handle === p.instagramHandle) || urls.size)) {
    for (const card of await directoryCards(ctx, p)) {
      if (!(targetBilling && credit.handle && credit.handle === p.instagramHandle) && !urls.has(canonicalProfile(card.url))) continue;
      const genres = directoryGenres(card);
      if (!genres.length) continue;
      supported.push({
        kind: "editorial", profileUrl: card.url, identity: { url: card.url, quote: card.artistName },
        genres: genres.map(genre => ({ genre, url: card.url, quote: card.labels.join(", "), dominant: false })),
      });
    }
  }
  if (supported.length)
    return { profileId: p._id, supported, primaryGenre: p.primaryGenre, billedAccount };
}

function specialPerformerProgramme(event: Event) {
  return /\b(?:tribute|homm?age|listening (?:party|session)|cover (?:night|set)|album playback|filmsk[aoi] projekcij\w*|vece posveceno)\b/u.test(
    normalizeTaxonomyText([event.title,event.description].filter(Boolean).join(" ")));
}

async function resolveCredit(ctx: ReadCtx, event: Event, credit: Credit, cache: SourceCache, targetBilling = false) {
  const existing = await resolveRegistryCredit(ctx, event, credit, cache, targetBilling);
  if (existing || credit.handle || specialPerformerProgramme(event)) return existing;
  const booking = await reviewedDirectoryBooking(ctx, event, credit.name);
  if (!booking) return;
  const { card, profile } = booking;
  const genres = directoryGenres(card);
  const supported: RegistryEvidence[] = [{ kind: "editorial", identity: { url: card.url, quote: card.artistName },
    genres: genres.map(genre => ({ genre, url: card.url, quote: card.labels.join(", "), dominant: false })) }];
  return { profileId: profile._id, supported, primaryGenre: profile.primaryGenre, billedAccount: undefined };
}

function namesSameSoloAct(title: string, billed: string, account: NonNullable<Profile["accountEvidence"]>) {
  const nameKey = (value: string) => normalizeTaxonomyText(value.normalize("NFKC")).replace(/\bbend$/u, "band");
  const name = nameKey(billed);
  const display = nameKey(account.displayName?.value ?? "");
  if (!display || name.length < 4 || name !== nameKey(title) || /^(?:band|bend|singer|artist|dj|live|music|muzika|grupa|izvodjac)$/u.test(name)) return false;
  if (display === name) return true;
  // An OCR title can lose the stroke in Đ. Require an independently bound
  // source spelling the entire same name with Đ before accepting that variant.
  return display.includes(" ") && display.replaceAll("dj", "d") === name && account.genres.some(({ quote, binding }) =>
    !!binding && /đ/iu.test(quote) && (" " + nameKey(quote) + " ").includes(" " + display + " ") &&
    (" " + nameKey(quote.replace(/đ/giu, "d")) + " ").includes(" " + name + " "));
}

/** Match earlier independent sources only. Returning [] lets ordinary research continue. */
export async function lookupPerformerRegistryProgramme(
  ctx: ReadCtx,
  event: Event,
  scopedHandles?: readonly PerformerHandleCredit[],
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
  const billedArtists = registryBilledArtists(event);
  const verifiedBilling = scopedHandles ?? (await loadScopedPerformerHandles(ctx, event));
  let credits = registryCredits(billedArtists, verifiedBilling);
  if (credits.length !== billedArtists.length || !credits.length) return empty;
  const context = getEventDiscoveryTaxonomy(event);
  if (
    context.categories.some(
      (c) => c !== "party" && c !== "live" && c !== "other",
    )
  )
    return empty;
  const cache: SourceCache = new Map();
  let resolved = await Promise.all(
    credits.map((credit) => resolveCredit(ctx, event, credit, cache, confirmsBillingHandle(event, credit, verifiedBilling))),
  );
  if (credits.length === 2) {
    const named = credits.findIndex(credit => !credit.handle);
    const accountIndex = 1 - named;
    const account = resolved[accountIndex]?.billedAccount;
    if (named >= 0 && !resolved[named] && account && credits[accountIndex].name.toLowerCase() === "@" + account.handle &&
      namesSameSoloAct(event.title, credits[named].name, account)) {
      resolved = [resolved[accountIndex]];
      credits = [credits[named]];
    }
  }
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
  scopedHandles?: readonly PerformerHandleCredit[],
): Promise<{ performer: string; profileUrl: string }[]> {
  if (
    !event.artists.length ||
    event.artists.length > 8 ||
    !(await eligible(ctx, event))
  )
    return [];
  const billedArtists = registryBilledArtists(event);
  const credits = registryCredits(
    billedArtists,
    scopedHandles ?? (await loadScopedPerformerHandles(ctx, event)),
  );
  if (credits.length !== billedArtists.length) return [];
  const cache: SourceCache = new Map();
  const hints: { performer: string; profileUrl: string }[] = [];
  for (const credit of credits) {
    const social = credit.handle ? await profilesByInstagram(ctx, credit.handle) : [];
    // A stage name can find the source for a future researcher even when the
    // announcement has no social handle. The researcher must still confirm identity.
    const directory = await directoryCardByName(ctx, credit.name);
    if (directory && (!credit.handle || (social.length === 1 && social[0]._id === directory.profile._id)) &&
      (await directoryCards(ctx, directory.profile)).some(card => card.url === directory.card.url)) {
      hints.push({ performer: credit.name, profileUrl: directory.card.url });
      continue;
    }
    const candidates = social.length ? social : await ctx.db
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

export function primaryGenreForProfile(support: Profile["support"], sources: NonNullable<Profile["accountEvidence"]>["genres"]) {
  const styles = new Set([...support.filter(s=>s.dominant>0).map(s=>s.genre),...sources.filter(s=>s.dominant).map(s=>s.genre)]);
  return styles.size === 1 ? [...styles][0] : undefined;
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

  await ctx.db.patch(profileId, {
    support,
    independentAppearances,
    primaryGenre: primaryGenreForProfile(support,profile.accountEvidence?.genres ?? []),
  });
}
type RegistryChanges = { profilesCreated: number; handlesAdded: number; handlesCleared: number; billingLinksWritten: number };
const emptyChanges = (): RegistryChanges => ({ profilesCreated: 0, handlesAdded: 0, handlesCleared: 0, billingLinksWritten: 0 });
async function attachProfileHandle(ctx: MutationCtx, profile: Profile, credit: Credit, changes: RegistryChanges, handle?: string, verified=false) {
  if (handle && profile.instagramHandle && handle !== profile.instagramHandle) return;
  if (handle && profile.identityKey.startsWith("handle:") && profile.identityKey !== "handle:" + handle) return;
  const sameName = credit.key === profile.nameKey || credit.name.toLowerCase() === "@" + handle;
  const upgradeName = !!handle && profile.name.toLowerCase() === "@" + handle && !credit.name.startsWith("@");
  if (handle && !sameName && !upgradeName && !await matchesAccountName(ctx,profile,credit,handle,verified)) return;
  if (upgradeName || (handle && profile.instagramHandle !== handle)) {
    if (handle && !profile.instagramHandle) changes.handlesAdded++;
    await ctx.db.patch(profile._id, { ...(handle ? { instagramHandle: handle } : {}),
      ...(upgradeName ? { name: credit.name, nameKey: credit.key } : {}) });
  }
  return profile._id;
}

async function ensureProfile(
  ctx: MutationCtx, event: Event, credit: Credit, proof: RegistryEvidence | undefined, billed: boolean, changes: RegistryChanges,
) {
  if (!proof && !billed) return;
  const handle = proof?.verifiedHandle ?? (billed ? credit.handle : undefined);
  const identityKey = proof ? profileKey(event._id, credit, proof) : "handle:" + handle;
  // A profile definition can supply the artist's display name when the poster
  // bills only an account, e.g. "Coolares Band is a rock group …".
  const subject = proof?.identity.quote.match(/^([\p{L}\p{M}\d .'’-]{2,75}?)\s+(?:is|are|je|su)\s/iu)?.[1]?.trim();
  const namedCredit = handle && subject && credit.name.toLowerCase() === "@" + handle &&
    normalizeTaxonomyText(subject).replaceAll(" ", "") === normalizeTaxonomyText(handle).replaceAll(" ", "")
    ? { ...credit, name: subject, key: normalizeTaxonomyText(subject) } : credit;
  const byAccount = handle ? await profilesByInstagram(ctx, handle) : [];
  if (byAccount.length > 1) return;
  const byOriginalKey = await profileByKey(ctx, identityKey);
  const byUrl = proof?.profileUrl && proof.verifiedHandle ? await profileByKey(ctx, profileKey(event._id, credit, { ...proof, verifiedHandle: undefined })) : null;
  const exact = new Map([byAccount[0], byUrl, byOriginalKey].filter((p): p is Profile => !!p).map(p => [p._id, p]));
  if (exact.size > 1) return;
  const stored = [...exact.values()][0];
  if (stored) return attachProfileHandle(ctx, stored, namedCredit, changes, handle, billed || proof?.verifiedHandle===handle);

  // A common display name is never sufficient to attach a social account or carry a style.
  const named = await namedProfiles(ctx, credit.key, 4);
  if (named.length >= 4) return;
  const candidates = [];
  const cache: SourceCache = new Map();
  for (const p of named) {
    for (const a of await profileSources(ctx, p._id)) {
      const prior = await liveEvidence(ctx, a, cache);
      const sharedUrl = proof?.profileUrl && prior?.profileUrl &&
        canonicalProfile(prior.profileUrl) === canonicalProfile(proof.profileUrl);
      if (sharedUrl || (handle && a.handle === handle && await currentBilling(ctx, a, handle))) {
        candidates.push(p);
        break;
      }
    }
  }
  if (candidates.length > 1) return;
  if (candidates.length) return attachProfileHandle(ctx, candidates[0], namedCredit, changes, handle, billed || proof?.verifiedHandle===handle);
  if (!proof && named.some(p => !p.instagramHandle)) return;
  changes.profilesCreated++;
  if (handle) changes.handlesAdded++;
  return ctx.db.insert("performerRegistryProfiles", {
    identityKey: handle ? "handle:" + handle : identityKey, name: namedCredit.name, nameKey: namedCredit.key,
    ...(handle ? { instagramHandle: handle } : {}), independentAppearances: 0, support: [],
  });
}

async function clearWithdrawnHandle(ctx: MutationCtx, profileId: Profile["_id"], changes: RegistryChanges) {
  const p = await ctx.db.get(profileId);
  if (!p?.instagramHandle || p.accountEvidence?.handle===p.instagramHandle) return;
  const handle = p.instagramHandle;
  const billed = await ctx.db.query("performerRegistryAppearances").withIndex("by_profile_billing", q =>
    q.eq("profileId", profileId).eq("handle", handle).eq("confirmedBilling", true)).take(1);
  if (billed.length) return;
  const verified = await ctx.db.query("performerRegistryAppearances").withIndex("by_profile_verified_handle", q =>
    q.eq("profileId", profileId).eq("evidence.verifiedHandle", handle)).take(1);
  if (!verified.length && !await directoryConfirmsHandle(ctx, p, handle)) {
    await ctx.db.patch(profileId, { instagramHandle: undefined });
    changes.handlesCleared++;
  }
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
): Promise<RegistryChanges> {
  const changes = emptyChanges();
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
  const previousProfileIds = new Set<Profile["_id"]>();
  const changedBillings = new Set<Profile["_id"]>();
  const pending = new Map(
    previous.map((a) => [JSON.stringify([a.nameKey, a.handle ?? null]), a]),
  );
  if (event && event.artists.length && (await eligible(ctx, event))) {
    const { row, label } = await evidenceInputs(ctx, eventId);
    const scoped = await loadScopedPerformerHandles(ctx, event);
    const entries = musicCompatible(event, label)
      ? evidenceForCredits(
          event,
          row,
          label,
          scoped,
        )
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
      const billed = confirmsBillingHandle(event, credit, scoped);
      const profileId = proof || billed
        ? await ensureProfile(ctx, event, credit, proof, billed, changes)
        : (await resolveCredit(ctx, event, credit, cache))?.profileId;
      const data: AppearanceFields = {
        eventId,
        eventUpdatedAt: event.updatedAt,
        name: credit.name,
        nameKey: credit.key,
        ...(credit.handle ? { handle: credit.handle } : {}),
        ...(profileId ? { profileId } : {}),
        ...(profileId && billed ? { confirmedBilling: true as const } : {}),
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
      if (data.confirmedBilling && (!old?.confirmedBilling || old.profileId !== profileId || old.handle !== data.handle)) changes.billingLinksWritten++;
      if (old) {
        const { _id, _creationTime, ...fields } = old;
        void _creationTime;
        if (exactJsonValue(fields, data)) continue;
        if (old.profileId) previousProfileIds.add(old.profileId);
        await ctx.db.replace(_id, data);
      } else await ctx.db.insert("performerRegistryAppearances", data);
      if (profileId && (data.confirmedBilling || proof?.verifiedHandle)) changedBillings.add(profileId);
      if (old?.profileId && (old.confirmedBilling || old.evidence?.verifiedHandle)) changedBillings.add(old.profileId);
      if (
        wakeBackfilledLink &&
        !proof &&
        old?.profileId !== profileId &&
        event.date >= getBelgradeDayKey()
      )
        linkedDuringBackfill ||= !!profileId && !!(await ctx.db.get(profileId))?.independentAppearances;
      if (profileId && credit.handle && data.confirmedBilling && proof && !old?.confirmedBilling) {
        wakes.set("handle:" + credit.handle, { kind: "handle", value: credit.handle });
      }
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
    if (old.confirmedBilling && old.handle && old.evidence) wakes.set("handle:" + old.handle, { kind: "handle", value: old.handle });
    if (old.profileId) previousProfileIds.add(old.profileId);
    if (old.profileId && (old.confirmedBilling || old.evidence?.verifiedHandle)) changedBillings.add(old.profileId);
    await ctx.db.delete(old._id);
    if (old.profileId && old.evidence)
      await updateSupport(ctx, old.profileId, old.evidence);
  }
  for (const id of previousProfileIds) await clearWithdrawnHandle(ctx, id, changes);
  for (const id of changedBillings) await invalidateAccountRank(ctx,id);
  if (event?.directorySearchCredits) await syncDirectoryEventSearch(ctx, event);
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
  return changes;
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

/** Reconcile confirmed Instagram identities in bounded local transactions. */
export const backfillInstagramHandles = internalMutation({
  args: { phase: v.union(v.literal("billing"), v.literal("research")), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ examined: v.number(), events: v.number(), isDone: v.boolean(), cursor: v.union(v.string(), v.null()),
    profilesCreated: v.number(), handlesAdded: v.number(), handlesCleared: v.number(), billingLinksWritten: v.number() }),
  handler: async (ctx, { phase, cursor }) => {
    const options = { cursor, numItems: 6, maximumBytesRead: 400_000 };
    const page = phase === "billing"
      ? await ctx.db.query("performerRegistryAppearances").withIndex("by_handle_date", q => q.gt("handle", undefined)).paginate(options)
      : await ctx.db.query("eventPerformerGenreResearch").paginate(options);
    const ids = [...new Set(page.page.map(a => a.eventId))];
    const changes = emptyChanges();
    for (const id of ids) {
      const result = await syncPerformerRegistryForEvent(ctx, id, true);
      changes.profilesCreated += result.profilesCreated;
      changes.handlesAdded += result.handlesAdded;
      changes.handlesCleared += result.handlesCleared;
      changes.billingLinksWritten += result.billingLinksWritten;
    }
    return { ...changes, examined: page.page.length, events: ids.length, isDone: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});

export const findProfiles = internalQuery({
  args: { name: v.string() },
  returns: v.object({
    profiles: v.array(
      v.object({
        profileId: v.id("performerRegistryProfiles"),
        name: v.string(),
        instagramHandle: v.optional(v.union(v.string(), v.null())),
      }),
    ),
    more: v.boolean(),
  }),
  handler: async (ctx, { name }) => {
    if (!name.trim() || name.length > 100) return { profiles: [], more: false };
    const exact = /^@|^https?:\/\//iu.test(name.trim());
    const handle = exact ? registryInstagramHandle(name) : undefined;
    if (exact && !handle) return { profiles: [], more: false };
    const rows = handle ? await profilesByInstagram(ctx, handle) : await ctx.db
      .query("performerRegistryProfiles")
      .withIndex("by_name", (q) =>
        q
          .eq("nameKey", normalizeTaxonomyText(name)),
      )
      .order("desc")
      .take(9);
    if (handle && rows.length !== 1) return { profiles: [], more: false };
    const byStage = !handle && await directoryCardByName(ctx, name);
    const reviewed = byStage && (await directoryCards(ctx, byStage.profile)).some(card => card.url === byStage.card.url)
      ? byStage.profile : undefined;
    if (reviewed && !rows.some(p => p._id === reviewed._id)) rows.unshift(reviewed);
    const visible = [];
    for (const p of rows) {
      if (!p.independentAppearances && !p.instagramHandle && p._id !== reviewed?._id) continue;
      let instagramHandle: string | null = null;
      if (handle || p.instagramHandle || p.identityKey.startsWith("handle:")) {
        const sources = await profileSources(ctx, p._id);
        const current = [];
        const cache: SourceCache = new Map();
        for (const a of sources) {
          const proof = await liveEvidence(ctx, a, cache);
          if (proof) current.push(proof);
        }
        instagramHandle = await visibleInstagramHandle(ctx, p, current);
        if ((handle || (!p.independentAppearances && p._id !== reviewed?._id)) && !instagramHandle) continue;
      }
      visible.push({ profileId: p._id, name: p.name, instagramHandle });
    }
    return {
      profiles: visible.slice(0, 8),
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
      instagramHandle: v.optional(v.union(v.string(), v.null())),
      genres: v.array(musicGenre),
      accountEvidence: v.optional(accountEvidence),
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
    const instagramHandle = await visibleInstagramHandle(ctx, p, sources.map(s=>s.evidence));
    const account = instagramHandle && p.accountEvidence?.handle === instagramHandle ? p.accountEvidence : undefined;
    const cards = await directoryCards(ctx, p);
    const genres = [...new Set([...sources.flatMap(s => s.evidence.genres.map(g => g.genre)),
      ...(account?.genres.map(g => g.genre) ?? []), ...cards.flatMap(directoryGenres)])];
    const dominant = new Set(
      sources.flatMap((s) =>
        s.evidence.genres.filter((g) => g.dominant).map((g) => g.genre),
      ),
    );
    for (const g of account?.genres ?? []) if (g.dominant) dominant.add(g.genre);
    return {
      name: p.name,
      instagramHandle,
      ...(account ? {accountEvidence:account} : {}),
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
      const verified = a.confirmedBilling && a.handle && await currentBilling(ctx, a, a.handle) ? true : a.independent
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
    sourceEventId: v.optional(v.id("events")),
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
