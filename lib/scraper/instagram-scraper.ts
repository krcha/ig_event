import { getRequiredEnv } from "../utils/env.ts";
import { fetchInstaloaderItems, getInstagramScraperProvider } from "./instaloader-client.ts";

const DEFAULT_APIFY_ACTOR_ID = "apify/instagram-post-scraper";
const DEFAULT_RESULTS_LIMIT = 3;
const MAX_TOP_LEVEL_POSTS_PER_ACCOUNT = 20;
const DEFAULT_DAYS_BACK = 10;
const DEFAULT_APIFY_HISTORY_RUNS_LIMIT = 100;
const MAX_APIFY_HISTORY_RUNS_LIMIT = 200;
const DEFAULT_SKIP_PINNED_POSTS = false;
const DEFAULT_APIFY_DATA_DETAIL_LEVEL = "basicData";
const APIFY_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MIN_APIFY_PAID_RUN_CHARGE_USD = 0.005;
const DEFAULT_APIFY_RUN_TIMEOUT_SECONDS = 120;
const MIN_APIFY_RUN_TIMEOUT_SECONDS = 30;
const MAX_APIFY_RUN_TIMEOUT_SECONDS = 300;
const SUPPORTED_APIFY_MEMORY_MBYTES = [
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
] as const;
const MIN_APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN = 0.01;
const MAX_APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN = 0.04;
const DEFAULT_APIFY_MAX_TOTAL_CHARGE_USD_PER_RESULT = 0.002;
const APIFY_API_BASE_URL = "https://api.apify.com/v2";
const INSTAGRAM_HOSTNAMES = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_POST_PATH_PREFIXES = new Set(["p", "reel", "reels", "tv"]);
const LEGACY_APIFY_ACTOR_IDS = new Set(["apify/instagram-scraper", "apify~instagram-scraper"]);

export type InstagramScrapedPost = {
  postId: string;
  caption: string | null;
  altText: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  /** Ordered provider slides; each slide's URLs are alternate representations. */
  imageSlides?: InstagramImageSlide[];
  /** Includes provider slides beyond the bounded retained manifest. */
  imageSlideCount?: number;
  postType: string | null;
  locationName: string | null;
  instagramPostUrl: string;
  postedAt: string | null;
  username: string;
  /** Transient acquisition provenance; never a persisted source fact. */
  metadataProvider?: "instaloader";
  /**
   * Kept only while selecting the current profile's newest post. Pinned posts
   * are deliberately never persisted into the normal ingestion path.
   */
  isPinned?: boolean;
};

export type InstagramImageSlide = {
  index: number;
  imageUrls: string[];
  mediaType?: "image" | "video" | "unknown";
};

export const MAX_RETAINED_INSTAGRAM_IMAGE_SLIDES = 20;

export type InstagramPinnedPostPolicy = "exclude_all" | "include_recent";

export const INSTAGRAM_SCRAPE_RAW_ITEM_COUNT = Symbol("instagramScrapeRawItemCount");

export function getInstagramScrapeRawItemCount(posts: InstagramScrapedPost[]): number {
  const annotated = posts as InstagramScrapedPost[] & {
    [INSTAGRAM_SCRAPE_RAW_ITEM_COUNT]?: number;
  };
  return annotated[INSTAGRAM_SCRAPE_RAW_ITEM_COUNT] ?? posts.length;
}

type ScrapeInstagramAccountOptions = {
  handle: string;
  resultsLimit?: number;
  daysBack?: number;
  /** Controller-only catch-up switch. Never infer this from a missing daysBack. */
  noAgeCutoff?: boolean;
  skipPinnedPosts?: boolean;
  pinnedPostPolicy?: InstagramPinnedPostPolicy;
  /** Durable daily/catch-up runs retain every eligible post in their paid window. */
  selectAllEligiblePosts?: boolean;
  maxTotalChargeUsd?: number;
  onlyPostsNewerThan?: string;
  abortAtMs?: number;
  /** Stable controller/lease identity for the collector's acquisition journal. */
  requestId?: string;
  /** Controller-only: readiness was checked before committing its attempt. */
  collectorReadinessChecked?: boolean;
  onRequestStarted?: () => void | Promise<void>;
  onTransportInvoked?: () => void;
};

type ApifyDataDetailLevel = "basicData" | "detailedData";

export type ApifyInstagramScrapeRequest = {
  input: {
    username: string[];
    resultsLimit: number;
    onlyPostsNewerThan: string;
    skipPinnedPosts: boolean;
    dataDetailLevel: ApifyDataDetailLevel;
  };
  runOptions: {
    maxItems: number;
    maxTotalChargeUsd: number;
    timeout: number;
    memory?: number;
  };
  daysBack: number;
};

type LoadRecentApifyRunPostsOptions = {
  handles?: string[];
  runsLimit?: number;
};

type ApifyInstagramImage =
  | string
  | {
      type?: string;
      id?: string | number;
      shortCode?: string;
      isVideo?: boolean;
      is_video?: boolean;
      url?: string;
      displayUrl?: string | null;
      display_url?: string;
      imageUrl?: string;
      image_url?: string;
      displayUrlHD?: string;
      display_url_hd?: string;
      thumbnailUrl?: string;
      thumbnail_url?: string;
      image_versions2?: { candidates?: Array<{ url?: string }> };
    };

type ApifyInstagramItem = {
  error?: unknown;
  errorDescription?: string;
  type?: string;
  productType?: string;
  mediaType?: string;
  __typename?: string;
  isVideo?: boolean;
  is_video?: boolean;
  id?: string | number;
  pk?: string | number;
  shortCode?: string;
  shortcode?: string;
  code?: string;
  postId?: string | number;
  url?: string;
  caption?: string | { text?: string } | null;
  captionText?: string;
  caption_text?: string;
  alt?: string | null;
  displayUrl?: string | null;
  display_url?: string;
  displayUrlHD?: string;
  display_url_hd?: string;
  imageUrl?: string;
  image_url?: string;
  thumbnailUrl?: string;
  thumbnail_url?: string;
  imageUrls?: string[];
  image_urls?: string[];
  images?: ApifyInstagramImage[];
  sidecarImages?: ApifyInstagramImage[];
  childPosts?: ApifyInstagramImage[];
  carouselMediaCount?: number;
  carousel_media_count?: number;
  childPostsCount?: number;
  imageSlideCount?: number;
  image_versions2?: {
    candidates?: Array<{ url?: string }>;
  };
  timestamp?: string | number;
  takenAtTimestamp?: number;
  taken_at_timestamp?: number;
  takenAt?: string;
  taken_at?: string;
  ownerUsername?: string;
  owner_username?: string;
  username?: string;
  owner?: { username?: string };
  locationName?: string | null;
  location_name?: string;
  location?: { name?: string };
  isPinned?: boolean;
  is_pinned?: boolean;
  pinned?: boolean;
};

type ApifyCollectionResponse<T> = {
  data?: {
    items?: T[];
  };
};

type ApifyActorRun = {
  id?: string;
  defaultDatasetId?: string;
  status?: string;
  finishedAt?: string;
  usageTotalUsd?: number | null;
};

export type RecentApifyRunPostsResult = {
  runsScanned: number;
  importedPosts: number;
  importedPostsByHandle: Record<string, InstagramScrapedPost[]>;
};

function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "instagram.com" || parsed.hostname === "www.instagram.com") {
      const candidate = parsed.pathname.split("/").filter(Boolean)[0];
      if (candidate) {
        return candidate.replace(/^@/, "").trim().toLowerCase();
      }
    }
  } catch {
    // Fall back to treating the input as a raw handle.
  }

  return (
    trimmed
      .replace(/^@/, "")
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
      .split("/")
      .filter(Boolean)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function normalizeResultsLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RESULTS_LIMIT;
  }
  const rounded = Math.trunc(value as number);
  if (rounded < 1) {
    return DEFAULT_RESULTS_LIMIT;
  }
  return Math.min(rounded, MAX_TOP_LEVEL_POSTS_PER_ACCOUNT);
}

function normalizeDaysBack(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DAYS_BACK;
  }

  const rounded = Math.trunc(value as number);
  if (rounded < 1) {
    return DEFAULT_DAYS_BACK;
  }

  return Math.min(rounded, 30);
}

function normalizeApifySkipPinnedPosts(value: string | undefined): boolean {
  if (value == null || value.trim().length === 0) {
    return DEFAULT_SKIP_PINNED_POSTS;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeApifyRunTimeoutSeconds(value: string | undefined): number {
  if (!value) {
    return DEFAULT_APIFY_RUN_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_APIFY_RUN_TIMEOUT_SECONDS;
  }

  return Math.max(
    MIN_APIFY_RUN_TIMEOUT_SECONDS,
    Math.min(parsed, MAX_APIFY_RUN_TIMEOUT_SECONDS),
  );
}

function normalizeApifyMaxTotalChargeUsdPerRun(
  value: string | undefined,
  resultsLimit: number,
): number {
  const configured = value ? Number.parseFloat(value) : Number.NaN;
  const requested =
    Number.isFinite(configured) && configured > 0
      ? configured
      : Math.max(
          MIN_APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN,
          resultsLimit * DEFAULT_APIFY_MAX_TOTAL_CHARGE_USD_PER_RESULT,
        );

  return Math.min(requested, MAX_APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN);
}

function normalizeApifyMemoryMbytes(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  const requestedMbytes = /g(?:b|ib)?$/.test(normalized)
    ? parsed * 1024
    : parsed;

  for (const memory of SUPPORTED_APIFY_MEMORY_MBYTES) {
    if (memory >= requestedMbytes) {
      return memory;
    }
  }

  return SUPPORTED_APIFY_MEMORY_MBYTES[SUPPORTED_APIFY_MEMORY_MBYTES.length - 1];
}

export function buildApifyInstagramScrapeRequest(options: {
  actorUsernameInput: string;
  resultsLimit?: number;
  daysBack?: number;
  onlyPostsNewerThan?: string;
  noAgeCutoff?: boolean;
  skipPinnedPosts?: boolean;
  maxTotalChargeUsd?: number;
  env?: Record<string, string | undefined>;
  nowMs?: number;
}): ApifyInstagramScrapeRequest {
  const env = options.env ?? process.env;
  const resultsLimit = normalizeResultsLimit(options.resultsLimit);
  const parsedOnlyPostsNewerThan = options.onlyPostsNewerThan
    ? Date.parse(options.onlyPostsNewerThan)
    : Number.NaN;
  // Every paid profile acquisition has a hard 24-hour provider-side boundary.
  // Historical checkpoints, manual daysBack and catch-up switches may narrow
  // this window, but must never expand it into a paid backfill.
  const cutoffMs = Math.max(
    (options.nowMs ?? Date.now()) - APIFY_RECENT_WINDOW_MS,
    Number.isFinite(parsedOnlyPostsNewerThan) ? parsedOnlyPostsNewerThan : Number.NEGATIVE_INFINITY,
  );
  const onlyPostsNewerThan = new Date(cutoffMs).toISOString();

  return {
    input: {
      username: [options.actorUsernameInput],
      resultsLimit,
      onlyPostsNewerThan,
      // Apify retains recent pins with the date filter and skips older pins.
      // The caller's local recent-pin policy still decides source admission.
      skipPinnedPosts: true,
      dataDetailLevel: DEFAULT_APIFY_DATA_DETAIL_LEVEL,
    },
    runOptions: {
      maxItems: resultsLimit,
      maxTotalChargeUsd: Number.isFinite(options.maxTotalChargeUsd) && (options.maxTotalChargeUsd as number) > 0
        ? options.maxTotalChargeUsd as number
        : normalizeApifyMaxTotalChargeUsdPerRun(
        env.APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN,
        resultsLimit,
      ),
      timeout: normalizeApifyRunTimeoutSeconds(env.APIFY_RUN_TIMEOUT_SECONDS),
      memory: normalizeApifyMemoryMbytes(env.APIFY_MEMORY_MBYTES),
    },
    daysBack: 1,
  };
}

function normalizeRunsLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_APIFY_HISTORY_RUNS_LIMIT;
  }
  const rounded = Math.trunc(value as number);
  if (rounded < 1) {
    return DEFAULT_APIFY_HISTORY_RUNS_LIMIT;
  }
  return Math.min(rounded, MAX_APIFY_HISTORY_RUNS_LIMIT);
}

function parsePostedAtTimestamp(value: string | null): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return Number.NEGATIVE_INFINITY;
  }
  return parsed;
}

function parsePostDate(item: ApifyInstagramItem): Date | null {
  if (typeof item.taken_at_timestamp === "number") {
    return new Date(item.taken_at_timestamp * 1000);
  }

  if (typeof item.takenAtTimestamp === "number") {
    return new Date(item.takenAtTimestamp * 1000);
  }

  if (typeof item.timestamp === "number") {
    const asMillis = item.timestamp > 9999999999 ? item.timestamp : item.timestamp * 1000;
    return new Date(asMillis);
  }

  if (typeof item.timestamp === "string" && item.timestamp.length > 0) {
    const parsed = Date.parse(item.timestamp);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  if (typeof item.takenAt === "string" && item.takenAt.length > 0) {
    const parsed = Date.parse(item.takenAt);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  if (typeof item.taken_at === "string" && item.taken_at.length > 0) {
    const parsed = Date.parse(item.taken_at);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return null;
}

function isPinnedApifyItem(item: ApifyInstagramItem): boolean {
  return item.isPinned === true || item.is_pinned === true || item.pinned === true;
}

function getApifyHeaders(apiToken: string): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${apiToken}`,
  };
}

function buildPostUrl(item: ApifyInstagramItem): string | null {
  if (item.url) return item.url;
  if (item.shortcode) return `https://www.instagram.com/p/${item.shortcode}/`;
  if (item.shortCode) return `https://www.instagram.com/p/${item.shortCode}/`;
  if (item.code) return `https://www.instagram.com/p/${item.code}/`;
  return null;
}

function normalizeIdentifier(value: string | number | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? normalizeString(value) : null;
}

function buildPostId(item: ApifyInstagramItem): string | null {
  return (
    normalizeIdentifier(item.id) ??
    normalizeIdentifier(item.pk) ??
    normalizeIdentifier(item.postId) ??
    normalizeString(item.shortCode) ??
    normalizeString(item.shortcode) ??
    normalizeString(item.code)
  );
}

function asHttpUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return null;
  }
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function normalizeString(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readUsername(item: ApifyInstagramItem, fallbackUsername: string): string | null {
  return (
    normalizeString(item.ownerUsername) ??
    normalizeString(item.owner_username) ??
    normalizeString(item.username) ??
    normalizeString(item.owner?.username) ??
    normalizeString(fallbackUsername)
  );
}

function buildProfileUrl(handle: string): string {
  return `https://www.instagram.com/${handle}/`;
}

function normalizeConfiguredApifyActorId(actorId: string): string {
  const trimmed = actorId.trim();
  return LEGACY_APIFY_ACTOR_IDS.has(trimmed) ? DEFAULT_APIFY_ACTOR_ID : trimmed;
}

function normalizeApifyActorIdForPath(actorId: string): string {
  const normalizedActorId = normalizeConfiguredApifyActorId(actorId);
  const trimmed = normalizedActorId.trim();
  if (trimmed.includes("~") || !trimmed.includes("/")) {
    return trimmed;
  }

  const [owner, name] = trimmed.split("/", 2);
  return owner && name ? `${owner}~${name}` : trimmed;
}

function parseInstagramActorTarget(value: string): {
  label: string;
  actorUsernameInput: string;
  fallbackUsername: string;
} {
  const trimmed = value.trim();

  try {
    const parsed = new URL(trimmed);
    if (INSTAGRAM_HOSTNAMES.has(parsed.hostname)) {
      const segments = parsed.pathname.split("/").filter(Boolean);
      const firstSegment = segments[0]?.replace(/^@/, "").trim().toLowerCase() ?? "";
      const secondSegment = segments[1]?.trim() ?? "";

      if (INSTAGRAM_POST_PATH_PREFIXES.has(firstSegment) && secondSegment) {
        const canonicalUrl = `https://www.instagram.com/${firstSegment}/${secondSegment}/`;
        return {
          label: canonicalUrl,
          actorUsernameInput: canonicalUrl,
          fallbackUsername: "",
        };
      }

      if (firstSegment) {
        const handle = normalizeHandle(firstSegment);
        return {
          label: handle,
          actorUsernameInput: buildProfileUrl(handle),
          fallbackUsername: handle,
        };
      }
    }
  } catch {
    // Fall back to handle normalization for plain usernames.
  }

  const handle = normalizeHandle(trimmed);
  return {
    label: handle,
    actorUsernameInput: buildProfileUrl(handle),
    fallbackUsername: handle,
  };
}

function readCaption(item: ApifyInstagramItem): string | null {
  if (typeof item.caption === "string") {
    return normalizeString(item.caption);
  }
  if (item.caption && typeof item.caption === "object" && typeof item.caption.text === "string") {
    return normalizeString(item.caption.text);
  }
  return normalizeString(item.captionText) ?? normalizeString(item.caption_text);
}

function getImages(item: ApifyInstagramItem): ApifyInstagramImage[] {
  if (Array.isArray(item.images) && item.images.length > 0) {
    return item.images;
  }
  if (Array.isArray(item.sidecarImages) && item.sidecarImages.length > 0) {
    return item.sidecarImages;
  }
  if (Array.isArray(item.childPosts) && item.childPosts.length > 0) {
    return item.childPosts;
  }
  return [];
}

function collectSlideImageUrls(image: ApifyInstagramImage): string[] {
  const candidates = typeof image === "string"
    ? [image]
    : [
        image.url, image.displayUrl, image.display_url, image.imageUrl, image.image_url,
        image.displayUrlHD, image.display_url_hd, image.thumbnailUrl, image.thumbnail_url,
        ...(image.image_versions2?.candidates ?? []).map((candidate) => candidate.url),
      ];
  return [...new Set(candidates.map((candidate) => asHttpUrl(candidate)).filter(
    (candidate): candidate is string => typeof candidate === "string" && !INSTAGRAM_HOSTNAMES.has(new URL(candidate).hostname),
  ))].slice(0, 8);
}

function collectImageSlideManifest(item: ApifyInstagramItem): {
  imageSlides?: InstagramImageSlide[];
  imageSlideCount?: number;
} {
  const explicitChildren = item.childPosts?.length ? item.childPosts : item.sidecarImages;
  const slides = explicitChildren?.length
    ? explicitChildren
    : resolvePostType(item) === "sidecar" && item.images?.length
      ? item.images
      : undefined;
  if (!slides) {
    // Flat URLs and image_versions2 can be alternate resolutions. They never
    // establish a carousel's slide count by themselves.
    return {};
  }
  return {
    imageSlides: slides.slice(0, MAX_RETAINED_INSTAGRAM_IMAGE_SLIDES).map((slide, index) => ({
      index,
      imageUrls: collectSlideImageUrls(slide).filter((url) => url.length <= 2_048),
      ...(typeof slide === "object" ? { mediaType:
        slide.isVideo === true || slide.is_video === true || /video|reel/iu.test(slide.type ?? "")
          ? "video" as const : /image|photo/iu.test(slide.type ?? "") ? "image" as const : "unknown" as const } : {}),
    })),
    imageSlideCount: slides.length,
  };
}

function pickImageCandidate(image: ApifyInstagramImage): string | null {
  if (typeof image === "string") {
    return asHttpUrl(image);
  }

  // Preserve the legacy source candidate priority. Additional resolutions live
  // in the diagnostic manifest without invalidating a saved analysis revision.
  return collectSlideImageUrls(image)[0] ?? null;
}

function pickImageFromImagesField(item: ApifyInstagramItem): string | null {
  const images = getImages(item);
  if (images.length === 0) {
    return null;
  }

  return pickImageCandidate(images[0]);
}

function imageSourcePriority(url: string): number {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("images.apifyusercontent.com")) return 0;
  if (lowerUrl.includes("cdninstagram.com")) return 1;
  if (lowerUrl.includes("fbcdn.net")) return 2;
  return 3;
}

function pickPreferredImageUrl(candidates: Array<string | null | undefined>): string | null {
  const urls = candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => asHttpUrl(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
  const uniqueUrls = [...new Set(urls)];

  uniqueUrls.sort((left, right) => imageSourcePriority(left) - imageSourcePriority(right));
  return uniqueUrls[0] ?? null;
}

function normalizePostType(type: string | undefined): string | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "video" || normalized === "graphvideo") return "video";
  if (normalized === "image" || normalized === "photo" || normalized === "graphimage") {
    return "image";
  }
  if (
    normalized === "sidecar" ||
    normalized === "album" ||
    normalized === "carousel" ||
    normalized === "carousel_container" ||
    normalized === "graphsidecar"
  ) {
    return "sidecar";
  }
  return normalized;
}

function resolvePostType(item: ApifyInstagramItem): string | null {
  const describedTypes = [item.type, item.productType, item.mediaType, item.__typename].map(normalizePostType);
  const describedType = describedTypes.find(Boolean) ?? null;
  // Mixed carousels sometimes have isVideo=true for their cover. Their parent
  // remains a sidecar, otherwise video siblings could disappear from coverage.
  if (describedTypes.includes("sidecar") || (declaredCarouselCount(item) ?? 0) > 1 ||
    (item.childPosts?.length ?? 0) > 1 || (item.sidecarImages?.length ?? 0) > 1) return "sidecar";
  if (item.isVideo === true || item.is_video === true) {
    return "video";
  }
  return describedType;
}

function selectPrimaryImageUrl(item: ApifyInstagramItem): string | null {
  const postType = resolvePostType(item);
  const displayUrl = pickPreferredImageUrl([
    item.displayUrl,
    item.display_url,
    item.displayUrlHD,
    item.display_url_hd,
    item.thumbnailUrl,
    item.thumbnail_url,
  ]);
  const directImageUrl = pickPreferredImageUrl([item.imageUrl, item.image_url]);
  const firstImage = pickImageFromImagesField(item);

  if (postType === "video") {
    return pickPreferredImageUrl([directImageUrl, displayUrl, firstImage]);
  }

  if (postType === "image") {
    return pickPreferredImageUrl([directImageUrl, displayUrl, firstImage]);
  }

  if (postType === "sidecar") {
    return pickPreferredImageUrl([firstImage, directImageUrl, displayUrl]);
  }

  return pickPreferredImageUrl([directImageUrl, displayUrl, firstImage]);
}

function collectImageUrls(item: ApifyInstagramItem): string[] {
  const candidates = new Set<string>();
  const appendCandidate = (candidate: string | null | undefined) => {
    const value = asHttpUrl(candidate);
    if (value) {
      candidates.add(value);
    }
  };

  appendCandidate(item.displayUrl);
  appendCandidate(item.display_url);
  appendCandidate(item.displayUrlHD);
  appendCandidate(item.display_url_hd);
  appendCandidate(item.imageUrl);
  appendCandidate(item.image_url);
  appendCandidate(item.thumbnailUrl);
  appendCandidate(item.thumbnail_url);

  if (Array.isArray(item.imageUrls)) {
    for (const candidate of item.imageUrls) {
      appendCandidate(candidate);
    }
  }

  if (Array.isArray(item.image_urls)) {
    for (const candidate of item.image_urls) {
      appendCandidate(candidate);
    }
  }

  for (const entry of getImages(item)) {
    const candidate = pickImageCandidate(entry);
    if (candidate) {
      candidates.add(candidate);
    }
  }
  // Basic image lists can omit video siblings. Keep every explicit child's
  // preview in the legacy flat URL contract as well as the ordered manifest.
  for (const entry of item.childPosts ?? item.sidecarImages ?? []) {
    appendCandidate(pickImageCandidate(entry));
  }

  if (Array.isArray(item.image_versions2?.candidates)) {
    for (const candidate of item.image_versions2.candidates) {
      appendCandidate(candidate.url);
    }
  }

  return [...candidates];
}

export function mapApifyItemToInstagramPost(
  item: ApifyInstagramItem,
  fallbackUsername: string,
): InstagramScrapedPost | null {
  if (item.error !== undefined && item.error !== null) {
    return null;
  }
  const postId = buildPostId(item);
  const instagramPostUrl = buildPostUrl(item);
  const username = readUsername(item, fallbackUsername);
  if (!postId || !instagramPostUrl || !username) {
    return null;
  }

  const parsedPostDate = parsePostDate(item);
  const postedAt = parsedPostDate && Number.isFinite(parsedPostDate.getTime()) ? parsedPostDate : null;
  const primaryImageUrl = selectPrimaryImageUrl(item);
  const imageUrls = collectImageUrls(item);
  if (primaryImageUrl && !imageUrls.includes(primaryImageUrl)) {
    imageUrls.unshift(primaryImageUrl);
  }

  return {
    postId,
    caption: readCaption(item),
    altText: normalizeString(item.alt),
    imageUrl: primaryImageUrl,
    imageUrls,
    ...collectImageSlideManifest(item),
    postType: resolvePostType(item),
    locationName:
      normalizeString(item.locationName) ??
      normalizeString(item.location_name) ??
      normalizeString(item.location?.name),
    instagramPostUrl,
    postedAt: postedAt ? postedAt.toISOString() : null,
    username,
    isPinned: isPinnedApifyItem(item),
  };
}

function declaredCarouselCount(item: ApifyInstagramItem): number | null {
  const counts = [item.carouselMediaCount, item.carousel_media_count, item.childPostsCount, item.imageSlideCount]
    .filter((value): value is number => typeof value === "number");
  if (counts.some((count) => !Number.isInteger(count) || count < 2) || new Set(counts).size > 1) {
    return Number.NaN;
  }
  return counts[0] ?? null;
}

function verifiedCarouselChildren(item: ApifyInstagramItem): ApifyInstagramImage[] | undefined {
  if (item.childPosts?.length) return item.childPosts;
  if (item.sidecarImages?.length) return item.sidecarImages;
  // A flat photo list alone can omit video siblings. An independent total
  // count matching every entry makes its full ordered coverage explicit.
  const count = declaredCarouselCount(item);
  return count !== null && count === item.images?.length ? item.images : undefined;
}

/** Require ordered child evidence, or a photo list with a matching total count. */
export function hasCompleteApifyCarousel(item: ApifyInstagramItem): boolean {
  const children = verifiedCarouselChildren(item);
  const count = declaredCarouselCount(item);
  const childIds = (children ?? []).map((child) => typeof child === "object"
    ? normalizeIdentifier(child.id) ?? normalizeString(child.shortCode) : null).filter(Boolean);
  return Boolean(
    children && children.length >= 2 && children.length <= MAX_RETAINED_INSTAGRAM_IMAGE_SLIDES &&
    new Set(childIds).size === childIds.length &&
    (count === null || count === children.length) &&
    children.every((child) => collectSlideImageUrls(child).some((url) => url.length <= 2_048)),
  );
}

function hasCaptionField(item: ApifyInstagramItem): boolean {
  return item.caption === null || typeof item.caption === "string" ||
    (typeof item.caption === "object" && typeof item.caption?.text === "string") ||
    typeof item.captionText === "string" || typeof item.caption_text === "string";
}

/** Request only fields needed to preserve the ingestion source contract. */
export function needsApifyPostDetails(item: ApifyInstagramItem): boolean {
  const type = resolvePostType(item);
  return !hasCaptionField(item) || !["image", "video", "sidecar"].includes(type ?? "") || !selectPrimaryImageUrl(item) ||
    (type === "sidecar" && !hasCompleteApifyCarousel(item));
}

function canonicalInstagramPostCode(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const [prefix, code] = url.pathname.split("/").filter(Boolean);
    return INSTAGRAM_HOSTNAMES.has(url.hostname) && INSTAGRAM_POST_PATH_PREFIXES.has(prefix) && code
      ? code : null;
  } catch {
    return null;
  }
}

function hasConsistentInstagramPostCode(item: ApifyInstagramItem): boolean {
  const code = canonicalInstagramPostCode(buildPostUrl(item));
  return Boolean(code && [item.shortCode, item.shortcode, item.code]
    .every((candidate) => !candidate || candidate === code));
}

/** A detail response may enrich a source, never replace its identity or date. */
export function mergeApifyPostDetails(
  basic: ApifyInstagramItem,
  detail: ApifyInstagramItem,
): ApifyInstagramItem {
  const basicDate = parsePostDate(basic)?.getTime();
  const detailDate = parsePostDate(detail)?.getTime();
  const basicOwner = normalizeHandle(readUsername(basic, "") ?? "");
  const detailOwner = normalizeHandle(readUsername(detail, "") ?? "");
  const basicCode = canonicalInstagramPostCode(buildPostUrl(basic));
  const detailCode = canonicalInstagramPostCode(buildPostUrl(detail));
  if (
    detail.error != null || !buildPostId(basic) || buildPostId(basic) !== buildPostId(detail) ||
    !basicCode || basicCode !== detailCode || !hasConsistentInstagramPostCode(basic) ||
    !hasConsistentInstagramPostCode(detail) || !basicOwner || basicOwner !== detailOwner ||
    !Number.isFinite(basicDate) || basicDate !== detailDate
  ) {
    throw new Error("Apify post details did not match the fresh source identity, owner and timestamp.");
  }
  const basicCount = declaredCarouselCount(basic);
  const detailCount = declaredCarouselCount(detail);
  const detailChildren = verifiedCarouselChildren(detail);
  const basicChildren = verifiedCarouselChildren(basic);
  if (resolvePostType(basic) === "sidecar" && (
    resolvePostType(detail) !== "sidecar" || !hasCompleteApifyCarousel(detail) ||
    (basicCount !== null && basicCount !== detailChildren?.length) ||
    (detailCount !== null && basicCount !== null && detailCount !== basicCount)
  )) {
    throw new Error("Apify carousel details are incomplete; refusing a cover-only source.");
  }
  if (basicChildren?.length && detailChildren?.length) {
    for (let index = 0; index < basicChildren.length; index += 1) {
      const before = basicChildren[index];
      const after = detailChildren[index];
      const beforeId = typeof before === "object" ? normalizeIdentifier(before.id) ?? normalizeString(before.shortCode) : null;
      const afterId = typeof after === "object" ? normalizeIdentifier(after.id) ?? normalizeString(after.shortCode) : null;
      if (!after || (beforeId && beforeId !== afterId)) {
        throw new Error("Apify carousel details changed a known child identity or order.");
      }
    }
  }
  const merged: ApifyInstagramItem = {
    ...basic,
    ...detail,
    // Source identity and profile pin status belong to the basic acquisition.
    id: basic.id,
    pk: basic.pk,
    postId: basic.postId,
    shortCode: basic.shortCode,
    shortcode: basic.shortcode,
    code: basic.code,
    url: buildPostUrl(basic) ?? undefined,
    ownerUsername: basicOwner,
    timestamp: new Date(basicDate as number).toISOString(),
    isPinned: isPinnedApifyItem(basic),
    is_pinned: false,
    pinned: false,
  };
  if (needsApifyPostDetails(merged)) {
    throw new Error("Apify post details are incomplete; required source fields are still missing.");
  }
  return merged;
}

/**
 * Apify's skipPinnedPosts input is advisory. Select locally from a small
 * over-fetch so a pinned profile header can never become the chosen post.
 * A missing/invalid original post date is intentionally not eligible: there
 * is no honest way to call it the newest post by date.
 */
export function selectLatestOriginalNonPinnedPost(
  posts: InstagramScrapedPost[],
  options: {
    pinnedPostPolicy?: InstagramPinnedPostPolicy;
    nowMs?: number;
  } = {},
): InstagramScrapedPost[] {
  const pinnedPostPolicy = options.pinnedPostPolicy ?? "exclude_all";
  const recentPinnedCutoffMs = (options.nowMs ?? Date.now()) - 24 * 60 * 60 * 1_000;
  const newest = posts
    .filter((post) => Number.isFinite(parsePostedAtTimestamp(post.postedAt)))
    .filter((post) => {
      if (post.isPinned !== true) return true;
      return (
        pinnedPostPolicy === "include_recent" &&
        parsePostedAtTimestamp(post.postedAt) >= recentPinnedCutoffMs
      );
    })
    .sort((left, right) => parsePostedAtTimestamp(right.postedAt) - parsePostedAtTimestamp(left.postedAt))[0];
  return newest ? [newest] : [];
}

export function selectRecentOriginalNonPinnedPosts(
  posts: InstagramScrapedPost[],
  options: {
    pinnedPostPolicy?: InstagramPinnedPostPolicy;
    nowMs?: number;
    limit: number;
  },
): InstagramScrapedPost[] {
  const pinnedPostPolicy = options.pinnedPostPolicy ?? "exclude_all";
  const recentPinnedCutoffMs = (options.nowMs ?? Date.now()) - 24 * 60 * 60 * 1_000;
  return posts
    .filter((post) => Number.isFinite(parsePostedAtTimestamp(post.postedAt)))
    .filter((post) =>
      post.isPinned !== true ||
      (pinnedPostPolicy === "include_recent" &&
        parsePostedAtTimestamp(post.postedAt) >= recentPinnedCutoffMs),
    )
    .sort((left, right) => parsePostedAtTimestamp(right.postedAt) - parsePostedAtTimestamp(left.postedAt))
    .slice(0, options.limit);
}

async function listRecentSucceededActorRuns(
  actorIdForPath: string,
  apiToken: string,
  runsLimit: number,
): Promise<ApifyActorRun[]> {
  const query = new URLSearchParams({
    desc: "1",
    limit: String(runsLimit),
    status: "SUCCEEDED",
  });
  const endpoint = `${APIFY_API_BASE_URL}/acts/${encodeURIComponent(actorIdForPath)}/runs?${query.toString()}`;
  const response = await fetch(endpoint, {
    headers: getApifyHeaders(apiToken),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to load recent Apify runs: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const payload = (await response.json()) as ApifyCollectionResponse<ApifyActorRun>;
  return Array.isArray(payload.data?.items) ? payload.data.items : [];
}

async function loadDatasetItemsForRun(
  datasetId: string,
  apiToken: string,
  signal?: AbortSignal,
): Promise<ApifyInstagramItem[]> {
  const query = new URLSearchParams({
    clean: "true",
    format: "json",
  });
  const endpoint = `${APIFY_API_BASE_URL}/datasets/${encodeURIComponent(datasetId)}/items?${query.toString()}`;
  const response = await fetch(endpoint, {
    headers: getApifyHeaders(apiToken),
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to load Apify dataset ${datasetId}: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  return (await response.json()) as ApifyInstagramItem[];
}

export async function loadRecentApifyRunPosts(
  options: LoadRecentApifyRunPostsOptions,
): Promise<RecentApifyRunPostsResult> {
  const apiToken = getRequiredEnv("APIFY_API_TOKEN");
  const actorId = normalizeConfiguredApifyActorId(
    process.env.APIFY_INSTAGRAM_ACTOR_ID ?? DEFAULT_APIFY_ACTOR_ID,
  );
  const actorIdForPath = normalizeApifyActorIdForPath(actorId);
  const runsLimit = normalizeRunsLimit(options.runsLimit);
  const handleFilter = new Set(
    (options.handles ?? []).map((handle) => normalizeHandle(handle)).filter(Boolean),
  );
  const runs = await listRecentSucceededActorRuns(actorIdForPath, apiToken, runsLimit);
  const postsByHandle = new Map<string, Map<string, InstagramScrapedPost>>();

  for (let index = 0; index < runs.length; index += 5) {
    const runBatch = runs.slice(index, index + 5);
    const datasetItemsBatch = await Promise.all(
      runBatch.map(async (run) => {
        if (!run.defaultDatasetId) {
          return [];
        }

        try {
          return await loadDatasetItemsForRun(run.defaultDatasetId, apiToken);
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "apify.instagram.history.dataset_failed",
              runId: run.id ?? null,
              datasetId: run.defaultDatasetId,
              error: error instanceof Error ? error.message : "Unknown Apify dataset error.",
            }),
          );
          return [];
        }
      }),
    );

    for (const datasetItems of datasetItemsBatch) {
      for (const item of datasetItems) {
        // Basic discovery runs also appear in free history imports. A failed
        // hydration must never re-enter ingestion as a cover-only source or
        // shadow a complete older dataset for the same post. History keeps its
        // full date range; only source completeness is required here.
        if (!item || typeof item !== "object" || needsApifyPostDetails(item)) {
          continue;
        }
        const post = mapApifyItemToInstagramPost(item, "");
        if (!post) {
          continue;
        }

        const handle = normalizeHandle(post.username);
        if (!handle) {
          continue;
        }
        if (handleFilter.size > 0 && !handleFilter.has(handle)) {
          continue;
        }

        const existingPosts = postsByHandle.get(handle) ?? new Map<string, InstagramScrapedPost>();
        const uniqueKey = `${post.postId}::${post.instagramPostUrl}`;
        if (!existingPosts.has(uniqueKey)) {
          existingPosts.set(uniqueKey, {
            ...post,
            username: handle,
          });
        }
        postsByHandle.set(handle, existingPosts);
      }
    }
  }

  const importedPostsByHandle: Record<string, InstagramScrapedPost[]> = {};
  let importedPosts = 0;
  const outputHandles =
    handleFilter.size > 0 ? [...handleFilter] : [...postsByHandle.keys()];

  for (const handle of outputHandles) {
    const posts = [...(postsByHandle.get(handle)?.values() ?? [])];
    posts.sort(
      (left, right) =>
        parsePostedAtTimestamp(right.postedAt) - parsePostedAtTimestamp(left.postedAt),
    );
    importedPosts += posts.length;
    importedPostsByHandle[handle] = posts;
  }

  return {
    runsScanned: runs.length,
    importedPosts,
    importedPostsByHandle,
  };
}

export async function scrapeInstagramAccount(
  options: ScrapeInstagramAccountOptions,
): Promise<InstagramScrapedPost[]> {
  if (getInstagramScraperProvider() === "instaloader") {
    const target = parseInstagramActorTarget(options.handle);
    const settings = buildApifyInstagramScrapeRequest({
      actorUsernameInput: target.actorUsernameInput,
      resultsLimit: options.resultsLimit,
      daysBack: options.daysBack,
      onlyPostsNewerThan: options.onlyPostsNewerThan,
      noAgeCutoff: options.noAgeCutoff,
      skipPinnedPosts: options.skipPinnedPosts,
      maxTotalChargeUsd: options.maxTotalChargeUsd,
    });
    // The collector keeps its established catch-up and pin behavior. The hard
    // 24-hour restriction applies only to paid Apify profile acquisitions.
    settings.daysBack = normalizeDaysBack(options.daysBack);
    settings.input.skipPinnedPosts = options.skipPinnedPosts ??
      normalizeApifySkipPinnedPosts(process.env.APIFY_SKIP_PINNED_POSTS);
    const configuredBoundaryMs = options.onlyPostsNewerThan ? Date.parse(options.onlyPostsNewerThan) : NaN;
    const onlyPostsNewerThan = options.noAgeCutoff ? null
      : Number.isFinite(configuredBoundaryMs) ? new Date(configuredBoundaryMs).toISOString()
      : new Date(Date.now() - settings.daysBack * 86_400_000).toISOString();
    const items = await fetchInstaloaderItems({
      target: target.fallbackUsername || target.actorUsernameInput,
      resultsLimit: settings.input.resultsLimit,
      onlyPostsNewerThan,
      skipPinnedPosts: settings.input.skipPinnedPosts,
      pinnedPostPolicy: options.pinnedPostPolicy,
      requestId: options.requestId,
      collectorReadinessChecked: options.collectorReadinessChecked,
      abortAtMs: options.abortAtMs,
      onRequestStarted: options.onRequestStarted,
      onTransportInvoked: options.onTransportInvoked,
    });
    const posts = normalizeInstagramCollection(items, target, options, settings,
      onlyPostsNewerThan === null ? undefined : Date.parse(onlyPostsNewerThan));
    for (const post of posts) post.metadataProvider = "instaloader";
    return posts;
  }
  const apiToken = getRequiredEnv("APIFY_API_TOKEN");
  const actorId = normalizeConfiguredApifyActorId(
    process.env.APIFY_INSTAGRAM_ACTOR_ID ?? DEFAULT_APIFY_ACTOR_ID,
  );
  const actorIdForPath = normalizeApifyActorIdForPath(actorId);
  const target = parseInstagramActorTarget(options.handle);
  // Apify ignores onlyPostsNewerThan for direct post URLs. Freshness must be
  // established by a profile acquisition before we pay for URL hydration.
  if (!target.fallbackUsername) {
    throw new Error("Direct paid Apify post fetches require a verified fresh profile source.");
  }
  const requestSettings = buildApifyInstagramScrapeRequest({
    actorUsernameInput: target.actorUsernameInput,
    resultsLimit: options.resultsLimit,
    daysBack: options.daysBack,
    onlyPostsNewerThan: options.onlyPostsNewerThan,
    noAgeCutoff: options.noAgeCutoff,
    skipPinnedPosts: options.skipPinnedPosts,
    maxTotalChargeUsd: options.maxTotalChargeUsd,
  });
  const { input, runOptions } = requestSettings;
  if (runOptions.maxTotalChargeUsd < MIN_APIFY_PAID_RUN_CHARGE_USD) {
    throw new Error("Apify logical scrape budget is below the provider's $0.005 minimum run cap.");
  }
  const providerRequestTimeoutMs = (runOptions.timeout + 30) * 1_000;
  const preflightLeaseRemainingMs =
    typeof options.abortAtMs === "number" ? options.abortAtMs - Date.now() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(preflightLeaseRemainingMs) && preflightLeaseRemainingMs < 5_000) {
    throw new Error(`Apify scraper lease deadline is too close for ${target.label}.`);
  }
  const abortController = new AbortController();
  // One deadline covers the marker, both paid phases, billing settlement and
  // storage reads. Hydration cannot reset a nearly expired daily receipt lease.
  const deadlineMs = Math.min(options.abortAtMs ?? Number.POSITIVE_INFINITY, Date.now() + providerRequestTimeoutMs);
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The awaited hook commits a crash-safe marker, not proof of provider
    // transport. Re-check the absolute lease deadline after it returns: a slow
    // marker must never reset an expired deadline into a new paid window.
    await options.onRequestStarted?.();
    const remainingLeaseMs = deadlineMs - Date.now();
    if (remainingLeaseMs < 5_000) {
      throw new Error(`Apify scraper lease deadline expired before transport for ${target.label}.`);
    }
    abortTimer = setTimeout(
      () => abortController.abort(new Error("Apify scraper request exceeded its lease-safe deadline.")),
      remainingLeaseMs,
    );
    abortTimer.unref?.();
    const ensureDeadline = (minimumRemainingMs = 0) => {
      abortController.signal.throwIfAborted();
      if (deadlineMs - Date.now() < minimumRemainingMs) {
        throw new Error(`Apify scraper lease deadline expired before transport for ${target.label}.`);
      }
    };
    const readRun = async (runId: string, waitForFinish?: number): Promise<ApifyActorRun> => {
      ensureDeadline();
      const query = waitForFinish ? `?waitForFinish=${waitForFinish}` : "";
      const response = await fetch(`${APIFY_API_BASE_URL}/actor-runs/${encodeURIComponent(runId)}${query}`, {
        headers: getApifyHeaders(apiToken), cache: "no-store", signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`Apify run receipt request failed: ${response.status}.`);
      const payload = await response.json() as { data?: ApifyActorRun };
      if (!payload.data || payload.data.id !== runId) throw new Error("Apify returned an invalid run receipt.");
      return payload.data;
    };
    const runPhase = async (phaseInput: ApifyInstagramScrapeRequest["input"], maxTotalChargeUsd: number) => {
      ensureDeadline(5_000);
      const query = new URLSearchParams({
        maxItems: String(phaseInput.username.length > 1 ? phaseInput.username.length : phaseInput.resultsLimit),
        maxTotalChargeUsd: String(maxTotalChargeUsd),
        timeout: String(Math.min(runOptions.timeout, Math.max(1, Math.floor((deadlineMs - Date.now()) / 1_000) - 1))),
        waitForFinish: String(Math.min(60, Math.max(1, Math.floor((deadlineMs - Date.now()) / 1_000) - 1))),
        restartOnError: "false",
      });
      if (runOptions.memory) query.set("memory", String(runOptions.memory));
      const endpoint = `${APIFY_API_BASE_URL}/acts/${encodeURIComponent(actorIdForPath)}/runs?${query.toString()}`;
      console.info(JSON.stringify({
        level: "info",
        event: "apify.instagram.request",
        handles: [target.label],
        actorId,
        ...phaseInput,
        maxTotalChargeUsd,
        logicalMaxTotalChargeUsd: runOptions.maxTotalChargeUsd,
        timeout: Number(query.get("timeout")),
        memory: runOptions.memory ?? null,
      }));
      const requestInit: RequestInit = {
        method: "POST",
        headers: { ...getApifyHeaders(apiToken), "content-type": "application/json" },
        body: JSON.stringify(phaseInput), cache: "no-store", signal: abortController.signal,
      };
      // The durable logical-attempt marker is already committed. Each paid
      // transport also retains the process-local invocation receipt.
      options.onTransportInvoked?.();
      const response = await fetch(endpoint, requestInit);
      if (!response.ok) {
        throw new Error(`Apify scraper request failed for ${target.label}: ${response.status} ${response.statusText} - ${await response.text()}`);
      }
      let run = (await response.json() as { data?: ApifyActorRun }).data;
      if (!run?.id) throw new Error("Apify did not return a paid run receipt.");
      const activeStatuses = new Set(["READY", "RUNNING", "TIMING-OUT", "ABORTING"]);
      // One paid start only; subsequent calls wait for that same run. The
      // attempt count and absolute deadline both bound these read-only waits.
      for (let attempt = 0; activeStatuses.has(run.status ?? "") && attempt < Math.ceil(runOptions.timeout / 60) + 1; attempt += 1) {
        ensureDeadline();
        run = await readRun(run.id as string, Math.min(60, Math.max(1, Math.floor((deadlineMs - Date.now()) / 1_000) - 1)));
      }
      if (run.status !== "SUCCEEDED" || !run.defaultDatasetId) {
        throw new Error(`Apify paid run did not succeed: ${run.status ?? "unknown"}.`);
      }
      ensureDeadline();
      const items = await loadDatasetItemsForRun(run.defaultDatasetId, apiToken, abortController.signal);
      if (!Array.isArray(items)) throw new Error("Apify returned an invalid Instagram dataset.");
      return { run, items };
    };
    const basic = await runPhase(input, runOptions.maxTotalChargeUsd);
    const cutoffMs = Date.parse(input.onlyPostsNewerThan);
    const freshItems = basic.items.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const dateMs = parsePostDate(item)?.getTime();
      return item.error == null && Number.isFinite(dateMs) && (dateMs as number) >= cutoffMs &&
        (dateMs as number) <= Date.now() && hasConsistentInstagramPostCode(item) &&
        normalizeHandle(readUsername(item, "") ?? "") === normalizeHandle(target.fallbackUsername);
    });
    const apifyOptions = { ...options, noAgeCutoff: false };
    const selected = normalizeInstagramCollection(freshItems, target, apifyOptions, requestSettings, cutoffMs);
    const selectedKeys = new Set(selected.map((post) => `${post.postId}::${post.instagramPostUrl}`));
    const candidates = freshItems.filter((item) => selectedKeys.has(`${buildPostId(item)}::${buildPostUrl(item)}`));
    const uniqueCandidates = [...new Map(candidates.map((item) => [`${buildPostId(item)}::${buildPostUrl(item)}`, item])).values()];
    const hydrationCandidates = uniqueCandidates.filter(needsApifyPostDetails);
    let completeItems = uniqueCandidates;
    if (hydrationCandidates.length > 0) {
      // Immediate terminal metadata may still have preliminary costs. Apify
      // documents a 10-second settlement interval before the authenticated
      // receipt read. Missing/ambiguous costs cannot authorize another charge.
      const finishedAtMs = basic.run.finishedAt ? Date.parse(basic.run.finishedAt) : Number.NaN;
      if (!Number.isFinite(finishedAtMs)) throw new Error("Apify billing receipt has no settled completion time; details were not fetched.");
      const settlementDelayMs = Math.max(0, finishedAtMs + 10_000 - Date.now());
      ensureDeadline(settlementDelayMs + 5_000);
      if (settlementDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(abortController.signal.reason); };
          const timer = setTimeout(() => { abortController.signal.removeEventListener("abort", onAbort); resolve(); }, settlementDelayMs);
          abortController.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      const settledRun = await readRun(basic.run.id as string);
      const actualCharge = settledRun.usageTotalUsd;
      if (settledRun.status !== "SUCCEEDED" || typeof actualCharge !== "number" || !Number.isFinite(actualCharge) || actualCharge < 0) {
        throw new Error("Apify billing receipt has no verified total charge; details were not fetched.");
      }
      // Integer microdollars round the remaining authorization down, never up.
      const remainingChargeUsd = Math.max(0, Math.floor((runOptions.maxTotalChargeUsd - actualCharge) * 1_000_000 + 0.000001) / 1_000_000);
      if (remainingChargeUsd < MIN_APIFY_PAID_RUN_CHARGE_USD) {
        throw new Error("Apify logical scrape budget cannot fund complete post details; refusing an incomplete source.");
      }
      const detailUrls = hydrationCandidates.map((item) => {
        const code = canonicalInstagramPostCode(buildPostUrl(item));
        if (!code) throw new Error("Apify fresh source has no verified Instagram permalink for details.");
        return `https://www.instagram.com/p/${code}/`;
      });
      const details = await runPhase({ ...input, username: detailUrls, resultsLimit: 1, dataDetailLevel: "detailedData" }, remainingChargeUsd);
      const hydrated = new Map(hydrationCandidates.map((candidate) => {
        const matches = details.items.filter((item) => buildPostId(item) === buildPostId(candidate));
        if (matches.length !== 1) throw new Error("Apify did not return exactly one complete detail result per fresh post.");
        return [candidate, mergeApifyPostDetails(candidate, matches[0])];
      }));
      completeItems = uniqueCandidates.map((candidate) => hydrated.get(candidate) ?? candidate);
    }
    return normalizeInstagramCollection(completeItems, target, apifyOptions, requestSettings, cutoffMs, basic.items.length);
  } finally {
    clearTimeout(abortTimer);
  }
}

/** Both transports retain the same source identity, owner, date and pin rules. */
function normalizeInstagramCollection(
  rawItems: ApifyInstagramItem[],
  target: ReturnType<typeof parseInstagramActorTarget>,
  options: ScrapeInstagramAccountOptions,
  requestSettings: ApifyInstagramScrapeRequest,
  transportBoundaryMs = Number.NEGATIVE_INFINITY,
  rawItemCount = rawItems.length,
): InstagramScrapedPost[] {
  const resultsLimit = requestSettings.input.resultsLimit;
  const cutoff = options.noAgeCutoff ? Number.NEGATIVE_INFINITY
    : Math.max(Date.now() - requestSettings.daysBack * 86_400_000, transportBoundaryMs);
  const expectedProfileOwner = normalizeHandle(target.fallbackUsername);
  const scrapedPosts = rawItems
    .map((item) => mapApifyItemToInstagramPost(item, target.fallbackUsername || target.label))
    .filter((item): item is InstagramScrapedPost => {
      if (!item) {
        return false;
      }
      // Profile scrapes can contain collaboration rows whose durable owner is
      // another account. Never let a newer foreign row win
      // selection and then be persisted under the requested profile. Direct
      // post targets intentionally have no fallback owner and remain unchanged.
      if (
        expectedProfileOwner &&
        normalizeHandle(item.username) !== expectedProfileOwner
      ) {
        return false;
      }
      return !item.postedAt || parsePostedAtTimestamp(item.postedAt) >= cutoff;
    });

  const uniqueTopLevelPosts = new Map<string, InstagramScrapedPost>();
  for (const post of scrapedPosts) {
    const uniqueKey = `${post.instagramPostUrl}::${post.postId}`;
    if (!uniqueTopLevelPosts.has(uniqueKey)) {
      uniqueTopLevelPosts.set(uniqueKey, post);
    }
  }

  const normalizedTopLevelPosts = [...uniqueTopLevelPosts.values()];
  normalizedTopLevelPosts.sort(
    (left, right) =>
      parsePostedAtTimestamp(right.postedAt) - parsePostedAtTimestamp(left.postedAt),
  );

  // Request a bounded over-fetch so local pinned-post filtering can choose the
  // latest genuine post. The durable caller asks for four; legacy callers keep
  // their explicit result count semantics.
  const result = options.selectAllEligiblePosts
    ? selectRecentOriginalNonPinnedPosts(normalizedTopLevelPosts, {
        pinnedPostPolicy: options.pinnedPostPolicy,
        limit: resultsLimit,
      })
    : options.pinnedPostPolicy
    ? selectLatestOriginalNonPinnedPost(normalizedTopLevelPosts, {
        pinnedPostPolicy: options.pinnedPostPolicy,
      })
    : options.skipPinnedPosts
    ? selectLatestOriginalNonPinnedPost(normalizedTopLevelPosts)
    : normalizedTopLevelPosts.slice(0, resultsLimit);
  Object.defineProperty(result, INSTAGRAM_SCRAPE_RAW_ITEM_COUNT, {
    value: rawItemCount,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}
