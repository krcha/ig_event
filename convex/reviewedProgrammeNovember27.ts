import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sha256Hex } from "../lib/domain/reconciliation/evidence-digest";
import {
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  nextEventUpdatedAt,
} from "../lib/events/event-update-precondition";
import { readEventEvidenceRecord } from "../lib/events/confirmed-event-schema-facts";
import {
  BILLED_PROGRAMME_REVIEW_VERSION,
  EMPTY_RESEARCH_RETRY_MS,
} from "../lib/taxonomy/performer-genre-research";
import type { DiscoveryCategory, DiscoveryFormat, MusicGenre } from "../lib/taxonomy/event-discovery";
import { writeEventAuditLog } from "./eventDomain/persistence";
import { evaluateEventPublication } from "./publicationPolicy";
import { buildEventOccurrenceIndexPatch } from "./sourceOccurrences";

const review = "programme-review-2026-11-27-v1";
const telmaTime = "Početak u 18:00 potvrđen je uredništvu za ovaj nastup.";
const giftArtist = "https://www.mascom.rs/sr/novi-bend-pod-okriljem-mascoma-grupa-gift-nid-533.1.126.html";
const giftGenre = "https://www.cinemacity.org/parks4all-promo-event-koncert-gift-8-mart-the-pub.2568.htm";
const giftRock = "https://www.oblakodermagazin.rs/tribute-bendovi-the-next-best-thing/";
const radeArtist = "https://ra.co/dj/radebadjin";
const dooArtist = "https://en.lovefest.rs/artist/doo/";
type Source = { genre: MusicGenre; performer: string; identityUrl: string; url: string };
type Target = {
  id: string;
  title: string;
  artists: string[];
  venueId: string;
  post: string;
  row: string;
  updatedAt: number;
  normalizedHash: string;
  labelAuditHash: string;
  rawHash: string;
  category: DiscoveryCategory;
  format: DiscoveryFormat;
  identityUrl: string;
  identityProof: string;
  basis: string;
  matches: Source[];
  genreEvidence: string[];
  changeTime?: true;
};
const targets: Target[] = [
  {
    id: "j570zfzjjyvv6ykk9m2r6qr3en8jsdhd",
    title: "GIFT",
    artists: ["GIFT"],
    venueId: "k174najg8yc8jksdmrsps5znr58970vq",
    post: "4036242053942296305",
    row: "petak 27.nov GIFT",
    updatedAt: 1795425751372,
    normalizedHash: "7e72a27770ea934fd3476f053e4fc564bf2d73e95570bcf81202e5e67ac3774f",
    labelAuditHash: "17d9cf74222a4cc30c4760be3a8eafad9b30f0875e3008ae3a785b6ac94f75c9",
    rawHash: "ff4516cf272356e3367a722b011aca68808caa7ec6c659c19e54f53729cf0594",
    category: "live",
    format: "live-performance",
    identityUrl: giftArtist,
    identityProof: "novosadskog benda Gift",
    basis:
      "Venue poster bills GIFT. The operator identified GIFT as the band. Mascom identifies the Novi Sad band and its frontman, Jovan Matić.",
    matches: [
      { performer: "GIFT", genre: "rock", url: giftRock, identityUrl: giftArtist },
      { performer: "GIFT", genre: "indie-alternative", url: giftGenre, identityUrl: giftArtist },
      { performer: "GIFT", genre: "pop", url: giftGenre, identityUrl: giftArtist },
    ],
    genreEvidence: ["rokenrola, britpopa", "britpop, alternativni rock"],
  },
  {
    id: "j576a9d2dnejasdjh6hbg31mq98hppk4",
    title: "Doo",
    artists: ["Doo"],
    venueId: "k17b45px4f8kvvdfxmn1fx2bg5896adq",
    post: "4023751309482503573",
    row: "27 NOVEMBER, FRIDAY Doo",
    updatedAt: 1793953232642,
    normalizedHash: "b37a9c198434fce8d61ce7b7151def0d7c0072b2331f38dc7a61b231ae5c1e43",
    labelAuditHash: "c4c6d4a6e4ba604fc608a579dcafa9b995a53e68ade5a7691fcec98d5661a1b4",
    rawHash: "9c0e328ff757dba43b83d9038455a47be0e560d2519c38af5caa68b59c774592",
    category: "party",
    format: "dj-set",
    identityUrl: dooArtist,
    identityProof: "Dušan Predojević aka DOO",
    basis:
      "EJE's Friday row names Doo. The operator identified the Belgrade DJ, corroborated by his Lovefest artist profile.",
    matches: [],
    genreEvidence: [],
  },
  {
    id: "j574745xzzzdwq2zzdrmedktr18jza2a",
    title: "Rade Badjin, Personal Belly",
    artists: ["Rade Badjin", "Personal Belly"],
    venueId: "k171sg0fhy3ks61b1f67an11298997ca",
    post: "4038453211260593841",
    row: "Rade Badjin / Personal Belly; 27. novembar",
    updatedAt: 1795683819280,
    normalizedHash: "12a6d8fe7d3c0871cd76110fbc51c6edb4fa5bffb96306435592cd438f02bc6d",
    labelAuditHash: "0fd00aba3e51c7270f8b996148b293a46bfa03cc45f29c921a2249e599fb7725",
    rawHash: "f789ff35d19e17c917bb07a680f95bbdbb58148ca286e9d90627914a09454e1d",
    category: "party",
    format: "dj-set",
    identityUrl: radeArtist,
    identityProof: "Artist, DeeJay, musician, Rade Petković",
    basis:
      "Telma bills both performers. Rade Badjin's artist profile confirms his DJ role and broad electronic style.",
    matches: [{ performer: "Rade Badjin", genre: "electronic", url: radeArtist, identityUrl: radeArtist }],
    genreEvidence: ["performing and appearing by the name Rade Badjin in the electronic music world"],
    changeTime: true,
  },
];

function fail(title: string, detail: string): never {
  throw new Error(`Reviewed programme: ${title}: ${detail}`);
}
function same(a: unknown, b: unknown): boolean {
  // Convex sorts object keys on the wire, while array order is billing order.
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.entries(a),
      right = b as Record<string, unknown>;
    return (
      left.length === Object.keys(right).length &&
      left.every(([k, v]) => Object.hasOwn(right, k) && same(v, right[k]))
    );
  }
  return a === b;
}
function taxonomy(t: Target) {
  return { primaryCategory: t.category, categories: [t.category], formats: [t.format], genres: [] };
}

async function inspect(ctx: QueryCtx | MutationCtx, t: Target) {
  const id = t.id as Id<"events">;
  const [e, l, r] = await Promise.all([
    ctx.db.get(id),
    ctx.db
      .query("eventDiscoveryLabels")
      .withIndex("by_eventId", (q) => q.eq("eventId", id))
      .unique(),
    ctx.db
      .query("eventPerformerGenreResearch")
      .withIndex("by_eventId", (q) => q.eq("eventId", id))
      .unique(),
  ]);
  if (
    !e ||
    e.title !== t.title ||
    !same(e.artists, t.artists) ||
    e.venueId !== t.venueId ||
    e.date !== "2026-11-27" ||
    e.instagramPostId !== t.post ||
    e.status !== "approved" ||
    e.publicationState !== "publishable" ||
    !e.instagramPostUrl ||
    sha256Hex(e.rawExtractionJson || "") !== t.rawHash
  )
    fail(t.title, "source, billing or publication changed");
  if (!l || l.eventUpdatedAt !== e.updatedAt || l.version !== 1) fail(t.title, "discovery version changed");
  const fields = readEventEvidenceRecord(e.normalizedFieldsJson);
  if (fields.rowSourceText !== t.row || fields.sourceOccurrencePlanUnverified !== false)
    fail(t.title, "occurrence proof changed");
  const audit = readEventEvidenceRecord(l.auditJson);
  if (l.model === review) {
    if (
      readEventEvidenceRecord(JSON.stringify(audit.reviewedProgramme)).review !== review ||
      !same(l.taxonomy, taxonomy(t)) ||
      !same(r?.matches ?? [], t.matches) ||
      (t.matches.length && (r?.eventUpdatedAt !== e.updatedAt || r?.model !== review)) ||
      (!t.matches.length && r) ||
      (t.changeTime &&
        (e.time !== "18:00" ||
          e.timeSource !== "description" ||
          e.occurrenceTimeIdentity !== "18:00" ||
          e.timeEvidenceText !== telmaTime ||
          fields.time !== "18:00" ||
          readEventEvidenceRecord(JSON.stringify(fields.reviewedTimeCorrection)).source !==
            "operator-confirmation" ||
          fields.sourceGroundingTimeVerified !== false ||
          fields.timeEvidenceVerified !== false))
    )
      fail(t.title, "incomplete or superseded review");
    return { t, e, l, r, audit, fields, applied: true };
  }
  if (
    e.updatedAt !== t.updatedAt ||
    sha256Hex(e.normalizedFieldsJson || "") !== t.normalizedHash ||
    sha256Hex(l.auditJson) !== t.labelAuditHash ||
    l.taxonomy !== null ||
    r ||
    (t.changeTime &&
      (e.time !== "06:00" || e.timeSource !== "schedule_entry" || e.occurrenceTimeIdentity !== "06:00"))
  )
    fail(t.title, "stale preconditions; re-review the stored event");
  return { t, e, l, r, audit, fields, applied: false };
}
const output = v.object({
  eventId: v.id("events"),
  title: v.string(),
  category: v.string(),
  format: v.string(),
  genres: v.array(v.string()),
  time: v.string(),
  applied: v.boolean(),
});
type Checked = Awaited<ReturnType<typeof inspect>>;
function result(v: Checked, applied = v.applied) {
  return {
    eventId: v.e._id,
    title: v.t.title,
    category: v.t.category,
    format: v.t.format,
    genres: v.t.matches.map((x) => x.genre),
    time: v.t.changeTime ? "18:00" : (v.e.time ?? "TBD"),
    applied,
  };
}
function digest(items: Checked[]) {
  return sha256Hex(
    JSON.stringify(
      items.map(({ t, e, l, r }) => [review, t.id, e.updatedAt, l._id, l.auditJson, r?._id ?? null, t]),
    ),
  );
}

async function checkedTimePatch(
  ctx: QueryCtx | MutationCtx,
  e: Doc<"events">,
  fields: Record<string, unknown>,
  updatedAt: number,
  now: number,
) {
  const description = `${e.description ?? e.title} ${telmaTime}`;
  const timeReview = {
    source: "operator-confirmation",
    reportedTime: "18:00",
    posterText: "petkom od 6h",
    previousTime: "06:00",
    reviewedAt: now,
  };
  const patch: Partial<Doc<"events">> = {
    time: "18:00",
    timeSource: "description",
    timeEvidenceText: telmaTime,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    description,
    updatedAt,
    reviewedAt: now,
    reviewedBy: "service:reviewed-programme-november27",
    moderationNote:
      "The operator confirmed the 18:00 start for this Telma listing. The venue poster states only 'petkom od 6h'.",
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    timeConfidence: undefined,
    ...buildEventOccurrenceIndexPatch({ ...e, time: "18:00" }),
    normalizedFieldsJson: JSON.stringify({
      ...fields,
      time: "18:00",
      timeSource: "description",
      timeEvidenceText: telmaTime,
      timeEvidenceVerified: false,
      timeConfidence: undefined,
      moderationAutoApproved: false,
      moderationAutoApproveRule: null,
      humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
      sourceGroundingTimeVerified: false,
      description,
      reviewedTimeCorrection: timeReview,
    }),
  };
  if ((await evaluateEventPublication(ctx, { ...e, ...patch })).state !== "publishable")
    fail(e.title, "public eligibility would change");
  return patch;
}

export const preview = internalQuery({
  args: {},
  returns: v.object({ digest: v.string(), rows: v.array(output) }),
  handler: async (ctx) => {
    const checked = await Promise.all(targets.map((t) => inspect(ctx, t)));
    for (const { t, e, fields, applied } of checked) {
      if (t.changeTime && !applied) await checkedTimePatch(ctx, e, fields, e.updatedAt + 1, e.updatedAt + 1);
    }
    return { digest: digest(checked), rows: checked.map((v) => result(v)) };
  },
});

export const apply = internalMutation({
  args: { expectedDigest: v.string() },
  returns: v.array(output),
  handler: async (ctx, { expectedDigest }) => {
    const checked = await Promise.all(targets.map((t) => inspect(ctx, t)));
    if (checked.every((v) => v.applied)) return checked.map((v) => result(v));
    if (checked.some((v) => v.applied) || expectedDigest !== digest(checked)) fail(review, "preview changed");
    const now = Date.now();
    for (const { t, e, l, fields, audit } of checked) {
      let updatedAt = e.updatedAt;
      const provenance = {
        review,
        listingUrl: e.instagramPostUrl!,
        listingRow: t.row,
        identityUrl: t.identityUrl,
        identityProof: t.identityProof,
        basis: t.basis,
        genreScope: "named-artist",
        genreEvidence: t.genreEvidence,
        reviewedAt: now,
      };
      if (t.changeTime) {
        updatedAt = nextEventUpdatedAt(e.updatedAt, now);
        const patch = await checkedTimePatch(ctx, e, fields, updatedAt, now);
        await ctx.db.patch(e._id, patch);
      }
      await ctx.db.patch(l._id, {
        eventUpdatedAt: updatedAt,
        model: review,
        taxonomy: taxonomy(t),
        auditJson: JSON.stringify({
          ...audit,
          reviewedProgramme: provenance,
          // The ordinary sweep honors the same completed empty-research window for this bill.
          ...(!t.matches.length
            ? {
                performerReviewVersion: BILLED_PROGRAMME_REVIEW_VERSION,
                performerReviewDeferred: false,
                upcomingGenreRetryAt: now + EMPTY_RESEARCH_RETRY_MS,
              }
            : {}),
        }),
      });
      if (t.matches.length)
        await ctx.db.insert("eventPerformerGenreResearch", {
          eventId: e._id,
          eventUpdatedAt: updatedAt,
          version: 1,
          model: review,
          researchedAt: now,
          matches: t.matches,
          auditJson: JSON.stringify(provenance),
        });
      await writeEventAuditLog(ctx, e._id, review, {
        actor: "editorial-review",
        note: t.basis,
        patch: {
          previousEventUpdatedAt: e.updatedAt,
          eventUpdatedAt: updatedAt,
          previousTaxonomy: null,
          taxonomy: taxonomy(t),
          performerGenreSources: t.matches,
          ...(t.changeTime
            ? {
                time: {
                  before: "06:00",
                  after: "18:00",
                  source: "operator-confirmation",
                  posterText: "petkom od 6h",
                },
              }
            : {}),
        },
      });
    }
    return checked.map((v) => result(v, true));
  },
});
