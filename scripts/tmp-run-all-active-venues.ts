import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';

type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed';
type HandleSummary = Record<string, any> & { handle: string; errors?: string[] };
type Summary = { startedAt: string; finishedAt: string; handles: HandleSummary[]; approvedDuplicateCleanup?: unknown };
type State = { handleIndex: number; currentHandle: string | null; currentPostIndex: number; currentHandlePosts: unknown[]; seenSourceKeysByHandle: Record<string, string[]> };

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

function argNumber(name: string, fallback: number): number {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const parsed = Number.parseInt(arg.slice(name.length + 3), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sum(summary: Summary, keys: (keyof HandleSummary)[]): number {
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
    latestErrors: errorMessages.slice(-5).map((message) => message.slice(0, 280)),
    approvedDuplicateCleanup: summary.approvedDuplicateCleanup ?? null,
  };
}

function hardLimitStillBlocking(summary: Summary, state: State): boolean {
  if (state.handleIndex < 4) return false;
  const processed = summary.handles.slice(0, state.handleIndex);
  const fetchedPosts = sum({ ...summary, handles: processed }, ['fetchedPosts', 'fetched_posts']);
  if (fetchedPosts > 0) return false;
  const errored = processed.filter((handle) => (handle.errors?.length ?? 0) > 0);
  if (errored.length < Math.min(4, processed.length)) return false;
  return errored.every((handle) => (handle.errors ?? []).some((message) => /Monthly usage hard limit exceeded|platform-feature-disabled/i.test(message)));
}

async function patchJob(convex: ConvexHttpClient, jobId: string, patch: Record<string, unknown>) {
  const patchRef = 'ingestionJobs:patchJob' as unknown as FunctionReference<'mutation'>;
  await convex.mutation(patchRef, { id: jobId, patch });
}

async function main() {
  loadEnv('/root/ig_event/.env.local');
  loadEnv('/opt/ig_event/.env.production');
  loadEnv('/root/.hermes/.env');

  const resultsLimit = argNumber('results-limit', 2);
  const daysBack = argNumber('days-back', 10);
  const batchSize = argNumber('batch-size', 4);
  const statusPath = process.argv.find((entry) => entry.startsWith('--status-path='))?.slice('--status-path='.length) ?? `/tmp/ig_event_full_ingestion_${Date.now()}.json`;

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error('NEXT_PUBLIC_CONVEX_URL is missing.');
  if (!process.env.APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN is missing.');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing.');

  const {
    createEmptyIngestionSummary,
    createInitialIngestionBatchState,
    getActiveVenueHandles,
    runInstagramIngestionBatchStep,
  } = await import('/root/ig_event/lib/pipeline/run-instagram-ingestion.ts') as any;

  const convex = new ConvexHttpClient(convexUrl);
  const handles: string[] = await getActiveVenueHandles();
  if (handles.length === 0) throw new Error('No active venue handles are configured.');

  let summary: Summary = createEmptyIngestionSummary(handles);
  let state: State = createInitialIngestionBatchState();
  const createRef = 'ingestionJobs:createJob' as unknown as FunctionReference<'mutation'>;
  const jobId = await convex.mutation(createRef, {
    source: 'manual_all_active_venues',
    mode: 'full_scrape',
    handles,
    resultsLimit,
    daysBack,
    batchSize,
    summaryJson: JSON.stringify(summary),
    stateJson: JSON.stringify(state),
  }) as string;

  const startedAt = new Date().toISOString();
  await patchJob(convex, jobId, { status: 'running' satisfies IngestionJobStatus, startedAt });
  console.log(JSON.stringify({ event: 'full_ingestion_started', jobId, activeVenueHandles: handles.length, resultsLimit, daysBack, batchSize, statusPath, startedAt }));

  let done = false;
  let batch = 0;
  try {
    while (!done) {
      batch += 1;
      const batchStartedAt = Date.now();
      const result = await runInstagramIngestionBatchStep({ handles, summary, state, resultsLimit, daysBack, batchSize, mode: 'full_scrape' });
      summary = result.summary as Summary;
      state = result.state as State;
      done = result.done;
      const finishedAt = done ? new Date().toISOString() : undefined;
      await patchJob(convex, jobId, {
        status: done ? ('completed' satisfies IngestionJobStatus) : ('running' satisfies IngestionJobStatus),
        summaryJson: JSON.stringify(summary),
        stateJson: JSON.stringify(state),
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
      });
      const progress = summarize(jobId, summary, state, { event: 'full_ingestion_batch', batch, done, batchSeconds: Math.round((Date.now() - batchStartedAt) / 100) / 10, resultsLimit, daysBack, batchSize, status: done ? 'completed' : 'running' });
      writeFileSync(statusPath, JSON.stringify(progress, null, 2));
      console.log(JSON.stringify(progress));
      if (!done && hardLimitStillBlocking(summary, state)) {
        throw new Error('Apify monthly hard limit is still blocking scraping after the first batch. Aborting to avoid useless all-venue attempts.');
      }
    }
    const finalStatus = summarize(jobId, summary, state, { event: 'full_ingestion_completed', status: 'completed', resultsLimit, daysBack, batchSize, finishedAt: new Date().toISOString() });
    writeFileSync(statusPath, JSON.stringify(finalStatus, null, 2));
    console.log(JSON.stringify(finalStatus, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchJob(convex, jobId, { status: 'failed' satisfies IngestionJobStatus, summaryJson: JSON.stringify(summary), stateJson: JSON.stringify(state), error: message, startedAt, finishedAt: new Date().toISOString() });
    const failedStatus = summarize(jobId, summary, state, { event: 'full_ingestion_failed', status: 'failed', error: message, resultsLimit, daysBack, batchSize, finishedAt: new Date().toISOString() });
    writeFileSync(statusPath, JSON.stringify(failedStatus, null, 2));
    console.error(JSON.stringify(failedStatus, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
