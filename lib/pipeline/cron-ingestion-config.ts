const DEFAULT_CRON_RESULTS_LIMIT = 1;
const DEFAULT_CRON_DAYS_BACK = 10;
const DEFAULT_CRON_MAX_HANDLES_PER_RUN = 600;
const DEFAULT_CRON_FULL_SCRAPE_COOLDOWN_HOURS = 23;
const MAX_RESULTS_LIMIT = 5;
const MAX_DAYS_BACK = 30;
const MAX_HANDLES_PER_RUN = 600;
const MAX_FULL_SCRAPE_COOLDOWN_HOURS = 24 * 30;

export type CronIngestionConfig = {
  resultsLimit: number;
  daysBack: number;
  maxHandlesPerRun: number;
  fullScrapeCooldownHours: number;
};

export type CronHandleSelection = {
  handles: string[];
  skippedRecentlyAttempted: number;
  skippedDueToRunLimit: number;
};

function parseBoundedPositiveInteger(
  value: string | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }

  return Math.min(parsed, maxValue);
}

export function getCronIngestionConfig(
  env: Record<string, string | undefined> = process.env,
): CronIngestionConfig {
  return {
    resultsLimit: parseBoundedPositiveInteger(
      env.CRON_RESULTS_LIMIT,
      DEFAULT_CRON_RESULTS_LIMIT,
      MAX_RESULTS_LIMIT,
    ),
    daysBack: parseBoundedPositiveInteger(env.CRON_DAYS_BACK, DEFAULT_CRON_DAYS_BACK, MAX_DAYS_BACK),
    maxHandlesPerRun: parseBoundedPositiveInteger(
      env.CRON_MAX_HANDLES_PER_RUN,
      DEFAULT_CRON_MAX_HANDLES_PER_RUN,
      MAX_HANDLES_PER_RUN,
    ),
    fullScrapeCooldownHours: parseBoundedPositiveInteger(
      env.CRON_FULL_SCRAPE_COOLDOWN_HOURS,
      DEFAULT_CRON_FULL_SCRAPE_COOLDOWN_HOURS,
      MAX_FULL_SCRAPE_COOLDOWN_HOURS,
    ),
  };
}

function allowsUnprotectedCron(env: Record<string, string | undefined>): boolean {
  if (env.CRON_SECRET?.trim()) {
    return false;
  }

  if (env.ALLOW_UNPROTECTED_CRON === "true") {
    return true;
  }

  return env.NODE_ENV !== "production";
}

export function isAuthorizedCronRequestHeader(
  authorizationHeader: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cronSecret = env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return allowsUnprotectedCron(env);
  }

  return authorizationHeader === `Bearer ${cronSecret}`;
}

export function selectCronIngestionHandles(options: {
  activeVenueHandles: string[];
  recentlyAttemptedHandles: string[];
  maxHandlesPerRun: number;
}): CronHandleSelection {
  const recentlyAttemptedHandleSet = new Set(options.recentlyAttemptedHandles);
  const eligibleHandles = options.activeVenueHandles.filter(
    (handle) => !recentlyAttemptedHandleSet.has(handle),
  );
  const handles = eligibleHandles.slice(0, options.maxHandlesPerRun);

  return {
    handles,
    skippedRecentlyAttempted: options.activeVenueHandles.length - eligibleHandles.length,
    skippedDueToRunLimit: Math.max(0, eligibleHandles.length - handles.length),
  };
}
