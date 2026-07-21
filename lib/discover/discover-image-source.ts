import { pickApifySourcedImageUrl } from "@/lib/images/apify-images";

export type DiscoverImageEventSource = {
  _id: string;
  imageUrl?: string | null;
  imageStorageId?: string | null;
  instagramPostId?: string | null;
  instagramPostUrl?: string | null;
};

export type DiscoverImagePostSource = {
  imageUrl?: string | null;
  imageStorageId?: string | null;
  imageUrls?: string[];
};

export function buildDiscoverImageUrl(event: DiscoverImageEventSource): string {
  return `/api/discover/images/${encodeURIComponent(event._id)}`;
}

export function getDiscoverImageCandidate(
  event: DiscoverImageEventSource,
  post: DiscoverImagePostSource | null,
): string | null {
  return pickApifySourcedImageUrl([
    event.imageUrl,
    post?.imageUrl,
    ...(post?.imageUrls ?? []),
  ]);
}

export function hasDiscoverImageSource(
  event: DiscoverImageEventSource,
  post: DiscoverImagePostSource | null = null,
): boolean {
  return Boolean(
    event.imageStorageId ||
      event.instagramPostId ||
      event.instagramPostUrl ||
      post?.imageStorageId ||
      getDiscoverImageCandidate(event, post),
  );
}

export function getDiscoverDisplayImageUrl(
  event: DiscoverImageEventSource,
  post: DiscoverImagePostSource | null,
): string | undefined {
  return hasDiscoverImageSource(event, post) ? buildDiscoverImageUrl(event) : undefined;
}
