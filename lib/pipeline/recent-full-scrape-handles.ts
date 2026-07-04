import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { normalizeHandle } from "@/lib/pipeline/venue-normalization";
import { getRequiredEnv } from "@/lib/utils/env";

export const FULL_SCRAPE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type RecentFullScrapeJobStatus = "queued" | "running" | "completed" | "failed";

type RecentFullScrapeJobRecord = {
  _id: string;
  source: string;
  status: RecentFullScrapeJobStatus;
  handles: string[];
  summaryJson?: string;
  stateJson: string;
  createdAt: number;
  startedAt?: string;
  finishedAt?: string;
};

type RecentFullScrapeHandleSummary = {
  handle?: string;
  fetchedPosts?: number;
  fetched_posts?: number;
  insertedEvents?: number;
  inserted_events?: number;
  insertedApprovedEvents?: number;
  insertedPendingEvents?: number;
  skippedDuplicates?: number;
  skipped_duplicates?: number;
  skipped_duplicates_clean?: number;
  skipped_missing_date?: number;
  skipped_missing_venue?: number;
  skipped_video?: number;
  skipped_invalid_event?: number;
  skipped_past_event?: number;
  skipped_far_future_event?: number;
  updated_duplicates_bad_data?: number;
  duplicate_update_failed?: number;
  failedDownloads?: number;
  failed_downloads?: number;
  failedConversions?: number;
  failed_conversions?: number;
  failedExtractions?: number;
  failed_extractions?: number;
  failed_extraction?: number;
  errors?: string[];
};

type RecentFullScrapeSummary = {
  handles?: RecentFullScrapeHandleSummary[];
};

type IngestionBatchStateSnapshot = {
  handleIndex: number;
  currentHandle: string | null;
};

export type RecentFullScrapeAttemptSummary = {
  attemptedHandles: string[];
  lastFreshScrapeAt: string | null;
};

const listRecentFullScrapeJobsQuery =
  "ingestionJobs:listRecentFullScrapeJobs" as unknown as FunctionReference<"query">;

function parseBatchStateSnapshot(stateJson: string): IngestionBatchStateSnapshot {
  try {
    const parsed = JSON.parse(stateJson) as Partial<IngestionBatchStateSnapshot>;
    return {
      handleIndex:
        typeof parsed.handleIndex === "number" && Number.isFinite(parsed.handleIndex)
          ? Math.max(0, Math.trunc(parsed.handleIndex))
          : 0,
      currentHandle: typeof parsed.currentHandle === "string" ? parsed.currentHandle : null,
    };
  } catch {
    return {
      handleIndex: 0,
      currentHandle: null,
    };
  }
}

const COMPLETED_HANDLE_PROGRESS_KEYS = [
  "fetchedPosts",
  "fetched_posts",
  "insertedEvents",
  "inserted_events",
  "insertedApprovedEvents",
  "insertedPendingEvents",
  "skippedDuplicates",
  "skipped_duplicates",
  "skipped_duplicates_clean",
  "skipped_missing_date",
  "skipped_missing_venue",
  "skipped_video",
  "skipped_invalid_event",
  "skipped_past_event",
  "skipped_far_future_event",
  "updated_duplicates_bad_data",
  "duplicate_update_failed",
  "failedDownloads",
  "failed_downloads",
  "failedConversions",
  "failed_conversions",
  "failedExtractions",
  "failed_extractions",
  "failed_extraction",
] as const;

function parseCompletedHandleSummaries(
  summaryJson: string | undefined,
): Map<string, RecentFullScrapeHandleSummary> | null {
  if (!summaryJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(summaryJson) as RecentFullScrapeSummary;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.handles)) {
      return null;
    }

    const summaries = new Map<string, RecentFullScrapeHandleSummary>();
    for (const handleSummary of parsed.handles) {
      if (!handleSummary || typeof handleSummary !== "object") {
        continue;
      }
      const handle = normalizeHandle(handleSummary.handle ?? "");
      if (handle) {
        summaries.set(handle, handleSummary);
      }
    }
    return summaries;
  } catch {
    return null;
  }
}

function hasPositiveProgressCount(summary: RecentFullScrapeHandleSummary): boolean {
  return COMPLETED_HANDLE_PROGRESS_KEYS.some((key) => {
    const value = summary[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

function isFreshCompletedHandleAttempt(
  summary: RecentFullScrapeHandleSummary | undefined,
): boolean {
  if (!summary) {
    return true;
  }

  if (hasPositiveProgressCount(summary)) {
    return true;
  }

  const errors = Array.isArray(summary.errors) ? summary.errors : [];
  return errors.length === 0;
}

function getAttemptedHandlesFromCompletedJob(job: RecentFullScrapeJobRecord): string[] {
  const summaries = parseCompletedHandleSummaries(job.summaryJson);
  if (!summaries) {
    return job.handles;
  }

  return job.handles.filter((handle) =>
    isFreshCompletedHandleAttempt(summaries.get(normalizeHandle(handle))),
  );
}

export function getAttemptedHandlesFromRecentJob(
  job: RecentFullScrapeJobRecord,
): string[] {
  if (job.status === "queued") {
    return [];
  }

  if (job.status === "completed") {
    return getAttemptedHandlesFromCompletedJob(job);
  }

  if (job.source === "cron_active_venues" && job.status === "running") {
    return job.handles;
  }

  const state = parseBatchStateSnapshot(job.stateJson);
  const attemptedHandles = job.handles.slice(
    0,
    Math.max(0, Math.min(state.handleIndex, job.handles.length)),
  );

  if (state.currentHandle && job.handles.includes(state.currentHandle)) {
    attemptedHandles.push(state.currentHandle);
  }

  return [...new Set(attemptedHandles)];
}

function getAttemptTimestamp(job: RecentFullScrapeJobRecord): number {
  if (typeof job.startedAt === "string") {
    const parsedStartedAt = Date.parse(job.startedAt);
    if (Number.isFinite(parsedStartedAt)) {
      return parsedStartedAt;
    }
  }

  return job.createdAt;
}

export async function getRecentFullScrapeAttemptSummary(options: {
  candidateHandles: string[];
  minCreatedAt?: number;
  serviceSecret?: string;
}): Promise<RecentFullScrapeAttemptSummary> {
  const normalizedCandidates = [
    ...new Set(options.candidateHandles.map((handle) => normalizeHandle(handle)).filter(Boolean)),
  ];

  if (normalizedCandidates.length === 0) {
    return {
      attemptedHandles: [],
      lastFreshScrapeAt: null,
    };
  }

  const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
  const serviceSecret = options.serviceSecret ?? process.env.CRON_SECRET?.trim();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required to read recent ingestion jobs.");
  }
  const recentJobs = (await convex.query(listRecentFullScrapeJobsQuery, {
    minCreatedAt: options.minCreatedAt ?? Date.now() - FULL_SCRAPE_COOLDOWN_MS,
    serviceSecret,
  })) as RecentFullScrapeJobRecord[];

  const candidateSet = new Set(normalizedCandidates);
  const recentHandles = new Set<string>();
  let lastFreshScrapeAtMs: number | null = null;

  for (const job of recentJobs) {
    const attemptedHandles = getAttemptedHandlesFromRecentJob(job);
    if (attemptedHandles.length === 0) {
      continue;
    }

    const attemptTimestamp = getAttemptTimestamp(job);
    let matchedCandidateHandle = false;

    for (const handle of attemptedHandles) {
      const normalizedHandle = normalizeHandle(handle);
      if (normalizedHandle && candidateSet.has(normalizedHandle)) {
        recentHandles.add(normalizedHandle);
        matchedCandidateHandle = true;
      }
    }

    if (
      matchedCandidateHandle &&
      (lastFreshScrapeAtMs === null || attemptTimestamp > lastFreshScrapeAtMs)
    ) {
      lastFreshScrapeAtMs = attemptTimestamp;
    }
  }

  return {
    attemptedHandles: [...recentHandles],
    lastFreshScrapeAt:
      lastFreshScrapeAtMs === null ? null : new Date(lastFreshScrapeAtMs).toISOString(),
  };
}

export async function getRecentlyAttemptedFullScrapeHandles(options: {
  candidateHandles: string[];
  minCreatedAt?: number;
  serviceSecret?: string;
}): Promise<string[]> {
  const summary = await getRecentFullScrapeAttemptSummary(options);
  return summary.attemptedHandles;
}
