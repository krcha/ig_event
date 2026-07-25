import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const backfillMutation = makeFunctionReference("events:backfillEventVenueIdentityBatch");
const MAX_BATCHES_PER_PASS = 10_000;

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
const serviceSecret = process.env.CRON_SECRET?.trim();
if (!convexUrl || !serviceSecret) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL and CRON_SECRET are required.");
}

const convex = new ConvexHttpClient(convexUrl);

async function runPass(pass) {
  let cursor = null;
  let batches = 0;
  let scanned = 0;
  let updated = 0;

  while (true) {
    if (batches >= MAX_BATCHES_PER_PASS) {
      throw new Error(`Event venue-identity backfill pass ${pass} exceeded the safety batch limit.`);
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
        pass,
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
      throw new Error(`Event venue-identity backfill pass ${pass} did not advance its cursor.`);
    }
    cursor = result.continueCursor;
  }

  return { pass, batches, scanned, updated };
}

const applyPass = await runPass(1);
const verificationPass = await runPass(2);
if (verificationPass.updated !== 0) {
  throw new Error(
    `Event venue-identity verification was not idempotent: ${verificationPass.updated} rows changed.`,
  );
}
if (verificationPass.scanned < applyPass.scanned) {
  throw new Error(
    `Event venue-identity verification scanned fewer rows (${verificationPass.scanned}) than the apply pass (${applyPass.scanned}).`,
  );
}

console.log(
  JSON.stringify({
    status: "complete",
    applyPass,
    verificationPass,
    verifiedIdempotent: true,
  }),
);
