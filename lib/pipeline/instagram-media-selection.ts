import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { resolveBestImageUrl } from "@/lib/ai/prepare-image-for-openai";

export type InstagramIngestionMediaSelection = {
  durableMediaCandidate: string | null;
  extractionMode: "caption_only" | "poster";
  selectedImageUrl: string | null;
};

export function isCaptionOnlyInstagramVideo(
  postType: string | null | undefined,
  usableStillUrl: string | null = null,
): boolean {
  const normalized = postType?.trim().toLowerCase() ?? "";
  const isVideo = normalized.includes("video") || normalized.includes("reel");
  return isVideo && !usableStillUrl?.trim();
}

export function resolveInstagramIngestionMediaSelection(
  post: InstagramScrapedPost,
): InstagramIngestionMediaSelection {
  const durableMediaCandidate = resolveBestImageUrl(post);
  const captionOnlyVideo = isCaptionOnlyInstagramVideo(
    post.postType,
    durableMediaCandidate,
  );
  const extractionMode =
    captionOnlyVideo || !durableMediaCandidate ? "caption_only" : "poster";

  return {
    durableMediaCandidate,
    extractionMode,
    selectedImageUrl: durableMediaCandidate,
  };
}
