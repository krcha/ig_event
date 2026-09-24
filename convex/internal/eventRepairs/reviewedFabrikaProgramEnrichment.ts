import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  buildReviewedFabrikaProgramEnrichmentPatch,
  FABRIKA_PROGRAM_REVIEWS,
  FABRIKA_WEEKLY_POST_URL,
  type ReviewedFabrikaProgramNight,
} from "../../../lib/events/reviewed-fabrika-program-enrichment";
import { nextEventUpdatedAt } from "../../../lib/events/event-update-precondition";
import { requireAdminOrServiceSecret } from "../../authz";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import {
  loadExactSource,
  type ReviewedFabrikaSourceVersion,
} from "./reviewedFabrikaDjNightEnrichment";

function parseObject(value: string | undefined, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "null") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Give every invalid snapshot the same fail-closed error below.
  }
  throw new Error(`Reviewed Fabrika ${label} evidence changed.`);
}

/** One exact source-linked public update, with both occurrence receipts unchanged. */
export async function enrichReviewedFabrikaProgramHandler(
  ctx: MutationCtx,
  args: {
    night: ReviewedFabrikaProgramNight;
    primaryId: Id<"events">;
    directId: Id<"events">;
    expectedPrimaryUpdatedAt: number;
    expectedPrimaryNormalizedFieldsJson: string;
    expectedDirectUpdatedAt: number;
    expectedDirectNormalizedFieldsJson: string;
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
    throw new Error("Reviewed Fabrika program enrichment requires service authentication.");
  }
  const review = FABRIKA_PROGRAM_REVIEWS[args.night];
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !review ||
    args.primaryId !== review.primaryId ||
    args.directId !== review.directId ||
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
    throw new Error("Reviewed Fabrika program plan is invalid.");
  }

  const [primary, direct] = await Promise.all([
    ctx.db.get(args.primaryId),
    ctx.db.get(args.directId),
  ]);
  if (
    !primary ||
    !direct ||
    primary.updatedAt !== args.expectedPrimaryUpdatedAt ||
    direct.updatedAt !== args.expectedDirectUpdatedAt ||
    primary.normalizedFieldsJson !== args.expectedPrimaryNormalizedFieldsJson ||
    direct.normalizedFieldsJson !== args.expectedDirectNormalizedFieldsJson ||
    primary.publicationState !== "publishable" ||
    direct.publicationState !== "hidden"
  ) {
    throw new Error("Reviewed Fabrika event or evidence revision changed.");
  }

  const [weeklySource, directSource] = await Promise.all([
    loadExactSource(ctx, primary, args.primarySource, FABRIKA_WEEKLY_POST_URL),
    loadExactSource(ctx, direct, args.directSource, review.directUrl),
  ]);
  const weeklyFields = parseObject(primary.normalizedFieldsJson, "weekly");
  const directFields = parseObject(direct.normalizedFieldsJson, "direct");
  const weeklyExtraction = parseObject(primary.rawExtractionJson, "weekly extraction");
  const sourceEntries = weeklyExtraction.schedule_entries;
  const splitIndex = weeklyFields.splitEventIndex;
  const sourceRow =
    Array.isArray(sourceEntries) &&
    Number.isSafeInteger(splitIndex) &&
    Number(splitIndex) >= 1
      ? sourceEntries[Number(splitIndex) - 1]
      : null;
  if (
    weeklySource.post.caption !== primary.sourceCaption ||
    directSource.post.caption !== direct.sourceCaption ||
    weeklySource.post.analysisResultJson !== primary.rawExtractionJson ||
    directSource.post.analysisResultJson !== direct.rawExtractionJson ||
    weeklySource.post.analysisRevision !== (weeklySource.post.sourceRevision ?? 1) ||
    directSource.post.analysisRevision !== (directSource.post.sourceRevision ?? 1) ||
    weeklySource.post.analysisContractVersion !== "event_evidence_v2" ||
    directSource.post.analysisContractVersion !== "event_evidence_v2" ||
    weeklySource.post.analysisIsEvent !== true ||
    directSource.post.analysisIsEvent !== true ||
    weeklySource.post.postedAt !== primary.sourcePostedAt ||
    directSource.post.postedAt !== direct.sourcePostedAt ||
    weeklyFields.sourceGroundingInstagramHandle !== "faks_beograd" ||
    directFields.sourceGroundingInstagramHandle !== "faks_beograd" ||
    weeklyFields.dateEvidenceVerified !== true ||
    weeklyFields.timeEvidenceVerified !== true ||
    directFields.dateEvidenceVerified !== true ||
    directFields.timeEvidenceVerified !== true ||
    directFields.venueEvidenceVerified !== true ||
    !sourceRow ||
    typeof sourceRow !== "object" ||
    Array.isArray(sourceRow) ||
    (sourceRow as Record<string, unknown>).date !== review.date ||
    (sourceRow as Record<string, unknown>).time !== review.primaryTime ||
    (sourceRow as Record<string, unknown>).title !== review.primaryTitle ||
    (sourceRow as Record<string, unknown>).source_text !== weeklyFields.rowSourceText ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, primary))
  ) {
    throw new Error("Reviewed Fabrika source evidence or weekly row changed.");
  }

  const patch = buildReviewedFabrikaProgramEnrichmentPatch(
    args.night,
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
    reviewedSourceUpdate: {
      ...patch.reviewedSourceUpdate,
      sourceEventId: direct._id,
    },
  };
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, effectivePrimary))) {
    throw new Error("Reviewed Fabrika update would lose public grounding.");
  }
  const updatedAt = nextEventUpdatedAt(primary.updatedAt);
  await ctx.db.patch(primary._id, {
    description: patch.description,
    ticketPrice: patch.ticketPrice,
    reviewedSourceUpdate: effectivePrimary.reviewedSourceUpdate,
    updatedAt,
  });
  await refreshCanonicalEventDerivedStates(ctx, [primary._id]);
  const [persistedPrimary, persistedDirect] = await Promise.all([
    ctx.db.get(primary._id),
    ctx.db.get(direct._id),
  ]);
  if (
    !persistedPrimary ||
    !persistedDirect ||
    persistedPrimary.publicationState !== "publishable" ||
    persistedDirect.status !== "pending" ||
    persistedDirect.publicationState !== "hidden" ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, persistedPrimary))
  ) {
    throw new Error("Reviewed Fabrika update did not preserve public visibility.");
  }
  await writeEventAuditLog(ctx, primary._id, "reviewed_fabrika_direct_program_enriched", {
    actor: authorization.actor,
    note,
    patch: {
      night: args.night,
      primarySourceLinkId: weeklySource.link._id,
      directSourceLinkId: directSource.link._id,
      directSourceUrl: review.directUrl,
      previousDescription: primary.description ?? null,
      description: patch.description,
      previousTicketPrice: primary.ticketPrice ?? null,
      ticketPrice: patch.ticketPrice,
      reviewedSourceUpdate: patch.reviewedSourceUpdate,
    },
  });
  return {
    applied: true,
    primaryId: primary._id,
    primaryUpdatedAt: updatedAt,
    directStatus: "pending",
  };
}
