import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { DiscoverFeedEvent } from "@/components/discover/discover-feed";
import { getDiscoverDisplayImageUrl } from "@/lib/discover/discover-image-source";
import {
  normalizeInstagramPostUrl,
} from "@/lib/images/apify-images";

type ScrapedPostRecord = {
  caption?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[];
  instagramPostUrl: string;
  postId: string;
};

const getScrapedPostByHandleAndPostRefQuery =
  "scrapedPosts:getByHandleAndPostRef" as unknown as FunctionReference<"query">;

function normalizeHandle(value: string | undefined): string {
  return value?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

function normalizeCaption(value: string | null | undefined): string | null {
  const caption = value?.trim();
  return caption ? caption : null;
}

async function loadMatchingScrapedPost(
  convex: ConvexHttpClient,
  event: DiscoverFeedEvent,
): Promise<ScrapedPostRecord | null> {
  const handle = normalizeHandle(event.instagramHandle);
  const instagramPostUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
  if (!handle || (!event.instagramPostId && !instagramPostUrl)) {
    return null;
  }

  return (await convex.query(getScrapedPostByHandleAndPostRefQuery, {
    handle,
    ...(instagramPostUrl ? { instagramPostUrl } : {}),
    ...(event.instagramPostId ? { postId: event.instagramPostId } : {}),
  })) as ScrapedPostRecord | null;
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

  const convex = new ConvexHttpClient(convexUrl);

  try {
    const posts = await Promise.all(
      events.map((event) => loadMatchingScrapedPost(convex, event)),
    );
    return events.map((event, index) =>
      mergeApifyPostIntoDiscoverEvent(event, posts[index] ?? null),
    );
  } catch {
    return events.map((event) => mergeApifyPostIntoDiscoverEvent(event, null));
  }
}
