import { canonicalizeSourceUrl } from "../domain/source-url.ts";

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
  const canonical = canonicalizeSourceUrl("instagram", raw);
  // Compatibility callers historically retain malformed/non-Instagram input
  // so equality checks fail against valid evidence instead of collapsing two
  // invalid values to an empty identity. Valid provider identity is owned only
  // by `lib/domain/source-url`.
  return canonical.ok ? canonical.value.canonicalUrl : raw;
}
