import { existsSync, readFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';

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

async function main() {
  loadEnv('/root/ig_event/.env.local');
  loadEnv('/opt/ig_event/.env.production');
  loadEnv('/root/.hermes/.env');
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error('NEXT_PUBLIC_CONVEX_URL is missing.');
  const jobId = argValue('job-id');
  if (!jobId) throw new Error('--job-id is required');
  const status = argValue('status') ?? 'failed';
  const error = argValue('error');
  const patchRef = 'ingestionJobs:patchJob' as unknown as FunctionReference<'mutation'>;
  const convex = new ConvexHttpClient(convexUrl);
  await convex.mutation(patchRef, {
    id: jobId,
    patch: {
      status,
      ...(error ? { error } : {}),
      finishedAt: new Date().toISOString(),
    },
  });
  console.log(JSON.stringify({ patched: true, jobId, status }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
