import { pickApifySourcedImageUrl } from "@/lib/images/apify-images";

export type DiscoverImageEventSource = {
  _id: string;
  imageUrl?: string | null;
  instagramHandle?: string | null;
};

export type DiscoverImagePostSource = {
  imageUrl?: string | null;
  imageUrls?: string[];
};

export function normalizeDiscoverImageHandle(value: string | null | undefined): string {
  return value?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

export function buildDiscoverImageUrl(event: DiscoverImageEventSource): string {
  const handle = normalizeDiscoverImageHandle(event.instagramHandle);
  const query = handle ? `?handle=${encodeURIComponent(handle)}` : "";
  return `/api/discover/images/${encodeURIComponent(event._id)}${query}`;
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

export function getDiscoverDisplayImageUrl(
  event: DiscoverImageEventSource,
  post: DiscoverImagePostSource | null,
): string | undefined {
  return getDiscoverImageCandidate(event, post) ? buildDiscoverImageUrl(event) : undefined;
}
