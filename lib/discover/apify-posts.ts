import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { DiscoverFeedEvent } from "@/components/discover/discover-feed";
import {
  buildDiscoverScrapedPostBatch,
  mergeDiscoverScrapedPostBatch,
  type DiscoverScrapedPostRecord,
} from "@/lib/discover/apify-post-alignment";

const getManyScrapedPostsByHandleAndPostRefsQuery =
  "scrapedPosts:getManyByHandleAndPostRefs" as unknown as FunctionReference<"query">;

export async function enrichDiscoverEventsWithApifyPosts(
  events: DiscoverFeedEvent[],
): Promise<DiscoverFeedEvent[]> {
  const { postIndexByEvent, refs } = buildDiscoverScrapedPostBatch(events);
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl || refs.length === 0) {
    return mergeDiscoverScrapedPostBatch(events, postIndexByEvent, []);
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const posts = (await convex.query(getManyScrapedPostsByHandleAndPostRefsQuery, {
      refs,
    })) as Array<DiscoverScrapedPostRecord | null>;
    return mergeDiscoverScrapedPostBatch(events, postIndexByEvent, posts);
  } catch {
    return mergeDiscoverScrapedPostBatch(events, postIndexByEvent, []);
  }
}
