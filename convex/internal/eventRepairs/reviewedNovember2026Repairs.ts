import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  hasHumanReviewedStructuredSourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { parseCanonicalEventPayload } from "../../../lib/domain/occurrences/canonical-event-payload";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { requireAdminOrServiceSecret } from "../../authz";
import { isSupportedExtractionModel } from "../extractionModel";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { evaluateEventPublication, isEventPubliclyVisible } from "../../publicationPolicy";
import { savedEventRepository } from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import {
  prepareInstagramOccurrenceTopologyForDedicatedReattestation,
  reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences,
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { assertApprovalCandidatePolicy, assertPersistedServiceSourcePolicy } from "../../eventDomain/sourceApproval";

// Exact user-reviewed November 6/7 incidents. No caller-supplied ID, date,
// source, title, time, venue, or artist may enroll another occurrence here.
export const NOVEMBER_2026_REVIEWS = {
  "bife-nov7": {
    date: "2026-11-07", venueId: "k178fbdgy1q0pw56qd5qphvfkn896008", handle: "bifebar",
    rows: [
      ["j577tr534ay5fdhm9vghza8qt58hnj0t", "DfUpd_zCItW", "PAD KRA PAO", "17:00"],
      ["j57c2akrmvh7rt3x4xfj3c0ndn8hmvx3", "DfUpd_zCItW", "AUX OF PAIN", "20:00"],
    ],
    nextTitle: "Pad Kra Pao",
    nextArtists: ["Aux of Pain", "Felix Bondarev", "Anton Berezin"],
    nextDescription: "Pad Kra Pao food special from 17:00 (700 RSD per dish), followed by Aux of Pain with Felix Bondarev and Anton Berezin from 20:00. The dish price is not an admission fee.",
    removeTicketPrice: true,
  },
  "vrtoglavica-nov6": {
    date: "2026-11-06", venueId: "k17ada8w8a4wgdhmnr9rq7ma3h897gfq", handle: "vrtoglavicaklub",
    rows: [
      ["j57emjde9hz7yn8a8875hha5sd8h4j1m", "De_wNGJi2w5", "Suicide Disco", "23:00-05:00"],
      ["j575e8b3n3e525djrv3aggnvqd8h599n", "De_wNGJi2w5", "Chillout Zone", "23:00-05:00"],
      ["j5763y2c3p6a77wcmczeymbqys8h5v5q", "De_wNGJi2w5", "Divorced Dad Rock", "23:00-05:00"],
    ],
    nextTitle: "Suicide Disco / Divorced Dad Rock",
    nextDescription: "One Vrtoglavica night, 23:00-05:00: Donji Klub - Suicide Disco with DJ Gavra and DJ RedRev; Gornji Klub - Divorced Dad Rock; Sredina / Vertigo Pub - Chillout Zone.",
  },
  "kuko-nov7": {
    date: "2026-11-07", venueId: "k179bp5gyxrpchbmf3phqwwe1s896z56", handle: "musicreactions",
    rows: [
      ["j578jtqtf9p1ckhrzp4eec4w198dfdr9", "Dcn2uZTCH2H", "KUKO ANL WORLD TOUR", "TBD"],
      ["j570yv7ew6ejvv7wj9h4dxs5758hkn13", "DfShPcoiAN4", "KUKO All Night Long", "TBD"],
      ["j573ztgwf4dvwa6ysat6q4y8z18gg4ee", "DemWopPCK05", "KUKO All Night Long", "TBD"],
      ["j5706v33hbd99y5959efe39ggh8hqx3d", "DfXJ_CcIKeq", "KUKO ALL NIGHT LONG", "TBD"],
    ],
    nextTitle: "KUKO All Night Long",
  },
  "dksg-nov6": {
    date: "2026-11-06", venueId: "k17b9jfjeatn3r0at2147hm1t9896j17", handle: "",
    rows: [
      ["j57bjfm2che5etgz0ew3qcj5m58hfvnp", "DfOy33Zhv0z", "\u0424\u0418\u041b\u041c \u201e\u0414\u0415\u0422\u0415 \u041d\u041e\u040b\u0418", "20:00"],
      ["j574fnwjf44re8meb3m5pv5nth8hafkj", "DfHXpNMNrNW", "Friday Program at Dom kulture Studentski grad", "20:00"],
    ],
    nextTitle: "Dete no\u0107i",
  },
  "bitef-nov6": {
    date: "2026-11-06", venueId: "k17bxvgdvjfwd92aa4drwbndn5896bzb", handle: "",
    rows: [
      ["j5711fams3rvneezkv35srzqvn8hkv5d", "DfR0H7clxOX", "Ne\u010dista krv", "20:00"],
      ["j5725qtskq3150jwnkhwh8bh6x8hq62p", "DfWm1pRh23Y", "Ne\u010diste krvi", "TBD"],
      ["j574ry2hfjx0pxkzpw5zk0h4t98h9gj7", "DfPMMidCu30", "\u041d\u0415\u0427\u0418\u0421\u0422\u0410 \u041a\u0420\u0412", "20:00"],
    ],
  },
  "ladidadi-nov6": {
    date: "2026-11-06", venueId: "k174najg8yc8jksdmrsps5znr58970vq", handle: "",
    rows: [
      ["j576n6c3n6wghjamyckxxew5q18h8gfy", "DfE4tbHOYz3", "Ladidadi - winter edition", "22:00-04:00"],
      ["j57age49qn45vtvg6z12s2fxq18hnmtf", "DfUeNOsjouM", "Igor Simi\u0107", "22:00"],
      ["j57fx9qqdr37ywfn492y77r6f98h57vg", "De_umvvOKYj", "Igor Simi\u0107 & band", "22:00"],
    ],
  },
  "tranzit-nov6": {
    date: "2026-11-06", venueId: "k17c39syhz99748nvqaybz1s0h897p8p", handle: "",
    rows: [
      ["j57bx8xrb42hnvgeqfmx00mafd8hekzs", "DfPZUBECrOw", "Ku\u0107a Dobrog Ritma", "23:00"],
      ["j572w72jswmh8t2b3rxn12d9xn8hmvcz", "DfUlq8yiRlJ", "@vujos_kaljevic", "TBD"],
    ],
  },
} as const;

export type November2026GroupKey = keyof typeof NOVEMBER_2026_REVIEWS;
type ReadCtx = QueryCtx | MutationCtx;
const MAX_ROWS = 32;
const MAX_SAVES = 100;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const BITEF_RETAINED_SOURCES = [
  { code: "DfEpAnJtj4U", linkId: "kx7evzc6gnhcypf755bm8a8r558h9sp9", key: "instagram-occurrence-v2:7af554834084ea90cf27a67569daa431b09663b522787571476a64bd0a6409bc" },
  { code: "DfPMMidCu30", linkId: "kx71vqyt7qghnyn7wa8e964pds8hfxht", key: "instagram-occurrence-v2:31126e9cc2382e4b46f75f6f3948de874b267682576dff6124038334c6af13db" },
] as const;
const fail = (message: string): never => { throw new Error(`Reviewed November repair: ${message}`); };
const parseFields = (event: Doc<"events">): Record<string, unknown> => {
  const fields: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fail("invalid normalized evidence.");
  return fields as Record<string, unknown>;
};
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sorted = <T extends { _id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a._id.localeCompare(b._id));

/** One transaction snapshot; every write discards all cached point reads. */
export function withNovember2026ReadCache<T extends ReadCtx>(ctx: T): T {
  const reads = new Map<string, Promise<unknown>>();
  const queries = new Map<string, Promise<unknown>>();
  const writes = new Set(["patch", "delete", "insert", "replace"]);
  const clear = () => { reads.clear(); queries.clear(); };
  const keyFor = (value: unknown): string | null => {
    const encode = (item: unknown): unknown => {
      if (item === null) return ["null"];
      if (item === undefined) return ["undefined"];
      if (typeof item === "string" || typeof item === "boolean") return [typeof item, item];
      if (typeof item === "number") return ["number", Object.is(item, -0) ? "-0" : String(item)];
      if (typeof item === "bigint") return ["bigint", String(item)];
      if (Array.isArray(item)) return ["array", item.map(encode)];
      if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
        return ["object", Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, encode(entry)])];
      }
      throw new Error("Unsupported query cache key.");
    };
    try { return JSON.stringify(encode(value)); } catch { return null; }
  };
  const wrapRange = (range: object, bounds: unknown[]): object => new Proxy(range, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (typeof property === "string" && ["eq", "gt", "gte", "lt", "lte"].includes(property)) {
        return (...args: unknown[]) => {
          bounds.push([property, args]);
          const next: unknown = Reflect.apply(method, target, args);
          return next && typeof next === "object" ? wrapRange(next, bounds) : next;
        };
      }
      return method.bind(target);
    },
  });
  const wrapQuery = (query: object, steps: unknown[]): object => new Proxy(query, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property === "withIndex") {
        return (name: unknown, configure?: unknown) => {
          const bounds: unknown[] = [];
          const args = typeof configure === "function"
            ? [name, (range: object) => Reflect.apply(configure, undefined, [wrapRange(range, bounds)])]
            : configure === undefined ? [name] : [name, configure];
          // The native builder invokes the user's callback exactly once. The
          // captured actual bounds distinguish closures with different IDs.
          const next: unknown = Reflect.apply(method, target, args);
          return next && typeof next === "object" ? wrapQuery(next, [...steps, [property, name, bounds]]) : next;
        };
      }
      if (property === "order") {
        return (...args: unknown[]) => {
          const next: unknown = Reflect.apply(method, target, args);
          return next && typeof next === "object" ? wrapQuery(next, [...steps, [property, args]]) : next;
        };
      }
      if (property === "take" || property === "first" || property === "unique") {
        return (...args: unknown[]) => {
          const key = keyFor([...steps, [property, args]]);
          let value = key ? queries.get(key) : undefined;
          if (!value) {
            value = Reflect.apply(method, target, args) as Promise<unknown>;
            if (key) queries.set(key, value);
          }
          // Callers may sort an array they read; its cached order is immutable.
          return value.then((result: unknown) => Array.isArray(result) ? [...result] : result);
        };
      }
      // Unknown builder operations use the original, uncached native chain.
      return method.bind(target);
    },
  });
  const db = new Proxy(ctx.db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property === "get") {
        return (...args: unknown[]) => {
          const key = JSON.stringify(args);
          const cached = reads.get(key);
          if (cached) return cached;
          const value = Reflect.apply(method, target, args) as Promise<unknown>;
          reads.set(key, value);
          return value;
        };
      }
      if (property === "query") {
        return (...args: unknown[]) => {
          const query: unknown = Reflect.apply(method, target, args);
          return query && typeof query === "object" ? wrapQuery(query, [["query", args]]) : query;
        };
      }
      if (typeof property === "string" && writes.has(property)) {
        return async (...args: unknown[]) => {
          clear();
          try { return await Reflect.apply(method, target, args) as unknown; }
          finally { clear(); }
        };
      }
      // Storage, authentication and all other APIs keep their original behavior.
      // This cache never exists outside these two incident handlers.
      return method.bind(target);
    },
  });
  return { ...ctx, db };
}

function contextDigest(context: unknown): string {
  const serialized = stableJson(context);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONTEXT_BYTES) return fail("frozen incident context exceeds its bounded proof size.");
  return sha256Hex(serialized);
}

async function requireService(ctx: ReadCtx, secret: string): Promise<string> {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") return fail("service authentication is required.");
  return auth.actor;
}

async function loadContext(ctx: ReadCtx, groupKey: November2026GroupKey) {
  const review = NOVEMBER_2026_REVIEWS[groupKey];
  if (!review) return fail("unknown frozen incident.");
  const events: Doc<"events">[] = [];
  for (const [id] of review.rows) {
    const event = await ctx.db.get(id as Id<"events">);
    if (!event) return fail("a pinned event disappeared.");
    events.push(event);
  }
  const primary = events[0]!;
  const venue = await ctx.db.get(review.venueId as Id<"venues">);
  if (!venue || !isVenuePublic(venue) || primary.venueId !== venue._id || primary.venue !== venue.name) {
    return fail("the primary must first bind the exact public target venue.");
  }
  const marker = parseFields(primary).reviewedNovember2026Repair as { groupKey?: unknown; role?: unknown; operationId?: unknown; primaryId?: unknown; componentIds?: unknown } | undefined;
  const complete = marker?.groupKey === groupKey && marker.role === "primary";
  if (complete && (primary.status !== "approved" || marker.operationId !== `reviewed-november-2026:${groupKey}:v1` ||
    marker.primaryId !== primary._id || !exactJsonValue(marker.componentIds, events.slice(1).map((event) => event._id)) ||
    events.slice(1).some((event) => event.status !== "rejected" ||
      (parseFields(event).reviewedNovember2026Repair as { groupKey?: unknown; role?: unknown } | undefined)?.groupKey !== groupKey ||
      (parseFields(event).reviewedNovember2026Repair as { role?: unknown } | undefined)?.role !== "component") ||
    primary.title !== ("nextTitle" in review ? review.nextTitle : review.rows[0]![2]) ||
    (primary.time ?? "TBD") !== review.rows[0]![3] ||
    ("nextArtists" in review && !exactJsonValue(primary.artists, [...review.nextArtists])) ||
    ("nextDescription" in review && primary.description !== review.nextDescription) ||
    ("removeTicketPrice" in review && primary.ticketPrice !== undefined))) {
    return fail("an applied incident has inconsistent payload or component markers.");
  }
  const links: Doc<"instagramEventSources">[] = [];
  const occurrences: Doc<"sourceOccurrences">[] = [];
  const receiptsById = new Map<string, Doc<"instagramSourceOccurrenceReceipts">>();
  const sourcesById = new Map<string, Doc<"scrapedPosts">>();
  const selectedIds = new Set(events.map((event) => event._id));
  for (const [index, event] of events.entries()) {
    const pin = review.rows[index]!;
    const fields = parseFields(event);
    const retainedBitefSources = groupKey === "bitef-nov6" && event._id === "j574ry2hfjx0pxkzpw5zk0h4t98h9gj7";
    if ((!complete && (index === 0 ? event.status !== "approved" : !["approved", "pending"].includes(event.status))) ||
      event.date !== review.date || event.title !== (complete && index === 0 && "nextTitle" in review ? review.nextTitle : pin[2]) || (event.time ?? "TBD") !== pin[3] ||
      event.instagramPostUrl !== `https://www.instagram.com/p/${pin[1]}/` ||
      (groupKey !== "kuko-nov7" && event.venueId !== venue._id) ||
      (review.handle && fields.sourceGroundingInstagramHandle !== review.handle) ||
      (!complete && (isCrossPostCampaignLineageEvent(event) || fields.reviewedNovember2026Repair !== undefined)) ||
      fields.extractionContractVersion !== "event_evidence_v2" || fields.extractionIsEvent !== true ||
      fields.sourceGroundingVersion !== 5 || fields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2") {
      return fail("a pinned event, date, source, or semantic row changed.");
    }
    const eventLinks = complete && retainedBitefSources
      ? (await Promise.all(BITEF_RETAINED_SOURCES.map((source) => ctx.db.query("instagramEventSources")
          .withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", `instagram-source-identity-v1:${source.code}`)
            .eq("sourceOccurrenceKey", source.key)).take(2)))).flat()
      : complete ? await ctx.db.query("instagramEventSources")
          .withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", `instagram-source-identity-v1:${pin[1]}`)
            .eq("sourceOccurrenceKey", event.sourceOccurrenceKey!)).take(2)
      : await ctx.db.query("instagramEventSources")
          .withIndex("by_event", (q) => q.eq("eventId", event._id)).take(3);
    if (eventLinks.length !== (retainedBitefSources ? 2 : 1)) return fail("original source-link cohort changed.");
    if (retainedBitefSources && (event.sourceOccurrenceKey !== BITEF_RETAINED_SOURCES[0].key ||
      fields.sourceOccurrenceKey !== BITEF_RETAINED_SOURCES[1].key ||
      !BITEF_RETAINED_SOURCES.every((source) => eventLinks.some((link) => link._id === source.linkId &&
        link.sourceIdentity === `instagram-source-identity-v1:${source.code}` && link.sourceOccurrenceKey === source.key)))) {
      return fail("the exact retained Bitef source cohort changed.");
    }
    for (const link of eventLinks) {
      if (link.eventId !== (complete ? primary._id : event._id) || (!retainedBitefSources && (link.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
        link.sourceOccurrenceKey !== fields.sourceOccurrenceKey || link.sourceFingerprint !== fields.sourceOccurrenceSourceFingerprint))) {
        return fail("source link evidence is incomplete.");
      }
      const occurrenceRows = link.sourceOccurrenceId
        ? [await ctx.db.get(link.sourceOccurrenceId)]
        : await ctx.db.query("sourceOccurrences")
            .withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", link.sourceIdentity)
              .eq("sourceOccurrenceKey", link.sourceOccurrenceKey)).take(2);
      const occurrence = occurrenceRows.length === 1 ? occurrenceRows[0] : null;
      // A historical compatibility link can legitimately predate first-class
      // materialization. Never invent an observed occurrence to repair it.
      if (occurrenceRows.length > 1 || (link.sourceOccurrenceId && !occurrence) ||
        (occurrence && (occurrence.state !== "satisfied" || occurrence.canonicalEventId !== (complete ? primary._id : event._id) ||
          occurrence.sourceIdentity !== link.sourceIdentity || occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
          occurrence.sourceFingerprint !== link.sourceFingerprint))) return fail("first-class occurrence changed.");
      const receiptRows = await ctx.db.query("instagramSourceOccurrenceReceipts")
        .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", link.sourceIdentity)).take(2);
      if (receiptRows.length !== 1) return fail("source receipt is not unique.");
      const receipt = receiptRows[0]!;
      assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
      const expected = (receipt.expectedOccurrences ?? []).filter((row) => row.key === link.sourceOccurrenceKey);
      const satisfied = receipt.satisfiedOccurrences.filter((row) => row.key === link.sourceOccurrenceKey);
      if (receipt.sourceFingerprint !== link.sourceFingerprint || expected.length !== 1 || satisfied.length !== 1 ||
        satisfied[0]!.eventId !== (complete ? primary._id : event._id) || !sourceOccurrenceRepresentativeMatchesExpected(complete ? primary : event, expected[0]) ||
        receipt.deferredChildCount !== 0 || receipt.deferredChildKeys.length !== 0 ||
        receipt.expectedKeys.length !== receipt.satisfiedKeys.length || receipt.expectedKeys.length > MAX_ROWS) {
        return fail("selected receipt row is incomplete or inconsistent.");
      }
      const sourceRows = occurrence
        ? [await ctx.db.get(occurrence.sourceDocumentId)]
        : await ctx.db.query("scrapedPosts")
            .withIndex("by_handle_postId", (q) => q.eq("handle", String(fields.sourceGroundingInstagramHandle))
              .eq("postId", event.instagramPostId!)).take(2);
      const source = sourceRows.length === 1 ? sourceRows[0] : null;
      const historicalBitefSource = retainedBitefSources && link.sourceIdentity === "instagram-source-identity-v1:DfEpAnJtj4U";
      const historicalPayload = historicalBitefSource ? parseCanonicalEventPayload(occurrence?.canonicalEventJson) : null;
      const historicalFields = historicalPayload ? JSON.parse(historicalPayload.normalizedFieldsJson) as Record<string, unknown> : null;
      if (!source || source.postId !== (historicalBitefSource ? link.instagramPostId : event.instagramPostId) ||
        source.instagramPostUrl !== (historicalBitefSource ? link.instagramPostUrl : event.instagramPostUrl) ||
        source.caption !== (historicalBitefSource ? historicalFields?.sourceGroundingSourceCaption : event.sourceCaption) ||
        (!historicalBitefSource && source.postedAt !== event.sourcePostedAt) ||
        source.analysisRevision !== (source.sourceRevision ?? 1) || (occurrence && occurrence.sourceRevision !== (source.sourceRevision ?? 1)) ||
        source.analysisContractVersion !== "event_evidence_v2" || source.analysisIsEvent !== true ||
        !isSupportedExtractionModel(source.analysisModel) || (!historicalBitefSource && source.analysisResultJson !== event.rawExtractionJson)) {
        return fail("persisted source analysis or revision changed.");
      }
      if (historicalBitefSource) {
        if (!historicalFields || !historicalPayload || !source.analysisResultJson ||
          historicalFields.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
          historicalFields.sourceOccurrenceSourceFingerprint !== link.sourceFingerprint ||
          historicalFields.sourceGroundingInstagramPostId !== link.instagramPostId ||
          historicalFields.sourceGroundingInstagramPostUrl !== link.instagramPostUrl) return fail("retained Bitef canonical source evidence changed.");
        const reviewedFields = JSON.stringify({ ...historicalFields,
          humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION });
        const sourceCandidate: Doc<"events"> = { ...event, status: "approved", title: String(historicalFields.title),
          date: String(historicalFields.normalizedDate), time: historicalPayload.time,
          venue: String(historicalFields.normalizedVenue), artists: historicalFields.artists as string[],
          instagramPostId: source.postId, instagramPostUrl: source.instagramPostUrl,
          sourceCaption: source.caption, sourcePostedAt: source.postedAt, rawExtractionJson: source.analysisResultJson,
          imageUrl: undefined, imageStorageId: undefined, normalizedFieldsJson: reviewedFields,
          humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
          reviewedAt: event.updatedAt, reviewedBy: "service:reviewed-november-source-proof",
          moderationNote: "Exact retained Bitef source row independently reviewed for the November 6 performance." };
        if (!sourceOccurrenceRepresentativeMatchesExpected(sourceCandidate, {
          key: link.sourceOccurrenceKey, title: event.title, date: event.date, time: event.time,
          venue: event.venue, artists: event.artists,
        })) return fail("retained Bitef source binding differs from the selected performance.");
        if (!(await isCanonicallyGroundedApprovedEvent(ctx, sourceCandidate))) return fail("retained Bitef source does not independently prove the selected performance.");
      }
      links.push(link); if (occurrence) occurrences.push(occurrence);
      receiptsById.set(receipt._id, receipt); sourcesById.set(source._id, source);
    }
  }
  const siblingsById = new Map<string, Doc<"events">>();
  for (const receipt of receiptsById.values()) {
    for (const satisfaction of receipt.satisfiedOccurrences) {
      if (selectedIds.has(satisfaction.eventId)) continue;
      const sibling = await ctx.db.get(satisfaction.eventId);
      const expected = receipt.expectedOccurrences?.filter((row) => row.key === satisfaction.key) ?? [];
      if (!sibling || expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(sibling, expected[0])) {
        return fail("an unrelated receipt sibling is incomplete.");
      }
      siblingsById.set(sibling._id, sibling);
      if (siblingsById.size > MAX_ROWS) return fail("receipt sibling bound exceeded.");
    }
  }
  const saves = [];
  for (const event of events) {
    const refs = await savedEventRepository.loadEventReferences(ctx, event._id, { limit: MAX_SAVES });
    if (complete && event._id !== primary._id && (refs.canonical.length || refs.legacy.length)) return fail("an applied component retains saved references.");
    saves.push({ eventId: event._id, canonical: sorted(refs.canonical), legacy: sorted(refs.legacy) });
  }
  if (complete) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
    if (topology.links.length !== review.rows.length + (groupKey === "bitef-nov6" ? 1 : 0) || topology.currentOccurrences.length !== occurrences.length ||
      !(await isEventPubliclyVisible(ctx, primary))) return fail("applied incident publication or provenance is incomplete.");
    for (const component of events.slice(1)) {
      const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, component._id);
      if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("applied component retained provenance.");
    }
  }
  return { groupKey, complete, primaryId: primary._id, events, links, occurrences,
    receipts: sorted([...receiptsById.values()]),
    sources: sorted([...sourcesById.values()]), venue, siblings: sorted([...siblingsById.values()]), saves };
}

export async function getReviewedNovember2026ContextHandler(ctx: QueryCtx,
  args: { groupKey: November2026GroupKey; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  await requireService(ctx, args.serviceSecret);
  const context = await loadContext(ctx, args.groupKey);
  return { ...context, contextSha256: contextDigest(context) };
}

export async function consolidateReviewedNovember2026Handler(ctx: MutationCtx,
  args: { groupKey: November2026GroupKey; expectedContextSha256: string; moderationNote: string; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx);
  const actor = await requireService(ctx, args.serviceSecret);
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (note.length < 30 || note.length > 1000 || !/^[a-f0-9]{64}$/u.test(args.expectedContextSha256)) {
    return fail("a bounded reviewed context and substantive note are required.");
  }
  const context = await loadContext(ctx, args.groupKey);
  if (context.complete) return fail("incident is already applied; inspect the final context.");
  if (contextDigest(context) !== args.expectedContextSha256) return fail("reviewed context changed; preview again.");
  const review = NOVEMBER_2026_REVIEWS[args.groupKey];
  const primary = context.events[0]!;
  const components = context.events.slice(1);
  const selectedIds = new Set(context.events.map((event) => event._id));
  const now = Date.now();
  const operationId = `reviewed-november-2026:${args.groupKey}:v1`;
  const marker = { policyVersion: 1, operationId, groupKey: args.groupKey, primaryId: primary._id,
    componentIds: components.map((event) => event._id), reviewedAt: now, reviewedBy: actor };
  const fields = parseFields(primary);
  const title = "nextTitle" in review ? review.nextTitle : primary.title;
  const artists = "nextArtists" in review ? [...review.nextArtists] : primary.artists;
  const description = "nextDescription" in review ? review.nextDescription : primary.description;
  const nextFields: Record<string, unknown> = { ...fields, title, artists,
    ...(description !== undefined ? { description } : {}),
    moderationAutoApproved: false, moderationAutoApproveRule: null,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedNovember2026Repair: { ...marker, role: "primary" } };
  const removeTicketPrice = "removeTicketPrice" in review && review.removeTicketPrice;
  if (removeTicketPrice) {
    delete nextFields.ticketPrice;
    // These model/extraction fields remain in immutable rawExtractionJson.
    // The curated admission-price display must not reuse a food price.
    nextFields.reviewedFoodPrice = { amount: "700 RSD", item: "Pad Kra Pao", startTime: "17:00" };
  }
  const effectivePrimary: Doc<"events"> = { ...primary, title, artists,
    ...(description !== undefined ? { description } : {}),
    ...(removeTicketPrice ? { ticketPrice: undefined } : {}),
    normalizedFieldsJson: JSON.stringify(nextFields),
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note };
  if (!hasHumanReviewedStructuredSourceAttestation(effectivePrimary.normalizedFieldsJson, effectivePrimary)) {
    return fail("review did not bind the complete final public payload.");
  }
  // The public predicate below also proves historical reviewed events. The
  // ordinary service-approval predicate intentionally accepts future dates only.
  if (hasHumanReviewableStructuredSourceAttestation(effectivePrimary.normalizedFieldsJson, effectivePrimary)) {
    await assertPersistedServiceSourcePolicy(ctx, effectivePrimary, { allowHumanReviewedStructured: true });
  }
  await assertApprovalCandidatePolicy(ctx, effectivePrimary, context.events.map((event) => event._id));
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) return fail("final public source proof failed.");
  // Capture exact original topology before changing any expected bindings.
  const topologies = [];
  for (const component of components) topologies.push(await prepareInstagramOccurrenceTopologyForDedicatedReattestation(ctx, component._id));
  const siblingsBefore = [];
  for (const sibling of context.siblings) siblingsBefore.push({ event: sibling,
    decision: await evaluateEventPublication(ctx, sibling),
    visible: await isEventPubliclyVisible(ctx, sibling, { allowNeverMigratedApproved: true }) });
  const receiptPlans = context.receipts.map((receipt) => {
    const selectedKeys = new Set(context.links.filter((link) => link.sourceIdentity === receipt.sourceIdentity).map((link) => link.sourceOccurrenceKey));
    const expectedOccurrences = receipt.expectedOccurrences!.map((row) => selectedKeys.has(row.key)
      ? { ...row, title, date: primary.date, time: primary.time, venue: primary.venue, artists } : row);
    const satisfiedOccurrences = receipt.satisfiedOccurrences.map((row) => selectedIds.has(row.eventId)
      ? { ...row, eventId: primary._id } : row);
    return { receipt, expectedOccurrences, satisfiedOccurrences };
  });
  for (const plan of receiptPlans) for (const satisfaction of plan.satisfiedOccurrences) {
    const expected = plan.expectedOccurrences.filter((row) => row.key === satisfaction.key);
    const representative = satisfaction.eventId === primary._id ? effectivePrimary : await ctx.db.get(satisfaction.eventId);
    if (expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(representative, expected[0])) {
      return fail("review would invalidate an existing receipt satisfaction.");
    }
  }
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, now);
  await ctx.db.patch(primary._id, { title, artists,
    ...(description !== undefined ? { description } : {}),
    ...(removeTicketPrice ? { ticketPrice: undefined } : {}),
    normalizedFieldsJson: effectivePrimary.normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note, updatedAt: primaryUpdatedAt });
  for (const plan of receiptPlans) await ctx.db.patch(plan.receipt._id, {
    expectedOccurrences: plan.expectedOccurrences, satisfiedOccurrences: plan.satisfiedOccurrences,
    updatedAt: nextEventUpdatedAt(plan.receipt.updatedAt, now) });
  let movedSaveCount = 0; let dedupedSaveCount = 0;
  for (const [index, component] of components.entries()) {
    await ctx.db.patch(component._id, { status: "rejected", reviewedAt: now, reviewedBy: actor,
      moderationNote: `[reviewed_november_component:v1] ${operationId} - ${note}`,
      normalizedFieldsJson: JSON.stringify({ ...parseFields(component), reviewedNovember2026Repair: { ...marker, role: "component" } }),
      updatedAt: nextEventUpdatedAt(component.updatedAt, now) });
    await reassignInstagramOccurrenceReferences(ctx, component._id, primary._id, topologies[index]!);
    const saves = await reassignSavedEventReferences(ctx, component._id, primary._id);
    movedSaveCount += saves.movedCount; dedupedSaveCount += saves.dedupedCount;
  }
  for (const link of context.links) {
    const plan = receiptPlans.find((item) => item.receipt.sourceIdentity === link.sourceIdentity)!;
    const expected = plan.expectedOccurrences.find((row) => row.key === link.sourceOccurrenceKey)!;
    await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, {
      expected, representative: effectivePrimary, sourceFingerprint: link.sourceFingerprint,
      sourceLink: link, topologyEpochVerified: true });
  }
  const finalTopology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  if (finalTopology.links.length !== context.links.length || finalTopology.currentOccurrences.length !== context.occurrences.length) {
    return fail("final primary source topology is incomplete.");
  }
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(ctx, primary._id, effectivePrimary);
  for (const component of components) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, component._id);
    if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("a rejected component retained source references.");
  }
  for (const before of context.occurrences) {
    const after = await ctx.db.get(before._id);
    if (!after || after.factsJson !== before.factsJson || after.canonicalEventJson !== before.canonicalEventJson ||
      after.sourceDocumentId !== before.sourceDocumentId || after.sourceRevision !== before.sourceRevision) {
      return fail("immutable observed source evidence changed.");
    }
  }
  // One at a time keeps every publication refresh synchronous; no deferred hold.
  for (const event of context.events) await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  const publishedPrimary = await ctx.db.get(primary._id);
  if (!publishedPrimary || (await evaluateEventPublication(ctx, publishedPrimary)).state !== "publishable" ||
    !(await isEventPubliclyVisible(ctx, publishedPrimary))) return fail("retained primary is not publicly visible.");
  for (const before of siblingsBefore) {
    const after = await ctx.db.get(before.event._id);
    if (!after || !exactJsonValue(after, before.event) || !exactJsonValue(await evaluateEventPublication(ctx, after), before.decision) ||
      (before.visible && !(await isEventPubliclyVisible(ctx, after)))) return fail("an unrelated sibling changed or lost publication.");
  }
  for (const before of context.events) {
    const after = await ctx.db.get(before._id);
    if (!after || after.rawExtractionJson !== before.rawExtractionJson || after.sourceCaption !== before.sourceCaption ||
      after.instagramPostUrl !== before.instagramPostUrl || after.imageStorageId !== before.imageStorageId) return fail("original event evidence changed.");
    await writeEventAuditLog(ctx, before._id, before._id === primary._id ? "reviewed_november_components_consolidated" : "reviewed_november_component_rejected", {
      actor, note, patch: { ...marker, before, next: { title, artists, time: primary.time, description: description ?? null },
        sourceLinksBefore: context.links.filter((link) => link.eventId === before._id),
        movedSaveCount, dedupedSaveCount } });
  }
  return { groupKey: args.groupKey, primaryId: primary._id, rejectedIds: components.map((event) => event._id),
    primaryUpdatedAt, movedSaveCount, dedupedSaveCount };
}

/** Stable representation used only by deterministic incident regression tests. */
export const stableNovember2026ContextJson = stableJson;
