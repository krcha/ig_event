import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";

for (const p of [".env.local", ".env", "events-api-keys.env", ".env.self-hosted"]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const serviceSecret = process.env.CRON_SECRET;
if (!url || !serviceSecret) throw new Error("Missing live Convex URL or service secret");
const client = new ConvexHttpClient(url);
const windowStart = Date.parse("2026-07-24T04:30:00Z");
const recent = await client.query("ingestionJobs:listRecentFullScrapeJobs", { minCreatedAt: windowStart, serviceSecret });
const jobs = [];
for (const item of recent) jobs.push(await client.query("ingestionJobs:getJob", { id: item._id, serviceSecret }));

function parseJson(value) { try { return JSON.parse(value || "{}"); } catch { return { __parseError: true }; } }
function firstNumber(obj, keys) { for (const key of keys) if (Number.isFinite(obj?.[key])) return Number(obj[key]); return 0; }
const specs = {
  fetchedPosts: ["fetchedPosts", "fetched_posts"], insertedEvents: ["insertedEvents", "inserted_events"],
  insertedApprovedEvents: ["insertedApprovedEvents"], insertedPendingEvents: ["insertedPendingEvents"],
  skippedDuplicates: ["skippedDuplicates", "skipped_duplicates", "skipped_duplicates_clean"],
  skippedMissingDate: ["skipped_missing_date"], skippedPastEvent: ["skipped_past_event"],
  skippedInvalidEvent: ["skipped_invalid_event"], skippedMissingVenue: ["skipped_missing_venue"],
  skippedFarFutureEvent: ["skipped_far_future_event"], skippedVideo: ["skipped_video"],
  failedDownloads: ["failedDownloads", "failed_downloads"],
  failedExtractions: ["failedExtractions", "failed_extractions", "failed_extraction"],
  mediaAssetsPersisted: ["mediaAssetsPersisted", "media_assets_persisted"],
  mediaAssetPersistenceFailed: ["mediaAssetPersistenceFailed", "media_asset_persistence_failed"],
};
function compactJob(job) {
  const summary = parseJson(job.summaryJson);
  const state = parseJson(job.stateJson);
  const handles = Array.isArray(summary.handles) ? summary.handles : [];
  const totals = {};
  for (const [name, keys] of Object.entries(specs)) totals[name] = handles.reduce((sum, handle) => sum + firstNumber(handle, keys), 0);
  const errors = [];
  for (const handle of handles) for (const error of (Array.isArray(handle.errors) ? handle.errors : [])) {
    const text = typeof error === "string" ? error : JSON.stringify(error);
    if (!errors.includes(text)) errors.push(text);
  }
  return {
    id: job._id, source: job.source, status: job.status,
    createdAt: new Date(job.createdAt).toISOString(), startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null, updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
    handleCount: job.handles?.length ?? 0,
    state: { handleIndex: state.handleIndex ?? null, handlesLength: Array.isArray(state.handles) ? state.handles.length : null, keys: Object.keys(state).sort() },
    summaryHandleCount: handles.length, totals, error: job.error ?? null,
    errorSamples: errors.slice(0, 10), cleanup: summary.approvedDuplicateCleanup ?? null,
  };
}

const output = { convexHost: new URL(url).host, jobs: jobs.map(compactJob) };
let cursor = null;
let isDone = false;
let totalApprovedUpcoming = 0;
let approvedCreatedSinceRunStart = 0;
const samples = [];
const runStart = Date.parse("2026-07-24T05:00:01Z");
while (!isDone) {
  const result = await client.query("events:listApprovedUpcomingByDatePaginated", {
    fromDate: "2026-07-24", paginationOpts: { numItems: 100, cursor },
  });
  for (const event of result.page) {
    totalApprovedUpcoming += 1;
    const createdAt = typeof event.createdAt === "number" ? event.createdAt : Date.parse(event.createdAt || "");
    if (Number.isFinite(createdAt) && createdAt >= runStart) {
      approvedCreatedSinceRunStart += 1;
      if (samples.length < 10) samples.push({ id: event._id, title: event.title, date: event.date, createdAt: new Date(createdAt).toISOString() });
    }
  }
  cursor = result.continueCursor;
  isDone = result.isDone;
  if (totalApprovedUpcoming > 5000) break;
}
output.publicUpcoming = { totalApprovedUpcoming, approvedCreatedSinceRunStart, samples };
console.log(JSON.stringify(output, null, 2));
