import type { DiscoverFeedEvent } from "@/components/discover/discover-feed";
import { getDiscoverDisplayImageUrl } from "@/lib/discover/discover-image-source";
import { normalizeInstagramPostUrl } from "@/lib/images/apify-images";

export const MAX_DISCOVER_SCRAPED_POST_REFS = 100;

export type DiscoverScrapedPostRecord = {
  caption?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[];
  instagramPostUrl: string;
  postId: string;
};

export type DiscoverScrapedPostRef = {
  handle: string;
  instagramPostUrl?: string;
  postId?: string;
};

function normalizeHandle(value: string | undefined): string {
  return value?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

function normalizeCaption(value: string | null | undefined): string | null {
  const caption = value?.trim();
  return caption ? caption : null;
}

function getScrapedPostRef(event: DiscoverFeedEvent): DiscoverScrapedPostRef | null {
  const handle = normalizeHandle(event.instagramHandle);
  const instagramPostUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  const postId = event.instagramPostId?.trim();
  if (!handle || (!postId && !instagramPostUrl)) {
    return null;
  }

  return {
    handle,
    ...(instagramPostUrl ? { instagramPostUrl } : {}),
    ...(postId ? { postId } : {}),
  };
}

function getScrapedPostRefKey(ref: DiscoverScrapedPostRef): string {
  return `${ref.handle}\u0000${ref.postId ? `id:${ref.postId}` : `url:${ref.instagramPostUrl}`}`;
}

export function buildDiscoverScrapedPostBatch(events: DiscoverFeedEvent[]): {
  postIndexByEvent: Array<number | null>;
  refs: DiscoverScrapedPostRef[];
} {
  const refs: DiscoverScrapedPostRef[] = [];
  const indexByRef = new Map<string, number>();
  const postIndexByEvent = events.map((event) => {
    const ref = getScrapedPostRef(event);
    if (!ref) {
      return null;
    }

    const key = getScrapedPostRefKey(ref);
    const existingIndex = indexByRef.get(key);
    if (existingIndex !== undefined) {
      return existingIndex;
    }
    if (refs.length >= MAX_DISCOVER_SCRAPED_POST_REFS) {
      return null;
    }

    const index = refs.length;
    refs.push(ref);
    indexByRef.set(key, index);
    return index;
  });

  return { postIndexByEvent, refs };
}

function mergeScrapedPostIntoDiscoverEvent(
  event: DiscoverFeedEvent,
  post: DiscoverScrapedPostRecord | null,
): DiscoverFeedEvent {
  const sourceCaption = normalizeCaption(event.sourceCaption) ?? normalizeCaption(post?.caption);

  return {
    ...event,
    imageUrl: getDiscoverDisplayImageUrl(event, post),
    sourceCaption: sourceCaption ?? undefined,
  };
}

export function mergeDiscoverScrapedPostBatch(
  events: DiscoverFeedEvent[],
  postIndexByEvent: Array<number | null>,
  posts: Array<DiscoverScrapedPostRecord | null>,
): DiscoverFeedEvent[] {
  return events.map((event, eventIndex) => {
    const postIndex = postIndexByEvent[eventIndex];
    const post = postIndex === null || postIndex === undefined ? null : posts[postIndex] ?? null;
    return mergeScrapedPostIntoDiscoverEvent(event, post);
  });
}
