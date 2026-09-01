import type { MutationCtx } from "../../_generated/server";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import {
  evaluateEventPublication,
  toPublicationPatch,
} from "../../publicationPolicy";
import { canonicalizeSourceUrl } from "../../../lib/domain/source-url";
import {
  eventDomainMigrationPatchDiffers,
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

/** Backfills immutable canonical URL identity on saved Instagram documents. */
export async function backfillSourceDocumentCanonicalUrlsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("scrapedPosts")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    mismatchCount: 0,
    scannedCount: page.page.length,
    updatedCount: 0,
  };
  for (const sourceDocument of page.page) {
    const canonical = canonicalizeSourceUrl(
      "instagram",
      sourceDocument.instagramPostUrl,
    );
    if (!canonical.ok) {
      counts.mismatchCount += 1;
      continue;
    }
    if (sourceDocument.canonicalSourceUrl === canonical.value.canonicalUrl) {
      continue;
    }
    counts.updatedCount += 1;
    if (!dryRun) {
      // Additive identity metadata must not advance sourceRevision or disturb
      // an active processing fence.
      await ctx.db.patch(sourceDocument._id, {
        canonicalSourceUrl: canonical.value.canonicalUrl,
      });
    }
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "source-document-canonical-url-v1",
    phase: "canonical_source_urls",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}

/** Backfills post identity on durable media without touching stored bytes. */
export async function backfillMediaCanonicalUrlsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("mediaAssets")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    mismatchCount: 0,
    scannedCount: page.page.length,
    updatedCount: 0,
  };
  for (const asset of page.page) {
    const canonical = canonicalizeSourceUrl(
      "instagram",
      asset.normalizedInstagramPostUrl,
    );
    if (!canonical.ok) {
      counts.mismatchCount += 1;
      continue;
    }
    if (asset.canonicalSourceUrl === canonical.value.canonicalUrl) continue;
    counts.updatedCount += 1;
    if (!dryRun) {
      await ctx.db.patch(asset._id, {
        canonicalSourceUrl: canonical.value.canonicalUrl,
      });
    }
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "media-canonical-url-v1",
    phase: "canonical_source_urls",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}

/**
 * Materializes signature, canonical URL and publication policy fields without
 * changing event.updatedAt (some audited campaign proofs bind that version).
 */
export async function backfillCanonicalEventFieldsBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("events")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    mismatchCount: 0,
    scannedCount: page.page.length,
    updatedCount: 0,
  };
  for (const event of page.page) {
    const canonical = event.instagramPostUrl
      ? canonicalizeSourceUrl("instagram", event.instagramPostUrl)
      : null;
    if (canonical && !canonical.ok) counts.mismatchCount += 1;
    const publication = toPublicationPatch(
      await evaluateEventPublication(ctx, event),
    );
    const publicationPatch =
      event.publicationPolicyVersion === publication.publicationPolicyVersion &&
      event.publicationReason === publication.publicationReason &&
      event.publicationState === publication.publicationState
        ? {}
        : publication;
    const patch = {
      ...(canonical?.ok
        ? { canonicalSourceUrl: canonical.value.canonicalUrl }
        : {}),
      ...buildEventOccurrenceIndexPatch(event),
      ...publicationPatch,
    };
    if (!eventDomainMigrationPatchDiffers(event, patch)) continue;
    counts.updatedCount += 1;
    if (!dryRun) await ctx.db.patch(event._id, patch);
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "canonical-event-domain-fields-v1",
    phase: "signature_and_publication",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
