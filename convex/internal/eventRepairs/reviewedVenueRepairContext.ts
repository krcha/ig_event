import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import { requireAdminOrServiceSecret } from "../../authz";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isReviewablySourceGroundedApprovedEvent } from "./reviewedStructuredCorrections";

/** Exact bounded read-only plan for a reviewed one-or-many-source venue repair. */
export async function getReviewedVenueRepairContextHandler(
  ctx: QueryCtx,
  args: { id: Id<"events">; serviceSecret: string },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("Reviewed venue repair context requires service authentication.");
  }
  const event = await ctx.db.get(args.id);
  if (
    !event ||
    event.status !== "approved" ||
    isCrossPostCampaignLineageEvent(event) ||
    !(await isReviewablySourceGroundedApprovedEvent(
      ctx,
      event,
      authorization.actor,
      "Reviewed venue correction planning with exact persisted evidence.",
    ))
  ) {
    throw new Error("Reviewed venue repair context requires a grounded approved event.");
  }
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_event", (q) => q.eq("eventId", event._id))
    .take(9);
  if (links.length < 1 || links.length > 8) {
    throw new Error("Reviewed venue repair context requires one to eight source links.");
  }
  const sources = [];
  for (const sourceLink of links) {
    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceLink.sourceIdentity))
      .take(2);
    const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
    if (!receipt || receipt.sourceFingerprint !== sourceLink.sourceFingerprint) {
      throw new Error("Reviewed venue repair context has a missing or changed receipt.");
    }
    assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    const occurrence = sourceLink.sourceOccurrenceId
      ? await ctx.db.get(sourceLink.sourceOccurrenceId)
      : await ctx.db
          .query("sourceOccurrences")
          .withIndex("by_source_occurrence", (q) =>
            q.eq("sourceIdentity", sourceLink.sourceIdentity)
              .eq("sourceOccurrenceKey", sourceLink.sourceOccurrenceKey))
          .unique();
    if (
      !occurrence ||
      occurrence.state !== "satisfied" ||
      occurrence.canonicalEventId !== event._id ||
      occurrence.sourceIdentity !== sourceLink.sourceIdentity ||
      occurrence.sourceOccurrenceKey !== sourceLink.sourceOccurrenceKey
    ) {
      throw new Error("Reviewed venue repair context requires a satisfied source occurrence.");
    }
    sources.push({ sourceLink, receipt, occurrence });
  }
  return { event, sources };
}
