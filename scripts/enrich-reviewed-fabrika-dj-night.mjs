import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import {
  buildReviewedFabrikaDjNightEnrichmentPatch,
  FABRIKA_DJ_NIGHT_DIRECT_ID,
  FABRIKA_DJ_NIGHT_DIRECT_URL,
  FABRIKA_DJ_NIGHT_PRIMARY_ID,
  FABRIKA_DJ_NIGHT_WEEKLY_URL,
} from "../lib/events/reviewed-fabrika-dj-night-enrichment.ts";

const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const OPERATION_ID = "reviewed-fabrika-dj-night-enrichment-20260924-v1";
const NOTE =
  "Reviewed Fabrika direct DJ Night announcement confirms entry price and resident lineup for the existing weekly DJ NIGHT card.";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceVersion(source, occurrence) {
  assert(source?.link && source?.receipt && occurrence, "Source topology is incomplete.");
  return {
    linkId: source.link._id,
    linkUpdatedAt: source.link.updatedAt,
    receiptId: source.receipt._id,
    receiptUpdatedAt: source.receipt.updatedAt,
    occurrenceId: occurrence._id,
    occurrenceUpdatedAt: occurrence.updatedAt,
  };
}

async function getSingleOccurrence(client, eventId, serviceSecret) {
  const page = await client.query("sourceOccurrences:listByCanonicalEvent", {
    eventId,
    paginationOpts: { cursor: null, numItems: 2 },
    serviceSecret,
  });
  assert(page.isDone && page.page.length === 1, "Event occurrence topology changed.");
  return page.page[0];
}

async function loadPlan(client, serviceSecret) {
  const [context, primaryOccurrence, directOccurrence, weeklyPost, directPost] =
    await Promise.all([
      client.query("events:getReviewedCrossPostScheduleFoldContext", {
        operationId: OPERATION_ID,
        primaryId: FABRIKA_DJ_NIGHT_PRIMARY_ID,
        duplicateId: FABRIKA_DJ_NIGHT_DIRECT_ID,
        serviceSecret,
      }),
      getSingleOccurrence(client, FABRIKA_DJ_NIGHT_PRIMARY_ID, serviceSecret),
      getSingleOccurrence(client, FABRIKA_DJ_NIGHT_DIRECT_ID, serviceSecret),
      client.query("scrapedPosts:getByHandleAndPostRef", {
        handle: "faks_beograd",
        instagramPostUrl: FABRIKA_DJ_NIGHT_WEEKLY_URL,
      }),
      client.query("scrapedPosts:getByHandleAndPostRef", {
        handle: "faks_beograd",
        instagramPostUrl: FABRIKA_DJ_NIGHT_DIRECT_URL,
      }),
    ]);
  assert(
    context.primary?._id === FABRIKA_DJ_NIGHT_PRIMARY_ID &&
      context.duplicate?._id === FABRIKA_DJ_NIGHT_DIRECT_ID &&
      context.primarySources?.length === 1 &&
      context.duplicateSources?.length === 1 &&
      weeklyPost?.caption === context.primary.sourceCaption &&
      directPost?.caption === context.duplicate.sourceCaption &&
      primaryOccurrence._id === context.primarySources[0].link.sourceOccurrenceId &&
      directOccurrence._id === context.duplicateSources[0].link.sourceOccurrenceId,
    "Reviewed Fabrika source evidence changed.",
  );
  const patch = buildReviewedFabrikaDjNightEnrichmentPatch(
    context.primary,
    context.duplicate,
    directPost.caption,
  );
  if (patch.alreadyDone) {
    return {
      status: "done",
      planSha256: null,
      operation: null,
      publicEventId: FABRIKA_DJ_NIGHT_PRIMARY_ID,
      pendingDirectEventId: FABRIKA_DJ_NIGHT_DIRECT_ID,
    };
  }
  const operation = {
    functionName: "events:enrichReviewedFabrikaDjNight",
    args: {
      primaryId: FABRIKA_DJ_NIGHT_PRIMARY_ID,
      directId: FABRIKA_DJ_NIGHT_DIRECT_ID,
      expectedPrimaryUpdatedAt: context.primary.updatedAt,
      expectedDirectUpdatedAt: context.duplicate.updatedAt,
      primarySource: sourceVersion(context.primarySources[0], primaryOccurrence),
      directSource: sourceVersion(context.duplicateSources[0], directOccurrence),
      moderationNote: NOTE,
    },
  };
  const evidence = {
    version: 1,
    operation,
    primary: context.primary,
    direct: context.duplicate,
    primarySource: context.primarySources[0],
    directSource: context.duplicateSources[0],
    primaryOccurrence,
    directOccurrence,
    weeklyPost,
    directPost,
    patch,
  };
  const planSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
  return {
    status: "pending",
    planSha256,
    operation,
    publicEventId: FABRIKA_DJ_NIGHT_PRIMARY_ID,
    pendingDirectEventId: FABRIKA_DJ_NIGHT_DIRECT_ID,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const hashFlag = argv.indexOf("--expect-plan-sha256");
  const expectedHash = hashFlag < 0 ? null : argv[hashFlag + 1];
  assert(
    argv.every((arg, index) =>
      arg === "--apply" ||
      arg === "--expect-plan-sha256" ||
      (index > 0 && argv[index - 1] === "--expect-plan-sha256"),
    ) &&
      (!apply ? expectedHash === null : /^[0-9a-f]{64}$/u.test(expectedHash ?? "")),
    "Preview first; apply with --apply --expect-plan-sha256 <preview hash>.",
  );
  const configuredUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(
    configuredUrl === CONVEX_URL && Boolean(serviceSecret),
    "Production Convex URL or CRON_SECRET is unavailable.",
  );
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret);
  if (!apply) {
    console.log(JSON.stringify({
      mode: "preview",
      status: before.status,
      planSha256: before.planSha256,
      publicEventId: before.publicEventId,
      pendingDirectEventId: before.pendingDirectEventId,
    }, null, 2));
    return;
  }
  assert(
    before.operation && before.planSha256 === expectedHash,
    "Reviewed Fabrika plan changed after preview or was already applied.",
  );
  const result = await client.mutation(before.operation.functionName, {
    ...before.operation.args,
    serviceSecret,
  });
  assert(result.applied === true && result.directStatus === "pending", "Enrichment did not apply exactly once.");
  const after = await loadPlan(client, serviceSecret);
  assert(after.status === "done", "Enrichment returned but postwrite verification failed.");
  console.log(JSON.stringify({
    mode: "applied",
    status: "done",
    publicEventId: result.primaryId,
    pendingDirectEventId: FABRIKA_DJ_NIGHT_DIRECT_ID,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const secret = process.env.CRON_SECRET?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reviewed Fabrika DJ Night enrichment stopped: ${secret ? message.replaceAll(secret, "[redacted]") : message}`);
    process.exitCode = 1;
  }
}
