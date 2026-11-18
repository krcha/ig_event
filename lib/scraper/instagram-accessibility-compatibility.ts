/** Pure compatibility proofs used only when preserving an existing analysis cache. */

const MONTHS = "January February March April May June July August September October November December".split(" ");
const DATE_TEXT = "(?:January|February|March|April|May|June|July|August|September|October|November|December) \\d{2}, \\d{4}";
const HANDLE = "@[A-Za-z0-9._]{1,30}";
const HANDLE_LIST = `${HANDLE}(?:, ${HANDLE})*, and ${HANDLE}`;
const INERT_IMAGE_CLAUSES = new Set([
  "May be an image of poster and text.",
]);
const MAX_OLD_ALT_LENGTH = 1_024;
const MAX_NEW_ALT_LENGTH = 4_096;
const MAX_AUTHOR_LENGTH = 256;

type PhotoAttribution = { author: string; dateKey: string };

function parseDate(value: string): string | null {
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{2}), (\d{4})$/u.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseBareAttribution(value: string): PhotoAttribution | null {
  const match = new RegExp(`^Photo by (.+) on (${DATE_TEXT})\\.$`, "u").exec(value);
  if (!match || match[1].length > MAX_AUTHOR_LENGTH) return null;
  const dateKey = parseDate(match[2]);
  return dateKey ? { author: match[1], dateKey } : null;
}

function isCompleteTagList(value: string): boolean {
  if (new RegExp(`^${HANDLE}$`, "u").test(value)) return true;
  return new RegExp(`^${HANDLE_LIST}$`, "u").test(value);
}

/**
 * True only when `newAlt` is a complete, inert Instagram accessibility wrapper
 * around the exact author/date attribution in `oldAlt`. This predicate never
 * rewrites source data; callers may use it only as one part of a cache-preserve
 * decision for an already completed current-quality source.
 */
export function isInertGeneratedAltEnrichment(oldAlt: string | null, newAlt: string | null): boolean {
  if (typeof oldAlt !== "string" || typeof newAlt !== "string" ||
    oldAlt.length > MAX_OLD_ALT_LENGTH || newAlt.length > MAX_NEW_ALT_LENGTH) return false;
  const oldValue = parseBareAttribution(oldAlt);
  if (!oldValue) return false;

  const wrapper = new RegExp(
    `^Photo (?:shared )?by (.+?) on (${DATE_TEXT}) tagging (.+)\\. (May be an image(?: of poster and text)?\\.)$`,
    "u",
  ).exec(newAlt);
  if (!wrapper || wrapper[1].length === 0 || wrapper[1].length > MAX_AUTHOR_LENGTH ||
    !INERT_IMAGE_CLAUSES.has(wrapper[4])) return false;
  const wrappedDate = parseDate(wrapper[2]);
  return wrapper[1].normalize("NFKC") === oldValue.author.normalize("NFKC") &&
    wrappedDate !== null && wrappedDate === oldValue.dateKey &&
    isCompleteTagList(wrapper[3]);
}

export type InstagramSlideAsset = {
  index: number;
  mediaType?: "image" | "video" | "unknown";
  imageUrls: readonly string[];
};

export type InstagramSlideAssetManifest = {
  slides: readonly InstagramSlideAsset[];
  /** Provider-declared total slide count, including any unretained slides. */
  completeCount: number;
};

function canonicalStaticAsset(value: string): { pathname: string; cacheKey: string | null } | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  const isInstagramCdn = hostname === "cdninstagram.com" || hostname.endsWith(".cdninstagram.com");
  const isFacebookCdn = hostname === "fbcdn.net" || hostname.endsWith(".fbcdn.net");
  if (!isInstagramCdn && !isFacebookCdn) return null;

  // The observed complete KISSA image set uses this Instagram photo family and
  // numeric static filename shape. Other version families, transformed, opaque
  // and unknown URL schemas remain unverified and fail closed.
  if (!/^\/v\/t51\.82787-15\/\d{6,}_\d{6,}_\d{6,}_n\.jpg$/u.test(url.pathname)) return null;
  const cacheKeys = url.searchParams.getAll("ig_cache_key");
  if (cacheKeys.length > 1 || (cacheKeys.length === 1 && cacheKeys[0].length === 0)) return null;
  return { pathname: url.pathname, cacheKey: cacheKeys[0] ?? null };
}

function certifiedSlideIdentity(imageUrls: readonly string[]): { pathname: string; cacheKey: string } | null {
  if (imageUrls.length === 0) return null;
  let identity: { pathname: string; cacheKey: string } | null = null;
  for (const imageUrl of imageUrls) {
    const asset = canonicalStaticAsset(imageUrl);
    if (!asset || asset.cacheKey === null) return null;
    if (identity && (identity.pathname !== asset.pathname || identity.cacheKey !== asset.cacheKey)) return null;
    identity = { pathname: asset.pathname, cacheKey: asset.cacheKey };
  }
  return identity;
}

/**
 * Proves ordered equality of complete static photo assets. Callers must provide
 * complete manifests; video/unknown slides, partial manifests and unknown CDN
 * URL schemas are deliberately rejected. Child IDs are not inferred from the
 * slide index.
 */
export function sameInstagramSlideAssets(
  oldManifest: InstagramSlideAssetManifest,
  newManifest: InstagramSlideAssetManifest,
): boolean {
  if (!oldManifest || !newManifest || !Array.isArray(oldManifest.slides) || !Array.isArray(newManifest.slides) ||
    !Number.isSafeInteger(oldManifest.completeCount) || oldManifest.completeCount < 1 ||
    oldManifest.completeCount !== oldManifest.slides.length ||
    oldManifest.completeCount !== newManifest.completeCount ||
    newManifest.completeCount !== newManifest.slides.length) return false;

  for (let index = 0; index < oldManifest.slides.length; index += 1) {
    const oldSlide = oldManifest.slides[index];
    const newSlide = newManifest.slides[index];
    if (!oldSlide || !newSlide || !Array.isArray(oldSlide.imageUrls) || !Array.isArray(newSlide.imageUrls) ||
      oldSlide.index !== index || newSlide.index !== index ||
      oldSlide.mediaType !== "image" || newSlide.mediaType !== "image" ||
      oldSlide.imageUrls.length === 0 || newSlide.imageUrls.length === 0) return false;
    const oldIdentity = certifiedSlideIdentity(oldSlide.imageUrls);
    const newIdentity = certifiedSlideIdentity(newSlide.imageUrls);
    if (!oldIdentity || !newIdentity || oldIdentity.pathname !== newIdentity.pathname ||
      oldIdentity.cacheKey !== newIdentity.cacheKey) return false;
  }
  return true;
}
