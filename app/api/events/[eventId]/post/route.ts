import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import {
  createPublicEventPostHandler,
  type PublicEventPostRecord,
  type PublicEventPostSourceRecord,
} from "@/lib/events/public-event-post";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
const getManyScrapedPostsByHandleAndPostRefsQuery =
  "scrapedPosts:getManyByHandleAndPostRefs" as unknown as FunctionReference<"query">;

type RouteContext = {
  params: Promise<{ eventId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  let convex: ConvexHttpClient | undefined;
  function getClient(): ConvexHttpClient {
    if (!convex) {
      const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
      if (!convexUrl) throw new Error("Public data is not configured.");
      convex = new ConvexHttpClient(convexUrl);
    }
    return convex;
  }

  return createPublicEventPostHandler({
    loadEvent: (eventId) => getClient().query(getPublicApprovedEventQuery, {
      id: eventId,
    }) as Promise<PublicEventPostRecord | null>,
    loadSourcePost: async (ref) => {
      const posts = await getClient().query(getManyScrapedPostsByHandleAndPostRefsQuery, {
        refs: [ref],
      }) as Array<PublicEventPostSourceRecord | null>;
      return posts[0] ?? null;
    },
  })(request, context);
}
