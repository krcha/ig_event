import { existsSync, readFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';

type HandleSummary = Record<string, any> & { handle: string; errors?: string[] };
type Summary = { handles: HandleSummary[]; approvedDuplicateCleanup?: unknown };
type State = { handleIndex: number; currentHandle: string | null };
type Job = {
  _id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  handles: string[];
  summaryJson: string;
  stateJson: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};
type EventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  venue: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
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

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sum(summary: Summary, keys: string[]): number {
  return summary.handles.reduce((total, handle) => total + Math.max(...keys.map((key) => Number(handle[key] ?? 0)), 0), 0);
}

function countByStatus(events: EventRecord[]) {
  return events.reduce((acc, event) => {
    acc[event.status] = (acc[event.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

async function httpCheck(url: string) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    const contentType = response.headers.get('content-type') ?? '';
    let okField: unknown = undefined;
    if (contentType.includes('application/json')) {
      try { okField = (await response.clone().json())?.ok; } catch {}
    }
    return { url, status: response.status, ok: response.ok, okField };
  } catch (error) {
    return { url, status: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  loadEnv('/root/ig_event/.env.local');
  loadEnv('/opt/ig_event/.env.production');
  loadEnv('/root/.hermes/.env');
  const jobId = argValue('job-id');
  if (!jobId) throw new Error('--job-id is required');
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error('NEXT_PUBLIC_CONVEX_URL is missing.');

  const convex = new ConvexHttpClient(convexUrl);
  const getJobRef = 'ingestionJobs:getJob' as unknown as FunctionReference<'query'>;
  const listEventsRef = 'events:listEvents' as unknown as FunctionReference<'query'>;
  const job = await convex.query(getJobRef, { id: jobId }) as Job | null;
  if (!job) throw new Error(`Ingestion job not found: ${jobId}`);

  const summary = parseJson<Summary>(job.summaryJson, { handles: [] });
  const state = parseJson<State>(job.stateJson, { handleIndex: 0, currentHandle: null });
  const startedMs = job.startedAt ? Date.parse(job.startedAt) : 0;
  const recentEvents = await convex.query(listEventsRef, { limit: 500 }) as EventRecord[];
  const createdSinceStart = recentEvents.filter((event) => Number(event.createdAt) >= startedMs);
  const statusCounts = countByStatus(createdSinceStart);
  const sample = createdSinceStart
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6)
    .map((event) => `${event.title} — ${event.date}${event.time ? ` ${event.time}` : ''} — ${event.venue} (${event.status})`);

  const [health, calendar] = await Promise.all([
    httpCheck('https://events.ineedtofeedmyrabbit.com/api/health'),
    httpCheck('https://events.ineedtofeedmyrabbit.com/calendar'),
  ]);

  const lines = [
    job.status === 'completed' ? '✅ All-venue Instagram ingestion completed.' : `⚠️ All-venue Instagram ingestion status: ${job.status}.`,
    `Job: ${jobId}`,
    `Processed: ${Math.min(state.handleIndex, job.handles.length)} / ${job.handles.length} venue handles`,
    `Posts fetched: ${sum(summary, ['fetchedPosts', 'fetched_posts'])}`,
    `Events inserted: ${sum(summary, ['insertedEvents', 'inserted_events'])} (${sum(summary, ['insertedApprovedEvents'])} approved, ${sum(summary, ['insertedPendingEvents'])} pending)`,
    `Skips: ${sum(summary, ['skipped_missing_date'])} missing date, ${sum(summary, ['skipped_past_event'])} past, ${sum(summary, ['skipped_invalid_event'])} invalid, ${sum(summary, ['skipped_missing_venue'])} missing venue`,
    `Errors: ${summary.handles.filter((handle) => (handle.errors?.length ?? 0) > 0).length} handles / ${summary.handles.flatMap((handle) => handle.errors ?? []).length} total`,
    `Convex verification: ${createdSinceStart.length} events currently found with createdAt >= job start (${statusCounts.approved ?? 0} approved, ${statusCounts.pending ?? 0} pending, ${statusCounts.rejected ?? 0} rejected).`,
    `HTTP health: /api/health ${health.status ?? 'ERR'}${health.okField !== undefined ? ` ok=${health.okField}` : ''}; /calendar ${calendar.status ?? 'ERR'}`,
  ];
  if (job.error) lines.push(`Job error: ${job.error}`);
  if (sample.length > 0) {
    lines.push('Recent created events:');
    for (const item of sample) lines.push(`- ${item}`);
  }
  if (job.finishedAt) lines.push(`Finished at: ${job.finishedAt}`);
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
