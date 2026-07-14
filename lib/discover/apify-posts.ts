import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { DiscoverFeedEvent } from "@/components/discover/discover-feed";
import { getDiscoverDisplayImageUrl } from "@/lib/discover/discover-image-source";
import { normalizeInstagramPostUrl } from "@/lib/images/apify-images";

type ScrapedPostRecord = {
  caption?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[];
  instagramPostUrl: string;
  postId: string;
};

type ScrapedPostRef = {
  handle: string;
  instagramPostUrl?: string;
  postId?: string;
};

const getManyScrapedPostsByHandleAndPostRefsQuery =
  "scrapedPosts:getManyByHandleAndPostRefs" as unknown as FunctionReference<"query">;

function normalizeHandle(value: string | undefined): string {
  return value?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

function normalizeCaption(value: string | null | undefined): string | null {
  const caption = value?.trim();
  return caption ? caption : null;
}

function getScrapedPostRef(event: DiscoverFeedEvent): ScrapedPostRef | null {
  const handle = normalizeHandle(event.instagramHandle);
  const instagramPostUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  if (!handle || (!event.instagramPostId && !instagramPostUrl)) {
    return null;
  }

  return {
    handle,
    ...(instagramPostUrl ? { instagramPostUrl } : {}),
    ...(event.instagramPostId ? { postId: event.instagramPostId } : {}),
  };
}

function mergeApifyPostIntoDiscoverEvent(
  event: DiscoverFeedEvent,
  post: ScrapedPostRecord | null,
): DiscoverFeedEvent {
  const sourceCaption = normalizeCaption(event.sourceCaption) ?? normalizeCaption(post?.caption);

  return {
    ...event,
    imageUrl: getDiscoverDisplayImageUrl(event, post),
    sourceCaption: sourceCaption ?? undefined,
  };
}

export async function enrichDiscoverEventsWithApifyPosts(
  events: DiscoverFeedEvent[],
): Promise<DiscoverFeedEvent[]> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl || events.length === 0) {
    return events.map((event) => mergeApifyPostIntoDiscoverEvent(event, null));
  }

  const refsByEvent = events.map(getScrapedPostRef);
  const refs = refsByEvent.filter((ref): ref is ScrapedPostRef => ref !== null).slice(0, 100);
  if (refs.length === 0) {
    return events.map((event) => mergeApifyPostIntoDiscoverEvent(event, null));
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const posts = (await convex.query(getManyScrapedPostsByHandleAndPostRefsQuery, {
      refs,
    })) as Array<ScrapedPostRecord | null>;
    let postIndex = 0;
    return events.map((event, eventIndex) => {
      if (!refsByEvent[eventIndex] || postIndex >= posts.length) {
        return mergeApifyPostIntoDiscoverEvent(event, null);
      }
      const post = posts[postIndex] ?? null;
      postIndex += 1;
      return mergeApifyPostIntoDiscoverEvent(event, post);
    });
  } catch {
    return events.map((event) => mergeApifyPostIntoDiscoverEvent(event, null));
  }
}
