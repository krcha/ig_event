import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isCaptionSourceCoherentWithEvent } from "../lib/events/event-source-approval";
import {
  hasCompleteSourceGroundedAutoApproval,
  hasCompleteSourceGroundingAttestation,
} from "../lib/events/event-update-precondition";
import { normalizeInstagramPostUrl } from "../lib/images/apify-images";
import { normalizeHandle } from "../lib/pipeline/venue-normalization";

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Reconstruct the public-approval decision from the canonical persisted
 * Instagram post. Event fields and normalized flags are necessary, but never
 * sufficient authority for public visibility.
 */
export async function isCanonicallyGroundedApprovedEvent(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
): Promise<boolean> {
  if (event.status !== "approved") return false;
  const fields = parseObject(event.normalizedFieldsJson);
  if (!fields) return false;
  const machineAuthorized = hasCompleteSourceGroundedAutoApproval(
    event.normalizedFieldsJson,
    {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    },
  );
  const humanAuthorized =
    typeof event.reviewedAt === "number" &&
    Number.isFinite(event.reviewedAt) &&
    typeof event.reviewedBy === "string" &&
    Boolean(event.reviewedBy.trim()) &&
    hasCompleteSourceGroundingAttestation(event.normalizedFieldsJson, {
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      imageUrl: event.imageUrl,
      instagramPostId: event.instagramPostId,
      instagramPostUrl: event.instagramPostUrl,
      sourceCaption: event.sourceCaption,
      sourcePostedAt: event.sourcePostedAt,
      venueInstagramHandle: event.venueInstagramHandle,
    });
  if (!machineAuthorized && !humanAuthorized) {
    return false;
  }

  const sourceHandle = normalizeHandle(
    readString(fields.sourceGroundingInstagramHandle) ??
      event.venueInstagramHandle ??
      "",
  );
  const postId = event.instagramPostId?.trim();
  if (!sourceHandle || !postId) return false;
  const persistedPost = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .first();
  if (!persistedPost) return false;

  const persistedCaption = persistedPost.caption?.trim();
  const persistedUrl = normalizeInstagramPostUrl(persistedPost.instagramPostUrl);
  const eventUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  const groundedUrl = normalizeInstagramPostUrl(
    readString(fields.sourceGroundingInstagramPostUrl) ?? undefined,
  );
  if (
    !persistedCaption ||
    event.sourceCaption?.trim() !== persistedCaption ||
    readString(fields.sourceGroundingSourceCaption) !== persistedCaption ||
    persistedPost.postId !== postId ||
    readString(fields.sourceGroundingInstagramPostId) !== postId ||
    !persistedUrl ||
    persistedUrl !== eventUrl ||
    persistedUrl !== groundedUrl ||
    !persistedPost.postedAt ||
    persistedPost.postedAt !== event.sourcePostedAt
  ) {
    return false;
  }

  return isCaptionSourceCoherentWithEvent({
    title: event.title,
    date: event.date,
    time: event.time,
    venue: event.venue,
    artists: event.artists,
    sourceCaption: persistedCaption,
    sourcePostedAt: persistedPost.postedAt,
    instagramPostId: persistedPost.postId,
    instagramPostUrl: persistedPost.instagramPostUrl,
    sourceInstagramHandle: persistedPost.handle,
    venueInstagramHandle: event.venueInstagramHandle,
  });
}
