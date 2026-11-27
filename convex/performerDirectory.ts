import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { performerSearchOccurrence } from "./publicEventProjection";
import type { Doc, Id } from "./_generated/dataModel";
import { directoryFields, directoryProof } from "./performerRegistryValues";
import { directoryGenreKeys } from "../lib/taxonomy/performer-account-styles";
import { canPublishPerformerGenreSource } from "../lib/taxonomy/performer-genre-research";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types";
import { exactJsonValue } from "../lib/events/exact-json-value";
import { registryInstagramHandle } from "./performerRegistryEvidence";

type ReadCtx = Pick<QueryCtx, "db">;
type Profile = Doc<"performerRegistryProfiles">;
type Proof = Infer<typeof directoryProof>;
const directoryEntry = v.object(directoryFields);
type Entry = Infer<typeof directoryEntry>;

const cardPattern = /^https:\/\/djs\.rs\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const eventPattern = /^https:\/\/djs\.rs\/e\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const creditKey = (name: string) => normalizeTaxonomyText(name.normalize("NFKC")).replaceAll(" ", "");
const short = (s: string) => s === s.trim() && s.length > 0 && s.length <= 160;
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");

function pinnedUrl(profile: Profile) {
  if (!profile.identityKey.startsWith("profile:")) return;
  try {
    const value: unknown = JSON.parse(profile.identityKey.slice(8));
    if (Array.isArray(value) && typeof value[1] === "string") return value[1] as string;
  } catch { return; }
}

function reviewedProfileHandle(profile: Profile, proofs: Proof[]) {
  // The registry already pins this RA artist page. Only its literal outgoing
  // Instagram profile link can attach a new handle to that same person.
  const source = pinnedUrl(profile);
  if (!source || !/^https:\/\/(?:[a-z]{2}\.)?ra\.co\/dj\/[\w-]+\/?$/u.test(source)) return;
  const handles = new Set(proofs.flatMap(proof => {
    if (proof.kind !== "identity" || !sameUrl(proof.localUrl, source) || !sameUrl(proof.url, source) ||
      !/^https:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.]+\/?$/u.test(proof.quote)) return [];
    const handle = registryInstagramHandle(proof.quote);
    return handle ? [handle] : [];
  }));
  return handles.size === 1 ? [...handles][0] : undefined;
}

export async function directoryConfirmsHandle(ctx: ReadCtx, profile: Profile, handle: string) {
  if (!profile.identityKey.startsWith("profile:")) return false;
  return (await directoryCards(ctx, profile)).some(card => reviewedProfileHandle(profile, card.proofs) === handle);
}

// Only reviewed source cards carry artist styles. A bill is evidence of one appearance.
export async function directoryCards(ctx: ReadCtx, profile: Profile) {
  const cards = await ctx.db.query("performerDirectoryLinks")
    .withIndex("by_profile_kind", q => q.eq("profileId", profile._id).eq("kind", "artist")).take(8);
  const current = [];
  for (const card of cards) {
    if (card.identityKey !== profile.identityKey) continue;
    for (const proof of card.proofs) {
      if (await validatesAnchor(ctx, profile, proof)) {
        current.push(card);
        break;
      }
    }
  }
  return current;
}

export function directoryGenres(card: Doc<"performerDirectoryLinks">) {
  return directoryGenreKeys(card.labels);
}

export async function directoryCardByName(ctx: ReadCtx, name: string) {
  const cards = await ctx.db.query("performerDirectoryLinks")
    .withIndex("by_kind_credit", q => q.eq("kind", "artist").eq("creditKey", creditKey(name))).take(2);
  if (cards.length !== 1 || !cards[0].profileId) return;
  const card = cards[0];
  const profile = await ctx.db.get(cards[0].profileId);
  if (!profile || profile.identityKey !== card.identityKey) return;
  return { card, profile };
}

export async function reviewedDirectoryBooking(ctx: ReadCtx, event: Doc<"events">, name: string) {
  const match = await directoryCardByName(ctx, name);
  if (!match) return;
  const { card, profile } = match;
  for (const proof of card.proofs) {
    if (proof.kind === "booking" && proof.eventId === event._id && proof.localName === name &&
      proof.date === event.date && proof.venue === event.venue && await validatesAnchor(ctx, profile, proof)) return { card, profile };
  }
}

function proofKey(proof: Proof) {
  return JSON.stringify(proof.kind === "booking" ? [proof.kind, proof.eventId, proof.url] :
    [proof.kind, proof.localUrl, proof.url]);
}

function shapeIsValid(entry: Entry) {
  const card = entry.kind === "artist";
  const urlOk = card ? cardPattern.test(entry.url) && !/\/(?:events|djs|venues|organizers|about|login)$/.test(entry.url) : eventPattern.test(entry.url);
  return urlOk && short(entry.artistName) && !!creditKey(entry.artistName) &&
    entry.labels.length <= 32 && entry.labels.every(short) && (card || !entry.labels.length) &&
    entry.proofs.length > 0 && entry.proofs.length <= 24 &&
    entry.proofs.every(p => p.kind === "booking"
      ? eventPattern.test(p.url) && (card || (p.url === entry.url && creditKey(p.creditedAs) === creditKey(entry.artistName))) &&
        /^\d{4}-\d{2}-\d{2}$/.test(p.date) && [p.localName, p.creditedAs, p.venue, p.sourceVenue].every(short) &&
        p.coBill.length <= 24 && p.coBill.every(short) && (!p.variantSource || (!card &&
          p.variantSource.url !== p.url && canPublishPerformerGenreSource(p.variantSource.url) &&
          p.variantSource.quote.length >= 4 && p.variantSource.quote.length <= 400))
      : card && canPublishPerformerGenreSource(p.localUrl) && canPublishPerformerGenreSource(p.url) &&
        p.quote.trim().length >= 4 && p.quote.length <= 600);
}

type Event = Doc<"events">;
type Appearance = Doc<"performerRegistryAppearances">;
type Link = Doc<"performerDirectoryLinks">;
type BookingContext = { event: Event | null; appearances: Appearance[] };

async function bookingAppearances(ctx: ReadCtx, eventId: Id<"events">) {
  return ctx.db.query("performerRegistryAppearances").withIndex("by_event", q => q.eq("eventId", eventId)).take(129);
}

async function validatesAnchor(ctx: ReadCtx, p: Profile | null, proof: Proof, context?: BookingContext) {
  if (proof.kind === "identity") {
    if (!p) return false;
    // The reviewer checked the named DJS card against a source bound to THIS registry identity.
    const handle = p.instagramHandle ?? (p.identityKey.startsWith("handle:") ? p.identityKey.slice(7) : undefined);
    if (handle && sameUrl(proof.localUrl, "https://www.instagram.com/" + handle + "/")) return true;
    const url = pinnedUrl(p);
    return !!url && sameUrl(url, proof.localUrl);
  }
  const [event, appearances] = context ? [context.event, context.appearances] as const :
    await Promise.all([ctx.db.get(proof.eventId), bookingAppearances(ctx, proof.eventId)]);
  if (!event || event.date !== proof.date || event.status !== "approved" || event.venue !== proof.venue ||
      event.publicationState !== "publishable" || appearances.length >= 129) return false;
  const named = appearances.filter(a => a.name === proof.localName && a.date === proof.date &&
    a.venue === proof.venue && a.eventUpdatedAt === event.updatedAt);
  if (named.some(a => a.profileId && a.profileId !== p?._id)) return false;
  if (p && named.some(a => a.profileId === p._id)) return true;
  if (!p || p.identityKey.startsWith("directory:")) {
    const credited = creditKey(proof.creditedAs);
    const name = proof.localName.replace(/\s+\([\p{L}\p{N}@_. ]{1,40}\)$/u, "");
    if (!credited || !(named.length > 0 || event.artists.includes(proof.localName))) return false;
    if (creditKey(name) === credited) return true;
    // Only an occurrence may carry a reviewed spelling correction. Require an
    // additional published source and two other performers on both bills.
    if (p || !proof.variantSource || !creditKey(proof.variantSource.quote).includes(credited)) return false;
    const others = new Set(event.artists.filter(act => act !== proof.localName).map(creditKey));
    return new Set(proof.coBill.map(creditKey).filter(key => key !== credited && others.has(key))).size >= 2;
  }
  // Historical billings sometimes predate registry linking. Accept the exact name of
  // one registry identity, with that same name in the event's published artist list.
  if (p.name !== proof.localName || !event.artists.includes(proof.localName)) return false;
  const names = await ctx.db.query("performerRegistryProfiles")
    .withIndex("by_name", q => q.eq("nameKey", p.nameKey)).take(2);
  return names.length === 1 && names[0]._id === p._id;
}

// Recompute from reviewed, event-bound booking proofs only. Profile-only
// identity evidence cannot add a name to another event's search results.
export async function syncDirectoryEventSearch(ctx: MutationCtx, event: Event, newSource?: Link["_id"]) {
  const requested = new Set(event.directorySearchCredits?.sources ?? []);
  if (newSource) requested.add(newSource);
  if (!requested.size) return false;
  const sources: Link["_id"][] = [];
  const names = new Set<string>();
  const context = { event, appearances: await bookingAppearances(ctx, event._id) };
  for (const id of [...requested].sort()) {
    const link = await ctx.db.get(id);
    if (!link) continue;
    const bookings = link.proofs.filter((proof): proof is Extract<Proof, { kind: "booking" }> =>
      proof.kind === "booking" && proof.eventId === event._id);
    if (!bookings.length) continue;
    sources.push(id);
    const profile = link.profileId ? await ctx.db.get(link.profileId) : null;
    if (link.profileId && (!profile || profile.identityKey !== link.identityKey)) continue;
    for (const proof of bookings) {
      if (await validatesAnchor(ctx, profile, proof, context)) {
        names.add(link.artistName);
        names.add(proof.creditedAs);
      }
    }
  }
  const credits = sources.length ? { sources, revision: event.updatedAt,
    occurrence: performerSearchOccurrence(event), names: [...names].sort() } : undefined;
  if (exactJsonValue(event.directorySearchCredits, credits)) return false;
  // Derived fields must not advance the source revision or invalidate its receipts.
  await ctx.db.patch(event._id, { directorySearchCredits: credits });
  return true;
}

const SEARCH_BATCH = 4;
function bookingEvents(link: Link) {
  return [...new Set(link.proofs.flatMap(proof => proof.kind === "booking" ? [proof.eventId] : []))].sort();
}
async function refreshLinkSearch(ctx: MutationCtx, link: Link, after?: string) {
  const ids = bookingEvents(link).filter(id => !after || id > after);
  const batch = ids.slice(0, SEARCH_BATCH);
  let changed = 0;
  for (const eventId of batch) {
    const event = await ctx.db.get(eventId);
    if (event && await syncDirectoryEventSearch(ctx, event, link._id)) changed++;
  }
  return { changed, after: ids.length > batch.length ? batch[batch.length - 1] : null };
}

// One CLI call handles one link and at most four distinct events. The returned
// cursor/after pair can resume safely; concurrent new and changed links self-sync.
export const backfillSearchCredits = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), after: v.optional(v.string()) },
  returns: v.object({ cursor: v.union(v.string(), v.null()), after: v.union(v.string(), v.null()), done: v.boolean(), changed: v.number() }),
  handler: async (ctx, args) => {
    const cursor = args.cursor ?? null;
    const page = await ctx.db.query("performerDirectoryLinks").paginate({ cursor, numItems: 1 });
    const result = page.page[0] ? await refreshLinkSearch(ctx, page.page[0], args.after) : { after: null, changed: 0 };
    return { ...result, done: !result.after && page.isDone, cursor: result.after ? cursor : page.isDone ? null : page.continueCursor };
  },
});

export const continueSearchCredits = internalMutation({
  args: { sourceId: v.id("performerDirectoryLinks"), after: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.sourceId);
    if (link) await refreshWrittenLink(ctx, link, args.after);
    return null;
  },
});

async function refreshWrittenLink(ctx: MutationCtx, link: Link, after?: string) {
  const result = await refreshLinkSearch(ctx, link, after);
  if (result.after) await ctx.scheduler.runAfter(0, internal.performerDirectory.continueSearchCredits,
    { sourceId: link._id, after: result.after });
}

// This is the private write boundary for an operator-reviewed directory comparison.
// Online evidence is checked prior to import. The transaction verifies local anchors and ownership.
export const record = internalMutation({
  args: { entry: directoryEntry, apply: v.boolean() },
  returns: v.union(v.literal("invalid"), v.literal("conflict"), v.literal("stale"),
    v.literal("insert"), v.literal("update"), v.literal("unchanged")),
  handler: async (ctx, { entry, apply }) => {
    if (!shapeIsValid(entry)) return "invalid" as const;
    let p: Profile | null = null;
    if (entry.profileId) {
      p = await ctx.db.get(entry.profileId);
      if (!p || p.identityKey !== entry.identityKey) return "stale" as const;
    } else {
      if (entry.proofs.some(proof => proof.kind !== "booking")) return "invalid" as const;
      if (entry.identityKey.startsWith("directory:")) {
        const cardUrl = entry.identityKey.slice("directory:".length);
        if (!cardPattern.test(cardUrl) || (entry.kind === "artist" && entry.url !== cardUrl)) return "invalid" as const;
        p = await ctx.db.query("performerRegistryProfiles").withIndex("by_identity", q => q.eq("identityKey", entry.identityKey)).unique();
        if (entry.kind === "billing") {
          if (!p) return "stale" as const;
          const [card] = await ctx.db.query("performerDirectoryLinks").withIndex("by_source_credit", q => q.eq("url", cardUrl)).take(1);
          if (card?.profileId !== p._id || !entry.proofs.every(booking => booking.kind === "booking" && card.proofs.some(proof =>
            proof.kind === "booking" && proof.eventId === booking.eventId && proof.url === booking.url && proof.localName === booking.localName))) return "stale" as const;
        }
      } else if (entry.kind !== "billing" || entry.proofs.some(proof =>
        proof.kind !== "booking" || entry.identityKey !== "booking:" + proof.eventId)) return "invalid" as const;
    }
    for (const proof of entry.proofs) if (!await validatesAnchor(ctx, p, proof)) return "stale" as const;
    const key = creditKey(entry.artistName);
    const owners = await ctx.db.query("performerDirectoryLinks").withIndex("by_source_credit", q =>
      entry.kind === "artist" ? q.eq("url", entry.url) : q.eq("url", entry.url).eq("creditKey", key)).take(2);
    const old = owners[0];
    if (owners.length > 1 || (old && (old.profileId !== p?._id || old.identityKey !== entry.identityKey))) return "conflict" as const;
    const proofs = new Map((old?.proofs ?? []).map(proof => [proofKey(proof), proof]));
    for (const proof of entry.proofs) proofs.set(proofKey(proof), proof);
    if (proofs.size > 64) return "invalid" as const;
    const reviewed = p && entry.kind === "artist" ? reviewedProfileHandle(p, [...proofs.values()]) : undefined;
    let addHandle = false;
    if (p && reviewed && reviewed !== p.instagramHandle) {
      const [indexed, legacy] = await Promise.all([
        ctx.db.query("performerRegistryProfiles").withIndex("by_instagram_handle", q => q.eq("instagramHandle", reviewed)).take(2),
        ctx.db.query("performerRegistryProfiles").withIndex("by_identity", q => q.eq("identityKey", "handle:" + reviewed)).unique(),
      ]);
      if (p.instagramHandle || indexed.some(row => row._id !== p._id) || (legacy && legacy._id !== p._id)) return "conflict" as const;
      addHandle = true;
      if (apply) await ctx.db.patch(p._id, { instagramHandle: reviewed });
    }
    let profileId = p?._id;
    if (!p && entry.kind === "artist") {
      const keys = new Set([entry.artistName, ...entry.proofs.flatMap(proof => proof.kind === "booking" ? [proof.localName] : [])]
        .map(name => normalizeTaxonomyText(name)));
      for (const nameKey of keys) {
        const names = await ctx.db.query("performerRegistryProfiles").withIndex("by_name", q => q.eq("nameKey", nameKey)).take(1);
        if (names.length) return "conflict" as const;
      }
      if (apply) profileId = await ctx.db.insert("performerRegistryProfiles", { name: entry.artistName,
        nameKey: normalizeTaxonomyText(entry.artistName), identityKey: entry.identityKey, support: [], independentAppearances: 0 });
    }
    const row = { ...entry, ...(profileId ? {profileId} : {}), creditKey: key, labels: [...new Set(entry.labels)].sort(), proofs: [...proofs.values()] };
    let attachedAppearance = false;
    if (apply && profileId) {
      for (const proof of entry.proofs) {
        if (proof.kind !== "booking") continue;
        const event = await ctx.db.get(proof.eventId);
        const appearances = await ctx.db.query("performerRegistryAppearances")
          .withIndex("by_event", q => q.eq("eventId", proof.eventId)).take(129);
        for (const a of appearances) {
          if (!a.profileId && a.eventUpdatedAt === event?.updatedAt && a.name === proof.localName &&
            a.date === proof.date && a.venue === proof.venue) {
            await ctx.db.patch(a._id, {profileId});
            attachedAppearance = true;
          }
        }
      }
    }
    const unchanged = old && !addHandle && old.artistName === row.artistName &&
      exactJsonValue(old.labels, row.labels) && exactJsonValue(old.proofs, row.proofs);
    if (unchanged) {
      if (attachedAppearance) await refreshWrittenLink(ctx, old);
      return "unchanged" as const;
    }
    if (apply) {
      let sourceId: Link["_id"];
      if (old) {
        await ctx.db.replace(old._id, row);
        sourceId = old._id;
      } else {
        sourceId = await ctx.db.insert("performerDirectoryLinks", row);
      }
      const link = await ctx.db.get(sourceId);
      if (link) await refreshWrittenLink(ctx, link);
    }
    return old ? "update" as const : "insert" as const;
  },
});

export const forProfile = internalQuery({
  args: { profileId: v.id("performerRegistryProfiles") },
  returns: v.array(directoryEntry),
  handler: async (ctx, { profileId }) => {
    const rows = await ctx.db.query("performerDirectoryLinks")
      .withIndex("by_profile_kind", q => q.eq("profileId", profileId)).take(128);
    return rows.map(({ profileId, identityKey, kind, url, artistName, labels, proofs }) =>
      ({ profileId, identityKey, kind, url, artistName, labels, proofs }));
  },
});
