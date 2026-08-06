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
  freshAttemptHandles: string[];
  stateJson: string;
  createdAt: number;
  startedAt?: string;
  finishedAt?: string;
};


type IngestionBatchStateSnapshot = {
  handleIndex: number;
  currentHandle: string | null;
};

export type RecentFullScrapeAttemptSummary = {
  attemptedHandles: string[];
  lastFreshScrapeAt: string | null;
};

type FreshFetchAttemptMetadata = {
  handle: string;
  lastFetchAttemptAt?: number;
};

const listFreshFetchAttemptMetadataQuery =
  "instagramSources:listFreshFetchAttemptMetadata" as unknown as FunctionReference<"query">;

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


export function getAttemptedHandlesFromRecentJob(
  job: RecentFullScrapeJobRecord,
): string[] {
  if (job.status === "queued") {
    return [];
  }

  if (job.status === "completed") {
    return job.freshAttemptHandles;
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
    throw new Error("CRON_SECRET is required to read recent provider attempts.");
  }
  const minAttemptAt = options.minCreatedAt ?? Date.now() - FULL_SCRAPE_COOLDOWN_MS;
  const recentAttempts = (await convex.query(listFreshFetchAttemptMetadataQuery, {
    minAttemptAt,
    limit: 5_000,
    serviceSecret,
  })) as FreshFetchAttemptMetadata[];

  const candidateSet = new Set(normalizedCandidates);
  const recentHandles = new Set<string>();
  let lastFreshScrapeAtMs: number | null = null;

  for (const attempt of recentAttempts) {
    const normalizedHandle = normalizeHandle(attempt.handle);
    if (!normalizedHandle || !candidateSet.has(normalizedHandle)) {
      continue;
    }
    const attemptedAt = attempt.lastFetchAttemptAt;
    if (
      typeof attemptedAt !== "number" ||
      !Number.isFinite(attemptedAt) ||
      attemptedAt < minAttemptAt
    ) {
      continue;
    }
    recentHandles.add(normalizedHandle);
    if (lastFreshScrapeAtMs === null || attemptedAt > lastFreshScrapeAtMs) {
      lastFreshScrapeAtMs = attemptedAt;
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
