import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireAdminOrServiceSecret } from "../../authz";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { assertExpectedEventUpdatedAt, nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { loadPendingSourceConflictCandidateProof } from "./pendingSourceConflictReclassification";
import { loadReviewedStructuredCorrectionContext, type ReviewedStructuredCorrectionVersionArgs } from "./reviewedStructuredCorrections";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";
import { refreshCanonicalEventDerivedStates, writeEventAuditLog } from "../../eventDomain/persistence";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";

type ReadCtx = QueryCtx | MutationCtx;
type RepairArgs = ReviewedStructuredCorrectionVersionArgs & {
  id: Id<"events">;
  expectedUpdatedAt: number;
  expectedNormalizedFieldsJson: string;
  expectedSourceId: Id<"scrapedPosts">;
  expectedSourceUpdatedAt: number;
  expectedSourceRevision: number;
  expectedOccurrenceId: Id<"sourceOccurrences">;
  expectedOccurrenceUpdatedAt: number;
  expectedFactsJson: string;
  expectedPosterChecksumSha256: string;
  nextArtists: string[];
  nextDescription: string;
  posterRowEvidence: string;
  posterArtistEvidence: string[];
  moderationNote: string;
  serviceSecret: string;
};

async function loadPendingPerformerContext(ctx: ReadCtx, id: Id<"events">) {
  const event = await ctx.db.get(id);
  if (!event || event.status !== "pending" || isCrossPostCampaignLineageEvent(event)) {
    throw new Error("Pending performer correction requires a pending non-lineage event.");
  }
  const links = await ctx.db.query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id)).take(2);
  if (links.length !== 1) throw new Error("Pending performer correction requires one source link.");
  const sourceLink = links[0]!;
  const receipts = await ctx.db.query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceLink.sourceIdentity)).take(2);
  if (receipts.length !== 1) throw new Error("Pending performer correction requires one receipt.");
  const receipt = receipts[0]!;
  const exact = await loadReviewedStructuredCorrectionContext(ctx, event, {
    expectedSourceLinkId: sourceLink._id,
    expectedSourceLinkUpdatedAt: sourceLink.updatedAt,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
  }, { allowUnverifiedPendingTarget: true });
  const proof = await loadPendingSourceConflictCandidateProof(ctx, receipt, event._id);
  const { source, occurrence } = proof;
  const fields = exact.currentFields;
  // The saved analysis remains immutable even when its OCR spelling was wrong.
  if (fields.extractionMode !== "poster" || source.analysisCarouselImages?.length ||
      source.processingStatus === "processing" ||
      !source.analysisImageSourceUrl || !source.analysisImageChecksumSha256 ||
      !/^[a-f0-9]{64}$/u.test(source.analysisImageChecksumSha256) ||
      source.caption !== event.sourceCaption ||
      source.caption !== fields.sourceGroundingSourceCaption ||
      source.caption !== exact.rawExtraction.source_caption ||
      source.postedAt !== event.sourcePostedAt ||
      requireCanonicalInstagramPostUrl(source.instagramPostUrl, "Pending performer source") !==
        requireCanonicalInstagramPostUrl(exact.rawExtraction.source_url as string, "Pending performer analysis") ||
      !occurrence.factsJson ||
      fields.normalizedDate !== event.date || fields.title !== event.title ||
      fields.normalizedVenue !== event.venue ||
      JSON.stringify(fields.artists) !== JSON.stringify(event.artists)) {
    throw new Error("Pending performer correction requires unchanged current poster evidence.");
  }
  const assets = await ctx.db.query("mediaAssets")
    .withIndex("by_sourceKey", (q) => q.eq("sourceKey", `instagram-post:${source.postId}`)).take(2);
  const posterAsset = assets.length === 1 ? assets[0] : null;
  if (!posterAsset || posterAsset.storageId !== source.imageStorageId ||
      posterAsset.checksumSha256 !== source.analysisImageChecksumSha256 ||
      event.imageStorageId !== posterAsset.storageId || event.imageUrl !== posterAsset.url) {
    throw new Error("Pending performer correction retained poster checksum failed.");
  }
  return { event, ...exact, source, occurrence, posterAsset };
}

export async function getReviewedPendingPerformerCorrectionContextHandler(
  ctx: QueryCtx, args: { id: Id<"events">; serviceSecret: string },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") throw new Error("Pending performer correction requires service authentication.");
  return loadPendingPerformerContext(ctx, args.id);
}

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export async function repairReviewedPendingPerformerCorrectionHandler(ctx: MutationCtx, args: RepairArgs) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") throw new Error("Pending performer correction requires service authentication.");
  const revisions = [args.expectedUpdatedAt, args.expectedSourceLinkUpdatedAt,
    args.expectedReceiptUpdatedAt, args.expectedSourceUpdatedAt, args.expectedSourceRevision,
    args.expectedOccurrenceUpdatedAt];
  if (revisions.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("Pending performer correction requires safe exact revisions.");
  }
  const context = await loadPendingPerformerContext(ctx, args.id);
  const { event, currentFields, sourceLink, receipt, source, occurrence, occurrenceIndex, posterAsset } = context;
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson ||
      sourceLink._id !== args.expectedSourceLinkId || sourceLink.updatedAt !== args.expectedSourceLinkUpdatedAt ||
      receipt._id !== args.expectedReceiptId || receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
      source._id !== args.expectedSourceId || source.updatedAt !== args.expectedSourceUpdatedAt ||
      (source.sourceRevision ?? 1) !== args.expectedSourceRevision ||
      occurrence._id !== args.expectedOccurrenceId || occurrence.updatedAt !== args.expectedOccurrenceUpdatedAt ||
      occurrence.factsJson !== args.expectedFactsJson ||
      posterAsset.checksumSha256 !== args.expectedPosterChecksumSha256) {
    throw new Error("Pending performer correction evidence or version changed.");
  }
  const nextArtists = args.nextArtists.map(clean);
  const posterArtistEvidence = args.posterArtistEvidence.map(clean);
  const posterRowEvidence = clean(args.posterRowEvidence);
  const moderationNote = clean(args.moderationNote);
  const nextDescription = clean(args.nextDescription);
  if (nextArtists.length < 1 || nextArtists.length > 16 ||
      nextArtists.some((value, index) => !value || value.length > 120 || value !== args.nextArtists[index]) ||
      new Set(nextArtists.map((value) => value.toLocaleLowerCase())).size !== nextArtists.length ||
      JSON.stringify(nextArtists) === JSON.stringify(event.artists) ||
      posterArtistEvidence.length !== nextArtists.length ||
      posterArtistEvidence.some((value, index) => !value || value.length > 500 ||
        !value.includes(nextArtists[index]!) || !posterRowEvidence.includes(value)) ||
      !posterRowEvidence.includes(event.title) ||
      !posterRowEvidence.includes(`${event.date.slice(8, 10)}.${event.date.slice(5, 7)}.`) ||
      posterRowEvidence.length > 2000 || moderationNote.length < 20 || moderationNote.length > 4000 ||
      !nextDescription || nextDescription !== args.nextDescription || nextDescription.length > 4000) {
    throw new Error("Pending performer correction requires canonical names and exact dated poster-row evidence.");
  }
  const reviewedAt = Date.now();
  const correction = { policyVersion: 1, reviewedAt, reviewedBy: authorization.actor,
    sourceId: source._id, sourceRevision: source.sourceRevision ?? 1,
    posterChecksumSha256: posterAsset.checksumSha256, posterRowEvidence, posterArtistEvidence,
    previousArtists: event.artists, nextArtists, statusPreserved: "pending" };
  const requiresReview = (values: unknown) => [...new Set([
    ...(Array.isArray(values) ? values.map(String) : []), "requires_human_approval",
  ])];
  const nextFields = { ...currentFields, artists: nextArtists, description: nextDescription,
    moderationAutoApproved: false, moderationAutoApproveRule: null,
    moderationPendingReasons: requiresReview(currentFields.moderationPendingReasons),
    moderationSignals: requiresReview(currentFields.moderationSignals),
    reviewedPendingPerformerCorrection: correction };
  const normalizedFieldsJson = JSON.stringify(nextFields);
  const updatedAt = nextEventUpdatedAt(event.updatedAt, reviewedAt);
  const receiptUpdatedAt = nextEventUpdatedAt(receipt.updatedAt, reviewedAt);
  const effectiveEvent = { ...event, artists: nextArtists, description: nextDescription,
    normalizedFieldsJson, reviewedAt, reviewedBy: authorization.actor, moderationNote, updatedAt };
  const nextExpectedOccurrences = receipt.expectedOccurrences.map((expected, index) =>
    index === occurrenceIndex ? { ...expected, artists: nextArtists } : expected);
  if (!sourceOccurrenceRepresentativeMatchesExpected(effectiveEvent, nextExpectedOccurrences[occurrenceIndex],
    { allowUnverifiedPending: true })) {
    throw new Error("Pending performer correction would invalidate the occurrence binding.");
  }
  // Do not run approval, rewrite the analysis/facts, or reconstruct siblings.
  await ctx.db.patch(event._id, { artists: nextArtists, description: nextDescription,
    normalizedFieldsJson, reviewedAt, reviewedBy: authorization.actor, moderationNote, updatedAt });
  await ctx.db.patch(receipt._id, { expectedOccurrences: nextExpectedOccurrences, updatedAt: receiptUpdatedAt });
  const updated = await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, {
    expected: nextExpectedOccurrences[occurrenceIndex]!, representative: effectiveEvent,
    sourceFingerprint: receipt.sourceFingerprint, sourceLink, topologyEpochVerified: true,
  });
  if (!updated) throw new Error("Pending performer correction lost its satisfied occurrence.");
  await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  await writeEventAuditLog(ctx, event._id, "reviewed_pending_performer_corrected", {
    actor: authorization.actor, note: moderationNote, patch: { ...correction,
      eventBeforeUpdatedAt: event.updatedAt, eventAfterUpdatedAt: updatedAt,
      receiptId: receipt._id, receiptBeforeUpdatedAt: receipt.updatedAt, receiptAfterUpdatedAt: receiptUpdatedAt,
      sourceLinkId: sourceLink._id, sourceLinkUpdatedAt: sourceLink.updatedAt,
      occurrenceId: occurrence._id, occurrenceBeforeUpdatedAt: occurrence.updatedAt,
      previousDescription: event.description, nextDescription,
    },
  });
  return { updated: true, updatedAt, receiptUpdatedAt, status: "pending" as const };
}
