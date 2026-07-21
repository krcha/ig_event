import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { resolveBestImageUrl } from "@/lib/ai/prepare-image-for-openai";

export type InstagramIngestionMediaSelection = {
  durableMediaCandidate: string | null;
  extractionMode: "caption_only" | "poster";
  selectedImageUrl: string | null;
};

export function isCaptionOnlyInstagramVideo(postType: string | null | undefined): boolean {
  const normalized = postType?.trim().toLowerCase() ?? "";
  return normalized.includes("video") || normalized.includes("reel");
}

export function resolveInstagramIngestionMediaSelection(
  post: InstagramScrapedPost,
): InstagramIngestionMediaSelection {
  const durableMediaCandidate = resolveBestImageUrl(post);
  const captionOnlyVideo = isCaptionOnlyInstagramVideo(post.postType);

  return {
    durableMediaCandidate,
    extractionMode: captionOnlyVideo ? "caption_only" : "poster",
    selectedImageUrl: captionOnlyVideo ? null : durableMediaCandidate,
  };
}
