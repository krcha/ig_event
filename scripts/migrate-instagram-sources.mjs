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

const client = new ConvexHttpClient(convexUrl);
const totals = {
  examined: 0,
  inserted: 0,
  reconciled: 0,
  alreadyPresent: 0,
  proposed: 0,
  proposedReconciliations: 0,
  pages: 0,
};
const sample = [];
const seenCursors = new Set();
let cursor = null;
while (true) {
  if (cursor && seenCursors.has(cursor)) {
    throw new Error("Cursor cycle while migrating Instagram sources.");
  }
  if (cursor) seenCursors.add(cursor);
  const page = await client.mutation("instagramSources:backfillFromVenues", {
    paginationOpts: { cursor, numItems: 100 },
    dryRun: !apply,
    serviceSecret,
  });
  totals.pages += 1;
  totals.examined += page.examined ?? 0;
  totals.inserted += page.inserted ?? 0;
  totals.reconciled += page.reconciled ?? 0;
  totals.alreadyPresent += page.alreadyPresent ?? 0;
  totals.proposed += page.proposals?.length ?? 0;
  totals.proposedReconciliations +=
    page.proposals?.filter((proposal) => proposal.action === "reconcile").length ?? 0;
  for (const proposal of page.proposals ?? []) {
    if (sample.length < 25) sample.push(proposal);
  }
  if (page.isDone) break;
  cursor = page.continueCursor;
}

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      ...totals,
      sample,
      note: apply
        ? "Legacy venue-backed Instagram sources were inserted or reconciled idempotently."
        : "No rows were changed. Re-run with --apply after reviewing this output.",
    },
    null,
    2,
  ),
);
