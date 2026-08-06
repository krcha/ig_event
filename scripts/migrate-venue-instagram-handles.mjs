import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const listPageQuery = makeFunctionReference("venues:listInstagramHandleNormalizationPage");
const applyBatchMutation = makeFunctionReference("venues:applyInstagramHandleNormalizationBatch");
const clearBatchMutation = makeFunctionReference("venues:clearInstagramHandleNormalizationBatch");
const PAGE_SIZE = 200;
const APPLY_BATCH_SIZE = 25;
const MAX_PAGES = 10_000;
const APPLY_CONFIRMATION = "NORMALIZE_VENUE_HANDLES";
const ROLLBACK_CONFIRMATION = "CLEAR_NORMALIZED_VENUE_HANDLES";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rollback = args.includes("--rollback");
const confirmIndex = args.indexOf("--confirm");
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
const requiredConfirmation = rollback ? ROLLBACK_CONFIRMATION : APPLY_CONFIRMATION;
if (apply && confirmation !== requiredConfirmation) {
  throw new Error(`Apply requires --confirm ${requiredConfirmation}.`);
}

const convexUrl = (
  process.env.CONVEX_SELF_HOSTED_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? ""
).trim();
const serviceSecret = (process.env.CRON_SECRET ?? "").trim();
if (!convexUrl || !serviceSecret) {
  throw new Error(
    "CONVEX_SELF_HOSTED_URL (or NEXT_PUBLIC_CONVEX_URL) and CRON_SECRET are required.",
  );
}
const convex = new ConvexHttpClient(convexUrl);

async function readSnapshot() {
  const rows = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const result = await convex.query(listPageQuery, {
      paginationOpts: { cursor, numItems: PAGE_SIZE },
      serviceSecret,
    });
    rows.push(...result.page);
    if (result.isDone) break;
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new Error("Venue handle normalization pagination did not advance.");
    }
    if (seenCursors.has(result.continueCursor)) {
      throw new Error("Venue handle normalization pagination repeated a cursor.");
    }
    seenCursors.add(result.continueCursor);
    cursor = result.continueCursor;
    if (pageIndex === MAX_PAGES - 1) {
      throw new Error(`Venue handle normalization exceeded ${MAX_PAGES} pages.`);
    }
  }

  const invalid = rows.filter((row) => !row.expectedNormalizedInstagramHandle);
  const idsByNormalizedHandle = new Map();
  for (const row of rows) {
    if (!row.expectedNormalizedInstagramHandle) continue;
    const ids = idsByNormalizedHandle.get(row.expectedNormalizedInstagramHandle) ?? [];
    ids.push(row.id);
    idsByNormalizedHandle.set(row.expectedNormalizedInstagramHandle, ids);
  }
  const collisions = [...idsByNormalizedHandle.values()].filter((ids) => ids.length > 1);
  const needsUpdate = rows.filter(
    (row) => row.normalizedInstagramHandle !== row.expectedNormalizedInstagramHandle,
  );
  const needsRollback = rows.filter((row) => row.normalizedInstagramHandle !== null);
  return { rows, invalid, collisions, needsUpdate, needsRollback };
}

function assertSafeSnapshot(snapshot, label) {
  if (snapshot.invalid.length > 0) {
    throw new Error(`${label} found ${snapshot.invalid.length} invalid venue Instagram handles.`);
  }
  if (snapshot.collisions.length > 0) {
    throw new Error(`${label} found ${snapshot.collisions.length} normalized handle collisions.`);
  }
}

const preflight = await readSnapshot();
assertSafeSnapshot(preflight, "Preflight");
const plannedRows = rollback ? preflight.needsRollback : preflight.needsUpdate;
console.log(
  JSON.stringify({
    phase: "preflight",
    mode: rollback ? "rollback" : "normalize",
    apply,
    scanned: preflight.rows.length,
    plannedUpdates: plannedRows.length,
    needsUpdate: preflight.needsUpdate.length,
    needsRollback: preflight.needsRollback.length,
    invalid: preflight.invalid.length,
    collisions: preflight.collisions.length,
  }),
);

if (!apply) {
  console.log(JSON.stringify({ status: "dry_run_complete", mutationCalls: 0 }));
  process.exit(0);
}

let updated = 0;
let mutationCalls = 0;
for (let index = 0; index < plannedRows.length; index += APPLY_BATCH_SIZE) {
  const batch = plannedRows.slice(index, index + APPLY_BATCH_SIZE);
  const result = await convex.mutation(rollback ? clearBatchMutation : applyBatchMutation, {
    rows: batch.map((row) => ({
      id: row.id,
      expectedInstagramHandle: row.instagramHandle,
      expectedNormalizedInstagramHandle: row.normalizedInstagramHandle,
    })),
    serviceSecret,
  });
  mutationCalls += 1;
  updated += result.updated;
  if (result.scanned !== batch.length) {
    throw new Error(
      `Normalization batch ${mutationCalls} scanned ${result.scanned} of ${batch.length} rows.`,
    );
  }
}

const verification = await readSnapshot();
assertSafeSnapshot(verification, "Verification");
if (verification.rows.length !== preflight.rows.length) {
  throw new Error(
    `Venue count changed during normalization (${preflight.rows.length} to ${verification.rows.length}).`,
  );
}
const remaining = rollback ? verification.needsRollback.length : verification.needsUpdate.length;
if (remaining !== 0) {
  throw new Error(
    `Venue handle normalization ${rollback ? "rollback" : "apply"} verification left ${remaining} rows unresolved.`,
  );
}
console.log(
  JSON.stringify({
    status: "complete",
    mode: rollback ? "rollback" : "normalize",
    scanned: verification.rows.length,
    plannedUpdates: plannedRows.length,
    updated,
    mutationCalls,
    verificationUpdatesRemaining: remaining,
    verifiedIdempotent: true,
  }),
);
