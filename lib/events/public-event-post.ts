import { isPlausibleConvexPublicId } from "@/lib/convex/public-id";
import { canonicalizeSourceUrl } from "@/lib/domain/source-url";
import {
  buildDiscoverImageUrl,
  hasDiscoverImageSource,
} from "@/lib/discover/discover-image-source";

export type PublicEventPostPreview = {
  eventId: string;
  title: string;
  venue: string;
  instagramHandle: string | null;
  instagramPostUrl: string | null;
  imageUrl: string | null;
  caption: string | null;
  captionSource: "instagram" | "event" | null;
};

export type PublicEventPostRecord = {
  _id: string;
  title: string;
  venue: string;
  status: string;
  description?: string | null;
  sourceCaption?: string | null;
  imageUrl?: string | null;
  imageStorageId?: string | null;
  instagramPostId?: string | null;
  instagramPostUrl?: string | null;
};

export type PublicEventPostSourceRef = {
  handle: string;
  postId?: string;
  instagramPostUrl?: string;
};

export type PublicEventPostSourceRecord = {
  caption?: string | null;
  imageUrl?: string | null;
  imageStorageId?: string | null;
  imageUrls?: string[];
  postId: string;
  instagramPostUrl: string;
};

type RouteContext = {
  params: Promise<{ eventId: string }>;
};

type PublicEventPostDependencies = {
  loadEvent: (eventId: string) => Promise<PublicEventPostRecord | null>;
  loadSourcePost: (
    ref: PublicEventPostSourceRef,
  ) => Promise<PublicEventPostSourceRecord | null>;
};

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

function nonemptyText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function instagramPostUrl(value: string | null | undefined): string | null {
  const result = canonicalizeSourceUrl("instagram", value);
  return result.ok ? result.value.canonicalUrl : null;
}

function getSourceRef(event: PublicEventPostRecord): PublicEventPostSourceRef | null {
  const postId = nonemptyText(event.instagramPostId);
  const postUrl = instagramPostUrl(event.instagramPostUrl);
  if (!postId && !postUrl) return null;

  // This existing public lookup uses global exact source indexes. The public
  // event does not establish a post owner, so do not invent a venue/source handle.
  return {
    handle: "",
    ...(postId ? { postId } : {}),
    ...(postUrl ? { instagramPostUrl: postUrl } : {}),
  };
}

function matchesSourceRef(
  ref: PublicEventPostSourceRef,
  post: PublicEventPostSourceRecord,
): boolean {
  const postUrl = instagramPostUrl(post.instagramPostUrl);
  if (ref.instagramPostUrl && postUrl && postUrl !== ref.instagramPostUrl) return false;

  return Boolean(
    (ref.postId && nonemptyText(post.postId) === ref.postId) ||
      (ref.instagramPostUrl && postUrl === ref.instagramPostUrl),
  );
}

function projectPublicEventPost(
  event: PublicEventPostRecord,
  post: PublicEventPostSourceRecord | null,
): PublicEventPostPreview {
  const sourceCaption = nonemptyText(event.sourceCaption) ?? nonemptyText(post?.caption);
  const description = nonemptyText(event.description);
  const sourceUrl = instagramPostUrl(event.instagramPostUrl) ?? instagramPostUrl(post?.instagramPostUrl);
  const imageEvent = { ...event, instagramPostUrl: sourceUrl };

  return {
    eventId: event._id,
    title: event.title,
    venue: event.venue,
    // A canonical physical venue's account is not proof of the original post's
    // owner; promoter-sourced posts must not be attributed to that venue.
    instagramHandle: null,
    instagramPostUrl: sourceUrl,
    imageUrl: hasDiscoverImageSource(imageEvent, post) ? buildDiscoverImageUrl(event) : null,
    caption: sourceCaption ?? description,
    captionSource: sourceCaption ? "instagram" : description ? "event" : null,
  };
}

export function createPublicEventPostHandler({
  loadEvent,
  loadSourcePost,
}: PublicEventPostDependencies) {
  return async function GET(_request: Request, context: RouteContext): Promise<Response> {
    try {
      const { eventId } = await context.params;
      if (!isPlausibleConvexPublicId(eventId)) {
        return Response.json({ error: "Invalid event ID." }, {
          headers: RESPONSE_HEADERS,
          status: 400,
        });
      }

      // Resolve eligibility first. Never expose a source post or even perform
      // its lookup when the selected event is missing, hidden or unapproved.
      const event = await loadEvent(eventId);
      if (!event || event._id !== eventId || event.status !== "approved") {
        return Response.json({ error: "Event not found." }, {
          headers: RESPONSE_HEADERS,
          status: 404,
        });
      }

      let post: PublicEventPostSourceRecord | null = null;
      const ref = !nonemptyText(event.sourceCaption) ? getSourceRef(event) : null;
      if (ref) {
        try {
          const source = await loadSourcePost(ref);
          post = source && matchesSourceRef(ref, source) ? source : null;
        } catch {
          // Original media still resolves independently through the image proxy.
          // Any generated description remains explicitly labeled as event text.
        }
      }

      return Response.json(projectPublicEventPost(event, post), {
        headers: RESPONSE_HEADERS,
      });
    } catch {
      // A backend/configuration failure is not an authoritative missing event.
      return Response.json({ error: "Event post is temporarily unavailable." }, {
        headers: RESPONSE_HEADERS,
        status: 503,
      });
    }
  };
}
