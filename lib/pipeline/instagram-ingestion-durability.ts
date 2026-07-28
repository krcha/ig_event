export const DEFAULT_INGESTION_BOOTSTRAP_DAYS = 10;
export const DEFAULT_INGESTION_FETCH_PAGE_SIZE = 5;
export const DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN = 50;
export const DEFAULT_APIFY_DAILY_BUDGET_USD = 2;
export const DEFAULT_APIFY_MAX_CHARGE_PER_HANDLE_USD = 0.04;
export const DEFAULT_OPENAI_DAILY_POST_LIMIT = 300;
export const DEFAULT_OPENAI_MAX_ATTEMPTS_PER_POST = 3;
export const DEFAULT_OPENAI_CIRCUIT_COOLDOWN_MINUTES = 60;
export const DEFAULT_OPENAI_MAX_IMAGES_PER_POST = 5;
export const FETCH_BOUNDARY_OVERLAP_MS = 5 * 60_000;

export type InstagramSourceRole = "venue" | "promoter" | "unknown";

export type FairSource = {
  handle: string;
  active: boolean;
  deferredAt?: number;
  lastFetchAttemptAt?: number;
  continuationActive?: boolean;
};

export function normalizeInstagramHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLocaleLowerCase();
}

export function parseBoundedPositiveInteger(
  value: string | number | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.trunc(parsed));
}

export function isPaidIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.PAID_INGESTION_ENABLED;
  if (configured !== undefined) return /^(?:1|true|yes|on)$/iu.test(configured.trim());
  const legacy = env.ENABLE_FRESH_APIFY_FETCH;
  if (legacy !== undefined) return /^(?:1|true|yes|on)$/iu.test(legacy.trim());
  return false;
}

export function getIngestionBootstrapDays(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.INGESTION_BOOTSTRAP_DAYS,
    DEFAULT_INGESTION_BOOTSTRAP_DAYS,
    90,
  );
}

export function getIngestionFetchPageSize(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.INGESTION_FETCH_PAGE_SIZE,
    DEFAULT_INGESTION_FETCH_PAGE_SIZE,
    DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
  );
}

export function getIngestionMaxPostsPerSource(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
    DEFAULT_INGESTION_MAX_POSTS_PER_SOURCE_PER_RUN,
    500,
  );
}

export function getOpenAiDailyPostLimit(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.OPENAI_DAILY_POST_LIMIT,
    DEFAULT_OPENAI_DAILY_POST_LIMIT,
    10_000,
  );
}

export function getOpenAiMaxAttemptsPerPost(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.OPENAI_MAX_ATTEMPTS_PER_POST,
    DEFAULT_OPENAI_MAX_ATTEMPTS_PER_POST,
    10,
  );
}

export function getOpenAiCircuitCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parseBoundedPositiveInteger(
      env.OPENAI_CIRCUIT_COOLDOWN_MINUTES,
      DEFAULT_OPENAI_CIRCUIT_COOLDOWN_MINUTES,
      24 * 60,
    ) * 60_000
  );
}

export function getOpenAiMaxImagesPerPost(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInteger(
    env.OPENAI_MAX_IMAGES_PER_POST,
    DEFAULT_OPENAI_MAX_IMAGES_PER_POST,
    10,
  );
}

export function usdToMicros(value: string | number | undefined, fallbackUsd: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  const usd = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackUsd;
  return Math.round(usd * 1_000_000);
}

export function getApifyBudgetConfig(env: NodeJS.ProcessEnv = process.env): {
  dailyBudgetMicros: number;
  maxChargePerHandleMicros: number;
} {
  return {
    dailyBudgetMicros: usdToMicros(
      env.APIFY_DAILY_BUDGET_USD,
      DEFAULT_APIFY_DAILY_BUDGET_USD,
    ),
    maxChargePerHandleMicros: usdToMicros(
      env.APIFY_MAX_CHARGE_PER_HANDLE_USD,
      DEFAULT_APIFY_MAX_CHARGE_PER_HANDLE_USD,
    ),
  };
}

export function getBudgetDayKey(
  now: Date = new Date(),
  timeZone = "Europe/Belgrade",
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isCompleteFollowingSnapshot(options: {
  providerSucceeded: boolean;
  rawItemCount: number;
  validItemCount: number;
  malformedItemCount: number;
  maxItems: number;
}): boolean {
  return (
    options.providerSucceeded &&
    options.rawItemCount > 0 &&
    options.validItemCount > 0 &&
    options.malformedItemCount === 0 &&
    options.rawItemCount === options.validItemCount &&
    options.rawItemCount < options.maxItems
  );
}

export function selectSourcesFairly<T extends FairSource>(sources: T[], limit: number): T[] {
  return sources
    .filter((source) => source.active)
    .sort((left, right) => {
      if (Boolean(left.continuationActive) !== Boolean(right.continuationActive)) {
        return left.continuationActive ? -1 : 1;
      }
      const leftDeferred = left.deferredAt ?? Number.POSITIVE_INFINITY;
      const rightDeferred = right.deferredAt ?? Number.POSITIVE_INFINITY;
      if (leftDeferred !== rightDeferred) return leftDeferred - rightDeferred;
      const leftAttempt = left.lastFetchAttemptAt ?? Number.NEGATIVE_INFINITY;
      const rightAttempt = right.lastFetchAttemptAt ?? Number.NEGATIVE_INFINITY;
      if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
      return normalizeInstagramHandle(left.handle).localeCompare(
        normalizeInstagramHandle(right.handle),
      );
    })
    .slice(0, Math.max(0, Math.trunc(limit)));
}

export function getFetchBoundary(options: {
  successfulFetchThroughAt?: number;
  fetchStartedAt: number;
  bootstrapDays?: number;
  overlapMs?: number;
}): { checkpointAt: number | null; requestNewerThanAt: number } {
  const checkpointAt =
    typeof options.successfulFetchThroughAt === "number" &&
    Number.isFinite(options.successfulFetchThroughAt)
      ? Math.trunc(options.successfulFetchThroughAt)
      : null;
  if (checkpointAt !== null) {
    return {
      checkpointAt,
      requestNewerThanAt: Math.max(0, checkpointAt - (options.overlapMs ?? FETCH_BOUNDARY_OVERLAP_MS)),
    };
  }
  const bootstrapDays = Math.max(
    1,
    Math.trunc(options.bootstrapDays ?? DEFAULT_INGESTION_BOOTSTRAP_DAYS),
  );
  return {
    checkpointAt: null,
    requestNewerThanAt: options.fetchStartedAt - bootstrapDays * 24 * 60 * 60_000,
  };
}

export function evaluateFetchWindow(options: {
  providerSucceeded: boolean;
  malformed: boolean;
  interrupted: boolean;
  leaseCurrent: boolean;
  budgetReserved: boolean;
  rawItemCount: number;
  requestedResultsLimit: number;
  checkpointAt: number | null;
  oldestFetchedAt: number | null;
}): { complete: boolean; saturated: boolean; reason: string } {
  if (!options.budgetReserved) return { complete: false, saturated: false, reason: "budget_blocked" };
  if (!options.leaseCurrent) return { complete: false, saturated: false, reason: "lease_lost" };
  if (options.interrupted) return { complete: false, saturated: false, reason: "interrupted" };
  if (!options.providerSucceeded) return { complete: false, saturated: false, reason: "provider_failed" };
  if (options.malformed) return { complete: false, saturated: false, reason: "malformed_response" };
  const saturated = options.rawItemCount >= options.requestedResultsLimit;
  const reachedBoundary =
    options.checkpointAt !== null &&
    options.oldestFetchedAt !== null &&
    options.oldestFetchedAt <= options.checkpointAt;
  if (saturated && !reachedBoundary) {
    return { complete: false, saturated: true, reason: "result_cap_before_boundary" };
  }
  return { complete: true, saturated, reason: reachedBoundary ? "boundary_reached" : "window_exhausted" };
}

export function nextContinuationResultsLimit(current: number, maximum: number): number {
  return Math.min(maximum, Math.max(current + 1, current * 2));
}

export function deduplicateMediaUrls(urls: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of urls) {
    const value = raw?.trim();
    if (!value) continue;
    let key = value;
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      key = `${parsed.origin}${parsed.pathname}`.toLocaleLowerCase();
    } catch {
      key = value.toLocaleLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= Math.max(1, Math.trunc(limit))) break;
  }
  return result;
}
