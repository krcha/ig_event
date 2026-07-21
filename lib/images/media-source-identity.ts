import { normalizeInstagramPostUrl } from "@/lib/images/apify-images";

export type InstagramMediaSourceIdentity = {
  postId?: string | null;
  instagramPostUrl?: string | null;
};

export type NormalizedInstagramMediaSourceIdentity = {
  postId: string;
  normalizedInstagramPostUrl: string;
  sourceKey: string;
};

export function normalizeInstagramMediaSourceIdentity(
  identity: InstagramMediaSourceIdentity,
): NormalizedInstagramMediaSourceIdentity {
  const postId = identity.postId?.trim() ?? "";
  const normalizedInstagramPostUrl = normalizeInstagramPostUrl(identity.instagramPostUrl);
  if (!postId && !normalizedInstagramPostUrl) {
    throw new Error("Instagram media persistence requires a post ID or Instagram post URL.");
  }

  return {
    postId,
    normalizedInstagramPostUrl,
    sourceKey: postId
      ? `instagram-post:${postId}`
      : `instagram-url:${normalizedInstagramPostUrl}`,
  };
}
