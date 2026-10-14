import { randomUUID } from "node:crypto";

export type InstagramScraperProvider = "apify" | "instaloader";

export function getInstagramScraperProvider(
  env: Record<string, string | undefined> = process.env,
): InstagramScraperProvider {
  const provider = (env.INSTAGRAM_SCRAPER_PROVIDER ?? "apify").trim().toLowerCase();
  if (provider !== "apify" && provider !== "instaloader") {
    throw new Error("INSTAGRAM_SCRAPER_PROVIDER must be apify or instaloader.");
  }
  return provider;
}

type InstaloaderRequest = {
  target: string;
  resultsLimit: number;
  onlyPostsNewerThan: string | null;
  skipPinnedPosts: boolean;
  pinnedPostPolicy?: "exclude_all" | "include_recent";
  requestId?: string;
  /** Internal controller preflight already completed before its attempt marker. */
  collectorReadinessChecked?: boolean;
  abortAtMs?: number;
  onRequestStarted?: () => void | Promise<void>;
  onTransportInvoked?: () => void;
};

type CollectorPost = {
  id: string;
  shortCode: string;
  ownerUsername: string;
  timestamp: string;
  type: string;
  caption: string | null;
  alt?: string | null;
  displayUrl?: string | null;
  locationName?: string | null;
  url: string;
  isPinned?: boolean;
  childPosts?: Array<{ type?: string; displayUrl?: string | null; isVideo?: boolean }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCollectorPost(value: unknown): asserts value is CollectorPost {
  if (!record(value) ||
    typeof value.id !== "string" || !/^\d{1,40}$/u.test(value.id) ||
    typeof value.shortCode !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.shortCode) ||
    typeof value.ownerUsername !== "string" || !/^[A-Za-z0-9._]{1,128}$/u.test(value.ownerUsername) ||
    typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.url !== "string" ||
    typeof value.type !== "string" || !/^(?:image|video|sidecar)$/iu.test(value.type) ||
    !(value.caption === null || typeof value.caption === "string")) {
    throw new Error("Instaloader returned a malformed source identity or post.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = BigInt(0);
  for (const character of value.shortCode) mediaId = (mediaId << BigInt(6)) + BigInt(alphabet.indexOf(character));
  if (mediaId !== BigInt(value.id)) {
    throw new Error("Instaloader returned a post ID that does not match its shortcode.");
  }
  const postUrl = new URL(value.url);
  if (postUrl.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(postUrl.hostname) ||
    !new RegExp(`^/(?:p|reel|reels|tv)/${value.shortCode}/?$`, "u").test(postUrl.pathname) ||
    postUrl.username || postUrl.password || postUrl.port) {
    throw new Error("Instaloader returned a mismatched Instagram post URL.");
  }
  if (value.isPinned !== undefined && typeof value.isPinned !== "boolean") {
    throw new Error("Instaloader returned malformed pinned-post metadata.");
  }
  for (const field of ["alt", "displayUrl", "locationName"]) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") {
      throw new Error("Instaloader returned malformed post metadata.");
    }
  }
  if (value.type.toLowerCase() === "sidecar") {
    if (!Array.isArray(value.childPosts) || value.childPosts.length < 2 || value.childPosts.length > 20 ||
      value.childPosts.some((child) => !record(child) ||
        typeof child.type !== "string" || !/^(?:image|video)$/iu.test(child.type) ||
        !(child.displayUrl === null || typeof child.displayUrl === "string"))) {
      throw new Error("Instaloader returned an incomplete carousel manifest.");
    }
    if (value.childPostsCount !== value.childPosts.length || value.carouselMediaCount !== value.childPosts.length) {
      throw new Error("Instaloader returned a contradictory carousel count.");
    }
    const childIds = new Set<string>();
    for (const [index, child] of value.childPosts.entries()) {
      if (!record(child) || typeof child.id !== "string" || !/^\d{1,40}$/u.test(child.id) ||
        childIds.has(child.id) || child.index !== index) {
        throw new Error("Instaloader returned an invalid carousel child identity or order.");
      }
      childIds.add(child.id);
    }
  }
}

/** Cheap internal readiness check; never performs an Instagram request. */
export async function getInstaloaderReadiness(): Promise<{ ready: boolean; paused: boolean }> {
  const configuredUrl = process.env.INSTALOADER_API_URL?.trim();
  const token = process.env.INSTALOADER_API_TOKEN?.trim();
  if (!configuredUrl || !token) {
    throw new Error("Instaloader requires INSTALOADER_API_URL and INSTALOADER_API_TOKEN.");
  }
  const baseUrl = new URL(configuredUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("INSTALOADER_API_URL is invalid.");
  }
  const response = await fetch(new URL("/ready", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  const payload: unknown = await response.json();
  if (!record(payload) || typeof payload.ready !== "boolean" || typeof payload.sessionAvailable !== "boolean") {
    throw new Error("Instaloader readiness is unconfirmed.");
  }
  const paused = payload.paused === true;
  return { ready: response.ok && payload.ready && payload.sessionAvailable && !paused, paused };
}

/** Private collector transport; no implicit paid fallback after uncertain outcomes. */
export async function fetchInstaloaderItems(options: InstaloaderRequest): Promise<CollectorPost[]> {
  const configuredUrl = process.env.INSTALOADER_API_URL?.trim();
  const token = process.env.INSTALOADER_API_TOKEN?.trim();
  if (!configuredUrl || !token) {
    throw new Error("Instaloader requires INSTALOADER_API_URL and INSTALOADER_API_TOKEN.");
  }
  const baseUrl = new URL(configuredUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password ||
    baseUrl.search || baseUrl.hash) {
    throw new Error("INSTALOADER_API_URL must be an HTTP service URL without credentials or query parameters.");
  }
  const configuredTimeout = Number(process.env.INSTALOADER_TIMEOUT_SECONDS ?? 180);
  if (!Number.isInteger(configuredTimeout) || configuredTimeout < 10 || configuredTimeout > 300) {
    throw new Error("INSTALOADER_TIMEOUT_SECONDS must be an integer between 10 and 300.");
  }
  const requestId = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9:._-]{1,200}$/u.test(requestId)) {
    throw new Error("Instaloader acquisition key is invalid.");
  }
  const remainingMs = () => options.abortAtMs === undefined ? Infinity : options.abortAtMs - Date.now();
  if (remainingMs() < 5_000) {
    throw new Error("Instaloader scraper lease deadline is too close.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!options.collectorReadinessChecked && !(await getInstaloaderReadiness()).ready) {
      throw new Error("Instaloader collector is not ready; no collection was started.");
    }
    await options.onRequestStarted?.();
    const leaseMs = remainingMs();
    if (leaseMs < 5_000) {
      throw new Error("Instaloader scraper lease expired before transport.");
    }
    const timeoutMs = Math.min((configuredTimeout + 5) * 1_000, leaseMs);
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        target: options.target,
        resultsLimit: options.resultsLimit,
        onlyPostsNewerThan: options.onlyPostsNewerThan,
        skipPinnedPosts: options.skipPinnedPosts,
        pinnedPostPolicy: options.pinnedPostPolicy ?? (options.skipPinnedPosts ? "exclude_all" : "include_all"),
        timeoutSeconds: Math.min(configuredTimeout, Math.floor((timeoutMs - 1_000) / 1_000)),
      }),
      cache: "no-store",
      signal: controller.signal,
      redirect: "error",
    };
    options.onTransportInvoked?.();
    const response = await fetch(new URL("/v1/scrape", baseUrl), init);
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error("Instaloader response exceeded the bounded payload size.");
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new Error("Instaloader returned an invalid response."); }
    if (!response.ok) {
      const code = record(payload) && record(payload.error) && typeof payload.error.code === "string"
        ? payload.error.code.replace(/[^a-z0-9_]/giu, "").slice(0, 80) : "provider_failure";
      throw new Error(`Instaloader scraper failed: HTTP ${response.status} (${code}).`);
    }
    if (!record(payload) || payload.schemaVersion !== 1 || !Array.isArray(payload.items) ||
      payload.items.length > options.resultsLimit || payload.rawItemCount !== payload.items.length) {
      throw new Error("Instaloader returned an unconfirmed or malformed collection window.");
    }
    for (const item of payload.items) validateCollectorPost(item);
    return payload.items as CollectorPost[];
  } finally {
    clearTimeout(timer);
  }
}
