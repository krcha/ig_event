import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const DEFAULT_STALE_HOURS = 6;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_SOURCE = "cron_active_venues";

function usage() {
  return [
    "Usage: npm run repair:stale-ingestion-jobs -- [--apply] [--hours N] [--days N] [--source NAME|--all-sources]",
    "",
    "Dry-run is the default. Finds ingestionJobs still marked running after the stale cutoff",
    "and marks them failed only when --apply is provided.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    staleHours: DEFAULT_STALE_HOURS,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    source: DEFAULT_SOURCE,
    allSources: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--hours") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--hours must be a positive number.");
      }
      options.staleHours = value;
    } else if (arg === "--days") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--days must be a positive number.");
      }
      options.lookbackDays = value;
    } else if (arg === "--source") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--source requires a value.");
      }
      options.source = value;
      options.allSources = false;
    } else if (arg === "--all-sources") {
      options.allSources = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnvFiles() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");
  loadEnvFile("events-api-keys.env");
}

function getTimestamp(job) {
  const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  if (Number.isFinite(startedAtMs)) {
    return startedAtMs;
  }
  return job.createdAt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnvFiles();

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const now = Date.now();
  const minCreatedAt = now - options.lookbackDays * 24 * 60 * 60 * 1000;
  const staleBefore = now - options.staleHours * 60 * 60 * 1000;
  const client = new ConvexHttpClient(convexUrl);
  const jobs = await client.query(api.ingestionJobs.listRecentFullScrapeJobs, {
    minCreatedAt,
  });

  const staleJobs = jobs
    .filter((job) => job.status === "running")
    .filter((job) => options.allSources || job.source === options.source)
    .filter((job) => getTimestamp(job) < staleBefore)
    .sort((a, b) => getTimestamp(a) - getTimestamp(b));

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    convexUrlHost: new URL(convexUrl).host,
    lookbackDays: options.lookbackDays,
    staleHours: options.staleHours,
    source: options.allSources ? "all" : options.source,
    scannedJobs: jobs.length,
    staleRunningJobs: staleJobs.length,
    applied: 0,
    samples: staleJobs.slice(0, 20).map((job) => ({
      id: job._id,
      source: job.source,
      handleCount: Array.isArray(job.handles) ? job.handles.length : null,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt ?? null,
      ageHours: Number(((now - getTimestamp(job)) / (60 * 60 * 1000)).toFixed(2)),
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!options.apply || staleJobs.length === 0) {
    return;
  }

  const finishedAt = new Date(now).toISOString();
  let applied = 0;
  for (const job of staleJobs) {
    const ageHours = Number(((now - getTimestamp(job)) / (60 * 60 * 1000)).toFixed(2));
    await client.mutation(api.ingestionJobs.patchJob, {
      id: job._id,
      patch: {
        status: "failed",
        error: `Marked stale by repair: job was still running after ${ageHours}h (cutoff ${options.staleHours}h).`,
        finishedAt,
      },
    });
    applied += 1;
  }

  console.log(JSON.stringify({ applied, finishedAt }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
