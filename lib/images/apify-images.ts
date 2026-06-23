export const APIFY_IMAGE_HOSTNAME = "images.apifyusercontent.com";

function getHostname(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isApifyImageUrl(value: string | null | undefined): value is string {
  return getHostname(value) === APIFY_IMAGE_HOSTNAME;
}

export function isInstagramCdnImageUrl(value: string | null | undefined): value is string {
  const hostname = getHostname(value);
  return Boolean(
    hostname &&
      (hostname === "cdninstagram.com" ||
        hostname.endsWith(".cdninstagram.com") ||
        hostname === "fbcdn.net" ||
        hostname.endsWith(".fbcdn.net")),
  );
}

export function isApifySourcedImageUrl(value: string | null | undefined): value is string {
  return isApifyImageUrl(value) || isInstagramCdnImageUrl(value);
}

export function pickApifyImageUrl(
  candidates: readonly (string | null | undefined)[],
): string | null {
  return candidates.find(isApifyImageUrl) ?? null;
}

export function pickApifySourcedImageUrl(
  candidates: readonly (string | null | undefined)[],
): string | null {
  return candidates.find(isApifyImageUrl) ?? candidates.find(isInstagramCdnImageUrl) ?? null;
}

export function normalizeInstagramPostUrl(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    if (!url.hostname.toLowerCase().endsWith("instagram.com")) {
      return raw;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `https://www.instagram.com/${parts[0]}/${parts[1]}/`;
    }
  } catch {
    return raw;
  }

  return raw;
}
