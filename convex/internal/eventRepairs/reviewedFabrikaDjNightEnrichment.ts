import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  buildReviewedFabrikaDjNightEnrichmentPatch,
  FABRIKA_DJ_NIGHT_DIRECT_ID,
  FABRIKA_DJ_NIGHT_DIRECT_URL,
  FABRIKA_DJ_NIGHT_PRIMARY_ID,
  FABRIKA_DJ_NIGHT_WEEKLY_URL,
} from "../../../lib/events/reviewed-fabrika-dj-night-enrichment";
import { nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { requireAdminOrServiceSecret } from "../../authz";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";

export type ReviewedFabrikaSourceVersion = {
  linkId: Id<"instagramEventSources">;
  linkUpdatedAt: number;
  receiptId: Id<"instagramSourceOccurrenceReceipts">;
  receiptUpdatedAt: number;
  occurrenceId: Id<"sourceOccurrences">;
  occurrenceUpdatedAt: number;
};

type SourceContext = {
  link: Doc<"instagramEventSources">;
  receipt: Doc<"instagramSourceOccurrenceReceipts">;
  occurrence: Doc<"sourceOccurrences">;
  post: Doc<"scrapedPosts">;
};

async function loadExactSource(
  ctx: MutationCtx,
  event: Doc<"events">,
  expected: ReviewedFabrikaSourceVersion,
  expectedUrl: string,
): Promise<SourceContext> {
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(2);
  const link = links.length === 1 ? links[0] : null;
  if (
    !link ||
    link._id !== expected.linkId ||
    link.updatedAt !== expected.linkUpdatedAt ||
    link.eventId !== event._id ||
    link.sourceOccurrenceId !== expected.occurrenceId ||
    link.instagramPostUrl !== expectedUrl ||
    link.instagramPostId !== event.instagramPostId ||
    (link.sourceHandle !== undefined && link.sourceHandle !== "faks_beograd")
  ) {
    throw new Error("Reviewed Fabrika source link changed.");
  }
  const receipts = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", link.sourceIdentity),
    )
    .take(2);
  const receipt = receipts.length === 1 ? receipts[0] : null;
  if (
    !receipt ||
    receipt._id !== expected.receiptId ||
    receipt.updatedAt !== expected.receiptUpdatedAt ||
    receipt.sourceFingerprint !== link.sourceFingerprint ||
    receipt.expectedKeys.filter((key) => key === link.sourceOccurrenceKey).length !== 1 ||
    receipt.satisfiedOccurrences.filter((item) =>
      item.key === link.sourceOccurrenceKey && item.eventId === event._id,
    ).length !== 1
  ) {
    throw new Error("Reviewed Fabrika source receipt changed.");
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expectedOccurrence = receipt.expectedOccurrences?.filter(
    (item) => item.key === link.sourceOccurrenceKey,
  );
  if (
    expectedOccurrence?.length !== 1 ||
    !sourceOccurrenceRepresentativeMatchesExpected(event, expectedOccurrence[0])
  ) {
    throw new Error("Reviewed Fabrika representative no longer matches its source receipt.");
  }
  const occurrence = await ctx.db.get(expected.occurrenceId);
  if (
    !occurrence ||
    occurrence.updatedAt !== expected.occurrenceUpdatedAt ||
    occurrence.state !== "satisfied" ||
    occurrence.canonicalEventId !== event._id ||
    occurrence.sourceIdentity !== link.sourceIdentity ||
    occurrence.sourceFingerprint !== link.sourceFingerprint ||
    occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
    occurrence.canonicalSourceUrl !== expectedUrl
  ) {
    throw new Error("Reviewed Fabrika first-class occurrence changed.");
  }
  const post = await ctx.db.get(occurrence.sourceDocumentId);
  if (
    !post ||
    post.handle !== "faks_beograd" ||
    post.instagramPostUrl !== expectedUrl ||
    post.postId !== event.instagramPostId ||
    post.sourceRevision !== occurrence.sourceRevision
  ) {
    throw new Error("Reviewed Fabrika persisted post changed.");
  }
  return { link, receipt, occurrence, post };
}

/** Preserve both receipt topologies; enrich only public, non-occurrence fields. */
export async function enrichReviewedFabrikaDjNightHandler(
  ctx: MutationCtx,
  args: {
    primaryId: Id<"events">;
    directId: Id<"events">;
    expectedPrimaryUpdatedAt: number;
    expectedDirectUpdatedAt: number;
    primarySource: ReviewedFabrikaSourceVersion;
    directSource: ReviewedFabrikaSourceVersion;
    moderationNote: string;
    serviceSecret: string;
  },
): Promise<{
  applied: boolean;
  primaryId: Id<"events">;
  primaryUpdatedAt: number;
  directStatus: "pending";
}> {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("Reviewed Fabrika enrichment requires service authentication.");
  }
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    args.primaryId !== FABRIKA_DJ_NIGHT_PRIMARY_ID ||
    args.directId !== FABRIKA_DJ_NIGHT_DIRECT_ID ||
    note.length < 24 ||
    [
      args.expectedPrimaryUpdatedAt,
      args.expectedDirectUpdatedAt,
      args.primarySource.linkUpdatedAt,
      args.primarySource.receiptUpdatedAt,
      args.primarySource.occurrenceUpdatedAt,
      args.directSource.linkUpdatedAt,
      args.directSource.receiptUpdatedAt,
      args.directSource.occurrenceUpdatedAt,
    ].some((value) => !Number.isSafeInteger(value))
  ) {
    throw new Error("Reviewed Fabrika enrichment plan is invalid.");
  }
  const [primary, direct] = await Promise.all([
    ctx.db.get(args.primaryId),
    ctx.db.get(args.directId),
  ]);
  if (
    !primary ||
    !direct ||
    primary.updatedAt !== args.expectedPrimaryUpdatedAt ||
    direct.updatedAt !== args.expectedDirectUpdatedAt
  ) {
    throw new Error("Reviewed Fabrika event revision changed.");
  }
  const [weeklySource, directSource] = await Promise.all([
    loadExactSource(ctx, primary, args.primarySource, FABRIKA_DJ_NIGHT_WEEKLY_URL),
    loadExactSource(ctx, direct, args.directSource, FABRIKA_DJ_NIGHT_DIRECT_URL),
  ]);
  if (
    weeklySource.post.caption !== primary.sourceCaption ||
    directSource.post.caption !== direct.sourceCaption ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, primary))
  ) {
    throw new Error("Reviewed Fabrika public event or source caption changed.");
  }
  const patch = buildReviewedFabrikaDjNightEnrichmentPatch(
    primary,
    direct,
    directSource.post.caption,
  );
  if (patch.alreadyDone) {
    return {
      applied: false,
      primaryId: primary._id,
      primaryUpdatedAt: primary.updatedAt,
      directStatus: "pending",
    };
  }
  const effectivePrimary = {
    ...primary,
    description: patch.description,
    ticketPrice: patch.ticketPrice,
  };
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) {
    throw new Error("Reviewed Fabrika enrichment would lose public grounding.");
  }
  const updatedAt = nextEventUpdatedAt(primary.updatedAt);
  await ctx.db.patch(primary._id, {
    description: patch.description,
    ticketPrice: patch.ticketPrice,
    updatedAt,
  });
  await refreshCanonicalEventDerivedStates(ctx, [primary._id]);
  const persisted = await ctx.db.get(primary._id);
  if (
    !persisted ||
    persisted.publicationState !== "publishable" ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, persisted))
  ) {
    throw new Error("Reviewed Fabrika enrichment did not preserve public visibility.");
  }
  await writeEventAuditLog(ctx, primary._id, "reviewed_fabrika_dj_night_enriched", {
    actor: authorization.actor,
    note,
    patch: {
      directEventId: direct._id,
      weeklySourceUrl: FABRIKA_DJ_NIGHT_WEEKLY_URL,
      directSourceUrl: FABRIKA_DJ_NIGHT_DIRECT_URL,
      weeklySourceLinkId: weeklySource.link._id,
      directSourceLinkId: directSource.link._id,
      previousDescription: primary.description ?? null,
      description: patch.description,
      previousTicketPrice: primary.ticketPrice ?? null,
      ticketPrice: patch.ticketPrice,
    },
  });
  return {
    applied: true,
    primaryId: primary._id,
    primaryUpdatedAt: updatedAt,
    directStatus: "pending",
  };
}
