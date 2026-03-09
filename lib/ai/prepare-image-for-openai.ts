import sharp from "sharp";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";

const DOWNLOAD_TIMEOUT_MS = 15000;
const DOWNLOAD_MAX_ATTEMPTS = 3;

type DownloadImageOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
};

export type DownloadedImage = {
  imageBuffer: Buffer;
  contentType: string | null;
  sourceUrl: string;
};

export type NormalizedImage = {
  imageBuffer: Buffer;
  mimeType: "image/jpeg";
  wasConverted: boolean;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function imageSourcePriority(url: string): number {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("images.apifyusercontent.com")) return 0;
  if (lowerUrl.includes("cdninstagram.com")) return 1;
  if (lowerUrl.includes("fbcdn.net")) return 2;
  return 3;
}

function isLikelyJpeg(contentTypeOrUrl: string): boolean {
  const normalized = contentTypeOrUrl.toLowerCase();
  return (
    normalized.includes("image/jpeg") ||
    normalized.includes("image/jpg") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg")
  );
}

function isHeifLike(contentTypeOrUrl: string): boolean {
  const normalized = contentTypeOrUrl.toLowerCase();
  return (
    normalized.includes("image/heic") ||
    normalized.includes("image/heif") ||
    normalized.endsWith(".heic") ||
    normalized.endsWith(".heif")
  );
}

export function isInstagramOrFbCdnUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes("cdninstagram.com") || lowerUrl.includes("fbcdn.net");
}

export function resolveBestImageUrl(post: InstagramScrapedPost): string | null {
  const candidates = (post.imageUrls ?? [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter(isHttpUrl);

  if (post.imageUrl && isHttpUrl(post.imageUrl)) {
    candidates.push(post.imageUrl);
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) return null;

  uniqueCandidates.sort((a, b) => imageSourcePriority(a) - imageSourcePriority(b));
  return uniqueCandidates[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function downloadImage(
  url: string,
  options?: DownloadImageOptions,
): Promise<DownloadedImage> {
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxAttempts = options?.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          accept: "image/*,*/*;q=0.8",
        },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `Image download failed with status ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        throw new Error("Downloaded image is empty.");
      }

      return {
        imageBuffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get("content-type"),
        sourceUrl: url,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(attempt * 400);
      }
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : "Unknown download error.";
  throw new Error(`Failed to download image after ${maxAttempts} attempts: ${errorMessage}`);
}

export async function normalizeToJpeg(
  imageBuffer: Buffer,
  contentTypeOrUrl: string,
): Promise<NormalizedImage> {
  try {
    const transformed = await sharp(imageBuffer, { failOn: "none" })
      .rotate()
      .resize({
        width: 2000,
        height: 2000,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();

    return {
      imageBuffer: transformed,
      mimeType: "image/jpeg",
      wasConverted: true,
    };
  } catch (error) {
    if (isLikelyJpeg(contentTypeOrUrl)) {
      return {
        imageBuffer,
        mimeType: "image/jpeg",
        wasConverted: false,
      };
    }

    const conversionHint = isHeifLike(contentTypeOrUrl)
      ? "HEIC/HEIF image could not be decoded."
      : "Image could not be converted to JPEG.";
    const errorMessage = error instanceof Error ? error.message : "Unknown conversion error.";
    throw new Error(`${conversionHint} ${errorMessage}`);
  }
}

export function toDataUrl(imageBuffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
}
