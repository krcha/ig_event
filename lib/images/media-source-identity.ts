import { canonicalizeSourceUrl } from "@/lib/domain/source-url";

export type InstagramMediaSourceIdentity = {
  postId?: string | null;
  instagramPostUrl?: string | null;
};

export type NormalizedInstagramMediaSourceIdentity = {
  canonicalSourceUrl: string;
  postId: string;
  normalizedInstagramPostUrl: string;
  sourceKey: string;
};

export function normalizeInstagramMediaSourceIdentity(
  identity: InstagramMediaSourceIdentity,
): NormalizedInstagramMediaSourceIdentity {
  const postId = identity.postId?.trim() ?? "";
  const rawInstagramPostUrl = identity.instagramPostUrl?.trim() ?? "";
  const canonical = rawInstagramPostUrl
    ? canonicalizeSourceUrl("instagram", rawInstagramPostUrl)
    : null;
  if (canonical && !canonical.ok) {
    throw new Error("Instagram media persistence requires a canonical Instagram post URL.");
  }
  const canonicalSourceUrl = canonical?.ok ? canonical.value.canonicalUrl : "";
  if (!postId && !canonicalSourceUrl) {
    throw new Error("Instagram media persistence requires a post ID or Instagram post URL.");
  }

  return {
    canonicalSourceUrl,
    postId,
    normalizedInstagramPostUrl: canonicalSourceUrl,
    sourceKey: postId
      ? `instagram-post:${postId}`
      : `instagram-url:${canonicalSourceUrl}`,
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
  let exactPairFound = false;
  for (const record of persistedRecords) {
    const persisted = normalizeInstagramMediaSourceIdentity(record);
    if (
      persisted.postId === normalized.postId &&
      persisted.normalizedInstagramPostUrl &&
      persisted.normalizedInstagramPostUrl !== normalized.normalizedInstagramPostUrl
    ) {
      return false;
    }
    if (
      persisted.normalizedInstagramPostUrl === normalized.normalizedInstagramPostUrl &&
      persisted.postId &&
      persisted.postId !== normalized.postId
    ) {
      return false;
    }
    if (
      persisted.postId === normalized.postId &&
      persisted.normalizedInstagramPostUrl === normalized.normalizedInstagramPostUrl
    ) {
      exactPairFound = true;
    }
  }
  return exactPairFound;
}
