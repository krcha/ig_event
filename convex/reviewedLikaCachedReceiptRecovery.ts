import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdminOrServiceSecret } from "./authz";
import { sha256Hex } from "../lib/domain/reconciliation/evidence-digest";
import { exactJsonValue } from "../lib/events/exact-json-value";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../lib/events/source-occurrence-representation";
import { hasHumanReviewedStructuredSourceAttestation } from "../lib/events/event-update-precondition";
import { isCanonicallyGroundedApprovedEvent } from "./publicEventGrounding";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import { assertRecordedCarouselMedia } from "./internal/carouselMediaProof";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "./internal/sourceOccurrenceReceipts";
import { writeEventAuditLog } from "./eventDomain/persistence";
import { isSupportedExtractionModel } from "./internal/extractionModel";

// This admission fixes one reviewed cached receipt. It cannot enroll a source,
// bypass an analysis lease, retry a provider request, or attach an occurrence.
export const LIKA_CACHED_RECEIPT_REVIEW = {
  operationId: "reviewed-lika-cached-receipt:2026-11-06:v1",
  sourceId: "jn778nc58ar8wr70ahhc98c1158hp0k4",
  handle: "mudractv",
  postId: "4023641953395594474",
  url: "https://www.instagram.com/p/DfW2QnXgNTq/",
  sourceIdentity: "instagram-source-identity-v1:DfW2QnXgNTq",
  fingerprint: "instagram-source-v2:c57333510c340ec9b307e862ac9a41273c7d6fe2aff126541fffc91532e0f0a3",
  analysisSha256: "a145731b80d7d104da26bf61f3136f46bffb5fc3a566c57eb4c8df7d286c3f9d",
  captionSha256: "7cedcd71767e5cf4b6a6bb38e481e899e116fe535f4c341363b0ae68a1c9318a",
  expectedBindingsSha256: "6f48cae9ad9923da35f3dfa2fc63a6efb5b19cd5c6f6ce37ae1ce6fc9b286589",
  receiptId: "mh7aa61a40y5zzqvh8hw3y1z258hqbwd",
  likaId: "j572espqfqam07pm18rnw6hk5x8gccwz",
  venueId: "k17acbmj3wzxhra3s6bkh5vr8s8gftz7",
  venueHandle: "kc_elektropionir",
  originalLinkId: "kx746v7xbs1wt85csfan2s31ch8gch0r",
  orphanKey: "instagram-occurrence-v2:c20bd837df9fe1cd2a34e8bd62bb30edbbbb9168c77f7a8ac32f5e7190ece8ea",
  occurrences: [
    ["pd7970t09gawbwjyhv87cw89c18hqstc", "087b47d7536bed915661ab6e1612d8545e7c45d73932175f768cb4140a21eefa", "j577js0g56s08hqfm8tp7zadyh8gsdfc", "9af7d3255bad40797d2325341e4447c87f38429adb441d1291559fe28ca19095", "2676c57659c734008ffb2ea609202f3b6a22af757eb85fdd1ced364c4d424358"],
    ["pd78pwbd7bbn5djj8dyhn6zy818hqx1e", "51eddbc26632b828d9ed016ad044178a0c6a77f91dfd3f9f048a099e3a22ccd2", "j57b3skdbfx6ka0895fsj8j17d8gs38p", "46dd58df87aa25255e56f70a9f4a7861fb46e75b0a342d216b39e046958383fb", "2ba860a2e4f2b9e59338d5412384fb1abd7a30e829eba6a1f02aa27304045ce4"],
    ["pd782p4gnrwxs1khg4vz5d9bzn8hp5s5", "94e2b8b6ca696c63f566660a57cbd86fee988fb7e0147256f4efa738597040af", "j571q3ttaz4gn1nwmg9r8j4yg18hpq2m", "ad91e9967fc6f3e78fc0a48e64c151e301195c56379e8d2b58527eaf604df5d1", "de803bf7aec30a21d18e1b4a62f91650c4112a551a93f95b18a02078e65ed297"],
    ["pd7b6gv0322ey69bn0s9ehzg418hppnk", "af3bbd7ce7edd56372b78daa0970e483cfa6496ca24267ed66b93d12a7a53868", "j57d8n4p3j95jegj1sxcssqxvd8gcpfp", "2e8efaac04ea2f66c863a3420eae7e2a643b398beccfd3ad2d358ef42956a828", "1d8ebbd2f5ea55bf9c8c4a2aaa4997a75b0da4ca17225463feb135a82ad2cf3e"],
    ["pd7a63jewwbb1gw93h9mk3twex8hpzr4", "c20bd837df9fe1cd2a34e8bd62bb30edbbbb9168c77f7a8ac32f5e7190ece8ea", null, "5e0bb41cd2b3e212afe98a57ce8b25c27620fc440b52762098eeaf94d68c5be4", "30ce0c8c73f8a6f38076736c859d24a96c2fb64556e5f4c036f00963ef194b65"],
    ["pd7505jfy14q3wzw10jhqk1zjx8hq9cg", "c5e264a4ba7f49d7d0d97dc01a4fc6666fd93b51d084f33dca3d0c4f71357c08", "j575xaqm08bx7r3hq9g7tvzdth8gedz8", "867dfb5cf01cf836a0e9cf34564734b47e4ccdff312e80f0a6785070d7a0bf73", "6e1b9eee9e849942b3503e9397cd85bd88bca26572c9090612d73c982810478a"],
    ["pd7br7gptm1f0gnpyfgb6pwwh58hp8h6", "c9cd185dbcd5d102cdc9478ee56a2b0213f8825611a12140ac7bcfcdc7ae48a6", "j57a6wqmvq70dqynpt9kagqgad8gnawe", "636b0228a0a8e3d9678d53d77accfde08cd07bff8a931041332bfc9bf86671c6", "a66d397c8439b245e70f27c3df9930c6efc30f8158a9f6a9856f4a8d1dcc9d91"],
  ],
} as const;

const ACTION = "reviewed_lika_cached_retry_admitted";
type ReadCtx = QueryCtx | MutationCtx;
const fail = (message: string): never => { throw new Error(`Reviewed Lika cached recovery: ${message}`); };
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function digest(context: unknown): string {
  const text = stableJson(context);
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) return fail("bounded context exceeded.");
  return sha256Hex(text);
}
async function authorize(ctx: ReadCtx, secret: string) {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") return fail("service authentication is required.");
  return auth.actor;
}

async function loadContext(ctx: ReadCtx) {
  const p = LIKA_CACHED_RECEIPT_REVIEW;
  const source = await ctx.db.get(p.sourceId as Id<"scrapedPosts">);
  const lika = await ctx.db.get(p.likaId as Id<"events">);
  const venue = await ctx.db.get(p.venueId as Id<"venues">);
  if (!source || source.handle !== p.handle || source.postId !== p.postId || source.instagramPostUrl !== p.url ||
    source.sourceRevision !== 1 || source.analysisRevision !== 1 || source.analysisContractVersion !== "event_evidence_v2" ||
    source.analysisIsEvent !== true || !isSupportedExtractionModel(source.analysisModel) ||
    sha256Hex(source.analysisResultJson ?? "") !== p.analysisSha256 || sha256Hex(source.caption ?? "") !== p.captionSha256 ||
    source.processingStatus !== "retryable_failure" || source.processingOutcome !== "incomplete_occurrence_receipt" ||
    source.processingLeaseOwner !== undefined || source.processingLeaseExpiresAt !== undefined ||
    source.analysisAttemptRevision !== 1 || !source.analysisCompletedAt ||
    source.analysisCompletedAt < (source.analysisAttemptStartedAt ?? Infinity)) return fail("exact cached source is unavailable or leased.");
  if (!venue || !isVenuePublic(venue) || venue.instagramHandle !== p.venueHandle || venue.name !== "KC Elektropionir" ||
    !lika || lika.status !== "approved" || lika.venueId !== venue._id || lika.venue !== venue.name ||
    lika.title !== "Lika Kolorado" || lika.date !== "2026-12-05" || lika.time !== "21:00" ||
    !exactJsonValue(lika.artists, ["Lika Kolorado"]) ||
    !hasHumanReviewedStructuredSourceAttestation(lika.normalizedFieldsJson, lika) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, lika))) return fail("approved source-corrected Lika candidate changed.");
  const analysis: unknown = JSON.parse(source.analysisResultJson!);
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return fail("cached analysis is invalid.");
  await assertRecordedCarouselMedia(ctx, source, analysis as Record<string, unknown>, source.analysisCarouselImages);
  const receipts = await ctx.db.query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", q => q.eq("sourceIdentity", p.sourceIdentity)).take(2);
  const receipt = receipts[0];
  if (receipts.length !== 1 || !receipt || receipt._id !== p.receiptId || receipt.sourceFingerprint !== p.fingerprint ||
    receipt.expectedKeys.length !== 7 || receipt.satisfiedKeys.length !== 6 || receipt.satisfiedOccurrences.length !== 6 ||
    receipt.deferredChildCount !== 0 || receipt.deferredChildKeys.length !== 0 ||
    digest(receipt.expectedOccurrences) !== p.expectedBindingsSha256) return fail("exact seven-child receipt changed.");
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const occurrences = await ctx.db.query("sourceOccurrences")
    .withIndex("by_source_occurrence", q => q.eq("sourceIdentity", p.sourceIdentity)).take(8);
  if (occurrences.length !== 7) return fail("source occurrence set changed.");
  const siblings: Doc<"events">[] = [];
  const links: Doc<"instagramEventSources">[] = [];
  for (const [id, suffix, eventId, factsSha, canonicalSha] of p.occurrences) {
    const key = `instagram-occurrence-v2:${suffix}`;
    const occurrence = occurrences.find(o => o._id === id);
    const expected = receipt.expectedOccurrences?.find(e => e.key === key);
    const satisfaction = receipt.satisfiedOccurrences.filter(s => s.key === key);
    const sourceLinks = await ctx.db.query("instagramEventSources")
      .withIndex("by_source_occurrence", q => q.eq("sourceIdentity", p.sourceIdentity).eq("sourceOccurrenceKey", key)).take(2);
    if (!occurrence || !expected || occurrence.sourceOccurrenceKey !== key || occurrence.sourceDocumentId !== source._id ||
      occurrence.sourceRevision !== 1 || occurrence.sourceFingerprint !== p.fingerprint || occurrence.canonicalSourceUrl !== p.url ||
      sha256Hex(occurrence.factsJson) !== factsSha || sha256Hex(occurrence.canonicalEventJson ?? "") !== canonicalSha) return fail("immutable occurrence evidence changed.");
    if (eventId === null) {
      if (occurrence.state !== "expected" || occurrence.canonicalEventId !== undefined || satisfaction.length !== 0 ||
        receipt.satisfiedKeys.includes(key) || sourceLinks.length !== 0 ||
        !sourceOccurrenceRepresentativeMatchesExpected(lika, expected)) return fail("exact orphan is no longer attachable to Lika.");
    } else {
      const sibling = await ctx.db.get(eventId as Id<"events">);
      const link = sourceLinks[0];
      if (!sibling || occurrence.state !== "satisfied" || occurrence.canonicalEventId !== eventId ||
        satisfaction.length !== 1 || satisfaction[0]!.eventId !== eventId || !receipt.satisfiedKeys.includes(key) ||
        sourceLinks.length !== 1 || !link || link.eventId !== eventId || link.sourceFingerprint !== p.fingerprint ||
        link.sourceOccurrenceId !== occurrence._id || !sourceOccurrenceRepresentativeMatchesExpected(sibling, expected)) return fail("a retained sibling binding changed.");
      siblings.push(sibling); links.push(link);
    }
  }
  const likaLinks = await ctx.db.query("instagramEventSources")
    .withIndex("by_event", q => q.eq("eventId", lika._id)).take(2);
  if (likaLinks.length !== 1 || likaLinks[0]!._id !== p.originalLinkId) return fail("Lika source topology changed.");
  const audits = await ctx.db.query("eventAuditLog").withIndex("by_event", q => q.eq("eventId", lika._id)).take(101);
  if (audits.length > 100) return fail("bounded admission audit exceeded.");
  const admissions = audits.filter(a => a.action === ACTION);
  if (admissions.length > 1 || (admissions.length === 0 && !Number.isSafeInteger(source.processingRetryAt)) ||
    (admissions.length === 1 && source.processingRetryAt !== undefined)) return fail("retry admission state changed.");
  return { operationId: p.operationId, source, receipt, occurrences: [...occurrences].sort((a, b) => a._id.localeCompare(b._id)),
    lika, venue, siblings, links, likaLinks, admitted: admissions.length === 1, admissions };
}

export const getContext = query({
  args: { serviceSecret: v.string() },
  returns: v.object({ context: v.any(), contextSha256: v.string(), admitted: v.boolean() }),
  handler: async (ctx, args) => {
    await authorize(ctx, args.serviceSecret);
    const context = await loadContext(ctx);
    return { context, contextSha256: digest(context), admitted: context.admitted };
  },
});

export const admitCachedRetry = mutation({
  args: { expectedContextSha256: v.string(), moderationNote: v.string(), serviceSecret: v.string() },
  returns: v.object({ admitted: v.literal(true), sourceId: v.id("scrapedPosts"), sourceRevision: v.literal(1), afterContextSha256: v.string() }),
  handler: async (ctx, args) => {
    const actor = await authorize(ctx, args.serviceSecret);
    if (!/^[a-f0-9]{64}$/u.test(args.expectedContextSha256) || args.moderationNote.trim().length < 24 || args.moderationNote.length > 1000) return fail("exact digest and substantive audit note required.");
    const before = await loadContext(ctx);
    if (before.admitted) return fail("this one-time cached retry was already admitted.");
    if (digest(before) !== args.expectedContextSha256) return fail("context changed after review.");
    // Only admission metadata changes. Ordinary existing processing/receipt APIs
    // must still acquire the lease, attach the exact child, and finish truthfully.
    await ctx.db.patch(before.source._id, { processingRetryAt: undefined });
    await writeEventAuditLog(ctx, before.lika._id, ACTION, { actor, note: args.moderationNote.trim(), patch: {
      operationId: LIKA_CACHED_RECEIPT_REVIEW.operationId, sourceId: before.source._id, sourceRevision: 1,
      receiptId: before.receipt._id, orphanKey: LIKA_CACHED_RECEIPT_REVIEW.orphanKey,
      analysisSha256: LIKA_CACHED_RECEIPT_REVIEW.analysisSha256, previousRetryAt: before.source.processingRetryAt,
      expectedContextSha256: args.expectedContextSha256, cachedOnly: true,
    } });
    const after = await loadContext(ctx);
    const expectedSource = { ...before.source };
    delete expectedSource.processingRetryAt;
    if (!after.admitted || !exactJsonValue(expectedSource, after.source)) return fail("admission changed unrelated source fields.");
    return { admitted: true as const, sourceId: before.source._id, sourceRevision: 1 as const, afterContextSha256: digest(after) };
  },
});
