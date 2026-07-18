import { DEFAULT_VENUE_CATEGORY } from "../taxonomy/venue-types.ts";
import { getRequiredEnv } from "../utils/env.ts";

const APIFY_API_BASE_URL = "https://api.apify.com/v2";

export const FOLLOW_DISCOVERY_CRON_PATH = "/api/cron/discover-following";
export const DEFAULT_FOLLOW_DISCOVERY_SOURCE_HANDLE = "eventzeka";
export const DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID =
  "scraping_solutions/instagram-scraper-followers-following-no-cookies";
export const DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT = 1500;
export const MIN_FOLLOW_DISCOVERY_RESULTS_LIMIT = 50;
export const MAX_FOLLOW_DISCOVERY_RESULTS_LIMIT = 1500;
export const DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD = 1.1;
export const MAX_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD = 1.5;
export const DEFAULT_FOLLOW_DISCOVERY_TIMEOUT_SECONDS = 300;
export const MIN_FOLLOW_DISCOVERY_TIMEOUT_SECONDS = 30;
export const MAX_FOLLOW_DISCOVERY_TIMEOUT_SECONDS = 300;
export const DEFAULT_FOLLOW_DISCOVERY_INGESTION_RESULTS_LIMIT = 1;
export const DEFAULT_FOLLOW_DISCOVERY_INGESTION_DAYS_BACK = 10;
const MAX_FOLLOW_DISCOVERY_INGESTION_RESULTS_LIMIT = 5;
const MAX_FOLLOW_DISCOVERY_INGESTION_DAYS_BACK = 30;

const INSTAGRAM_HOSTNAMES = new Set(["instagram.com", "www.instagram.com"]);
const RESERVED_INSTAGRAM_PATHS = new Set([
  "about",
  "accounts",
  "api",
  "developer",
  "direct",
  "explore",
  "legal",
  "oauth",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);
const INSTAGRAM_USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

export type FollowDiscoveryConfig = {
  sourceHandle: string;
  actorId: string;
  resultsLimit: number;
  maxTotalChargeUsd: number;
  timeoutSeconds: number;
  ingestionResultsLimit: number;
  ingestionDaysBack: number;
};

export type ApifyFollowingScrapeRequest = {
  actorId: string;
  input: {
    Account: string[];
    resultsLimit: number;
    dataToScrape: "Followings";
  };
  runOptions: {
    maxItems: number;
    maxTotalChargeUsd: number;
    timeout: number;
  };
};

export type FollowDiscoveryAccount = {
  username: string;
  full_name?: string | null;
  fullName?: string | null;
  name?: string | null;
  url?: string | null;
  profileUrl?: string | null;
  profile_link?: string | null;
  [key: string]: unknown;
};

export type VenueListRecord = {
  name: string;
  instagramHandle: string;
};

export type DiscoveredVenueInput = {
  name: string;
  instagramHandle: string;
  category: string;
  publicStatus: "pending";
  scrapeActive: true;
};

export type FollowDiscoveryPlan = {
  missingHandles: string[];
  newVenues: DiscoveredVenueInput[];
  skippedExisting: number;
  skippedDuplicate: number;
  skippedInvalid: number;
};

type VenueIngestionSummary = {
  startedAt: string;
  finishedAt: string;
  handles: unknown[];
  [key: string]: unknown;
};

export type FollowDiscoveryWorkflowResult = FollowDiscoveryPlan & {
  sourceHandle: string;
  actorId: string;
  followingCount: number;
  existingVenueCount: number;
  createdHandles: string[];
  createdVenueIds: unknown[];
  ingestionTriggered: boolean;
  ingestionSummary: VenueIngestionSummary | null;
  costControls: {
    followingResultsLimit: number;
    followingMaxItems: number;
    followingMaxTotalChargeUsd: number;
    followingTimeoutSeconds: number;
    ingestionResultsLimit: number;
    ingestionDaysBack: number;
  };
};

export type FollowDiscoveryWorkflowDeps = {
  scrapeFollowing: (request: ApifyFollowingScrapeRequest) => Promise<FollowDiscoveryAccount[]>;
  listVenues: () => Promise<VenueListRecord[]>;
  createVenue: (venue: DiscoveredVenueInput) => Promise<unknown>;
  runVenueIngestion: (options: {
    handles: string[];
    mode: "full_scrape";
    resultsLimit: number;
    daysBack: number;
  }) => Promise<VenueIngestionSummary>;
};

function normalizeEnvString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function parseBoundedInteger(options: {
  value: string | undefined;
  defaultValue: number;
  minValue: number;
  maxValue: number;
}): number {
  const rawValue = normalizeEnvString(options.value);
  if (!rawValue) {
    return options.defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return options.defaultValue;
  }

  return Math.min(Math.max(parsed, options.minValue), options.maxValue);
}

function parseBoundedNumber(options: {
  value: string | undefined;
  defaultValue: number;
  minValue: number;
  maxValue: number;
}): number {
  const rawValue = normalizeEnvString(options.value);
  if (!rawValue) {
    return options.defaultValue;
  }

  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return options.defaultValue;
  }

  return Math.min(Math.max(parsed, options.minValue), options.maxValue);
}

function stripInstagramUrlWithoutProtocol(value: string): string {
  if (/^(www\.)?instagram\.com\//i.test(value)) {
    return `https://${value}`;
  }
  return value;
}

function normalizeHandleCandidate(candidate: string): string {
  const normalized = candidate
    .trim()
    .replace(/^@+/, "")
    .split(/[?#]/, 1)[0]
    .trim()
    .toLowerCase();

  if (!normalized || RESERVED_INSTAGRAM_PATHS.has(normalized)) {
    return "";
  }
  if (
    !INSTAGRAM_USERNAME_PATTERN.test(normalized) ||
    normalized.includes("..") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".")
  ) {
    return "";
  }
  return normalized;
}

export function normalizeInstagramHandle(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const maybeUrl = stripInstagramUrlWithoutProtocol(trimmed);
  try {
    const parsed = new URL(maybeUrl);
    if (INSTAGRAM_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      const candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
      return normalizeHandleCandidate(candidate);
    }
  } catch {
    // Fall back to treating the value as a raw handle.
  }

  const rawCandidate = trimmed
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split("/")
    .filter(Boolean)[0] ?? "";
  return normalizeHandleCandidate(rawCandidate);
}

export function getFollowDiscoveryConfig(
  env: Record<string, string | undefined> = process.env,
): FollowDiscoveryConfig {
  const sourceHandle =
    normalizeInstagramHandle(env.FOLLOW_DISCOVERY_SOURCE_HANDLE) ||
    DEFAULT_FOLLOW_DISCOVERY_SOURCE_HANDLE;
  const actorId =
    normalizeEnvString(env.FOLLOW_DISCOVERY_ACTOR_ID) || DEFAULT_FOLLOW_DISCOVERY_ACTOR_ID;

  return {
    sourceHandle,
    actorId,
    resultsLimit: parseBoundedInteger({
      value: env.FOLLOW_DISCOVERY_RESULTS_LIMIT,
      defaultValue: DEFAULT_FOLLOW_DISCOVERY_RESULTS_LIMIT,
      minValue: MIN_FOLLOW_DISCOVERY_RESULTS_LIMIT,
      maxValue: MAX_FOLLOW_DISCOVERY_RESULTS_LIMIT,
    }),
    maxTotalChargeUsd: parseBoundedNumber({
      value: env.FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
      defaultValue: DEFAULT_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
      minValue: 0.01,
      maxValue: MAX_FOLLOW_DISCOVERY_MAX_TOTAL_CHARGE_USD,
    }),
    timeoutSeconds: parseBoundedInteger({
      value: env.FOLLOW_DISCOVERY_TIMEOUT_SECONDS,
      defaultValue: DEFAULT_FOLLOW_DISCOVERY_TIMEOUT_SECONDS,
      minValue: MIN_FOLLOW_DISCOVERY_TIMEOUT_SECONDS,
      maxValue: MAX_FOLLOW_DISCOVERY_TIMEOUT_SECONDS,
    }),
    ingestionResultsLimit: parseBoundedInteger({
      value: env.FOLLOW_DISCOVERY_INGESTION_RESULTS_LIMIT,
      defaultValue: DEFAULT_FOLLOW_DISCOVERY_INGESTION_RESULTS_LIMIT,
      minValue: 1,
      maxValue: MAX_FOLLOW_DISCOVERY_INGESTION_RESULTS_LIMIT,
    }),
    ingestionDaysBack: parseBoundedInteger({
      value: env.FOLLOW_DISCOVERY_INGESTION_DAYS_BACK,
      defaultValue: DEFAULT_FOLLOW_DISCOVERY_INGESTION_DAYS_BACK,
      minValue: 1,
      maxValue: MAX_FOLLOW_DISCOVERY_INGESTION_DAYS_BACK,
    }),
  };
}

export function buildApifyFollowingScrapeRequest(
  config: FollowDiscoveryConfig,
): ApifyFollowingScrapeRequest {
  return {
    actorId: config.actorId,
    input: {
      Account: [config.sourceHandle],
      resultsLimit: config.resultsLimit,
      dataToScrape: "Followings",
    },
    runOptions: {
      maxItems: config.resultsLimit,
      maxTotalChargeUsd: config.maxTotalChargeUsd,
      timeout: config.timeoutSeconds,
    },
  };
}

function normalizeApifyActorIdForPath(actorId: string): string {
  const trimmed = actorId.trim();
  if (trimmed.includes("~") || !trimmed.includes("/")) {
    return trimmed;
  }
  const [owner, name] = trimmed.split("/", 2);
  return owner && name ? `${owner}~${name}` : trimmed;
}

function getApifyHeaders(apiToken: string): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${apiToken}`,
  };
}

function readFirstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractFollowingUsername(account: FollowDiscoveryAccount | string): string {
  if (typeof account === "string") {
    return account;
  }
  return readFirstString([
    account.username,
    account.handle,
    account.userName,
    account.profileUrl,
    account.profile_link,
    account.url,
  ]);
}

function extractFollowingName(account: FollowDiscoveryAccount | string): string {
  if (typeof account === "string") {
    return "";
  }
  return readFirstString([account.full_name, account.fullName, account.name]);
}

function titleCaseToken(value: string): string {
  return value.length > 0 ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function formatHandleAsVenueName(handle: string): string {
  return handle
    .split(/[._]+/)
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ") || handle;
}

function deriveVenueName(account: FollowDiscoveryAccount | string, handle: string): string {
  const accountName = extractFollowingName(account).replace(/\s+/g, " ").trim();
  return accountName || formatHandleAsVenueName(handle);
}

function normalizeApifyFollowingAccount(item: unknown): FollowDiscoveryAccount | null {
  if (typeof item === "string") {
    const username = normalizeInstagramHandle(item);
    return username ? { username } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const record = item as FollowDiscoveryAccount;
  const username = normalizeInstagramHandle(extractFollowingUsername(record));
  if (!username) {
    return null;
  }
  return {
    ...record,
    username,
  };
}

export function planFollowDiscoveryVenues(options: {
  following: Array<FollowDiscoveryAccount | string>;
  existingVenues: VenueListRecord[];
}): FollowDiscoveryPlan {
  const existingHandles = new Set(
    options.existingVenues
      .map((venue) => normalizeInstagramHandle(venue.instagramHandle))
      .filter(Boolean),
  );
  const seenMissingHandles = new Set<string>();
  const newVenues: DiscoveredVenueInput[] = [];
  let skippedExisting = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  for (const account of options.following) {
    const handle = normalizeInstagramHandle(extractFollowingUsername(account));
    if (!handle) {
      skippedInvalid += 1;
      continue;
    }
    if (existingHandles.has(handle)) {
      skippedExisting += 1;
      continue;
    }
    if (seenMissingHandles.has(handle)) {
      skippedDuplicate += 1;
      continue;
    }

    seenMissingHandles.add(handle);
    newVenues.push({
      name: deriveVenueName(account, handle),
      instagramHandle: handle,
      category: DEFAULT_VENUE_CATEGORY,
      publicStatus: "pending",
      scrapeActive: true,
    });
  }

  return {
    missingHandles: [...seenMissingHandles],
    newVenues,
    skippedExisting,
    skippedDuplicate,
    skippedInvalid,
  };
}

export async function scrapeInstagramFollowingAccounts(options: {
  request: ApifyFollowingScrapeRequest;
  env?: Record<string, string | undefined>;
}): Promise<FollowDiscoveryAccount[]> {
  const env = options.env ?? process.env;
  const apiToken = env.APIFY_API_TOKEN?.trim() || getRequiredEnv("APIFY_API_TOKEN");
  const actorIdForPath = normalizeApifyActorIdForPath(options.request.actorId);
  const query = new URLSearchParams({
    clean: "true",
    maxItems: String(options.request.runOptions.maxItems),
    maxTotalChargeUsd: String(options.request.runOptions.maxTotalChargeUsd),
    timeout: String(options.request.runOptions.timeout),
  });
  const endpoint = `${APIFY_API_BASE_URL}/acts/${encodeURIComponent(
    actorIdForPath,
  )}/run-sync-get-dataset-items?${query.toString()}`;

  console.info(
    JSON.stringify({
      level: "info",
      event: "apify.instagram.following.request",
      actorId: options.request.actorId,
      sourceHandle: options.request.input.Account[0] ?? null,
      resultsLimit: options.request.input.resultsLimit,
      dataToScrape: options.request.input.dataToScrape,
      maxItems: options.request.runOptions.maxItems,
      maxTotalChargeUsd: options.request.runOptions.maxTotalChargeUsd,
      timeout: options.request.runOptions.timeout,
    }),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...getApifyHeaders(apiToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(options.request.input),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Apify following scraper request failed: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const rawItems = (await response.json()) as unknown[];
  return rawItems
    .map((item) => normalizeApifyFollowingAccount(item))
    .filter((item): item is FollowDiscoveryAccount => item !== null);
}

export async function runFollowDiscoveryWorkflow(options: {
  env?: Record<string, string | undefined>;
  deps: FollowDiscoveryWorkflowDeps;
}): Promise<FollowDiscoveryWorkflowResult> {
  const config = getFollowDiscoveryConfig(options.env);
  const request = buildApifyFollowingScrapeRequest(config);
  const [following, existingVenues] = await Promise.all([
    options.deps.scrapeFollowing(request),
    options.deps.listVenues(),
  ]);
  const plan = planFollowDiscoveryVenues({ following, existingVenues });
  const createdVenueIds: unknown[] = [];
  const createdHandles: string[] = [];

  for (const venue of plan.newVenues) {
    const venueId = await options.deps.createVenue(venue);
    createdVenueIds.push(venueId);
    createdHandles.push(venue.instagramHandle);
  }

  const ingestionSummary =
    createdHandles.length > 0
      ? await options.deps.runVenueIngestion({
          handles: createdHandles,
          mode: "full_scrape",
          resultsLimit: config.ingestionResultsLimit,
          daysBack: config.ingestionDaysBack,
        })
      : null;

  return {
    ...plan,
    sourceHandle: config.sourceHandle,
    actorId: config.actorId,
    followingCount: following.length,
    existingVenueCount: existingVenues.length,
    createdHandles,
    createdVenueIds,
    ingestionTriggered: createdHandles.length > 0,
    ingestionSummary,
    costControls: {
      followingResultsLimit: config.resultsLimit,
      followingMaxItems: request.runOptions.maxItems,
      followingMaxTotalChargeUsd: request.runOptions.maxTotalChargeUsd,
      followingTimeoutSeconds: request.runOptions.timeout,
      ingestionResultsLimit: config.ingestionResultsLimit,
      ingestionDaysBack: config.ingestionDaysBack,
    },
  };
}
