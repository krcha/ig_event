import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const listPageQuery = makeFunctionReference("venues:listInstagramHandleNormalizationPage");
const applyBatchMutation = makeFunctionReference("venues:applyInstagramHandleNormalizationBatch");
const PAGE_SIZE = 200;
const APPLY_BATCH_SIZE = 25;
const MAX_PAGES = 10_000;
const CONFIRMATION = "NORMALIZE_VENUE_HANDLES";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirmIndex = args.indexOf("--confirm");
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
if (apply && confirmation !== CONFIRMATION) {
  throw new Error(`Apply requires --confirm ${CONFIRMATION}.`);
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
  return { rows, invalid, collisions, needsUpdate };
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
console.log(
  JSON.stringify({
    phase: "preflight",
    apply,
    scanned: preflight.rows.length,
    needsUpdate: preflight.needsUpdate.length,
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
for (let index = 0; index < preflight.needsUpdate.length; index += APPLY_BATCH_SIZE) {
  const batch = preflight.needsUpdate.slice(index, index + APPLY_BATCH_SIZE);
  const result = await convex.mutation(applyBatchMutation, {
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
if (verification.needsUpdate.length !== 0) {
  throw new Error(
    `Venue handle normalization verification left ${verification.needsUpdate.length} rows unresolved.`,
  );
}
console.log(
  JSON.stringify({
    status: "complete",
    scanned: verification.rows.length,
    plannedUpdates: preflight.needsUpdate.length,
    updated,
    mutationCalls,
    verificationUpdatesRemaining: verification.needsUpdate.length,
    verifiedIdempotent: true,
  }),
);
