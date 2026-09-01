import type { Doc } from "../../_generated/dataModel";
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

const LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_CUTOFF_MS = Date.UTC(
  2026,
  7,
  1,
);
const LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_REASON =
  "legacy_instagram_profile_snapshot";
const LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_KEYS = [
  "_creationTime",
  "_id",
  "blocksPaidFetch",
  "createdAt",
  "handle",
  "imageUrls",
  "instagramPostUrl",
  "lastProcessedAt",
  "postId",
  "processingAttempts",
  "processingOutcome",
  "processingStatus",
  "sourceKey",
  "updatedAt",
  "username",
] as const;

/**
 * Before canonical post-only admission, one retired discovery path persisted
 * bare Instagram profile responses in scrapedPosts. They contain no post
 * media, caption, timestamp, or shortcode and were already terminally
 * classified as non-events. Keep those historical rows untouched and
 * auditable; every other malformed source URL remains a blocking mismatch.
 */
function isLegacyInstagramProfileSnapshot(
  sourceDocument: Doc<"scrapedPosts">,
): boolean {
  const keys = Object.keys(sourceDocument).sort();
  const expectedKeys = [...LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }

  const handle = sourceDocument.handle;
  return (
    /^[a-z0-9._]{1,30}$/u.test(handle) &&
    sourceDocument.username === handle &&
    /^\d{1,32}$/u.test(sourceDocument.postId) &&
    sourceDocument.instagramPostUrl ===
      `https://www.instagram.com/${handle}` &&
    sourceDocument.sourceKey === `${handle}:${sourceDocument.postId}` &&
    Array.isArray(sourceDocument.imageUrls) &&
    sourceDocument.imageUrls.length === 0 &&
    sourceDocument.blocksPaidFetch === false &&
    sourceDocument.processingStatus === "completed" &&
    sourceDocument.processingOutcome === "terminal_no_event" &&
    sourceDocument.processingAttempts === 1 &&
    Number.isFinite(sourceDocument.createdAt) &&
    sourceDocument.createdAt < LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_CUTOFF_MS &&
    Number.isFinite(sourceDocument.updatedAt) &&
    Number.isFinite(sourceDocument.lastProcessedAt)
  );
}

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
    skippedCount: 0,
    updatedCount: 0,
  };
  let legacyInstagramProfileSnapshotCount = 0;
  for (const sourceDocument of page.page) {
    const canonical = canonicalizeSourceUrl(
      "instagram",
      sourceDocument.instagramPostUrl,
    );
    if (!canonical.ok) {
      if (isLegacyInstagramProfileSnapshot(sourceDocument)) {
        counts.skippedCount! += 1;
        legacyInstagramProfileSnapshotCount += 1;
        continue;
      }
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
    detailJson: JSON.stringify({
      legacyProfileSnapshotPolicy:
        "exact-pre-2026-08-instagram-profile-snapshot-v1",
    }),
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "source-document-canonical-url-v1",
    phase: "canonical_source_urls",
    restart: args.restart ?? false,
    skipReasonCounts: {
      [LEGACY_INSTAGRAM_PROFILE_SNAPSHOT_REASON]:
        legacyInstagramProfileSnapshotCount,
    },
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
