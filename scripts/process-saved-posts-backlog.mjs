import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { ConvexHttpClient } from "convex/browser";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

for (const filePath of [".env.local", ".env", "events-api-keys.env", ".env.self-hosted"]) {
  loadEnvFile(filePath);
}

const apply = process.argv.includes("--apply");
const daysBackArg = process.argv.find((value) => value.startsWith("--days-back="));
const parsedDaysBack = Number.parseInt(daysBackArg?.split("=", 2)[1] ?? "10", 10);
const daysBack = Number.isFinite(parsedDaysBack)
  ? Math.max(1, Math.min(30, parsedDaysBack))
  : 10;
const auditConcurrencyArg = process.argv.find((value) =>
  value.startsWith("--audit-concurrency="),
);
const parsedAuditConcurrency = Number.parseInt(
  auditConcurrencyArg?.split("=", 2)[1] ?? "2",
  10,
);
const auditConcurrency = Number.isFinite(parsedAuditConcurrency)
  ? Math.max(1, Math.min(4, parsedAuditConcurrency))
  : 2;
const convexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  process.env.CONVEX_SELF_HOSTED_URL ??
  process.env.CONVEX_URL;
const serviceSecret =
  process.env.INGESTION_SERVICE_SECRET ??
  process.env.CONVEX_INGESTION_SERVICE_SECRET ??
  process.env.CRON_SECRET;
if (!convexUrl || !serviceSecret) {
  throw new Error("Missing Convex URL or ingestion service secret.");
}

const { getActiveVenueHandles, runInstagramIngestion } = await import(
  "../lib/pipeline/run-instagram-ingestion.ts"
);
const client = new ConvexHttpClient(convexUrl);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConvexRetry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === 6) break;
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after retries: ${message}`);
}

const activeHandles = await getActiveVenueHandles({ serviceSecret });

async function listAllSavedHandles() {
  const handles = new Set(activeHandles);
  const seenCursors = new Set();
  let cursor = null;
  while (true) {
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Cursor cycle while listing saved handles.");
    }
    if (cursor) seenCursors.add(cursor);
    const page = await withConvexRetry("List saved handles", () =>
      client.query("scrapedPosts:listAllHandlesPaginated", {
        paginationOpts: { cursor, numItems: 100 },
        serviceSecret,
      }),
    );
    for (const handle of page.page ?? []) {
      if (typeof handle === "string" && handle.trim()) handles.add(handle);
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return [...handles].sort();
}

const handles = await listAllSavedHandles();

async function countBacklogForHandle(handle) {
  let cursor = null;
  let pending = 0;
  let completed = 0;
  let retryable = 0;
  let legacyUnknown = 0;
  let unmigratedPaidFetchFlag = 0;
  const postsByUtcDay = new Map();
  const seenCursors = new Set();
  while (true) {
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`Cursor cycle while auditing ${handle}.`);
    }
    if (cursor) seenCursors.add(cursor);
    const page = await withConvexRetry(`Audit saved posts for ${handle}`, () =>
      client.query("scrapedPosts:listByHandlePaginated", {
        handle,
        paginationOpts: { cursor, numItems: 100 },
        serviceSecret,
      }),
    );
    for (const post of page.page ?? []) {
      if (post.processingStatus === "completed") completed += 1;
      else if (post.processingStatus === "retryable_failure") retryable += 1;
      else if (post.processingStatus === "pending") pending += 1;
      else legacyUnknown += 1;
      if (post.blocksPaidFetch === undefined) unmigratedPaidFetchFlag += 1;
      const postedAtMs = Date.parse(post.postedAt ?? "");
      if (Number.isFinite(postedAtMs)) {
        const utcDay = new Date(postedAtMs).toISOString().slice(0, 10);
        postsByUtcDay.set(utcDay, (postsByUtcDay.get(utcDay) ?? 0) + 1);
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return {
    pending,
    completed,
    retryable,
    legacyUnknown,
    unmigratedPaidFetchFlag,
    maxPostsPerUtcDay: Math.max(0, ...postsByUtcDay.values()),
  };
}

async function auditBacklog() {
  const totals = {
    pending: 0,
    completed: 0,
    retryable: 0,
    legacyUnknown: 0,
    unmigratedPaidFetchFlag: 0,
    observedMaxPostsPerHandlePerUtcDay: 0,
  };
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < handles.length) {
      const handle = handles[nextIndex];
      nextIndex += 1;
      const counts = await countBacklogForHandle(handle);
      for (const key of [
        "pending",
        "completed",
        "retryable",
        "legacyUnknown",
        "unmigratedPaidFetchFlag",
      ]) {
        totals[key] += counts[key];
      }
      totals.observedMaxPostsPerHandlePerUtcDay = Math.max(
        totals.observedMaxPostsPerHandlePerUtcDay,
        counts.maxPostsPerUtcDay,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(auditConcurrency, handles.length) }, () => worker()));
  return totals;
}

async function migratePaidFetchFlags() {
  let cursor = null;
  let scanned = 0;
  let missing = 0;
  let updated = 0;
  const reconciled = {
    scanned: 0,
    releasedTerminal: 0,
    releasedRetryable: 0,
    releasedOutOfHorizon: 0,
    releasedExpiredLease: 0,
  };
  const horizonCutoffMs = Date.now() - daysBack * 24 * 60 * 60_000;
  const seenCursors = new Set();
  while (true) {
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Cursor cycle while migrating paid-fetch flags.");
    }
    if (cursor) seenCursors.add(cursor);
    const page = await withConvexRetry("List paid-fetch migration page", () =>
      client.query("scrapedPosts:listPaidFetchMigrationPage", {
        paginationOpts: { cursor, numItems: 100 },
        serviceSecret,
      }),
    );
    const pageRows = page.page ?? [];
    const pageIds = pageRows.map((post) => post._id);
    scanned += pageRows.length;
    const missingIds = pageRows.filter((post) => post.missing).map((post) => post._id);
    missing += missingIds.length;
    if (missingIds.length > 0) {
      const result = await withConvexRetry("Backfill paid-fetch flags", () =>
        client.mutation("scrapedPosts:backfillPaidFetchFlags", {
          ids: missingIds,
          serviceSecret,
        }),
      );
      updated += result.updated ?? 0;
    }
    if (pageIds.length > 0) {
      const result = await withConvexRetry("Reconcile paid-fetch flags", () =>
        client.mutation("scrapedPosts:reconcilePaidFetchFlags", {
          ids: pageIds,
          horizonCutoffMs,
          serviceSecret,
        }),
      );
      for (const key of Object.keys(reconciled)) {
        reconciled[key] += result[key] ?? 0;
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { scanned, missing, updated, horizonCutoffMs, reconciled };
}

const before = await auditBacklog();
if (!apply) {
  console.log(
    JSON.stringify({
      mode: "dry_run",
      daysBack,
      auditConcurrency,
      activeHandles: activeHandles.length,
      savedHandles: handles.length,
      backlog: before,
    }),
  );
  process.exit(0);
}

let migration = null;
try {
  migration = await migratePaidFetchFlags();
  const afterMigration = await auditBacklog();
  if (afterMigration.unmigratedPaidFetchFlag !== 0) {
    throw new Error(
      `Paid-fetch flag migration incomplete: ${afterMigration.unmigratedPaidFetchFlag} rows remain.`,
    );
  }
  const summary = await runInstagramIngestion({
    handles,
    mode: "saved_posts",
    daysBack,
    serviceSecret,
  });
  const totals = summary.handles.reduce(
    (result, handle) => {
      result.insertedEvents += handle.insertedEvents;
      result.insertedApprovedEvents += handle.insertedApprovedEvents;
      result.insertedPendingEvents += handle.insertedPendingEvents;
      result.skippedDuplicates += handle.skippedDuplicates;
      result.failures +=
        handle.failedDownloads + handle.failedConversions + handle.failedExtractions;
      return result;
    },
    {
      insertedEvents: 0,
      insertedApprovedEvents: 0,
      insertedPendingEvents: 0,
      skippedDuplicates: 0,
      failures: 0,
    },
  );
  const after = await auditBacklog();
  const paidFetchGate = await withConvexRetry("Mark paid-fetch backlog index ready", () =>
    client.mutation("scrapedPosts:markPaidFetchBacklogIndexReady", { serviceSecret }),
  );
  console.log(
    JSON.stringify({
      mode: "apply",
      daysBack,
      auditConcurrency,
      activeHandles: activeHandles.length,
      savedHandles: handles.length,
      before,
      migration,
      after,
      totals,
      paidFetchGate,
    }),
  );
} catch (error) {
  const after = await auditBacklog();
  const message = error instanceof Error ? error.message : "Saved-post processing failed.";
  console.error(
    JSON.stringify({
      mode: "apply",
      daysBack,
      auditConcurrency,
      activeHandles: activeHandles.length,
      savedHandles: handles.length,
      before,
      migration,
      after,
      error: message.slice(0, 1_000),
    }),
  );
  process.exitCode = 1;
}
