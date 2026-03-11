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
  stateJson: string;
  createdAt: number;
  startedAt?: string;
  finishedAt?: string;
};

type IngestionBatchStateSnapshot = {
  handleIndex: number;
  currentHandle: string | null;
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

function getAttemptedHandlesFromRecentJob(job: RecentFullScrapeJobRecord): string[] {
  if (job.status === "queued") {
    return [];
  }

  if (job.status === "completed") {
    return job.handles;
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

export async function getRecentlyAttemptedFullScrapeHandles(options: {
  candidateHandles: string[];
  minCreatedAt?: number;
}): Promise<string[]> {
  const normalizedCandidates = [
    ...new Set(options.candidateHandles.map((handle) => normalizeHandle(handle)).filter(Boolean)),
  ];

  if (normalizedCandidates.length === 0) {
    return [];
  }

  const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
  const recentJobs = (await convex.query(listRecentFullScrapeJobsQuery, {
    minCreatedAt: options.minCreatedAt ?? Date.now() - FULL_SCRAPE_COOLDOWN_MS,
  })) as RecentFullScrapeJobRecord[];

  const candidateSet = new Set(normalizedCandidates);
  const recentHandles = new Set<string>();

  for (const job of recentJobs) {
    for (const handle of getAttemptedHandlesFromRecentJob(job)) {
      const normalizedHandle = normalizeHandle(handle);
      if (normalizedHandle && candidateSet.has(normalizedHandle)) {
        recentHandles.add(normalizedHandle);
      }
    }
  }

  return [...recentHandles];
}
