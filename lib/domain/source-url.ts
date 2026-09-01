import {
  DomainError,
  domainFailure,
  domainSuccess,
  type DomainResult,
} from "./errors.ts";

export const SOURCE_URL_CANONICALIZATION_VERSION = 1 as const;

export type SourceProvider = "instagram";

export type CanonicalSourceUrl = {
  canonicalUrl: string;
  externalId: string;
  originalUrl: string;
  provider: SourceProvider;
  resourceType: "post";
  version: typeof SOURCE_URL_CANONICALIZATION_VERSION;
};

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "m.instagram.com",
  "www.instagram.com",
]);
const INSTAGRAM_POST_PATH_KINDS = new Set(["p", "reel", "reels", "tv"]);
const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function invalidSourceUrl(
  provider: SourceProvider,
  originalUrl: string,
  reason: string,
): DomainResult<never> {
  return domainFailure(
    new DomainError("SOURCE_URL_INVALID", `Invalid ${provider} source URL: ${reason}.`, {
      details: { originalUrl, provider, reason },
    }),
  );
}

/**
 * Canonicalizes provider URLs to a durable identity. Instagram uses the media
 * shortcode as identity, so `/p/`, `/reel/`, `/reels/` and legacy `/tv/`
 * representations converge on one `/p/{shortcode}/` URL.
 */
export function canonicalizeSourceUrl(
  provider: SourceProvider,
  value: string | null | undefined,
): DomainResult<CanonicalSourceUrl> {
  const originalUrl = value?.trim() ?? "";
  if (!originalUrl) {
    return invalidSourceUrl(provider, originalUrl, "the URL is empty");
  }

  if (provider !== "instagram") {
    return invalidSourceUrl(provider, originalUrl, "the provider is unsupported");
  }

  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return invalidSourceUrl(provider, originalUrl, "the URL cannot be parsed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidSourceUrl(provider, originalUrl, "the protocol is not HTTP(S)");
  }
  if (parsed.username || parsed.password) {
    return invalidSourceUrl(provider, originalUrl, "userinfo is not allowed");
  }
  if (parsed.port) {
    return invalidSourceUrl(provider, originalUrl, "custom ports are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!INSTAGRAM_HOSTS.has(hostname)) {
    return invalidSourceUrl(provider, originalUrl, "the hostname is not Instagram");
  }

  const pathMatch = parsed.pathname.match(
    /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/iu,
  );
  const resourceKind = (pathMatch?.[1] ?? "").toLowerCase();
  const externalId = pathMatch?.[2] ?? "";
  if (
    !pathMatch ||
    !INSTAGRAM_POST_PATH_KINDS.has(resourceKind) ||
    !INSTAGRAM_SHORTCODE_PATTERN.test(externalId)
  ) {
    return invalidSourceUrl(provider, originalUrl, "the post shortcode is missing or invalid");
  }

  return domainSuccess({
    canonicalUrl: `https://www.instagram.com/p/${externalId}/`,
    externalId,
    originalUrl,
    provider,
    resourceType: "post",
    version: SOURCE_URL_CANONICALIZATION_VERSION,
  });
}

/**
 * Produces transitional lookup variants for rows written before canonical URL
 * backfill. The canonical URL is always first; callers must keep lookups
 * bounded and de-duplicate returned records by ID.
 */
export function getSourceUrlLookupVariants(
  provider: SourceProvider,
  value: string | null | undefined,
): string[] {
  const canonical = canonicalizeSourceUrl(provider, value);
  if (!canonical.ok) return [];

  const { externalId } = canonical.value;
  return [
    canonical.value.canonicalUrl,
    `https://www.instagram.com/reel/${externalId}/`,
    `https://www.instagram.com/reels/${externalId}/`,
    `https://www.instagram.com/tv/${externalId}/`,
  ];
}

export function canonicalizeSourceUrlOrEmpty(
  provider: SourceProvider,
  value: string | null | undefined,
): string {
  const result = canonicalizeSourceUrl(provider, value);
  return result.ok ? result.value.canonicalUrl : "";
}
