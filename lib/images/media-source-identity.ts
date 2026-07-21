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
  const rawInstagramPostUrl = identity.instagramPostUrl?.trim() ?? "";
  if (rawInstagramPostUrl) {
    let hostname: string;
    try {
      hostname = new URL(rawInstagramPostUrl).hostname.toLowerCase();
    } catch {
      throw new Error("Instagram media persistence requires a valid Instagram post URL.");
    }
    if (hostname !== "instagram.com" && !hostname.endsWith(".instagram.com")) {
      throw new Error("Instagram media persistence requires an Instagram post URL.");
    }
  }
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

export function hasCoherentInstagramMediaSourceRecord(
  identity: InstagramMediaSourceIdentity,
  persistedRecords: readonly InstagramMediaSourceIdentity[],
): boolean {
  if (!identity.postId?.trim() || !identity.instagramPostUrl?.trim()) {
    return true;
  }
  const normalized = normalizeInstagramMediaSourceIdentity(identity);
  return persistedRecords.some((record) => {
    const persisted = normalizeInstagramMediaSourceIdentity(record);
    return (
      persisted.postId === normalized.postId &&
      persisted.normalizedInstagramPostUrl === normalized.normalizedInstagramPostUrl
    );
  });
}
