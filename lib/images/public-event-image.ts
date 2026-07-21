export function isRawInstagramOrFacebookCdnUrl(
  value: string | null | undefined,
): boolean {
  if (!value) return false;

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "cdninstagram.com" ||
      hostname.endsWith(".cdninstagram.com") ||
      hostname === "fbcdn.net" ||
      hostname.endsWith(".fbcdn.net")
    );
  } catch {
    return false;
  }
}

export function getNonExpiringPublicEventImageUrl(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized || isRawInstagramOrFacebookCdnUrl(normalized)) {
    return undefined;
  }
  return normalized;
}

export function assertPublicEventImageWrite(
  imageUrl: string | undefined,
  imageStorageId: string | undefined,
): void {
  if (imageStorageId && !imageUrl) {
    throw new Error("An event image storage ID requires its current image URL.");
  }
  if (isRawInstagramOrFacebookCdnUrl(imageUrl)) {
    throw new Error(
      "Event image URLs must not reference expiring Instagram or Facebook CDN media.",
    );
  }
}
