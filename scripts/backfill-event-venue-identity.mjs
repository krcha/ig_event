import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const backfillMutation = makeFunctionReference("events:backfillEventVenueIdentityBatch");

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
const serviceSecret = process.env.CRON_SECRET?.trim();
if (!convexUrl || !serviceSecret) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL and CRON_SECRET are required.");
}

const convex = new ConvexHttpClient(convexUrl);
let cursor = null;
let batches = 0;
let scanned = 0;
let updated = 0;

while (true) {
  if (batches >= 10_000) {
    throw new Error("Event venue-identity backfill exceeded the safety batch limit.");
  }
  const result = await convex.mutation(backfillMutation, {
    cursor,
    limit: 100,
    serviceSecret,
  });
  batches += 1;
  scanned += result.scanned;
  updated += result.updated;
  console.log(
    JSON.stringify({
      batch: batches,
      isDone: result.isDone,
      scanned: result.scanned,
      totalScanned: scanned,
      totalUpdated: updated,
      updated: result.updated,
    }),
  );
  if (result.isDone) break;
  if (!result.continueCursor || result.continueCursor === cursor) {
    throw new Error("Event venue-identity backfill did not advance its cursor.");
  }
  cursor = result.continueCursor;
}

console.log(JSON.stringify({ status: "complete", batches, scanned, updated }));
