import { getRequiredEnv } from "@/lib/utils/env";

const DEFAULT_APIFY_ACTOR_ID = "apify/instagram-scraper";
const DEFAULT_RESULTS_LIMIT = 20;
const DEFAULT_DAYS_BACK = 60;

export type InstagramScrapedPost = {
  postId: string;
  caption: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  instagramPostUrl: string;
  postedAt: string | null;
  username: string;
};

type ScrapeInstagramAccountOptions = {
  handle: string;
  resultsLimit?: number;
  daysBack?: number;
};

type ApifyInstagramItem = {
  id?: string;
  shortCode?: string;
  code?: string;
  postId?: string;
  url?: string;
  caption?: string;
  captionText?: string;
  displayUrl?: string;
  displayUrlHD?: string;
  imageUrl?: string;
  imageUrls?: string[];
  images?: Array<
    | string
    | {
        url?: string;
        displayUrl?: string;
        imageUrl?: string;
      }
  >;
  image_versions2?: {
    candidates?: Array<{ url?: string }>;
  };
  timestamp?: string | number;
  takenAtTimestamp?: number;
  takenAt?: string;
  ownerUsername?: string;
  owner?: { username?: string };
};

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

function parsePostDate(item: ApifyInstagramItem): Date | null {
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

  return null;
}

function buildPostUrl(item: ApifyInstagramItem): string | null {
  if (item.url) return item.url;
  if (item.shortCode) return `https://www.instagram.com/p/${item.shortCode}/`;
  if (item.code) return `https://www.instagram.com/p/${item.code}/`;
  return null;
}

function buildPostId(item: ApifyInstagramItem): string | null {
  return item.id ?? item.postId ?? item.shortCode ?? item.code ?? null;
}

function collectImageUrls(item: ApifyInstagramItem): string[] {
  const candidates = new Set<string>();
  const appendCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    const value = candidate.trim();
    if (value.startsWith("http://") || value.startsWith("https://")) {
      candidates.add(value);
    }
  };

  appendCandidate(item.displayUrlHD);
  appendCandidate(item.displayUrl);
  appendCandidate(item.imageUrl);

  if (Array.isArray(item.imageUrls)) {
    for (const candidate of item.imageUrls) {
      appendCandidate(candidate);
    }
  }

  if (Array.isArray(item.images)) {
    for (const entry of item.images) {
      if (typeof entry === "string") {
        appendCandidate(entry);
      } else {
        appendCandidate(entry.url);
        appendCandidate(entry.displayUrl);
        appendCandidate(entry.imageUrl);
      }
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
  const actorId = process.env.APIFY_INSTAGRAM_ACTOR_ID ?? DEFAULT_APIFY_ACTOR_ID;
  const handle = normalizeHandle(options.handle);
  const resultsLimit = options.resultsLimit ?? DEFAULT_RESULTS_LIMIT;
  const daysBack = options.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${apiToken}&clean=true`;
  const input = {
    directUrls: [`https://www.instagram.com/${handle}/`],
    resultsType: "posts",
    resultsLimit,
    addParentData: false,
  };

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
      `Apify scraper request failed for @${handle}: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const rawItems = (await response.json()) as ApifyInstagramItem[];

  return rawItems
    .map<InstagramScrapedPost | null>((item) => {
      const postId = buildPostId(item);
      const instagramPostUrl = buildPostUrl(item);
      if (!postId || !instagramPostUrl) return null;

      const postedAt = parsePostDate(item);
      if (postedAt && postedAt.getTime() < cutoff) return null;
      const imageUrls = collectImageUrls(item);

      return {
        postId,
        caption: item.caption ?? item.captionText ?? null,
        imageUrl: imageUrls[0] ?? null,
        imageUrls,
        instagramPostUrl,
        postedAt: postedAt ? postedAt.toISOString() : null,
        username: item.ownerUsername ?? item.owner?.username ?? handle,
      };
    })
    .filter((item): item is InstagramScrapedPost => item !== null);
}
