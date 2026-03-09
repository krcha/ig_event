import { getRequiredEnv } from "@/lib/utils/env";

const DEFAULT_APIFY_ACTOR_ID = "apify/instagram-post-scraper";
const DEFAULT_RESULTS_LIMIT = 5;
const MAX_TOP_LEVEL_POSTS_PER_ACCOUNT = 5;
const DEFAULT_DAYS_BACK = 5;
const DEFAULT_SKIP_PINNED_POSTS = true;
const INSTAGRAM_HOSTNAMES = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_POST_PATH_PREFIXES = new Set(["p", "reel", "reels", "tv"]);
const LEGACY_APIFY_ACTOR_IDS = new Set(["apify/instagram-scraper", "apify~instagram-scraper"]);

export type InstagramScrapedPost = {
  postId: string;
  caption: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  postType: string | null;
  locationName: string | null;
  instagramPostUrl: string;
  postedAt: string | null;
  username: string;
};

type ScrapeInstagramAccountOptions = {
  handle: string;
  resultsLimit?: number;
  daysBack?: number;
};

type ApifyInstagramImage =
  | string
  | {
      url?: string;
      displayUrl?: string;
      display_url?: string;
      imageUrl?: string;
      image_url?: string;
    };

type ApifyInstagramItem = {
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
  caption?: string | { text?: string };
  captionText?: string;
  caption_text?: string;
  displayUrl?: string;
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
  locationName?: string;
  location_name?: string;
  location?: { name?: string };
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

function asHttpUrl(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return null;
  }
  return trimmed;
}

function normalizeString(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  return [];
}

function pickImageCandidate(image: ApifyInstagramImage): string | null {
  if (typeof image === "string") {
    return asHttpUrl(image);
  }

  return (
    asHttpUrl(image.url) ??
    asHttpUrl(image.displayUrl) ??
    asHttpUrl(image.display_url) ??
    asHttpUrl(image.imageUrl) ??
    asHttpUrl(image.image_url)
  );
}

function pickImageFromImagesField(item: ApifyInstagramItem): string | null {
  const images = getImages(item);
  if (images.length === 0) {
    return null;
  }

  return pickImageCandidate(images[0]);
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
    normalized === "graphsidecar"
  ) {
    return "sidecar";
  }
  return normalized;
}

function resolvePostType(item: ApifyInstagramItem): string | null {
  if (item.isVideo === true || item.is_video === true) {
    return "video";
  }

  return (
    normalizePostType(item.type) ??
    normalizePostType(item.productType) ??
    normalizePostType(item.mediaType) ??
    normalizePostType(item.__typename)
  );
}

function selectPrimaryImageUrl(item: ApifyInstagramItem): string | null {
  const postType = resolvePostType(item);
  const displayUrl =
    asHttpUrl(item.displayUrl) ??
    asHttpUrl(item.display_url) ??
    asHttpUrl(item.displayUrlHD) ??
    asHttpUrl(item.display_url_hd) ??
    asHttpUrl(item.thumbnailUrl) ??
    asHttpUrl(item.thumbnail_url);
  const firstImage = pickImageFromImagesField(item);

  if (postType === "video") {
    return null;
  }

  if (postType === "image") {
    return displayUrl;
  }

  if (postType === "sidecar") {
    return firstImage ?? displayUrl;
  }

  return displayUrl ?? firstImage ?? asHttpUrl(item.imageUrl) ?? asHttpUrl(item.image_url);
}

function collectImageUrls(item: ApifyInstagramItem): string[] {
  const candidates = new Set<string>();
  const appendCandidate = (candidate: string | undefined) => {
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

  if (Array.isArray(item.image_versions2?.candidates)) {
    for (const candidate of item.image_versions2.candidates) {
      appendCandidate(candidate.url);
    }
  }

  return [...candidates];
}

export async function scrapeInstagramAccount(
  options: ScrapeInstagramAccountOptions,
): Promise<InstagramScrapedPost[]> {
  const apiToken = getRequiredEnv("APIFY_API_TOKEN");
  const actorId = normalizeConfiguredApifyActorId(
    process.env.APIFY_INSTAGRAM_ACTOR_ID ?? DEFAULT_APIFY_ACTOR_ID,
  );
  const actorIdForPath = normalizeApifyActorIdForPath(actorId);
  const target = parseInstagramActorTarget(options.handle);
  const resultsLimit = normalizeResultsLimit(options.resultsLimit);
  const daysBack = options.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const onlyPostsNewerThan = `${daysBack} day${daysBack === 1 ? "" : "s"}`;

  const query = new URLSearchParams({
    token: apiToken,
    clean: "true",
  });
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorIdForPath)}/run-sync-get-dataset-items?${query.toString()}`;
  const username = [target.actorUsernameInput];
  const input = {
    username,
    resultsLimit,
    onlyPostsNewerThan,
    skipPinnedPosts: DEFAULT_SKIP_PINNED_POSTS,
  };

  console.info(
    JSON.stringify({
      level: "info",
      event: "apify.instagram.request",
      handles: [target.label],
      actorId,
      username: input.username,
      resultsLimit: input.resultsLimit,
      onlyPostsNewerThan: input.onlyPostsNewerThan,
      skipPinnedPosts: input.skipPinnedPosts,
    }),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Apify scraper request failed for ${target.label}: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const rawItems = (await response.json()) as ApifyInstagramItem[];
  const scrapedPosts = rawItems
    .map<InstagramScrapedPost | null>((item) => {
      const postId = buildPostId(item);
      const instagramPostUrl = buildPostUrl(item);
      if (!postId || !instagramPostUrl) return null;

      const postedAt = parsePostDate(item);
      if (postedAt && postedAt.getTime() < cutoff) return null;
      const primaryImageUrl = selectPrimaryImageUrl(item);
      const imageUrls = collectImageUrls(item);
      if (primaryImageUrl && !imageUrls.includes(primaryImageUrl)) {
        imageUrls.unshift(primaryImageUrl);
      }

      return {
        postId,
        caption: readCaption(item),
        imageUrl: primaryImageUrl,
        imageUrls,
        postType: resolvePostType(item),
        locationName:
          normalizeString(item.locationName) ??
          normalizeString(item.location_name) ??
          normalizeString(item.location?.name),
        instagramPostUrl,
        postedAt: postedAt ? postedAt.toISOString() : null,
        username:
          normalizeString(item.ownerUsername) ??
          normalizeString(item.owner_username) ??
          normalizeString(item.username) ??
          normalizeString(item.owner?.username) ??
          (target.fallbackUsername || target.label),
      };
    })
    .filter((item): item is InstagramScrapedPost => item !== null);

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

  return normalizedTopLevelPosts.slice(0, resultsLimit);
}
