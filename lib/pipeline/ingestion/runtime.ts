import { getIngestionFetchPageSize, getIngestionMaxPostsPerSource, isPaidIngestionEnabled } from "@/lib/pipeline/instagram-ingestion-durability";
import { getRequiredEnv } from "@/lib/utils/env";
import { ConvexHttpClient } from "convex/browser";


export const DEFAULT_SCRAPED_POST_PAGE_SIZE = 25;


export const MAX_SCRAPED_POST_PAGE_SIZE = 100;


export const DEFAULT_FULL_SCRAPE_RESULTS_LIMIT = 5;


export const MAX_FULL_SCRAPE_RESULTS_LIMIT = 50;


export const DEFAULT_INGESTION_POST_STEP_LIMIT = 8;


export const MAX_INGESTION_POST_STEP_LIMIT = 50;


export const DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY = 4;


export const MAX_DIRECT_FULL_SCRAPE_CONCURRENCY = 16;


export const DEFAULT_PROVIDER_ATTEMPT_COOLDOWN_HOURS = 23;


export const MAX_PROVIDER_ATTEMPT_COOLDOWN_HOURS = 24 * 30;


export const MAX_INGESTION_BATCH_SIZE = 64;

export function logInfo(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: "info",
      event,
      ...payload,
    }),
  );
}

export function logError(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...payload,
    }),
  );
}

export function normalizeDirectFullScrapeConcurrency(
  value: string | undefined = process.env.INGESTION_FULL_SCRAPE_CONCURRENCY,
): number {
  if (!value) {
    return DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_DIRECT_FULL_SCRAPE_CONCURRENCY;
  }

  return Math.min(parsed, MAX_DIRECT_FULL_SCRAPE_CONCURRENCY);
}

export function getProviderAttemptCooldownMs(
  value: string | undefined = process.env.CRON_FULL_SCRAPE_COOLDOWN_HOURS,
): number {
  const hours = normalizeBoundedPositiveInteger({
    value,
    defaultValue: DEFAULT_PROVIDER_ATTEMPT_COOLDOWN_HOURS,
    maxValue: MAX_PROVIDER_ATTEMPT_COOLDOWN_HOURS,
  });
  return hours * 60 * 60_000;
}

export function normalizeBoundedPositiveInteger(options: {
  value: number | string | undefined;
  defaultValue: number;
  maxValue: number;
}): number {
  if (options.value === undefined || options.value === null || options.value === "") {
    return options.defaultValue;
  }

  const parsed =
    typeof options.value === "number"
      ? options.value
      : Number.parseInt(String(options.value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return options.defaultValue;
  }

  return Math.min(Math.trunc(parsed), options.maxValue);
}

export function isFreshApifyFetchEnabled(): boolean {
  return isPaidIngestionEnabled();
}

export function normalizeFullScrapeResultsLimit(value?: number): number {
  return normalizeBoundedPositiveInteger({
    value,
    defaultValue: getIngestionFetchPageSize(),
    maxValue: getIngestionMaxPostsPerSource(),
  });
}

export function normalizeIngestionPostStepLimit(value?: number): number {
  return normalizeBoundedPositiveInteger({
    value: value ?? process.env.INGESTION_POST_STEP_LIMIT,
    defaultValue: DEFAULT_INGESTION_POST_STEP_LIMIT,
    maxValue: MAX_INGESTION_POST_STEP_LIMIT,
  });
}

export function normalizeScrapedPostPageSize(value?: number): number {
  return normalizeBoundedPositiveInteger({
    value: value ?? process.env.SCRAPED_POST_PAGE_SIZE,
    defaultValue: DEFAULT_SCRAPED_POST_PAGE_SIZE,
    maxValue: MAX_SCRAPED_POST_PAGE_SIZE,
  });
}

export function getConfiguredServiceSecret(explicitSecret?: string): string {
  const serviceSecret = explicitSecret ?? process.env.CRON_SECRET?.trim();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required for ingestion Convex writes.");
  }
  return serviceSecret;
}

export function withServiceSecret<T extends Record<string, unknown>>(
  args: T,
  serviceSecret: string,
): T & { serviceSecret: string } {
  return {
    ...args,
    serviceSecret,
  };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

export function isIncompleteSourceIdentityLookup(error: unknown): boolean {
  return getErrorMessage(error).includes("E_EVENT_SOURCE_MATCH_LIMIT");
}

export function getConvexClient(): ConvexHttpClient {
  const convexUrl = getRequiredEnv("NEXT_PUBLIC_CONVEX_URL");
  return new ConvexHttpClient(convexUrl);
}

export function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  const rounded = Math.trunc(value as number);
  return Math.max(1, Math.min(MAX_INGESTION_BATCH_SIZE, rounded));
}
