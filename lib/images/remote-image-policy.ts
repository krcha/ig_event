function isAllowedImageHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "images.apifyusercontent.com" ||
    normalized === "cdninstagram.com" ||
    normalized.endsWith(".cdninstagram.com") ||
    normalized === "fbcdn.net" ||
    normalized.endsWith(".fbcdn.net")
  );
}

export function assertAllowedRemoteImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote image URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Remote image URL must use HTTPS.");
  }
  if (url.port && url.port !== "443") {
    throw new Error("Remote image URL must use the default HTTPS port.");
  }
  if (url.username || url.password) {
    throw new Error("Remote image URL must not contain credentials.");
  }
  if (!isAllowedImageHostname(url.hostname)) {
    throw new Error("Remote image host is not allowed.");
  }
  return url;
}

export function isAllowedRemoteImageUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    assertAllowedRemoteImageUrl(value);
    return true;
  } catch {
    return false;
  }
}
