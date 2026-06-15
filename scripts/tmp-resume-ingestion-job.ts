import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';

type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed';
type HandleSummary = Record<string, any> & { handle: string; errors?: string[] };
type Summary = { startedAt: string; finishedAt: string; handles: HandleSummary[]; approvedDuplicateCleanup?: unknown };
type State = { handleIndex: number; currentHandle: string | null; currentPostIndex: number; currentHandlePosts: unknown[]; seenSourceKeysByHandle: Record<string, string[]> };
type Job = {
  _id: string;
  source: string;
  mode?: 'full_scrape' | 'saved_posts';
  status: IngestionJobStatus;
  handles: string[];
  resultsLimit?: number;
  daysBack?: number;
  batchSize: number;
  summaryJson: string;
  stateJson: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function argValue(name: string): string | undefined {
  const withEquals = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return undefined;
}

function argNumber(name: string): number | undefined {
  const value = argValue(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function sum(summary: Summary, keys: string[]): number {
  return summary.handles.reduce((total, handle) => total + Math.max(...keys.map((key) => Number(handle[key] ?? 0)), 0), 0);
}

function summarize(jobId: string, summary: Summary, state: State, extra: Record<string, unknown> = {}) {
  const errorMessages = summary.handles.flatMap((handle) => handle.errors ?? []);
  return {
    jobId,
    ...extra,
    handlesTotal: summary.handles.length,
    handlesProcessed: Math.min(state.handleIndex, summary.handles.length),
    currentHandle: state.currentHandle,
    fetchedPosts: sum(summary, ['fetchedPosts', 'fetched_posts']),
    insertedEvents: sum(summary, ['insertedEvents', 'inserted_events']),
    insertedApprovedEvents: sum(summary, ['insertedApprovedEvents']),
    insertedPendingEvents: sum(summary, ['insertedPendingEvents']),
    skippedDuplicates: sum(summary, ['skippedDuplicates', 'skipped_duplicates']),
    skippedMissingDate: sum(summary, ['skipped_missing_date']),
    skippedMissingVenue: sum(summary, ['skipped_missing_venue']),
    skippedVideo: sum(summary, ['skipped_video']),
    skippedInvalidEvent: sum(summary, ['skipped_invalid_event']),
    skippedPastEvent: sum(summary, ['skipped_past_event']),
    skippedFarFutureEvent: sum(summary, ['skipped_far_future_event']),
    failedDownloads: sum(summary, ['failedDownloads', 'failed_downloads']),
    failedConversions: sum(summary, ['failedConversions', 'failed_conversions']),
    failedExtractions: sum(summary, ['failedExtractions', 'failed_extractions', 'failed_extraction']),
    handlesWithErrors: summary.handles.filter((handle) => (handle.errors?.length ?? 0) > 0).length,
    totalErrors: errorMessages.length,
    latestErrors: errorMessages.slice(-5).map((message) => String(message).slice(0, 280)),
    approvedDuplicateCleanup: summary.approvedDuplicateCleanup ?? null,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function patchJob(convex: ConvexHttpClient, jobId: string, patch: Record<string, unknown>) {
  const patchRef = 'ingestionJobs:patchJob' as unknown as FunctionReference<'mutation'>;
  await convex.mutation(patchRef, { id: jobId, patch });
}

async function main() {
  loadEnv('/root/ig_event/.env.local');
  loadEnv('/opt/ig_event/.env.production');
  loadEnv('/root/.hermes/.env');

  const jobId = argValue('job-id');
  if (!jobId) throw new Error('--job-id is required');
  const statusPath = argValue('status-path') ?? `/tmp/ig_event_resume_${jobId}_${Date.now()}.json`;
  const maxBatches = argNumber('max-batches');
  const batchSizeOverride = argNumber('batch-size');
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error('NEXT_PUBLIC_CONVEX_URL is missing.');
  if (!process.env.APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN is missing.');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing.');

  const {
    createEmptyIngestionSummary,
    createInitialIngestionBatchState,
    runInstagramIngestionBatchStep,
  } = await import('/root/ig_event/lib/pipeline/run-instagram-ingestion.ts') as any;

  const convex = new ConvexHttpClient(convexUrl);
  const getRef = 'ingestionJobs:getJob' as unknown as FunctionReference<'query'>;
  const job = await convex.query(getRef, { id: jobId }) as Job | null;
  if (!job) throw new Error(`Ingestion job not found: ${jobId}`);

  let summary = parseJson<Summary>(job.summaryJson, createEmptyIngestionSummary(job.handles));
  let state = parseJson<State>(job.stateJson, createInitialIngestionBatchState());
  const startedAt = job.startedAt ?? new Date().toISOString();
  const resultsLimit = job.resultsLimit ?? 2;
  const daysBack = job.daysBack ?? 10;
  const batchSize = batchSizeOverride ?? job.batchSize ?? 4;
  let batch = 0;
  let done = job.status === 'completed' || state.handleIndex >= job.handles.length;

  await patchJob(convex, jobId, { status: done ? 'completed' : 'running', startedAt });
  const startStatus = summarize(jobId, summary, state, {
    event: 'full_ingestion_resume_started',
    status: done ? 'completed' : 'running',
    resultsLimit,
    daysBack,
    batchSize,
    apifyMemoryMbytes: process.env.APIFY_MEMORY_MBYTES ?? null,
    fullScrapeConcurrency: process.env.INGESTION_FULL_SCRAPE_CONCURRENCY ?? null,
    maxBatches: maxBatches ?? null,
    statusPath,
    startedAt,
  });
  writeFileSync(statusPath, JSON.stringify(startStatus, null, 2));
  console.log(JSON.stringify(startStatus));

  try {
    while (!done && (maxBatches == null || batch < maxBatches)) {
      batch += 1;
      const batchStartedAt = Date.now();
      const result = await runInstagramIngestionBatchStep({
        handles: job.handles,
        summary,
        state,
        resultsLimit,
        daysBack,
        batchSize,
        mode: job.mode ?? 'full_scrape',
      });
      summary = result.summary;
      state = result.state;
      done = result.done;
      const finishedAt = done ? new Date().toISOString() : undefined;
      await patchJob(convex, jobId, {
        status: done ? 'completed' : 'running',
        summaryJson: JSON.stringify(summary),
        stateJson: JSON.stringify(state),
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
      });
      const progress = summarize(jobId, summary, state, {
        event: done ? 'full_ingestion_completed' : 'full_ingestion_batch',
        resumedBatch: batch,
        done,
        batchSeconds: Math.round((Date.now() - batchStartedAt) / 100) / 10,
        resultsLimit,
        daysBack,
        batchSize,
        apifyMemoryMbytes: process.env.APIFY_MEMORY_MBYTES ?? null,
        fullScrapeConcurrency: process.env.INGESTION_FULL_SCRAPE_CONCURRENCY ?? null,
        status: done ? 'completed' : 'running',
        ...(finishedAt ? { finishedAt } : {}),
      });
      writeFileSync(statusPath, JSON.stringify(progress, null, 2));
      console.log(JSON.stringify(progress));
    }

    if (!done) {
      const pausedStatus = summarize(jobId, summary, state, {
        event: 'full_ingestion_chunk_paused',
        status: 'running',
        done,
        resumedBatches: batch,
        resultsLimit,
        daysBack,
        batchSize,
        apifyMemoryMbytes: process.env.APIFY_MEMORY_MBYTES ?? null,
        fullScrapeConcurrency: process.env.INGESTION_FULL_SCRAPE_CONCURRENCY ?? null,
        maxBatches: maxBatches ?? null,
      });
      writeFileSync(statusPath, JSON.stringify(pausedStatus, null, 2));
      console.log(JSON.stringify(pausedStatus));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchJob(convex, jobId, {
      status: 'failed',
      summaryJson: JSON.stringify(summary),
      stateJson: JSON.stringify(state),
      error: message,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const failedStatus = summarize(jobId, summary, state, {
      event: 'full_ingestion_failed',
      status: 'failed',
      error: message,
      resultsLimit,
      daysBack,
      batchSize,
      apifyMemoryMbytes: process.env.APIFY_MEMORY_MBYTES ?? null,
      fullScrapeConcurrency: process.env.INGESTION_FULL_SCRAPE_CONCURRENCY ?? null,
      finishedAt: new Date().toISOString(),
    });
    writeFileSync(statusPath, JSON.stringify(failedStatus, null, 2));
    console.error(JSON.stringify(failedStatus, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
